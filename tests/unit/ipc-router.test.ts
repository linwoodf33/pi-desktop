import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { IpcRouter } from '../../src/main/ipc/router'
import { createRouter } from '../../src/main/ipc/handlers'
import { createArtifactsService } from '../../src/main/services/artifacts'
import { createAuditLog } from '../../src/main/services/audit-log'
import { createConfigStore } from '../../src/main/services/config-store'
import { createAgentCatalog } from '../../src/main/services/agent-catalog'
import { createSkillCatalog } from '../../src/main/services/skill-catalog'
import { createModelConfigStore } from '../../src/main/services/model-config-store'
import { createFsBridge, type FsBridge } from '../../src/main/services/fs-bridge'
import { createPiLocator } from '../../src/main/services/pi-locator'
import { createSessionHistory } from '../../src/main/services/session-history'
import { createSessionDelete, type SessionDelete } from '../../src/main/services/session-delete'
import { createSessionIndex, type SessionIndex } from '../../src/main/services/session-index'
import type { SessionService } from '../../src/main/services/session-service'
import { realpathNative } from '../../src/main/services/realpath-native'
import { createWorkspaceResolver } from '../../src/main/services/workspace-resolver'
import { IPC_INVOKE_CHANNELS, type InvokeChannel } from '../../src/shared/ipc-channels'
import { IpcFailure } from '../../src/shared/contracts/result'

/** 只用于装配：默认所有方法都「不应被调用」，各用例按需覆盖 */
function stubSessionService(overrides: Partial<SessionService> = {}): SessionService {
  const unexpected = (): Promise<never> => Promise.reject(new Error('该会话方法不应被调用'))
  return {
    create: unexpected,
    resume: unexpected,
    fork: unexpected,
    prompt: unexpected,
    abort: unexpected,
    dispose: unexpected,
    state: unexpected,
    stats: unexpected,
    forkPoints: unexpected,
    listModels: unexpected,
    setModel: unexpected,
    setName: unexpected,
    respondExtUi: unexpected,
    keys: () => [],
    workspaceOf: () => undefined,
    sessionFileOf: () => undefined,
    workspaces: () => [],
    disposeAll: () => Promise.resolve(),
    ...overrides
  }
}

function buildRouter(
  overrides: Partial<SessionService> = {},
  timeouts?: Partial<Record<InvokeChannel, number>>,
  fsBridgeOverride?: FsBridge,
  sessionIndexOverride?: SessionIndex,
  sessionDeleteOverride?: SessionDelete
): IpcRouter {
  const sessionService = stubSessionService(overrides)
  return createRouter(
    {
      configStore: createConfigStore(),
      // 用不存在的会话目录：保持列表为空，避免依赖开发者本机会话
      sessionIndex:
        sessionIndexOverride ??
        createSessionIndex({ sessionDir: () => 'C:/nonexistent-pi-sessions' }),
      piLocator: createPiLocator(),
      sessionService,
      // M3 新增通道：目录对话框与历史回放（默认不应被调用，需要时在用例里覆盖）
      fsBridge:
        fsBridgeOverride ??
        createFsBridge({ showOpenDialog: () => Promise.reject(new Error('不应弹目录')) }),
      sessionHistory: createSessionHistory({
        sessionRoot: () => 'C:/nonexistent-pi-sessions'
      }),
      // M6 产物层：无活跃会话（workspaceOf 返回 undefined）→ 任何路径都会被拒
      // A14：模型管理通道（默认不调用；指向不存在的 agent 目录，避免读写开发者真配置）
      modelConfigStore: createModelConfigStore({ agentDir: 'C:/nonexistent-pi-agent' }),
      // A18：agent 目录（默认不调用；无 pi 启动规格 → supportsAgentFlag=false）
      agentCatalog: createAgentCatalog({}),
      // A31：技能清单（只读；默认不调用）
      skillCatalog: createSkillCatalog({}),
      artifacts: createArtifactsService({
        resolver: createWorkspaceResolver({
          liveCwd: (sessionKey) => sessionService.workspaceOf(sessionKey),
          liveCwds: () => sessionService.workspaces(),
          sessionRoot: () => 'C:/nonexistent-pi-sessions'
        }),
        openPath: () => Promise.resolve(''),
        audit: createAuditLog({ sink: () => {} })
      }),
      // A39：`sessionDelete` 在 RouterDeps 里是必填（破坏性通道，缺依赖不能静默成功）。
      // 默认给一个「被调用即失败」的桩，需要真实链路的用例从第 5 个参数传进来，
      // 这样既有 4 参调用（以及所有不碰删除的用例）一行都不用改。
      sessionDelete: sessionDeleteOverride ?? {
        remove: () => Promise.reject(new Error('该会话删除方法不应被调用'))
      }
    },
    undefined,
    timeouts
  )
}

