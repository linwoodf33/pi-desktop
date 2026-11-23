import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  detectGitWorkspace,
  gitFileDiff,
  gitListChanges,
  parsePorcelainZ
} from '../../src/main/services/git-adapter'

const run = promisify(execFile)

/**
 * git 适配层（M6，§6.1 产物流）。
 *
 * 用**真实 git 仓库夹具**（临时目录）验证三件容易写错的事：
 * 1. `-z` 输出的解析（重命名条目是「新路径在前、旧路径在后」的两段 NUL 记录）；
 * 2. 工作区 ≠ 仓库根时的路径换算与过滤；
 * 3. `git diff` 覆盖「已暂存 + 未暂存」（分两次取再拼接）。
 */
async function gitAvailable(): Promise<boolean> {
  try {
    await run('git', ['--version'])
    return true
  } catch {
    return false
  }
}

describe('parsePorcelainZ（纯解析）', () => {
  it('解析修改 / 未跟踪 / 暂存新增', () => {
    const stdout = Buffer.from(' M sub/x.txt\0?? new.txt\0A  staged.txt\0', 'utf8')
    expect(parsePorcelainZ(stdout)).toEqual([
      { path: 'sub/x.txt', change: 'modified' },
      { path: 'new.txt', change: 'added', untracked: true },
      { path: 'staged.txt', change: 'added' }
    ])
  })

  it('解析重命名：新路径在前、旧路径在后', () => {
    const stdout = Buffer.from('R  sub/a2.txt\0a.txt\0', 'utf8')
    expect(parsePorcelainZ(stdout)).toEqual([
      { path: 'sub/a2.txt', change: 'renamed', oldPath: 'a.txt' }
    ])
  })

  it('解析删除', () => {
    const stdout = Buffer.from(' D gone.txt\0D  gone2.txt\0', 'utf8')
    expect(parsePorcelainZ(stdout).map((entry) => entry.change)).toEqual(['deleted', 'deleted'])
  })
})

