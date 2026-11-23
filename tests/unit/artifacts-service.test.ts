import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createArtifactsService,
  MAX_ARTIFACT_ENTRIES,
  MAX_PREVIEW_BYTES
} from '../../src/main/services/artifacts'
import { createAuditLog, type AuditEntry } from '../../src/main/services/audit-log'
import type { GitRunner } from '../../src/main/services/git-adapter'
import type { WorkspaceResolver } from '../../src/main/services/workspace-resolver'

/**
 * 产物服务（M6）：列表 / diff / 预览 / 系统程序打开四条通道的业务分支。
 *
 * 用真实临时目录（真实 fs），只把「git 执行器」和「openPath」注入成假实现，
 * 这样既覆盖真实 IO，又能在 CI 上确定性地验证失败路径（git 不存在、外部程序报错）。
 */

/** 让 `git` 一律失败 → 强制走非 git 回退链路 */
const noGit: GitRunner = () =>
  Promise.resolve({ code: 127, stdout: Buffer.alloc(0), stderr: 'not a git repository' })

function resolverFor(root: string, extraRoots: string[] = []): WorkspaceResolver {
  return {
    resolve: (ref) => {
      if (ref.sessionKey === 'live')
        return Promise.resolve({ root, source: { kind: 'session', id: 'live' } })
      return Promise.reject(
        Object.assign(new Error('会话未在运行'), { code: 'SESSION_NOT_FOUND', name: 'IpcFailure' })
      )
    },
    knownRoots: () => Promise.resolve([root, ...extraRoots]),
    remember: () => undefined
  }
}

interface Harness {
  service: ReturnType<typeof createArtifactsService>
  audit: AuditEntry[]
  opened: string[]
}

function createHarness(
  root: string,
  overrides: {
    openPath?: (path: string) => Promise<string>
    runGit?: GitRunner
    maxEntries?: number
  } = {}
): Harness {
  const audit: AuditEntry[] = []
  const opened: string[] = []
  const service = createArtifactsService({
    resolver: resolverFor(root),
    runGit: overrides.runGit ?? noGit,
    openPath:
      overrides.openPath ??
      ((path) => {
        opened.push(path)
        return Promise.resolve('')
      }),
    audit: createAuditLog({ sink: (entry) => audit.push(entry) }),
    ...(overrides.maxEntries === undefined ? {} : { limits: { maxEntries: overrides.maxEntries } })
  })
  return { service, audit, opened }
}