describe('IpcRouter.dispatch 管线', () => {
  it('实现了的通道返回 ok(data)', async () => {
    const result = await buildRouter().dispatch(IPC_INVOKE_CHANNELS.appGetBoot, {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data as { config: { maxActiveSessions: number } }
    expect(data.config.maxActiveSessions).toBe(3)
  })

  it('session:list 在无会话目录时返回空列表且带 items 字段', async () => {
    const result = await buildRouter().dispatch(IPC_INVOKE_CHANNELS.sessionList, {})
    expect(result).toEqual({ ok: true, data: { items: [] } })
  })

  it('入参类型错误 → VALIDATION，且不进入业务层（U8）', async () => {
    const handler = vi.fn(() => Promise.resolve('should-not-run'))
    const router = new IpcRouter({
      handlers: { [IPC_INVOKE_CHANNELS.sessionList]: handler }
    })

    const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionList, { cwd: 42 })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION')
    expect(result.error.detail).toContain('cwd')
    expect(handler).not.toHaveBeenCalled()
  })

  it('多余字段被 strict schema 拒绝 → VALIDATION', async () => {
    const result = await buildRouter().dispatch(IPC_INVOKE_CHANNELS.appGetBoot, {
      unexpected: true
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION')
  })

  it('缺失必填字段 → VALIDATION', async () => {
    const result = await buildRouter().dispatch(IPC_INVOKE_CHANNELS.sessionCreate, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION')
  })

  it('白名单内但未实现的通道 → NOT_IMPLEMENTED（与未注册通道可区分）', async () => {
    // M6 起全部白名单通道都有处理器；这个分支仍需可测（将来新增通道时先占位）。
    // 直接构造 IpcRouter（不走 createRouter）以保留「部分处理器」场景。
    const router = new IpcRouter({ handlers: {} })
    const result = await router.dispatch(IPC_INVOKE_CHANNELS.fsReadText, {
      path: 'a.txt',
      maxBytes: 1024
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('NOT_IMPLEMENTED')
  })

  it('未注册通道一律拒绝 → UNKNOWN_CHANNEL（S2）', async () => {
    const router = buildRouter()
    for (const channel of ['fs:evil', 'app:getBoot:extra', 'ipc:internal', '']) {
      const result = await router.dispatch(channel, {})
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('UNKNOWN_CHANNEL')
      expect(result.error.message).toContain('未注册')
    }
  })

  it('session:create 校验通过后调用 SessionService.create', async () => {
    const create = vi.fn(() => Promise.resolve({ sessionKey: 's1', sessionId: 'pi-1' }))
    const result = await buildRouter({ create }).dispatch(IPC_INVOKE_CHANNELS.sessionCreate, {
      cwd: 'C:/work',
      name: '任务一'
    })

    expect(result).toEqual({ ok: true, data: { sessionKey: 's1', sessionId: 'pi-1' } })
    expect(create).toHaveBeenCalledWith({ cwd: 'C:/work', name: '任务一' })
  })

  it('session:prompt 的 streamingBehavior 原样透传给 SessionService', async () => {
    const prompt = vi.fn(() => Promise.resolve({ disposition: 'queued' as const }))
    const router = buildRouter({ prompt })

    await router.dispatch(IPC_INVOKE_CHANNELS.sessionPrompt, {
      sessionKey: 's1',
      message: '排队',
      streamingBehavior: 'followUp'
    })

    expect(prompt).toHaveBeenCalledWith({
      sessionKey: 's1',
      message: '排队',
      streamingBehavior: 'followUp'
    })
  })

  it('坏参数在进入 SessionService 之前就被拦下（SESSION_BUSY 之外的防线）', async () => {
    const prompt = vi.fn(() => Promise.resolve({ disposition: 'started' as const }))
    const result = await buildRouter({ prompt }).dispatch(IPC_INVOKE_CHANNELS.sessionPrompt, {
      sessionKey: 's1',
      message: '',
      streamingBehavior: 'steer'
    })

    expect(result.ok).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('通道级超时（§7 约束 13）：处理器迟迟不返回 → TIMEOUT', async () => {
    const router = buildRouter(
      { state: () => new Promise(() => {}) },
      { [IPC_INVOKE_CHANNELS.sessionState]: 10 }
    )

    const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionState, { sessionKey: 's1' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('TIMEOUT')
    expect(result.error.detail).toContain('timeoutMs=10')
  })

  it('未配置超时的通道不受影响（prompt 走事件流，不设总超时）', async () => {
    const prompt = vi.fn(() => Promise.resolve({ disposition: 'started' as const }))
    const result = await buildRouter({ prompt }).dispatch(IPC_INVOKE_CHANNELS.sessionPrompt, {
      sessionKey: 's1',
      message: 'hi'
    })
    expect(result.ok).toBe(true)
  })

  it('处理器抛 IpcFailure → 保留错误码，不变成 INTERNAL', async () => {
    const router = new IpcRouter({
      handlers: {
        [IPC_INVOKE_CHANNELS.appGetBoot]: () => {
          throw new IpcFailure('PI_NOT_FOUND', 'PATH 中找不到 pi')
        }
      }
    })

    const result = await router.dispatch(IPC_INVOKE_CHANNELS.appGetBoot, {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PI_NOT_FOUND')
  })

  it('处理器抛普通异常 → INTERNAL，并上报 onError（不外抛）', async () => {
    const onError = vi.fn()
    const router = new IpcRouter({
      handlers: {
        [IPC_INVOKE_CHANNELS.sessionList]: () => {
          throw new Error('索引读取失败')
        }
      },
      onError
    })

    const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionList, {})
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: '索引读取失败' } })
    expect(onError).toHaveBeenCalledWith(IPC_INVOKE_CHANNELS.sessionList, expect.any(Error))
  })
})

describe('IpcRouter.registerAll', () => {
  it('只在 ipcMain 上注册白名单通道，且各自绑定固定通道', async () => {
    const registered = new Map<string, (event: never, payload: unknown) => Promise<unknown>>()
    const fakeIpcMain = {
      handle: (channel: string, listener: (event: never, payload: unknown) => Promise<unknown>) => {
        registered.set(channel, listener)
      }
    }

    buildRouter().registerAll(fakeIpcMain)

    // 注册面 == 白名单，不多不少
    expect([...registered.keys()].sort()).toEqual(Object.values(IPC_INVOKE_CHANNELS).slice().sort())

    const listener = registered.get(IPC_INVOKE_CHANNELS.appGetBoot)
    expect(listener).toBeTypeOf('function')
    const viaListener = await listener!(null as never, {})
    expect(viaListener).toMatchObject({ ok: true })

    // 通过监听器调用时同样做校验
    const invalid = await registered.get(IPC_INVOKE_CHANNELS.sessionList)!(null as never, {
      cursor: 1
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
  })
})

describe('A22：引用工作区文件', () => {
  it('选到工作区外 → VALIDATION（边界必须由主进程判定）', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'pi-outside-'))
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'secret', 'utf8')

    try {
      const fsBridge: FsBridge = {
        pickDirectory: () => Promise.resolve({ path: workspace }),
        pickFile: () => Promise.resolve({ canceled: false, path: outsideFile })
      }
      const router = buildRouter(
        { workspaceOf: (sessionKey: string) => (sessionKey === 'k1' ? workspace : undefined) },
        undefined,
        fsBridge
      )

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.fsPickWorkspaceFile, {
        sessionKey: 'k1'
      })
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION')
        expect(result.error.message).toContain('工作区内')
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('工作区内 → 返回 POSIX 相对路径；取消不算错误', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pi-ws-'))
    const file = join(workspace, 'src', 'main.ts')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(file, '// x', 'utf8')

    try {
      const fsBridge: FsBridge = {
        pickDirectory: () => Promise.resolve({ path: workspace }),
        pickFile: () => Promise.resolve({ canceled: false, path: file })
      }
      const router = buildRouter({ workspaceOf: () => workspace }, undefined, fsBridge)

      const ok = await router.dispatch(IPC_INVOKE_CHANNELS.fsPickWorkspaceFile, {
        sessionKey: 'k1'
      })
      expect(ok).toMatchObject({ ok: true })
      if (ok.ok) {
        expect(ok.data).toMatchObject({ canceled: false, relative: 'src/main.ts' })
      }

      // 取消：拿到 canceled 而不是错误
      const canceledRouter = buildRouter({ workspaceOf: () => workspace }, undefined, {
        pickDirectory: () => Promise.resolve({ path: workspace }),
        pickFile: () => Promise.resolve({ canceled: true })
      })
      const canceled = await canceledRouter.dispatch(IPC_INVOKE_CHANNELS.fsPickWorkspaceFile, {
        sessionKey: 'k1'
      })
      expect(canceled).toMatchObject({ ok: true, data: { canceled: true } })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('会话没有活跃进程 → NOT_FOUND（不猜工作区）', async () => {
    const router = buildRouter({ workspaceOf: () => undefined })
    const result = await router.dispatch(IPC_INVOKE_CHANNELS.fsPickWorkspaceFile, {
      sessionKey: 'k1'
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
  })
})

describe('默认工作目录（用户反馈的 bug 回归）', () => {
  it('app:getBoot 的 lastCwd 是用户主目录，不是进程启动目录', async () => {
    const router = buildRouter()
    const result = await router.dispatch(IPC_INVOKE_CHANNELS.appGetBoot, {})
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    const lastCwd = (result.data as { lastCwd?: string }).lastCwd
    expect(lastCwd).toBe(homedir())
    // 明确不等于 process.cwd()（从快捷方式启动时那是安装目录）
    expect(lastCwd).not.toBe(process.cwd())
  })
})

describe('A23：改会话名（历史任务，追加 session_info）', () => {
  it('索引里的会话文件可以改名，且原内容不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-rename-'))
    const cwdKey = join(dir, '--work--')
    mkdirSync(cwdKey, { recursive: true })
    const file = join(cwdKey, 's.jsonl')
    const original =
      '{"type":"session","version":3,"id":"aaaa1111","cwd":"/work"}' + String.fromCharCode(10)
    writeFileSync(file, original, 'utf8')

    try {
      const index = createSessionIndex({ sessionDir: () => dir })
      const router = buildRouter({}, undefined, undefined, index)
      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionFile: file,
        name: '新名字'
      })
      expect(result).toMatchObject({ ok: true })

      const after = readFileSync(file, 'utf8')
      expect(after.startsWith(original)).toBe(true)
      expect(after).toContain('"name":"新名字"')

      // 索引立刻读到新名字（session_info 优先于首条用户消息）
      const listed = await index.list({})
      expect(listed.items[0]?.title).toBe('新名字')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('索引之外的 .jsonl 被拒（PATH_DENIED）', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'pi-outside-'))
    const file = join(outer, 'x.jsonl')
    writeFileSync(
      file,
      '{"type":"session","version":3,"id":"a","cwd":"/w"}' + String.fromCharCode(10),
      'utf8'
    )
    try {
      const router = buildRouter()
      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionFile: file,
        name: 'x'
      })
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error.code).toBe('PATH_DENIED')
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  /**
   * I1–I4：真实规模会话的改名链路。
   *
   * 夹具 = 头部 + 一条 60KB 的**单行**用户消息（> 64KB，索引的 32KB 头部预算装不下），
   * 这正是用户报的那个会话形态：改名当场生效、重启后名字丢失。
   */
  function bigSessionContent(): string {
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id: 'bbbb2222',
      timestamp: '2026-11-20T00:00:00.000Z',
      cwd: '/work'
    })
    const bigRecord = JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-11-20T00:00:02.000Z',
      message: { role: 'user', content: `首条消息${'填'.repeat(25_000)}`, timestamp: 1 }
    })
    return `${header}\n${bigRecord}\n`
  }

  function bigSessionFile(prefix: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const cwdKey = join(dir, '--work--')
    mkdirSync(cwdKey, { recursive: true })
    const file = join(cwdKey, 'big.jsonl')
    writeFileSync(file, bigSessionContent(), 'utf8')
    return { dir, file }
  }

  /** pi（或本项目的 append 路径）写出的同形 session_info 一行 */
  function infoLine(name: string): string {
    return `${JSON.stringify({
      type: 'session_info',
      id: 'abcd1234',
      parentId: 'b1',
      timestamp: '2026-11-20T00:00:03.000Z',
      name
    })}\n`
  }

  it('I1：> 64KB 会话改名后，session:list 标题 = 新名', async () => {
    const { dir, file } = bigSessionFile('pi-rename-big-')
    try {
      expect(Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8')).toBeGreaterThan(64 * 1024)
      const index = createSessionIndex({ sessionDir: () => dir })
      const router = buildRouter({}, undefined, undefined, index)

      const renamed = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionFile: file,
        name: '重命名存活'
      })
      expect(renamed).toMatchObject({ ok: true })

      const listed = await router.dispatch(IPC_INVOKE_CHANNELS.sessionList, {})
      expect(listed).toMatchObject({ ok: true })
      if (!listed.ok) return
      const items = (listed.data as { items: Array<{ title: string }> }).items
      expect(items).toHaveLength(1)
      expect(items[0]?.title).toBe('重命名存活')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('I2：改名后「重启」（全新索引实例 + 空缓存）依然读到新名', async () => {
    const { dir, file } = bigSessionFile('pi-rename-restart-')
    try {
      const index = createSessionIndex({ sessionDir: () => dir })
      const router = buildRouter({}, undefined, undefined, index)
      await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionFile: file,
        name: '重启后仍在'
      })

      // 模拟应用重启：新进程 = 新索引实例、没有任何缓存
      const restarted = createSessionIndex({ sessionDir: () => dir })
      const listed = await restarted.list({})
      expect(listed.items[0]?.title).toBe('重启后仍在')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('I3：活跃会话路径 —— pi 往文件尾追加 session_info，列表读到新名', async () => {
    const { dir, file } = bigSessionFile('pi-rename-live-')
    try {
      const index = createSessionIndex({ sessionDir: () => dir })
      const calls: string[] = []
      const router = buildRouter(
        {
          // 真实场景里由 pi 自己落盘；这里由夹具代劳（同形 append）
          setName: (input: { sessionKey: string; name: string }) => {
            calls.push(`${input.sessionKey}=${input.name}`)
            appendFileSync(file, infoLine(input.name), 'utf8')
            return Promise.resolve({ ok: true } as const)
          },
          sessionFileOf: (sessionKey: string) => (sessionKey === 'live-1' ? file : undefined)
        },
        undefined,
        undefined,
        index
      )

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionKey: 'live-1',
        name: '活跃改名'
      })
      expect(result).toMatchObject({ ok: true })
      expect(calls).toEqual(['live-1=活跃改名'])

      const listed = await index.list({})
      expect(listed.items[0]?.title).toBe('活跃改名')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('I4：同一会话连续改名 3 次，列表显示最后一次', async () => {
    const { dir, file } = bigSessionFile('pi-rename-thrice-')
    try {
      const index = createSessionIndex({ sessionDir: () => dir })
      const router = buildRouter({}, undefined, undefined, index)
      for (const name of ['第一版', '第二版', '第三版']) {
        const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
          sessionFile: file,
          name
        })
        expect(result).toMatchObject({ ok: true })
      }
      const listed = await index.list({})
      expect(listed.items[0]?.title).toBe('第三版')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * R1–R5 + I2b：`session:delete` 的路由层（A39）。
 *
 * 真实要素：zod 校验 → 真实处理器 → 真实 `SessionIndex` → 真实 `SessionDelete` → 真实文件；
 * 只把「回收站」注入成真实 `unlink`（E2E 里由主进程 stub 成同样的语义）。
 */
describe('A39：删除本地会话（session:delete）', () => {
  /** 一条 > 64KB 的真实会话（头部 + 单行约 75KB 用户消息） */
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
    return `${header}
${big}
`
  }

  /** 真实删除服务（trash = 记录路径 + 真实 unlink） */
  function realDeleteService(index: SessionIndex): {
    service: SessionDelete
    trashed: string[]
  } {
    const trashed: string[] = []
    const service = createSessionDelete({
      sessionRoot: () => index.root(),
      findSession: (filePath) => index.find(filePath),
      activeSessionFiles: () => [],
      trash: async (absPath) => {
        trashed.push(absPath)
        await unlink(absPath)
      }
    })
    return { service, trashed }
  }

  it('R1：入参校验失败一律 VALIDATION，且服务未被调用', async () => {
    const remove = vi.fn(() => Promise.reject(new Error('不应被调用')))
    const router = buildRouter({}, undefined, undefined, undefined, { remove })

    const payloads: unknown[] = [
      {},
      { sessionFile: 1 },
      { sessionFile: '' },
      { sessionFile: 'x', extra: 1 }
    ]
    for (const payload of payloads) {
      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(remove).not.toHaveBeenCalled()
  })

  it('R2：真实索引 + 真实文件 → ok，且紧接着 session:list 已不含它（索引被失效）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-del-router-'))
    const group = join(root, '--work--')
    mkdirSync(group, { recursive: true })
    const file = join(group, 's.jsonl')
    writeFileSync(file, sessionContent('sid-1'), 'utf8')

    try {
      const index = createSessionIndex({ sessionDir: () => root })
      const { service, trashed } = realDeleteService(index)
      const router = buildRouter({}, undefined, undefined, index, service)
      const realFile = await realpathNative(file)

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
        sessionFile: file,
        sessionId: 'sid-1'
      })
      expect(result).toMatchObject({ ok: true })
      if (result.ok) {
        expect(result.data).toEqual({ id: 'sid-1', filePath: realFile })
      }
      expect(trashed).toHaveLength(1)
      expect(existsSync(file)).toBe(false)

      // 同一毫秒内的下一次查询也必须看到「已删除」（handler 显式 invalidate）
      const listed = await router.dispatch(IPC_INVOKE_CHANNELS.sessionList, {})
      expect(listed).toMatchObject({ ok: true })
      if (listed.ok) expect((listed.data as { items: unknown[] }).items).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('R3：根外文件 → PATH_DENIED，trash 未调用，列表不变', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-del-router-deny-'))
    const group = join(root, '--work--')
    mkdirSync(group, { recursive: true })
    writeFileSync(join(group, 's.jsonl'), sessionContent('sid-1'), 'utf8')

    const outside = mkdtempSync(join(tmpdir(), 'pi-del-router-outside-'))
    const outsideFile = join(outside, 'x.jsonl')
    writeFileSync(outsideFile, sessionContent('sid-outside'), 'utf8')

    try {
      const index = createSessionIndex({ sessionDir: () => root })
      const { service, trashed } = realDeleteService(index)
      const router = buildRouter({}, undefined, undefined, index, service)

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
        sessionFile: outsideFile
      })
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.error.code).toBe('PATH_DENIED')
      expect(trashed).toEqual([])
      expect(existsSync(outsideFile)).toBe(true)

      const listed = await router.dispatch(IPC_INVOKE_CHANNELS.sessionList, {})
      expect(listed).toMatchObject({ ok: true })
      if (listed.ok) expect((listed.data as { items: unknown[] }).items).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('R4：sessionId 超长 / 非字符串 → VALIDATION', async () => {
    const remove = vi.fn(() => Promise.reject(new Error('不应被调用')))
    const router = buildRouter({}, undefined, undefined, undefined, { remove })

    for (const payload of [
      { sessionFile: 'x', sessionId: 'y'.repeat(129) },
      { sessionFile: 'x', sessionId: 1 },
      { sessionFile: 'x'.repeat(4097) }
    ]) {
      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(remove).not.toHaveBeenCalled()
  })

  it('R5：删除后新建索引实例（模拟重启）仍不含该条', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-del-router-restart-'))
    const group = join(root, '--work--')
    mkdirSync(group, { recursive: true })
    const file = join(group, 's.jsonl')
    writeFileSync(file, sessionContent('sid-1'), 'utf8')

    try {
      const index = createSessionIndex({ sessionDir: () => root })
      const { service } = realDeleteService(index)
      const router = buildRouter({}, undefined, undefined, index, service)

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionDelete, {
        sessionFile: file
      })
      expect(result).toMatchObject({ ok: true })

      const restarted = createSessionIndex({ sessionDir: () => root })
      expect((await restarted.list({})).items).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('I2b：25 条会话中改名第 21 条及之后（F1 回归：旧实现只校验 list 首页）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-rename-page2-'))
    const files: string[] = []
    for (let i = 0; i < 25; i += 1) {
      const group = join(root, `--g${i}--`)
      mkdirSync(group, { recursive: true })
      const file = join(group, 's.jsonl')
      writeFileSync(file, sessionContent(`sid-${i}`), 'utf8')
      // mtime 严格递增：首页 = sid-24..sid-5，目标（最早写入的 sid-0）必然在第二页
      const at = new Date(Date.UTC(2026, 10, 20, 0, 0, i))
      utimesSync(file, at, at)
      files.push(file)
    }

    try {
      const index = createSessionIndex({ sessionDir: () => root })
      const router = buildRouter({}, undefined, undefined, index)
      const target = files[0]!

      // 前提校验必须在改名之前：改名会 append 一行，mtime 变成「最新」，目标会被顶到首页，
      // 那样这条用例就再也盖不住 F1 了。
      const firstPage = await index.list({})
      expect(firstPage.items).toHaveLength(20)
      expect(firstPage.items.some((item) => item.id === 'sid-0')).toBe(false)

      const result = await router.dispatch(IPC_INVOKE_CHANNELS.sessionSetName, {
        sessionFile: target,
        name: '第二页也能改名'
      })
      expect(result).toMatchObject({ ok: true })
      expect(readFileSync(target, 'utf8')).toContain('第二页也能改名')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