describe.skipIf(!(await gitAvailable()))('真实 git 仓库夹具', () => {
  let base: string
  let repoRoot: string
  let nested: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'pi-desktop-git-'))
    repoRoot = base
    await run('git', ['init', '-q', '.'], { cwd: repoRoot })
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot })
    await run('git', ['config', 'user.name', 'test'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'a.txt'), 'a\nb\n', 'utf8')
    await mkdir(join(repoRoot, 'sub'), { recursive: true })
    await writeFile(join(repoRoot, 'sub', 'x.txt'), 'x\n', 'utf8')
    await run('git', ['add', '-A'], { cwd: repoRoot })
    await run('git', ['commit', '-qm', 'init'], { cwd: repoRoot })

    // 已暂存的重命名 + 未暂存的修改 + 未跟踪文件
    await run('git', ['mv', 'a.txt', 'sub/a2.txt'], { cwd: repoRoot })
    await writeFile(join(repoRoot, 'sub', 'x.txt'), 'x\nchanged\n', 'utf8')
    await writeFile(join(repoRoot, 'new.txt'), 'new\n', 'utf8')

    nested = join(repoRoot, 'sub')
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  })

  it('仓库根即工作区：列出新增/修改/重命名', async () => {
    const detected = await detectGitWorkspace({ workspaceRoot: repoRoot })
    expect(detected.workspace?.repoRoot.toLowerCase()).toBe(repoRoot.toLowerCase())

    const { entries } = await gitListChanges({ workspace: detected.workspace! })
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    expect(byPath.get('sub/x.txt')?.change).toBe('modified')
    expect(byPath.get('new.txt')?.change).toBe('added')
    expect(byPath.get('new.txt')?.untracked).toBe(true)
    expect(byPath.get('sub/a2.txt')?.change).toBe('renamed')
    expect(byPath.get('sub/a2.txt')?.oldPath).toBe('a.txt')
  })

  it('diff 同时覆盖已暂存（重命名）与未暂存（修改）', async () => {
    const detected = await detectGitWorkspace({ workspaceRoot: repoRoot })
    const workspace = detected.workspace!

    const renamed = await gitFileDiff({
      workspace,
      path: 'sub/a2.txt',
      oldPath: 'a.txt',
      change: 'renamed'
    })
    expect(renamed.patch).toContain('rename from a.txt')
    expect(renamed.patch).toContain('rename to sub/a2.txt')

    const modified = await gitFileDiff({ workspace, path: 'sub/x.txt', change: 'modified' })
    expect(modified.patch).toContain('+changed')

    // 未跟踪文件：git diff 为空（调用方负责用文件内容合成补丁）
    const untracked = await gitFileDiff({ workspace, path: 'new.txt', change: 'added' })
    expect(untracked.patch.trim()).toBe('')
  })

  it('工作区是仓库子目录：路径换算成工作区相对，且过滤掉工作区外的条目', async () => {
    await writeFile(join(repoRoot, 'outside.txt'), 'outside\n', 'utf8')
    const detected = await detectGitWorkspace({ workspaceRoot: nested })
    expect(detected.workspace?.prefix.replace(/\\/g, '/')).toBe('sub')

    const { entries } = await gitListChanges({ workspace: detected.workspace! })
    const paths = entries.map((entry) => entry.path)
    expect(paths).toContain('x.txt')
    expect(paths).toContain('a2.txt')
    // 工作区外的 new.txt / outside.txt 不应出现
    expect(paths).not.toContain('new.txt')
    expect(paths).not.toContain('outside.txt')
  })

  it('非 git 目录 → workspace 为空并给出回退原因', async () => {
    // 必须在仓库**之外**建目录（仓库内的子目录依然属于 work tree）
    const plain = await mkdtemp(join(tmpdir(), 'pi-desktop-plain-'))
    try {
      const detected = await detectGitWorkspace({ workspaceRoot: plain })
      expect(detected.workspace).toBeUndefined()
      expect(detected.reason).toContain('快照比对')
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('仓库无提交时 `git diff --cached` 仍可用（不依赖 HEAD 存在）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pi-desktop-git-empty-'))
    try {
      await run('git', ['init', '-q', '.'], { cwd: empty })
      await writeFile(join(empty, 'only.txt'), 'hi\n', 'utf8')
      await run('git', ['add', 'only.txt'], { cwd: empty })
      const detected = await detectGitWorkspace({ workspaceRoot: empty })
      const diff = await gitFileDiff({ workspace: detected.workspace!, path: 'only.txt' })
      expect(diff.patch).toContain('new file')
      expect(diff.patch).toContain('+hi')
    } finally {
      await rm(empty, { recursive: true, force: true }).catch(() => {})
    }
  })

  /**
   * 收口债 #3：`sizeOf` 用 `lstat` 而非 `stat`。
   *
   * 语义：产物列表报的是「工作区里这个条目的体积」。跟随链接会把目标（可能在工作区外、
   * 可能是几条 GB 的数据文件）的尺寸报成这里条目的尺寸；且悬空链接用 `stat` 直接失败
   * → 尺寸直接丢失。本用例用 4KB 目标 + 链接验证不会报成 4096。
   *
   * Windows 上创建符号链接需要开发者模式/提权：拿不到权限就跳过（不假装通过）。
   */
  it('符号链接取链接自身尺寸（lstat，不跟随目标）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-desktop-git-link-'))
    const target = join(tmpdir(), 'pi-desktop-link-target.bin')
    try {
      await run('git', ['init', '-q', '.'], { cwd: dir })
      await writeFile(target, Buffer.alloc(4096, 0x61))
      try {
        await symlink(target, join(dir, 'link.bin'))
      } catch {
        return // 无符号链接权限（非开发者模式）→ 本机无法验证，跳过
      }

      const detected = await detectGitWorkspace({ workspaceRoot: dir })
      const { entries } = await gitListChanges({ workspace: detected.workspace! })
      const link = entries.find((entry) => entry.path === 'link.bin')
      expect(link).toBeDefined()
      // 关键断言：不是目标的 4096（stat 行为），而是链接本身（几十字节）
      expect(link?.sizeBytes).not.toBe(4096)
      expect(link?.sizeBytes).toBeLessThan(1024)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await rm(target, { force: true }).catch(() => {})
    }
  })

  it('git 不可用（命令失败）时 detectGitWorkspace 给出可解释原因，不抛异常', async () => {
    const detected = await detectGitWorkspace({
      workspaceRoot: repoRoot,
      run: () =>
        Promise.resolve({ code: 127, stdout: Buffer.alloc(0), stderr: 'git: command not found' })
    })
    expect(detected.workspace).toBeUndefined()
    expect(detected.reason).toContain('git 不可用')
  })

  it('路径含空格/中文也能正确 diff（literal pathspec）', async () => {
    const name = '带 空格 的文件.txt'
    await writeFile(join(repoRoot, name), 'v1\n', 'utf8')
    await run('git', ['add', name], { cwd: repoRoot })
    await writeFile(join(repoRoot, name), 'v1\nv2\n', 'utf8')

    const detected = await detectGitWorkspace({ workspaceRoot: repoRoot })
    const diff = await gitFileDiff({ workspace: detected.workspace!, path: name })
    expect(diff.patch).toContain('+v2')
    // 清理，避免影响后续用例
    await run('git', ['rm', '-q', '--cached', name], { cwd: repoRoot }).catch(() => {})
    const restored = join(repoRoot, `${name}.bak`)
    await rename(join(repoRoot, name), restored).catch(() => {})
    await rm(restored, { force: true }).catch(() => {})
  })
})
