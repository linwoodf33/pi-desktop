import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertSafeRawPath,
  isInsideRoot,
  normalizeForCompare,
  resolveInsideAnyRoot,
  resolveWorkspaceTarget
} from '../../src/main/services/path-guard'
import { IpcFailure } from '../../src/shared/contracts/result'

/**
 * 路径校验器对抗矩阵（M6，§9.1 U9 / §9.4 S6 等价项）。
 *
 * 「本地校验是唯一防线」（Phase 1 没有远端）：因此这里覆盖的是**绕过手法**，
 * 而不是覆盖率数字——每一条都是攻击者会更早尝试的那一类。
 */
describe('assertSafeRawPath：词法黑名单', () => {
  const denied: Array<[string, string]> = [
    ['父目录穿越', '../etc/passwd'],
    ['反斜杠父目录穿越', '..\\Windows\\System32\\config\\SAM'],
    ['中间穿越', 'sub/../../outside.txt'],
    ['深层穿越', 'a/b/c/../../../x.txt'],
    ['UNC 反斜杠', '\\\\server\\share\\secret.txt'],
    ['UNC 正斜杠', '//server/share/secret.txt'],
    ['设备命名空间 \\\\?\\', '\\\\?\\C:\\Windows\\win.ini'],
    ['设备命名空间 \\\\.\\', '\\\\.\\PhysicalDrive0'],
    ['ADS（相对）', 'notes.txt:hidden'],
    ['ADS（绝对）', 'C:\\work\\notes.txt:stream'],
    ['NUL 字符', 'a\u0000b'],
    ['控制字符', 'a\u0001b'],
    ['尾随点', 'evil.'],
    ['尾随空格', 'evil '],
    ['保留设备名 CON', 'CON'],
    ['保留设备名（带扩展名）', 'nul.txt'],
    ['保留设备名在子目录', 'sub/com1.log'],
    ['仅空格', '   ']
  ]

  for (const [name, raw] of denied) {
    it(`拒绝：${name}（${JSON.stringify(raw)}）`, () => {
      expect(() => assertSafeRawPath(raw, 'win32')).toThrow(IpcFailure)
      try {
        assertSafeRawPath(raw, 'win32')
      } catch (error) {
        expect((error as IpcFailure).code).toMatch(/PATH_DENIED|VALIDATION/)
      }
    })
  }

  const allowed = ['a.txt', 'sub/dir/a.txt', './a.txt', 'C:\\work\\a.txt', 'résumé.md', 'a b.txt']
  for (const raw of allowed) {
    it(`放行：${JSON.stringify(raw)}`, () => {
      expect(() => assertSafeRawPath(raw, 'win32')).not.toThrow()
    })
  }
})

describe('isInsideRoot / normalizeForCompare：大小写与分隔符归一', () => {
  it('Windows 语义下大小写不敏感', () => {
    expect(isInsideRoot('C:/Work', 'c:/work/sub/a.txt', 'win32')).toBe(true)
    expect(isInsideRoot('C:\\Work', 'c:/WORK/sub/a.txt', 'win32')).toBe(true)
  })

  it('前缀相同但不是子目录时不算在内', () => {
    expect(isInsideRoot('C:/work', 'C:/workshop/a.txt', 'win32')).toBe(false)
  })

  it('根自身算在内', () => {
    expect(isInsideRoot('C:/work', 'c:/work', 'win32')).toBe(true)
  })

  it('分隔符归一不改变大小写敏感的 POSIX 语义', () => {
    expect(normalizeForCompare('/tmp/Work', 'linux')).toBe('/tmp/Work')
    expect(isInsideRoot('/tmp/Work', '/tmp/work/a', 'linux')).toBe(false)
  })
})

