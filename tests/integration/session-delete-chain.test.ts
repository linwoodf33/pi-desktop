import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createRouter } from '../../src/main/ipc/handlers'
import { createAgentCatalog } from '../../src/main/services/agent-catalog'
import { createArtifactsService } from '../../src/main/services/artifacts'
import { createAuditLog } from '../../src/main/services/audit-log'
import { createConfigStore } from '../../src/main/services/config-store'
import { createFsBridge } from '../../src/main/services/fs-bridge'
import { createModelConfigStore } from '../../src/main/services/model-config-store'
import { createPiLocator } from '../../src/main/services/pi-locator'
import { realpathNative } from '../../src/main/services/realpath-native'
import { createSessionDelete } from '../../src/main/services/session-delete'
import { createSessionHistory } from '../../src/main/services/session-history'
import { createSessionIndex, type SessionIndex } from '../../src/main/services/session-index'
import { createSkillCatalog } from '../../src/main/services/skill-catalog'
import { createWorkspaceResolver } from '../../src/main/services/workspace-resolver'
import { IPC_INVOKE_CHANNELS } from '../../src/shared/ipc-channels'

/**
 * I18-a..c：删除会话链路集成测试（A39，§9.2）。
 *
 * 真实要素：真实 IPC 路由（zod + 错误码映射）→ 真实 `SessionIndex.find` →
 * 真实 `SessionDelete` → 真实文件系统；只把「回收站」注入成真实 `unlink`。
 * 覆盖「重启语义」（重建索引实例后仍不可见）与「真实规模分页」（100 条会话）。
 */
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 真实规模的会话（> 64KB 单行记录） */
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

/** 归一到真实长路径（CI 的 TMP 是 8.3 短名） */
async function makeRoot(prefix: string): Promise<string> {
  const root = await realpathNative(await mkdtemp(join(tmpdir(), prefix)))
  dirs.push(root)
  return root
}

/** 写入一条真实会话；`order` 用于让 mtime 严格递增（分页顺序确定） */
async function writeSession(
  root: string,
  group: string,
  id: string,
  order: number
): Promise<string> {
  const groupDir = join(root, group)
  await mkdir(groupDir, { recursive: true })
  const file = join(groupDir, 's.jsonl')
  await writeFile(file, sessionContent(id), 'utf8')
  const at = new Date(Date.UTC(2026, 10, 20) + order * 1000)
  await utimes(file, at, at)
  return file
}

type Dispatch = (
  channel: string,
  payload: unknown
) => Promise<
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; detail?: string } }
>

interface Harness {
  index: SessionIndex
  trashed: string[]
  dispatch: Dispatch
}

function buildHarness(root: string): Harness {
  const index = createSessionIndex({ sessionDir: () => root })
  const trashed: string[] = []
  const sessionDelete = createSessionDelete({
    sessionRoot: () => index.root(),
    findSession: (filePath) => index.find(filePath),
    // 活跃会话留空：活跃拒绝的单测在 session-delete.test.ts（D6），这里只验删除链路
    activeSessionFiles: () => [],
    trash: async (absPath) => {
      trashed.push(absPath)
      await unlink(absPath)
    },
    audit: createAuditLog({ sink: () => {} })
  })

  const sessionService = {
    workspaceOf: () => undefined,
    workspaces: () => [],
    keys: () => [],
    sessionFileOf: () => undefined
  }

  const router = createRouter({
    configStore: createConfigStore(),
    sessionIndex: index,
    piLocator: createPiLocator(),
    // 本用例不碰活跃会话通道；RouterDeps 只要求形状可用
    sessionService: sessionService as never,
    fsBridge: createFsBridge({ showOpenDialog: () => Promise.reject(new Error('不应弹目录')) }),
    sessionHistory: createSessionHistory({ sessionRoot: () => root }),
    artifacts: createArtifactsService({
      resolver: createWorkspaceResolver({
        liveCwd: () => undefined,
        liveCwds: () => [],
        sessionRoot: () => root
      }),
      openPath: () => Promise.resolve(''),
      audit: createAuditLog({ sink: () => {} })
    }),
    modelConfigStore: createModelConfigStore({ agentDir: join(root, '.agent') }),
    agentCatalog: createAgentCatalog({}),
    skillCatalog: createSkillCatalog({}),
    sessionDelete
  })

  return { index, trashed, dispatch: (channel, payload) => router.dispatch(channel, payload) }
}

describe('A39：删除会话链路（真实索引 + 真实文件）', () => {
  it('I18-a：删除后磁盘文件不存在，且新索引实例（模拟重启）不再列出它', async () => {
    const root = await makeRoot('pi-del-chain-')
    const file = await writeSession(root, '--work--', 'sid-a', 0)
    const harness = buildHarness(root)
    // 先取真实长名：删除之后 realpath 会 ENOENT
    const expected = await realpathNative(file)

    const result = await harness.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
      sessionFile: file,
      sessionId: 'sid-a'
    })
    expect(result.ok).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(harness.trashed).toEqual([expected])

    // 重启语义：全新索引实例（没有任何缓存）也看不到这条
    const restarted = createSessionIndex({ sessionDir: () => root })
    expect((await restarted.list({})).items.map((item) => item.id)).not.toContain('sid-a')
  })

  it('I18-b：100 条会话删中间一条后，按 cursor 遍历全量仍得 99 条且无死循环', async () => {
    const root = await makeRoot('pi-del-chain-many-')
    const files: string[] = []
    for (let i = 0; i < 100; i += 1) {
      files.push(await writeSession(root, `--g${i}--`, `sid-${i}`, i))
    }
    const harness = buildHarness(root)

    const deleted = await harness.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
      sessionFile: files[50]!
    })
    expect(deleted.ok).toBe(true)

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      pages += 1
      // 守卫：100 条 / 每页 20 条 = 5 页；超过就是 cursor 死循环
      expect(pages).toBeLessThanOrEqual(10)
      const page = await harness.dispatch(
        IPC_INVOKE_CHANNELS.sessionList,
        cursor === undefined ? {} : { cursor }
      )
      expect(page.ok).toBe(true)
      if (!page.ok) break
      const data = page.data as { items: Array<{ id: string }>; nextCursor?: string }
      seen.push(...data.items.map((item) => item.id))
      cursor = data.nextCursor
    } while (cursor !== undefined)

    expect(seen).toHaveLength(99)
    expect(new Set(seen).size).toBe(99)
    expect(seen).not.toContain('sid-50')
  })

  it('I18-c：经 junction 别名传入 → realpath 归一后删除成功，trash 收到长名', async (ctx) => {
    const root = await makeRoot('pi-del-chain-alias-')
    const file = await writeSession(root, '--real--', 'sid-alias', 0)
    const expected = await realpathNative(file)

    const linkedDir = join(root, '--alias--')
    try {
      await symlink(join(root, '--real--'), linkedDir, 'junction')
    } catch (error) {
      // 与 session-history.test.ts 同口径：无法创建 junction 时**显式 skip**（return 空跑会伪装成绿）
      ctx.skip(`无法创建 junction：${String(error)}`)
      return
    }

    const harness = buildHarness(root)
    const result = await harness.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
      sessionFile: join(linkedDir, 's.jsonl')
    })
    expect(result.ok).toBe(true)
    expect(harness.trashed).toEqual([expected])
    expect(existsSync(file)).toBe(false)
  })
})
