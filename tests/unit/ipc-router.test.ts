import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { IpcRouter } from '../../src/main/ipc/router'
import { createRouter } from '../../src/main/ipc/handlers'
import { createArtifactsService } from '../../src/main/services/artifacts'
import { createAuditLog } from '../../src/main/services/audit-log'
import { createConfigStore } from '../../src/main/services/config-store'
import { createAgentCatalog } from '../../src/main/services/agent-catalog'
import { createModelConfigStore } from '../../src/main/services/model-config-store'
import { createFsBridge, type FsBridge } from '../../src/main/services/fs-bridge'
import { createPiLocator } from '../../src/main/services/pi-locator'
import { createSessionHistory } from '../../src/main/services/session-history'
import { createSessionIndex, type SessionIndex } from '../../src/main/services/session-index'
import type { SessionService } from '../../src/main/services/session-service'
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
    workspaces: () => [],
    disposeAll: () => Promise.resolve(),
    ...overrides
  }
}

function buildRouter(
  overrides: Partial<SessionService> = {},
  timeouts?: Partial<Record<InvokeChannel, number>>,
  fsBridgeOverride?: FsBridge,
  sessionIndexOverride?: SessionIndex
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
      artifacts: createArtifactsService({
        resolver: createWorkspaceResolver({
          liveCwd: (sessionKey) => sessionService.workspaceOf(sessionKey),
          liveCwds: () => sessionService.workspaces(),
          sessionRoot: () => 'C:/nonexistent-pi-sessions'
        }),
        openPath: () => Promise.resolve(''),
        audit: createAuditLog({ sink: () => {} })
      })
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
})
