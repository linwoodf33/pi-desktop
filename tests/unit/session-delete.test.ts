import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createAuditLog, type AuditEntry } from '../../src/main/services/audit-log'
import { realpathNative } from '../../src/main/services/realpath-native'
import { createSessionDelete } from '../../src/main/services/session-delete'
import { createSessionIndex } from '../../src/main/services/session-index'

/**
 * D1–D12：删除本地会话（A39）。
 *
 * 夹具基座一律是**真实临时文件**：目录布局 `<root>/--work--/s.jsonl`，
 * 内容 = header + 一条 **> 64KB 的单行**用户消息（保证真的走 `size > headBytes` 分支，
 * 任何「readHead 返回整文件」式 fake 都会让这些用例失去意义）。
 * 只注入 `trash`（spy + 真实 unlink）/ `realPath` / `lstat`（均为「外部世界」）。
 */
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 一条真实的 > 64KB 单行会话（头部 + 一条约 75KB 的用户消息） */
function sessionContent(id: string, cwd = 'C:/work'): string {
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-11-20T00:00:00.000Z',
    cwd
  })
  const big = JSON.stringify({
    type: 'message',
    id: 'b1',
    parentId: null,
    timestamp: '2026-11-20T00:00:02.000Z',
    message: { role: 'user', content: `首条消息${'填'.repeat(25_000)}`, timestamp: 1 }
  })
  return `${header}\n${big}\n`
}

/** 归一到真实长路径：CI 的 TMP 是 8.3 短名，不归一会假红 */
async function makeRoot(prefix = 'pi-del-'): Promise<string> {
  const root = await realpathNative(await mkdtemp(join(tmpdir(), prefix)))
  dirs.push(root)
  return root
}

async function makeSession(root: string, id = 'sid-1', group = '--work--'): Promise<string> {
  const groupDir = join(root, group)
  await mkdir(groupDir, { recursive: true })
  const file = join(groupDir, 's.jsonl')
  await writeFile(file, sessionContent(id), 'utf8')
  return file
}

interface HarnessOptions {
  activeSessionFiles?: () => readonly string[]
  trash?: (absPath: string) => Promise<void>
  realPath?: (value: string) => Promise<string>
  lstat?: (value: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean }>
}

function harness(root: string, options: HarnessOptions = {}) {
  const trashed: string[] = []
  const audit: AuditEntry[] = []
  const index = createSessionIndex({ sessionDir: () => root })
  const service = createSessionDelete({
    sessionRoot: () => index.root(),
    findSession: (filePath) => index.find(filePath),
    activeSessionFiles: options.activeSessionFiles ?? (() => []),
    trash:
      options.trash ??
      ((absPath) => {
        trashed.push(absPath)
        return unlink(absPath)
      }),
    audit: createAuditLog({ sink: (entry) => audit.push(entry) }),
    ...(options.realPath === undefined ? {} : { realPath: options.realPath }),
    ...(options.lstat === undefined ? {} : { lstat: options.lstat })
  })
  return { service, index, trashed, audit }
}