describe('resolveWorkspaceTarget：真实路径双闸', () => {
  let root: string
  let outside: string
  let insideLink: string | undefined
  let escapeLink: string | undefined

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'pi-desktop-pathguard-'))
    root = join(base, 'workspace')
    outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(join(root, 'sub'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'a.txt'), 'hello\n', 'utf8')
    await writeFile(join(root, 'sub', 'b.txt'), 'world\n', 'utf8')
    await writeFile(join(outside, 'secret.txt'), 'top secret\n', 'utf8')

    // 工作区内 → 工作区内的符号链接：必须放行
    try {
      const link = join(root, 'link-inside')
      await symlink(join(root, 'sub'), link, 'junction')
      insideLink = join(link, 'b.txt')
    } catch {
      insideLink = undefined
    }
    // 工作区内 → 工作区外的 junction：必须拒绝（词法闸根本看不出问题）
    try {
      const link = join(root, 'link-escape')
      await symlink(outside, link, 'junction')
      escapeLink = join(link, 'secret.txt')
    } catch {
      escapeLink = undefined
    }
  })

  afterAll(async () => {
    await rm(join(root, '..'), { recursive: true, force: true }).catch(() => {})
  })

  it('工作区内的相对路径 → 正常解析，返回相对路径口径', async () => {
    const resolved = await resolveWorkspaceTarget({ root, raw: 'sub/b.txt' })
    expect(resolved.relative).toBe('sub/b.txt')
  })

  it('绝对路径落在根内 → 放行（大小写不同也算）', async () => {
    const upper = join(root, 'A.TXT')
    const resolved = await resolveWorkspaceTarget({ root, raw: upper })
    expect(resolved.relative.toLowerCase()).toBe('a.txt')
  })

  it('`..` 穿越 → PATH_DENIED（即使最终仍落在根内也拒绝，fail-closed）', async () => {
    await expect(resolveWorkspaceTarget({ root, raw: 'sub/../a.txt' })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
  })

  it('根外绝对路径 → PATH_DENIED', async () => {
    await expect(
      resolveWorkspaceTarget({ root, raw: join(outside, 'secret.txt') })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('工作区内指向工作区内的符号链接 → 放行', async () => {
    if (insideLink === undefined) {
      // Windows 无符号链接权限时跳过（不是产品缺陷）
      expect(insideLink).toBeUndefined()
      return
    }
    const resolved = await resolveWorkspaceTarget({ root, raw: insideLink })
    expect(resolved.relative.replace(/\\/g, '/')).toContain('b.txt')
  })

  it('工作区内指向工作区外的 junction → PATH_DENIED（真实路径闸）', async () => {
    if (escapeLink === undefined) {
      expect(escapeLink).toBeUndefined()
      return
    }
    await expect(resolveWorkspaceTarget({ root, raw: escapeLink })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
  })

  it('不存在的文件：默认 NOT_FOUND；allowMissing 时放行（父目录可信）', async () => {
    await expect(resolveWorkspaceTarget({ root, raw: 'gone.txt' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    const resolved = await resolveWorkspaceTarget({
      root,
      raw: 'gone.txt',
      allowMissing: true
    })
    expect(resolved.relative).toBe('gone.txt')
  })

  it('不存在的文件 + 父目录是逃逸 junction → PATH_DENIED（不因 allowMissing 放宽）', async () => {
    if (escapeLink === undefined) {
      expect(escapeLink).toBeUndefined()
      return
    }
    await expect(
      resolveWorkspaceTarget({
        root,
        raw: join(root, 'link-escape', 'nope.txt'),
        allowMissing: true
      })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('realpath 抛非 ENOENT 错误（EACCES）→ PATH_DENIED（fail-closed）', async () => {
    await expect(
      resolveWorkspaceTarget({
        root: 'C:/work',
        raw: 'C:/work/a.txt',
        platform: 'win32',
        realPath: (value) => {
          if (
            normalizeForCompare(value, 'win32') === normalizeForCompare('C:/work/a.txt', 'win32')
          ) {
            const error = new Error('permission denied') as NodeJS.ErrnoException
            error.code = 'EACCES'
            return Promise.reject(error)
          }
          return Promise.resolve(value)
        }
      })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })
})

describe('resolveInsideAnyRoot：多根白名单', () => {
  let base: string
  let rootA: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'pi-desktop-anyroot-'))
    rootA = join(base, 'a')
    await mkdir(rootA, { recursive: true })
    await writeFile(join(rootA, 'x.txt'), 'x\n', 'utf8')
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  })

  it('绝对路径命中任一白名单根 → 放行', async () => {
    const resolved = await resolveInsideAnyRoot({ roots: [rootA], raw: join(rootA, 'x.txt') })
    expect(resolved.relative).toBe('x.txt')
  })

  it('不在任何根内的绝对路径 → PATH_DENIED', async () => {
    await expect(
      resolveInsideAnyRoot({ roots: [join(base, 'nope')], raw: join(rootA, 'x.txt') })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('没有会话上下文时相对路径直接拒绝（无法确定根）', async () => {
    await expect(resolveInsideAnyRoot({ roots: [rootA], raw: 'x.txt' })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
  })

  it('白名单为空 → 一律拒绝', async () => {
    await expect(
      resolveInsideAnyRoot({ roots: [], raw: join(rootA, 'x.txt') })
    ).rejects.toBeInstanceOf(IpcFailure)
  })
})