describe('产物列表（非 git → 快照比对）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-artifacts-'))
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'keep.txt'), 'keep\n', 'utf8')
    await writeFile(join(root, 'mod.txt'), 'v1\n', 'utf8')
    await writeFile(join(root, 'gone.txt'), 'bye\n', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('会话开始时建立快照 → 之后的新增/修改/删除都能列出，并说明「非 git 工作区，快照比对」', async () => {
    const { service } = createHarness(root)
    service.onSessionStarted('live')
    // onSessionStarted 是刻意异步的（不阻塞会话创建），等快照落位
    await new Promise((resolve) => setTimeout(resolve, 200))

    await writeFile(join(root, 'mod.txt'), 'v2\n', 'utf8')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'added.txt'), 'new\n', 'utf8')

    const list = await service.list({ sessionKey: 'live' })
    expect(list.mode).toBe('snapshot')
    expect(list.items.map((item) => [item.path, item.change])).toEqual([
      ['added.txt', 'added'],
      ['gone.txt', 'deleted'],
      ['mod.txt', 'modified']
    ])
    expect(list.note).toContain('快照比对')
    expect(list.truncated).toBe(false)
  })

  it('没有会话开始快照时补建，并显式说明「此前的变更不可见」', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'pi-desktop-artifacts-fresh-'))
    try {
      await writeFile(join(fresh, 'pre.txt'), 'pre\n', 'utf8')
      const { service } = createHarness(fresh)
      const list = await service.list({ sessionKey: 'live' })
      expect(list.items).toEqual([])
      expect(list.note).toContain('快照在本次扫描时建立')
    } finally {
      await rm(fresh, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('条目数超上限 → truncated + totalCount（不静默）', async () => {
    const many = await mkdtemp(join(tmpdir(), 'pi-desktop-artifacts-many-'))
    try {
      const { service } = createHarness(many, { maxEntries: 2 })
      service.onSessionStarted('live')
      await new Promise((resolve) => setTimeout(resolve, 200))
      for (let index = 0; index < 5; index += 1) {
        await writeFile(join(many, `f${index}.txt`), `${index}\n`, 'utf8')
      }
      const list = await service.list({ sessionKey: 'live' })
      expect(list.items).toHaveLength(2)
      expect(list.totalCount).toBe(5)
      expect(list.truncated).toBe(true)
    } finally {
      await rm(many, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('未注册的 sessionKey → SESSION_NOT_FOUND（可操作提示，不扫盘）', async () => {
    const { service } = createHarness(root)
    await expect(service.list({ sessionKey: 'nope' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })

  it('默认上限常量为 1000', () => {
    expect(MAX_ARTIFACT_ENTRIES).toBe(1000)
  })
})

describe('diff（非 git → 快照合成）', () => {
  let root: string
  let service: ReturnType<typeof createArtifactsService>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-diff-'))
    await writeFile(join(root, 'mod.txt'), 'one\ntwo\n', 'utf8')
    await writeFile(join(root, 'gone.txt'), 'bye\n', 'utf8')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    service = createHarness(root).service
    service.onSessionStarted('live')
    await new Promise((resolve) => setTimeout(resolve, 200))

    await writeFile(join(root, 'mod.txt'), 'one\nTWO\n', 'utf8')
    await rm(join(root, 'gone.txt'))
    await writeFile(join(root, 'added.txt'), 'hello\nworld\n', 'utf8')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 9, 9, 9]))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('修改：生成 hunk，含 -/+ 行', async () => {
    const diff = await service.diff({ sessionKey: 'live', path: 'mod.txt' })
    expect(diff.mode).toBe('snapshot')
    expect(diff.change).toBe('modified')
    expect(diff.patch).toContain('-two')
    expect(diff.patch).toContain('+TWO')
    expect(diff.truncated).toBe(false)
  })

  it('新增：new file + /dev/null', async () => {
    const diff = await service.diff({ sessionKey: 'live', path: 'added.txt' })
    expect(diff.change).toBe('added')
    expect(diff.patch).toContain('new file')
    expect(diff.patch).toContain('+hello')
  })

  it('删除：deleted file（文件已不存在但仍能出 diff）', async () => {
    const diff = await service.diff({ sessionKey: 'live', path: 'gone.txt' })
    expect(diff.change).toBe('deleted')
    expect(diff.patch).toContain('deleted file')
    expect(diff.patch).toContain('-bye')
  })

  it('二进制：不渲染补丁，显式标注', async () => {
    const diff = await service.diff({ sessionKey: 'live', path: 'blob.bin' })
    expect(diff.binary).toBe(true)
    expect(diff.patch).toBe('')
    expect(diff.note).toContain('二进制')
  })

  it('内容与快照一致 → 空补丁 + 「没有内容变化」说明（而不是谎报修改）', async () => {
    const quiet = await mkdtemp(join(tmpdir(), 'pi-desktop-diff-quiet-'))
    try {
      await writeFile(join(quiet, 'same.txt'), 'same\n', 'utf8')
      const quietService = createHarness(quiet).service
      quietService.onSessionStarted('live')
      await new Promise((resolve) => setTimeout(resolve, 200))

      const diff = await quietService.diff({ sessionKey: 'live', path: 'same.txt' })
      expect(diff.patch).toBe('')
      expect(diff.note).toContain('没有内容变化')
    } finally {
      await rm(quiet, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('路径逃逸 → PATH_DENIED（diff 通道也走同一校验器）', async () => {
    await expect(
      service.diff({ sessionKey: 'live', path: '../outside.txt' })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })
})

describe('fs:readText（预览）', () => {
  let root: string
  let service: ReturnType<typeof createArtifactsService>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-read-'))
    await writeFile(join(root, 'a.txt'), 'a'.repeat(1000), 'utf8')
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    service = createHarness(root).service
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('默认读取前 1000 字节，超过 maxBytes 时 truncated', async () => {
    const result = await service.readText({ sessionKey: 'live', path: 'a.txt', maxBytes: 100 })
    expect(result.text).toHaveLength(100)
    expect(result.truncated).toBe(true)
    expect(result.sizeBytes).toBe(1000)
    expect(result.binary).toBe(false)
  })

  it('offset 分页', async () => {
    const result = await service.readText({
      sessionKey: 'live',
      path: 'a.txt',
      maxBytes: 50,
      offset: 950
    })
    expect(result.offset).toBe(950)
    expect(result.truncated).toBe(false)
    expect(result.text).toHaveLength(50)
  })

  it('二进制文件返回 binary:true 且不返回内容（不渲染乱码）', async () => {
    const result = await service.readText({ sessionKey: 'live', path: 'blob.bin' })
    expect(result.binary).toBe(true)
    expect(result.text).toBe('')
  })

  it('maxBytes 被服务端再次夹到 64KB 上限', async () => {
    const result = await service.readText({
      sessionKey: 'live',
      path: 'a.txt',
      maxBytes: MAX_PREVIEW_BYTES * 4
    })
    // 文件本身只有 1000 字节，因此只验证不越界读取
    expect(result.sizeBytes).toBe(1000)
  })

  it('绝对路径 + 无会话引用：落在已知工作区内才放行', async () => {
    const ok = await service.readText({ path: join(root, 'a.txt'), maxBytes: 10 })
    expect(ok.text).toHaveLength(10)

    const outside = join(tmpdir(), 'pi-desktop-not-a-workspace.txt')
    await writeFile(outside, 'x', 'utf8')
    await expect(service.readText({ path: outside, maxBytes: 10 })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    await rm(outside, { force: true }).catch(() => {})
  })

  it('文件不存在 → NOT_FOUND', async () => {
    await expect(
      service.readText({ sessionKey: 'live', path: 'missing.txt' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  /**
   * 收口债 #5：分页切点落在多字节字符中间时的容忍策略。
   *
   * 旧行为：`TextDecoder(fatal:true)` 失败 → 当二进制 → `text:''`（整段不显示）。
   * 新行为：只在**末尾回退 1..3 字节**能解开时按截断容忍（丢半个字，不渲染乱码）；
   * 中段非法字节仍当二进制。
   */
  it('maxBytes 切在多字节字符中间 → 仍按文本返回（丢半个字，不误判二进制）', async () => {
    // `中文` = 6 字节；maxBytes=4 会切在第二个字（3 字节）的中间
    const path = join(root, 'cjk.txt')
    await writeFile(path, '中文ab', 'utf8')

    const result = await service.readText({ sessionKey: 'live', path, maxBytes: 4 })
    expect(result.binary).toBe(false)
    expect(result.text).toBe('中')
    expect(result.text).not.toContain('\uFFFD')
    expect(result.truncated).toBe(true)
  })

  it('emoji（4 字节）跨边界 → 按码点边界回退，不产生替换字符', async () => {
    // `😀` 占 4 字节（F0 9F 98 80）；maxBytes=2 会把 4 字节序列切成「声明 4 字节但只有 2 字节」
    const path = join(root, 'emoji.txt')
    await writeFile(path, '😀ab', 'utf8')

    const cutInside = await service.readText({ sessionKey: 'live', path, maxBytes: 2 })
    expect(cutInside.binary).toBe(false)
    expect(cutInside.text).toBe('')
    expect(cutInside.text).not.toContain('�')
    expect(cutInside.truncated).toBe(true)

    // 5 字节 = 完整 emoji + 'a'：整字符保留，只丢半个「不存在的下一个字符」
    const cutAfterA = await service.readText({ sessionKey: 'live', path, maxBytes: 5 })
    expect(cutAfterA.binary).toBe(false)
    expect(cutAfterA.text).toBe('😀a')
    expect(cutAfterA.text).not.toContain('�')
  })

  it('中段出现非法 UTF-8 字节 → 仍判二进制（容忍不放宽到脏文本）', async () => {
    const path = join(root, 'dirty.txt')
    // 合法前缀 `中` + 非法字节 0xff（非 NUL，因此不会被 NUL 启发式提前拦住）
    await writeFile(path, Buffer.from([0xe4, 0xb8, 0xad, 0xff, 0x61, 0x62]))

    const result = await service.readText({ sessionKey: 'live', path, maxBytes: 100 })
    expect(result.binary).toBe(true)
    expect(result.text).toBe('')
  })
})

describe('artifact:open（系统程序打开）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-open-'))
    await writeFile(join(root, 'a.txt'), 'hello\n', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('校验通过 → 调用 openPath 并记录审计（无内容）', async () => {
    const harness = createHarness(root)
    await harness.service.open({ sessionKey: 'live', path: 'a.txt' })
    expect(harness.opened).toHaveLength(1)
    expect(harness.opened[0]).toContain('a.txt')
    expect(harness.audit).toEqual([
      expect.objectContaining({ action: 'artifact:open', outcome: 'opened', target: 'a.txt' })
    ])
  })

  it('越权路径 → PATH_DENIED + 审计 denied（不到达外部程序）', async () => {
    const harness = createHarness(root)
    await expect(
      harness.service.open({ sessionKey: 'live', path: '../../etc/passwd' })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
    expect(harness.opened).toHaveLength(0)
    expect(harness.audit[0]).toMatchObject({ outcome: 'denied', code: 'PATH_DENIED' })
  })

  it('文件不存在 → NOT_FOUND，不调外部程序', async () => {
    const harness = createHarness(root)
    await expect(
      harness.service.open({ sessionKey: 'live', path: 'nope.txt' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(harness.opened).toHaveLength(0)
  })

  it('openPath 返回错误串 → OPEN_FAILED（可操作错误 + 审计 failed）', async () => {
    const harness = createHarness(root, {
      openPath: () => Promise.resolve('没有可用的应用程序打开该文件')
    })
    await expect(harness.service.open({ sessionKey: 'live', path: 'a.txt' })).rejects.toMatchObject(
      { code: 'OPEN_FAILED' }
    )
    expect(harness.audit[0]).toMatchObject({ outcome: 'failed', code: 'OPEN_FAILED' })
  })
})

describe('git 模式（注入假 git）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-artifacts-git-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('detect 命中 git → 列表 mode=git，diff 走 git 输出', async () => {
    const patch = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n'
    const runGit: GitRunner = (args) => {
      if (args.includes('--show-toplevel')) {
        return Promise.resolve({ code: 0, stdout: Buffer.from(`${root}\n`), stderr: '' })
      }
      if (args.includes('status')) {
        return Promise.resolve({ code: 0, stdout: Buffer.from(' M x.txt\0', 'utf8'), stderr: '' })
      }
      return Promise.resolve({ code: 0, stdout: Buffer.from(patch), stderr: '' })
    }
    const { service } = createHarness(root, { runGit })
    const list = await service.list({ sessionKey: 'live' })
    expect(list.mode).toBe('git')
    expect(list.items).toEqual([{ path: 'x.txt', change: 'modified' }])

    const diff = await service.diff({ sessionKey: 'live', path: 'x.txt' })
    expect(diff.mode).toBe('git')
    expect(diff.patch).toContain('+b')
  })
})
