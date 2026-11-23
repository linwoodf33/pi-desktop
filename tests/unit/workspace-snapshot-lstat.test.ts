import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as FsPromises from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 技术债 #3 的**核心回归**：快照的候选文件判定必须用 `lstat`（看链接本身），
 * 不能用 `stat`（解析链接目标）。
 *
 * 为什么不能只靠真实文件系统测：`readdir` 的 dirent 与随后的 `stat/lstat` 之间存在
 * TOCTOU 窗口——文件可能在两次调用之间被换成链接。这里把该窗口**构造出来**：
 * `readdir` 被包装成对某个名字谎报「普通文件」，而磁盘上那个名字实际上是指向区外目录的
 * junction。于是：
 * - 用 `lstat`：识别为链接 → 跳过 + `skippedSymlinks += 1` + `complete` 保持 true；
 * - 用 `stat`：跟随到目录 → 非普通文件 → 走 error 分支 → `complete = false` 且计数不增加。
 * 断言同时覆盖了「不泄漏目标内容」与「不把设计性跳过误报为扫描失败」。
 */
const io = vi.hoisted(() => ({
  /** 需要被「谎报为普通文件」的目录路径（readdir 的 path 必须精确等于它才改写） */
  fakeDir: undefined as string | undefined,
  /** 谎报的名字 */
  fakeName: 'fake-regular.txt',
  /** readdir 被改写的次数（确认测试确实触发了伪造路径，而不是空跑） */
  rewrites: 0
}))

/** 最小 FileDirent 替身：只实现 takeSnapshot 会用到的判定函数 */
const fakeDirent = {
  name: io.fakeName,
  path: '',
  parentPath: '',
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isFIFO: () => false,
  isSocket: () => false
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: (async (path: string, options: unknown) => {
      const real = await (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, options)
      if (io.fakeDir === undefined || String(path) !== io.fakeDir) return real
      io.rewrites += 1
      // 真实 dirent 里同名条目**剔除**：本用例要单独验证 describeFile 的 lstat 分支，
      // 不能让 readdir 层的链接判定提前命中（否则计数会来自两个分支，断言失去区分力）。
      const rest = (real as Array<{ name: string }>).filter((entry) => entry.name !== io.fakeName)
      return [...rest, fakeDirent]
    }) as typeof actual.readdir
  }
})

const { takeSnapshot } = await import('../../src/main/services/workspace-snapshot')

describe('describeFile 用 lstat 而非 stat（链接目标绝不跟随）', () => {
  let root: string
  let outsideDir: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-lstat-'))
    outsideDir = await mkdtemp(join(tmpdir(), 'pi-desktop-lstat-outside-'))
    await writeFile(join(outsideDir, 'secret.txt'), 'outside secret\n', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {})
  })

  it('dirent 谎报为普通文件、实际是指向区外目录的 junction → lstat 识别为链接并跳过', async () => {
    const dir = join(root, 'race')
    await mkdir(dir, { recursive: true })
    // 磁盘上 `fake-regular.txt` 实际是指向工作区外的目录 junction
    await symlink(outsideDir, join(dir, io.fakeName), 'junction')
    io.fakeDir = dir
    io.rewrites = 0

    const snapshot = await takeSnapshot(dir)
    io.fakeDir = undefined

    // 前置：伪造路径确实被触发（避免「因为没走到而通过」的假绿）
    expect(io.rewrites).toBe(1)
    // 不收录链接本身，也不收录其目标内容
    expect(snapshot.files.size).toBe(0)
    expect([...snapshot.files.keys()]).toEqual([])
    // 关键区分点：lstat → 计入 skippedSymlinks 且 complete 仍为 true；
    // 若用 stat，则会走 error 分支 → skippedSymlinks 为 0 且 complete 为 false
    expect(snapshot.skippedSymlinks).toBe(1)
    expect(snapshot.complete).toBe(true)
  })

  it('对照：dirent 谎报为普通文件、磁盘上已被删除 → 才算扫描失败（complete=false）', async () => {
    const dir = join(root, 'race-gone')
    await mkdir(dir, { recursive: true })
    io.fakeDir = dir
    io.rewrites = 0

    const snapshot = await takeSnapshot(dir)
    io.fakeDir = undefined

    expect(io.rewrites).toBe(1)
    // 文件真的不存在（ENOENT）才属于「扫描失败」，与链接跳过语义必须区分开
    expect(snapshot.files.size).toBe(0)
    expect(snapshot.skippedSymlinks).toBe(0)
    expect(snapshot.complete).toBe(false)
  })
})
