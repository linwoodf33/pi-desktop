import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { compareSnapshots, takeSnapshot } from '../../src/main/services/workspace-snapshot'

/**
 * 链接边界（技术债 #3：快照判定必须走 `lstat`，看链接本身而不是跟随目标）。
 *
 * 约定（与模块注释一致）：
 * - 链接（符号链接 / Windows junction）**不进入** `files`，也不遍历其目标；
 * - 只计入 `skippedSymlinks`，**不**把 `complete` 置 false（这是设计性跳过，不是扫描失败）；
 * - 目标被改指向、目标被删除（断链）都不得让快照崩溃或产生假变更。
 *
 * 平台现实（在本仓库 Windows 开发机上实测）：
 * - **junction** 无需管理员权限即可创建，且 `readdir(withFileTypes)` 报告 `isSymbolicLink() === true`，
 *   因此 junction 用例在 win32 上**无条件运行**，覆盖同一段「链接 → 跳过」代码；
 * - **文件/目录符号链接**在 Windows 需要开发者模式或管理员权限（此处 `EPERM`），
 *   这类用例按运行时探测的能力门控（`capability.fileSymlinks`），失败根因是 OS 权限而非实现。
 *   POSIX CI runner 上它们会真实运行。
 */
describe('takeSnapshot 的链接边界（junction 覆盖 / symlink 按能力门控）', () => {
  let root: string
  /** 工作区外部的「秘密」目录：绝不能有任何内容泄漏进快照 */
  let outside: string
  const capability = { fileSymlinks: false }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-links-'))
    outside = await mkdtemp(join(tmpdir(), 'pi-desktop-links-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')
    await mkdir(join(outside, 'deep'), { recursive: true })
    await writeFile(join(outside, 'deep', 'nested.txt'), 'nested secret\n', 'utf8')

    // 探测文件符号链接能力（Windows 上通常需要开发者模式）
    const probeDir = join(root, '__probe__')
    await mkdir(probeDir, { recursive: true })
    await writeFile(join(probeDir, 'target.txt'), 'probe\n', 'utf8')
    try {
      await symlink(join(probeDir, 'target.txt'), join(probeDir, 'link.txt'), 'file')
      capability.fileSymlinks = true
    } catch {
      capability.fileSymlinks = false
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    await rm(outside, { recursive: true, force: true }).catch(() => {})
  })

  it('工作区内的目录 junction：不遍历、不收录、计入 skippedSymlinks 且不判不完整', async () => {
    const dir = join(root, 'junction-inside')
    const target = join(dir, 'real-dir')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'inside.txt'), 'inside\n', 'utf8')
    // Windows junction 需要绝对目标路径
    await symlink(target, join(dir, 'linked-dir'), 'junction')

    const snapshot = await takeSnapshot(dir)

    expect(snapshot.files.has('linked-dir/inside.txt')).toBe(false)
    expect(snapshot.files.has('linked-dir')).toBe(false)
    // 真实目录照常收录（没有因为链接而误跳过）
    expect(snapshot.files.get('real-dir/inside.txt')?.content).toBe('inside\n')
    expect(snapshot.skippedSymlinks).toBe(1)
    expect(snapshot.skippedNonRegular).toBe(0)
    expect(snapshot.complete).toBe(true)
  })

  it('指向工作区外部的 junction：目标树一个字节都不进快照', async () => {
    const dir = join(root, 'junction-outside')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'mine.txt'), 'mine\n', 'utf8')
    await symlink(outside, join(dir, 'escape'), 'junction')

    const snapshot = await takeSnapshot(dir)
    const paths = [...snapshot.files.keys()]

    expect(paths).toEqual(['mine.txt'])
    // 「secret」「nested」这两个词只存在于工作区外，出现即代表跟随了链接
    expect(paths.some((path) => path.includes('secret'))).toBe(false)
    expect(paths.some((path) => path.includes('nested'))).toBe(false)
    expect(snapshot.skippedSymlinks).toBe(1)
    expect(snapshot.complete).toBe(true)
  })

  it('断链 junction（目标目录已删除）：不崩溃、不判不完整、计入 skippedSymlinks', async () => {
    const dir = join(root, 'junction-dangling')
    const target = join(root, 'junction-dangling-target')
    await mkdir(dir, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'gone.txt'), 'gone\n', 'utf8')
    await symlink(target, join(dir, 'dangling'), 'junction')
    // 删掉目标 → 链接悬空
    await rm(target, { recursive: true, force: true })

    const snapshot = await takeSnapshot(dir)

    expect(snapshot.files.size).toBe(0)
    expect(snapshot.skippedSymlinks).toBe(1)
    // 关键：悬空链接不是「扫描失败」，不能污染 complete 语义
    expect(snapshot.complete).toBe(true)
  })

  it('junction 目标被改指向 / 目标内容变化 → 不产生任何假变更', async () => {
    const dir = join(root, 'junction-retarget')
    const first = join(root, 'junction-retarget-a')
    const second = join(root, 'junction-retarget-b')
    await mkdir(dir, { recursive: true })
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'v.txt'), 'v1\n', 'utf8')
    await writeFile(join(second, 'v.txt'), 'v2-different\n', 'utf8')
    await writeFile(join(dir, 'own.txt'), 'own\n', 'utf8')
    await symlink(first, join(dir, 'swap'), 'junction')

    const before = await takeSnapshot(dir)
    // 目标内容变了 + 链接改指向：快照看的是链接本身，两者都不该被当成「文件变更」
    await writeFile(join(first, 'v.txt'), 'v1-changed\n', 'utf8')
    await rm(join(dir, 'swap'), { force: true })
    await symlink(second, join(dir, 'swap'), 'junction')
    const after = await takeSnapshot(dir)

    expect(compareSnapshots(before, after).entries).toEqual([])
    expect(after.skippedSymlinks).toBe(1)
    expect(after.complete).toBe(true)
  })

  it.skipIf(process.platform !== 'win32' || !capability.fileSymlinks)(
    '文件符号链接（指向区外文件）：不收录、不读取目标内容',
    async () => {
      const dir = join(root, 'file-link-outside')
      await mkdir(dir, { recursive: true })
      await symlink(join(outside, 'secret.txt'), join(dir, 'leak.txt'), 'file')

      const snapshot = await takeSnapshot(dir)

      expect(snapshot.files.size).toBe(0)
      expect(snapshot.skippedSymlinks).toBe(1)
      expect(snapshot.complete).toBe(true)
    }
  )

  it.skipIf(process.platform !== 'win32' || !capability.fileSymlinks)(
    '文件符号链接（指向区内文件）：链接与目标各按本义处理，不重复计数',
    async () => {
      const dir = join(root, 'file-link-inside')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'real.txt'), 'real\n', 'utf8')
      await symlink(join(dir, 'real.txt'), join(dir, 'alias.txt'), 'file')

      const snapshot = await takeSnapshot(dir)

      expect([...snapshot.files.keys()]).toEqual(['real.txt'])
      expect(snapshot.files.get('real.txt')?.content).toBe('real\n')
      expect(snapshot.skippedSymlinks).toBe(1)
      expect(snapshot.skippedNonRegular).toBe(0)
      expect(snapshot.complete).toBe(true)
    }
  )

  it('链接旁边的普通文件哈希不受影响（回归：没有把整棵树都当成链接跳过）', async () => {
    const dir = join(root, 'mixed')
    const target = join(root, 'mixed-target')
    await mkdir(dir, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'a\n', 'utf8')
    await writeFile(join(dir, 'b.txt'), 'b\n', 'utf8')
    await symlink(target, join(dir, 'c-link'), 'junction')

    const snapshot = await takeSnapshot(dir)

    expect([...snapshot.files.keys()].sort()).toEqual(['a.txt', 'b.txt'])
    expect(snapshot.scanned).toBe(2)
    expect(snapshot.skippedSymlinks).toBe(1)
  })
})