describe('SessionDelete：判定顺序与安全闸（A39）', () => {
  it('D1：正常删除 → 移到回收站、文件消失、审计只含会话 id', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const { service, trashed, audit } = harness(root)

    // 先取真实长名：删除之后就 realpath 不出来了（这正是「已删除」的证据）
    const realFile = await realpathNative(file)
    const result = await service.remove({ sessionFile: file, sessionId: 'sid-1' })

    expect(result).toEqual({ id: 'sid-1', filePath: realFile })
    expect(trashed).toEqual([realFile])
    expect(existsSync(file)).toBe(false)

    expect(audit).toHaveLength(1)
    const entry = audit[0]!
    expect(entry).toMatchObject({ action: 'session:delete', outcome: 'deleted', target: 'sid-1' })
    // 审计里绝不能出现绝对路径（§7 约束 9）
    expect(entry.target).not.toMatch(/[\\/:]/)
  })

  it('D2：会话根之外的文件 → PATH_DENIED，文件仍在，trash 未被调用', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'pi-del-outside-'))
    dirs.push(outside)
    const outsideFile = join(outside, 'x.jsonl')
    await writeFile(outsideFile, sessionContent('sid-outside'), 'utf8')

    const { service, trashed } = harness(root)
    await expect(service.remove({ sessionFile: outsideFile })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(existsSync(outsideFile)).toBe(true)
    expect(trashed).toEqual([])
  })

  it('D3：深度不是恰好 2（根下 / 再嵌一层）→ PATH_DENIED', async () => {
    const root = await makeRoot()
    const loose = join(root, 'loose.jsonl')
    await writeFile(loose, sessionContent('sid-loose'), 'utf8')
    const nestedDir = join(root, '--g--', 'nested')
    await mkdir(nestedDir, { recursive: true })
    const nested = join(nestedDir, 'x.jsonl')
    await writeFile(nested, sessionContent('sid-nested'), 'utf8')

    const { service, trashed } = harness(root)
    await expect(service.remove({ sessionFile: loose })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    await expect(service.remove({ sessionFile: nested })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(trashed).toEqual([])
    expect(existsSync(loose)).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  it('D4：布局对但解析不出会话（无 header）→ PATH_DENIED', async () => {
    const root = await makeRoot()
    const group = join(root, '--g--')
    await mkdir(group, { recursive: true })
    const file = join(group, 'not-a-session.jsonl')
    await writeFile(file, 'not json\n', 'utf8')

    const { service, trashed } = harness(root)
    await expect(service.remove({ sessionFile: file })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(trashed).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('D5：不存在的路径 → NOT_FOUND，trash 未被调用、无审计', async () => {
    const root = await makeRoot()
    const missing = join(root, '--work--', 'missing.jsonl')
    const { service, trashed, audit } = harness(root)

    await expect(service.remove({ sessionFile: missing })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(trashed).toEqual([])
    expect(audit).toEqual([])
  })

  it('D6：活跃会话持有同一文件（分隔符/大小写变体）→ SESSION_BUSY，文件仍在', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const variants =
      process.platform === 'win32' ? [file, file.replace(/\\/g, '/'), file.toUpperCase()] : [file]

    for (const variant of variants) {
      const { service, trashed, audit } = harness(root, {
        activeSessionFiles: () => [variant]
      })
      await expect(service.remove({ sessionFile: file })).rejects.toMatchObject({
        code: 'SESSION_BUSY'
      })
      expect(trashed).toEqual([])
      expect(audit[0]).toMatchObject({ outcome: 'denied', code: 'SESSION_BUSY' })
    }
    expect(existsSync(file)).toBe(true)
  })

  it('D7：8.3 短名 → 长名（注入 realPath，复刻 CI 的 RUNNER~1 形状）', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const realFile = await realpathNative(file)
    // 短名形态的入参（实际不存在，由注入的 realPath 归一成长名）
    const shortName = join(root, '--WORK~1--', 'S~1.JSONL')
    const { service, trashed } = harness(root, {
      realPath: (value) => Promise.resolve(value === resolve(shortName) ? realFile : value)
    })

    const result = await service.remove({ sessionFile: shortName })
    expect(result).toEqual({ id: 'sid-1', filePath: realFile })
    expect(trashed).toEqual([realFile])
    expect(existsSync(file)).toBe(false)
  })

  it('D8：sessionId 与文件当前会话不一致 → NOT_FOUND，文件仍在', async () => {
    const root = await makeRoot()
    const file = await makeSession(root, 'sid-1')
    const { service, trashed } = harness(root)

    await expect(service.remove({ sessionFile: file, sessionId: 'other' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('刷新')
    })
    expect(trashed).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('D9：回收站失败 → DELETE_FAILED，文件仍在，审计记 failed + 系统错误码', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const { service, audit } = harness(root, {
      trash: () =>
        Promise.reject(
          Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        )
    })

    await expect(service.remove({ sessionFile: file })).rejects.toMatchObject({
      code: 'DELETE_FAILED',
      detail: 'EPERM'
    })
    // 绝不降级为永久删除
    expect(existsSync(file)).toBe(true)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ outcome: 'failed', code: 'EPERM', target: 'sid-1' })
  })

  it('D10：lstat 报告符号链接 → PATH_DENIED', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const { service, trashed } = harness(root, {
      lstat: () => Promise.resolve({ isFile: () => true, isSymbolicLink: () => true })
    })

    await expect(service.remove({ sessionFile: file })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(trashed).toEqual([])
    expect(existsSync(file)).toBe(true)
  })

  it('D11：分组目录是真实 junction 指向根外 → PATH_DENIED', async (ctx) => {
    const root = await makeRoot()
    const outsideDir = await mkdtemp(join(tmpdir(), 'pi-del-link-out-'))
    dirs.push(outsideDir)
    const outsideFile = join(outsideDir, 'redirected.jsonl')
    await writeFile(outsideFile, sessionContent('sid-redirected'), 'utf8')

    const linkedDir = join(root, '--linked--')
    try {
      await symlink(outsideDir, linkedDir, 'junction')
    } catch (error) {
      // Windows 无权限创建 junction（或平台不支持）：**显式 skip**，不能靠 return 空跑通过
      // （空跑会伪装成「已覆盖 junction 逃逸」的绿）。
      ctx.skip(`无法创建 junction：${String(error)}`)
      return
    }

    const linkedFile = join(linkedDir, 'redirected.jsonl')
    const { service, trashed } = harness(root)
    await expect(service.remove({ sessionFile: linkedFile })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(trashed).toEqual([])
    expect(existsSync(outsideFile)).toBe(true)
  })

  it('D12：连续删两次 → 第一次成功、第二次 NOT_FOUND（幂等契约）', async () => {
    const root = await makeRoot()
    const file = await makeSession(root)
    const { service, audit } = harness(root)

    const first = await service.remove({ sessionFile: file })
    expect(first.id).toBe('sid-1')
    await expect(service.remove({ sessionFile: file })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    // 只有第一次记了 deleted
    expect(audit.filter((entry) => entry.outcome === 'deleted')).toHaveLength(1)
  })
})
