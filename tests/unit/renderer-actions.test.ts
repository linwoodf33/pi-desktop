import { beforeEach, describe, expect, it } from 'vitest'

import type { PiApi } from '../../src/shared/contracts/api'
import type { Result } from '../../src/shared/contracts/result'
import type {
  AgentState,
  AppConfigView,
  ModelInfo,
  SessionForkPointsOutput,
  SessionHistoryOutput,
  SessionStats,
  SessionSummary
} from '../../src/shared/contracts/types'

import {
  abortRun,
  continueConversation,
  createTask,
  endTask,
  forkTask,
  loadForkPoints,
  loadTasks,
  locatePi,
  newTask,
  saveSettings,
  selectTask,
  sendMessage,
  switchModel,
  titleFromMessage
} from '../../src/renderer/lib/actions'
import { subscribeEvents } from '../../src/renderer/lib/client'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useRunStore } from '../../src/renderer/stores/runStore'
import { initialChatState } from '../../src/renderer/lib/reducer'
import { liveTaskId, useSessionStore } from '../../src/renderer/stores/sessionStore'

/**
 * renderer 编排层单测（组件不拼状态，编排与归约都可测）：
 * - 新建任务：必须先 `fs:pickDirectory` 选目录，再用该目录 `session:create`（M3 前置修复 2）；
 * - 选中历史任务：只调 `session:history` 回放，不启动子进程（§6.1 第 4 步）；
 * - 发送：乐观插入用户消息；busy 时带 `streamingBehavior`（§7 约束 5）；
 * - 停止：点击即「已中止」且按钮不可用（E4）；
 * - 事件：`evt:record` 按 sessionKey 路由到对应任务，`evt:status` 驱动 phase。
 */

type Call = { method: string; input?: unknown }

/** 契约最小可用值（新增的 session:state / session:stats / config:update 都需要） */
const AGENT_STATE: AgentState = {
  status: 'settled',
  busy: false,
  isStreaming: false,
  isCompacting: false,
  messageCount: 0,
  pendingMessageCount: 0
}

const EMPTY_STATS: SessionStats = {
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0
}

const BOOT_CONFIG: AppConfigView = {
  piCommand: 'pi',
  workspaceRoots: [],
  maxActiveSessions: 3,
  idleRecycleMinutes: 30,
  theme: 'system',
  permission: {
    enabled: true,
    tools: ['bash', 'powershell', 'write', 'edit'],
    timeoutMs: 120_000,
    noUi: 'deny'
  }
}

interface FakeApiOptions {
  list?: Result<{ items: SessionSummary[] }>
  history?: Result<SessionHistoryOutput>
  pickedPath?: Result<{ path: string }>
  created?: Result<{ sessionKey: string; sessionId: string }>
  resumed?: Result<{ sessionKey: string }>
  prompt?: Result<{ disposition: 'started' | 'queued' | 'handled' }>
  aborted?: Result<{ ok: true }>
  disposed?: Result<{ ok: true }>
  fork?: Result<{ sessionKey: string }>
  state?: Result<AgentState>
  stats?: Result<SessionStats>
  forkPoints?: Result<SessionForkPointsOutput>
  modelList?: Result<ModelInfo[]>
  modelSet?: Result<{ ok: true }>
  configUpdate?: Result<AppConfigView>
}

function createFakeApi(options: FakeApiOptions = {}) {
  const calls: Call[] = []
  const listeners: Array<(payload: unknown) => void> = []
  const statusListeners: Array<(payload: unknown) => void> = []
  const diagnosticListeners: Array<(payload: unknown) => void> = []

  const api = {
    app: { getBoot: () => Promise.resolve({ ok: true as const, data: {} as never }) },
    pi: { locate: () => Promise.resolve({ ok: true as const, data: { state: 'ok' as const } }) },
    session: {
      list: () => {
        calls.push({ method: 'session.list' })
        return Promise.resolve(options.list ?? { ok: true, data: { items: [] } })
      },
      history: (input: { sessionFile: string }) => {
        calls.push({ method: 'session.history', input })
        return Promise.resolve(
          options.history ?? {
            ok: true,
            data: { records: [], truncated: false, messageCount: 0, totalRecords: 0 }
          }
        )
      },
      create: (input: { cwd: string }) => {
        calls.push({ method: 'session.create', input })
        return Promise.resolve(
          options.created ?? { ok: true, data: { sessionKey: 's1', sessionId: 'id-1' } }
        )
      },
      resume: (input: { sessionFile: string }) => {
        calls.push({ method: 'session.resume', input })
        return Promise.resolve(options.resumed ?? { ok: true, data: { sessionKey: 's-resumed' } })
      },
      fork: (input: { sessionKey: string; entryId?: string }) => {
        calls.push({ method: 'session.fork', input })
        return Promise.resolve(
          options.fork ?? { ok: true as const, data: { sessionKey: 's-fork' } }
        )
      },
      prompt: (input: { sessionKey: string; message: string; streamingBehavior?: string }) => {
        calls.push({ method: 'session.prompt', input })
        return Promise.resolve(options.prompt ?? { ok: true, data: { disposition: 'started' } })
      },
      abort: (input: { sessionKey: string }) => {
        calls.push({ method: 'session.abort', input })
        return Promise.resolve(options.aborted ?? { ok: true, data: { ok: true as const } })
      },
      dispose: (input: { sessionKey: string }) => {
        calls.push({ method: 'session.dispose', input })
        return Promise.resolve(
          options.disposed ?? { ok: true as const, data: { ok: true as const } }
        )
      },
      state: (input: { sessionKey: string }) => {
        calls.push({ method: 'session.state', input })
        return Promise.resolve(options.state ?? { ok: true as const, data: AGENT_STATE })
      },
      stats: (input: { sessionKey: string }) => {
        calls.push({ method: 'session.stats', input })
        return Promise.resolve(
          options.stats ?? {
            ok: true as const,
            data: {
              userMessages: 0,
              assistantMessages: 0,
              toolCalls: 0,
              toolResults: 0,
              totalMessages: 0
            }
          }
        )
      },
      forkPoints: (input: { sessionKey: string }) => {
        calls.push({ method: 'session.forkPoints', input })
        return Promise.resolve(options.forkPoints ?? { ok: true as const, data: { points: [] } })
      }
    },
    config: {
      update: (input: unknown) => {
        calls.push({ method: 'config.update', input })
        return Promise.resolve(options.configUpdate ?? { ok: true as const, data: BOOT_CONFIG })
      }
    },
    model: {
      list: () => {
        calls.push({ method: 'model.list' })
        return Promise.resolve(options.modelList ?? { ok: true as const, data: [] })
      },
      set: (input: unknown) => {
        calls.push({ method: 'model.set', input })
        return Promise.resolve(
          options.modelSet ?? { ok: true as const, data: { ok: true as const } }
        )
      }
    },
    extui: { respond: () => Promise.resolve({ ok: true as const, data: { ok: true as const } }) },
    fs: {
      pickDirectory: (input?: { defaultPath?: string }) => {
        calls.push({ method: 'fs.pickDirectory', input })
        return Promise.resolve(options.pickedPath ?? { ok: true, data: { path: 'C:/work' } })
      },
      listArtifacts: () => Promise.resolve({ ok: true as const, data: [] }),
      readText: () => Promise.resolve({ ok: true as const, data: { text: '', truncated: false } }),
      diff: () => Promise.resolve({ ok: true as const, data: { path: '', patch: '' } })
    },
    artifact: { open: () => Promise.resolve({ ok: true as const, data: { ok: true as const } }) },
    events: {
      onRecord: (cb: (payload: unknown) => void) => {
        listeners.push(cb)
        return () => {}
      },
      onExtUi: () => () => {},
      onStatus: (cb: (payload: unknown) => void) => {
        statusListeners.push(cb)
        return () => {}
      },
      onDiagnostic: (cb: (payload: unknown) => void) => {
        diagnosticListeners.push(cb)
        return () => {}
      }
    }
  }

  return {
    api: api as unknown as PiApi,
    calls,
    emitRecord: (sessionKey: string, record: { type: string }) => {
      for (const listener of listeners) listener({ sessionKey, record })
    },
    emitStatus: (sessionKey: string, status: string) => {
      for (const listener of statusListeners) listener({ sessionKey, status })
    },
    emitDiagnostic: (payload: unknown) => {
      for (const listener of diagnosticListeners) listener(payload)
    }
  }
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    title: '历史任务',
    cwd: 'C:/work',
    updatedAt: '2026-01-01T00:00:00.000Z',
    filePath: 'C:/sessions/--work--/sess-1.jsonl',
    ...overrides
  }
}

/** 重置两个 store（`selectedId` 是可选项，用 delete 清掉以满足 exactOptionalPropertyTypes） */
function resetStores(): void {
  useSessionStore.setState({
    tasks: [],
    loaded: false,
    selectedId: undefined,
    chats: {},
    bySessionKey: {},
    truncated: {}
  })
  useRunStore.setState({
    phases: {},
    statuses: {},
    banners: [],
    aborting: {},
    aborted: {},
    switching: {},
    forking: {},
    ending: {},
    locating: false
  })
}

beforeEach(() => {
  resetStores()
})

describe('新建任务：先选目录再建会话（不再用主进程 cwd 兜底）', () => {
  it('pickDirectory → session.create(cwd=所选目录)', async () => {
    const fake = createFakeApi({ pickedPath: { ok: true, data: { path: 'D:/projects/demo' } } })

    await newTask({ api: fake.api })

    // M4：创建后还会回填 session:state 与 session:stats（模型/文件/token 展示）
    expect(fake.calls.map((call) => call.method)).toEqual([
      'fs.pickDirectory',
      'session.create',
      'session.state',
      'session.stats'
    ])
    expect(fake.calls[1]?.input).toEqual({ cwd: 'D:/projects/demo' })

    const state = useSessionStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]?.cwd).toBe('D:/projects/demo')
    expect(state.tasks[0]?.kind).toBe('live')
    expect(state.selectedId).toBe(state.tasks[0]?.id)
  })

  it('取消目录选择不产生任务，也不显示错误条', async () => {
    const fake = createFakeApi({
      pickedPath: { ok: false, error: { code: 'CANCELLED', message: '已取消目录选择' } }
    })

    await newTask({ api: fake.api })

    expect(fake.calls.map((call) => call.method)).toEqual(['fs.pickDirectory'])
    expect(useSessionStore.getState().tasks).toHaveLength(0)
    expect(useRunStore.getState().banners).toHaveLength(0)
  })

  it('create 失败时给出错误条，不留下半成品任务', async () => {
    const fake = createFakeApi({
      created: { ok: false, error: { code: 'PI_NOT_FOUND', message: '找不到 pi' } }
    })

    await newTask({ api: fake.api })

    expect(useSessionStore.getState().tasks).toHaveLength(0)
    expect(useRunStore.getState().banners[0]?.message).toContain('PI_NOT_FOUND')
  })
})

describe('任务列表：session:list + 选中回放', () => {
  it('loadTasks 载入历史任务并默认选中第一条（触发一次 history 回放）', async () => {
    const fake = createFakeApi({
      list: { ok: true, data: { items: [summary(), summary({ id: 'sess-2', title: '第二条' })] } },
      history: {
        ok: true,
        data: {
          records: [
            { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 1 } },
            {
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hello' }],
                timestamp: 2
              }
            }
          ],
          truncated: false,
          messageCount: 2,
          totalRecords: 2
        }
      }
    })

    await loadTasks({ api: fake.api })

    const state = useSessionStore.getState()
    expect(state.tasks).toHaveLength(2)
    expect(state.selectedId).toBe('sess-1')
    expect(fake.calls.filter((call) => call.method === 'session.history')).toHaveLength(1)
    // 回放不启动子进程
    expect(fake.calls.some((call) => call.method === 'session.create')).toBe(false)
    expect(fake.calls.some((call) => call.method === 'session.resume')).toBe(false)

    const chat = useSessionStore.getState().chats['sess-1']
    expect(chat?.messages.map((message) => message.text)).toEqual(['hi', 'hello'])
  })

  it('切换任务不重复读盘（已有消息时跳过回放）', async () => {
    const fake = createFakeApi({
      list: { ok: true, data: { items: [summary()] } },
      history: {
        ok: true,
        data: {
          records: [
            { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 1 } }
          ],
          truncated: false,
          messageCount: 1,
          totalRecords: 1
        }
      }
    })

    await loadTasks({ api: fake.api })
    await selectTask('sess-1', { api: fake.api })

    expect(fake.calls.filter((call) => call.method === 'session.history')).toHaveLength(1)
  })

  it('回放被截断时标记 truncated（UI 显式提示）', async () => {
    const fake = createFakeApi({
      list: { ok: true, data: { items: [summary()] } },
      history: {
        ok: true,
        data: { records: [], truncated: true, messageCount: 0, totalRecords: 0 }
      }
    })

    await loadTasks({ api: fake.api })
    expect(useSessionStore.getState().truncated['sess-1']).toBe(true)
  })
})

describe('发送消息（§6.2）', () => {
  it('新任务：乐观插入用户消息 + prompt(不带 streamingBehavior)', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })

    await sendMessage('列出当前目录', { api: fake.api })

    const promptCall = fake.calls.find((call) => call.method === 'session.prompt')
    expect(promptCall?.input).toEqual({ sessionKey: 's1', message: '列出当前目录' })

    const state = useSessionStore.getState()
    const taskId = state.selectedId as string
    expect(state.chats[taskId]?.messages[0]?.text).toBe('列出当前目录')
    expect(state.tasks[0]?.title).toBe('列出当前目录')
  })

  it('历史任务首次发送才 resume（不提前起子进程）', async () => {
    const fake = createFakeApi({ list: { ok: true, data: { items: [summary()] } } })
    await loadTasks({ api: fake.api })

    await sendMessage('继续', { api: fake.api })

    const methods = fake.calls.map((call) => call.method)
    expect(methods).toContain('session.resume')
    expect(methods).toContain('session.prompt')
    expect(methods.indexOf('session.resume')).toBeLessThan(methods.indexOf('session.prompt'))
    const promptCall = fake.calls.find((call) => call.method === 'session.prompt')
    expect(promptCall?.input).toMatchObject({ sessionKey: 's-resumed' })
  })

  it('运行中发送带 streamingBehavior=followUp（§7 约束 5）', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    useRunStore.getState().setPhase(taskId, 'streaming')

    await sendMessage('排队一条', { api: fake.api })

    const promptCall = fake.calls.find((call) => call.method === 'session.prompt')
    expect(promptCall?.input).toMatchObject({ streamingBehavior: 'followUp' })
  })

  it('prompt 失败时给出错误条（IPC Result.error → 错误条）', async () => {
    const fake = createFakeApi({
      prompt: { ok: false, error: { code: 'SESSION_BUSY', message: '会话正在运行' } }
    })
    await newTask({ api: fake.api })

    await sendMessage('x', { api: fake.api })

    expect(useRunStore.getState().banners[0]?.message).toContain('SESSION_BUSY')
  })
})

describe('停止按钮（E4）', () => {
  it('点击后立即标记已中止并调用 session:abort，随后回 idle', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    useRunStore.getState().setPhase(taskId, 'streaming')

    const pending = abortRun({ api: fake.api })
    // 同步阶段：按钮已置灰 + 已提示「已中止」（不等 abort 响应）
    expect(useRunStore.getState().aborting[taskId]).toBe(true)
    expect(useRunStore.getState().aborted[taskId]).toBe(true)

    await pending

    expect(fake.calls.some((call) => call.method === 'session.abort')).toBe(true)
    expect(useRunStore.getState().aborting[taskId]).toBeUndefined()
    expect(useRunStore.getState().phases[taskId]).toBe('idle')
  })
})

describe('事件接线（evt:record / evt:status / evt:diagnostic）', () => {
  it('记录按 sessionKey 路由到对应任务，agent_settled 回 idle', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    const off = subscribeEvents(fake.api)

    fake.emitRecord('s1', { type: 'agent_start' })
    expect(useRunStore.getState().phases[taskId]).toBe('streaming')

    fake.emitRecord('s1', {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'ls' }
    } as never)
    expect(useRunStore.getState().phases[taskId]).toBe('tool_running')

    fake.emitRecord('s1', { type: 'agent_end' })
    expect(useRunStore.getState().phases[taskId]).toBe('settling')

    fake.emitRecord('s1', { type: 'agent_settled' })
    expect(useRunStore.getState().phases[taskId]).toBe('idle')

    off()
  })

  it('无关 sessionKey 的记录被忽略（多会话不串流）', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    const off = subscribeEvents(fake.api)

    fake.emitRecord('other-session', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'nope' }], timestamp: 1 }
    } as never)

    expect(useSessionStore.getState().chats[taskId]?.messages ?? []).toHaveLength(0)
    off()
  })

  it('evt:status 按 sessionKey 记录，settled 时 phase 回 idle', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    const off = subscribeEvents(fake.api)

    fake.emitStatus('s1', 'running')
    expect(useRunStore.getState().statuses['s1']).toBe('running')
    expect(useRunStore.getState().phases[taskId]).toBe('streaming')

    fake.emitStatus('s1', 'settled')
    expect(useRunStore.getState().phases[taskId]).toBe('idle')

    off()
  })

  it('evt:diagnostic 进入错误条，带 stderr 尾部', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const off = subscribeEvents(fake.api)

    fake.emitDiagnostic({ level: 'error', message: 'pi 进程意外退出', stderrTail: 'boom' })

    const banner = useRunStore.getState().banners[0]
    expect(banner?.level).toBe('error')
    expect(banner?.message).toBe('pi 进程意外退出')
    expect(banner?.detail).toBe('boom')
    off()
  })
})

describe('纯函数：标题推导', () => {
  it('取首行并截断，空消息回落为「新任务」', () => {
    expect(titleFromMessage('第一行\n第二行')).toBe('第一行')
    expect(titleFromMessage('   ')).toBe('新任务')
    expect(titleFromMessage('x'.repeat(80)).endsWith('…')).toBe(true)
  })

  it('空对话初始状态可被 store 复用', () => {
    expect(initialChatState.messages).toEqual([])
  })
})

describe('M4：新建任务弹层（createTask）', () => {
  it('带 model/name 创建，并按 pi 的 state 回填模型、文件与统计', async () => {
    const fake = createFakeApi({
      created: { ok: true, data: { sessionKey: 's-new', sessionId: 'id-new' } },
      state: {
        ok: true,
        data: {
          ...AGENT_STATE,
          model: { id: 'claude', provider: 'anthropic', name: 'Claude' },
          thinkingLevel: 'high',
          sessionFile: 'C:/sessions/--work--/new.jsonl'
        }
      },
      stats: { ok: true, data: { ...EMPTY_STATS, totalMessages: 4, cost: 0.12 } }
    })

    const taskId = await createTask(
      { cwd: 'C:/work', model: 'anthropic/claude', thinkingLevel: 'high', name: '重构登录' },
      { api: fake.api }
    )

    expect(taskId).toBeDefined()
    expect(fake.calls.find((call) => call.method === 'session.create')?.input).toEqual({
      cwd: 'C:/work',
      model: 'anthropic/claude',
      name: '重构登录'
    })
    // 推理档位只能在会话建立后设置（pi 没有 create 时传档位的参数）
    expect(fake.calls.find((call) => call.method === 'model.set')?.input).toEqual({
      sessionKey: 's-new',
      model: 'anthropic/claude',
      thinkingLevel: 'high'
    })

    const state = useSessionStore.getState()
    const task = state.tasks.find((item) => item.id === taskId)
    expect(task?.title).toBe('重构登录')
    expect(task?.model).toBe('anthropic/claude')
    expect(task?.thinkingLevel).toBe('high')
    expect(task?.filePath).toBe('C:/sessions/--work--/new.jsonl')
    expect(taskId === undefined ? undefined : state.stats[taskId]?.cost).toBe(0.12)
  })

  it('未选模型时不调用 model.set（不主动改 pi 的默认模型/档位）', async () => {
    const fake = createFakeApi()
    await createTask({ cwd: 'C:/work', thinkingLevel: 'high' }, { api: fake.api })
    expect(fake.calls.some((call) => call.method === 'model.set')).toBe(false)
  })
})

describe('M4：模型与档位切换（model:set）', () => {
  it('切换成功后回填模型与档位', async () => {
    const fake = createFakeApi()
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string

    const ok = await switchModel(
      { model: 'openai/gpt-4o', thinkingLevel: 'low' },
      { api: fake.api }
    )

    expect(ok).toBe(true)
    expect(fake.calls.find((call) => call.method === 'model.set')?.input).toEqual({
      sessionKey: 's1',
      model: 'openai/gpt-4o',
      thinkingLevel: 'low'
    })
    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.model).toBe('openai/gpt-4o')
    expect(task?.thinkingLevel).toBe('low')
  })

  it('切换失败给明确错误条（带错误码），不改任务上的模型', async () => {
    const fake = createFakeApi({
      modelSet: { ok: false, error: { code: 'PI_COMMAND_FAILED', message: '模型不可用' } }
    })
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string

    const ok = await switchModel({ model: 'openai/gpt-4o' }, { api: fake.api })

    expect(ok).toBe(false)
    expect(useRunStore.getState().banners[0]?.message).toContain('PI_COMMAND_FAILED')
    expect(
      useSessionStore.getState().tasks.find((item) => item.id === taskId)?.model
    ).toBeUndefined()
  })

  it('没有运行中的会话时提示先「继续对话」，不发 model:set', async () => {
    const fake = createFakeApi({
      list: {
        ok: true,
        data: { items: [summary({ id: 'hist-1', title: '历史' })] }
      },
      history: {
        ok: true,
        data: { records: [], truncated: false, messageCount: 0, totalRecords: 0 }
      }
    })
    await loadTasks({ api: fake.api })

    const ok = await switchModel({ model: 'openai/gpt-4o' }, { api: fake.api })

    expect(ok).toBe(false)
    expect(fake.calls.some((call) => call.method === 'model.set')).toBe(false)
    expect(useRunStore.getState().banners[0]?.message).toContain('继续对话')
  })
})

describe('M4：恢复与分叉', () => {
  it('「继续对话」才 session:resume（选历史任务本身不起进程）', async () => {
    const fake = createFakeApi({
      list: { ok: true, data: { items: [summary({ id: 'hist-1', title: '历史任务' })] } },
      history: {
        ok: true,
        data: { records: [], truncated: false, messageCount: 0, totalRecords: 0 }
      }
    })
    await loadTasks({ api: fake.api })
    expect(fake.calls.some((call) => call.method === 'session.resume')).toBe(false)

    await continueConversation({ api: fake.api })

    expect(fake.calls.find((call) => call.method === 'session.resume')?.input).toEqual({
      sessionFile: 'C:/sessions/--work--/sess-1.jsonl'
    })
    const task = useSessionStore.getState().tasks.find((item) => item.id === 'hist-1')
    expect(task?.sessionKey).toBe('s-resumed')
    // 恢复会话 = 重新有了活进程：必须升级为 live，否则「结束」按钮一直是禁用态、
    // 「进行中」pill 也不出现（用户会以为恢复失败）。
    expect(task?.kind).toBe('live')
    // 可结束的直接证据：有 live 通道
    expect(useSessionStore.getState().taskIdForSession('s-resumed')).toBe('hist-1')
  })

  it('分叉：原任务降级为只读回放，新任务接管新 sessionKey', async () => {
    const fake = createFakeApi({
      fork: { ok: true, data: { sessionKey: 's-fork' } },
      state: {
        ok: true,
        data: { ...AGENT_STATE, sessionFile: 'C:/sessions/--work--/fork.jsonl' }
      },
      history: {
        ok: true,
        data: {
          records: [
            { type: 'message_end', message: { role: 'user', content: '第一条', timestamp: 1 } },
            { type: 'message_end', message: { role: 'user', content: '第二条', timestamp: 2 } }
          ],
          truncated: false,
          messageCount: 2,
          totalRecords: 2
        }
      }
    })
    await newTask({ api: fake.api })
    const originalId = useSessionStore.getState().selectedId as string

    await forkTask('entry-2', { api: fake.api })

    expect(fake.calls.find((call) => call.method === 'session.fork')?.input).toEqual({
      sessionKey: 's1',
      entryId: 'entry-2'
    })

    const state = useSessionStore.getState()
    const original = state.tasks.find((item) => item.id === originalId)
    // 通道移交给新任务：原任务不再是 live，但仍可用文件只读回放（A4：文件不变）
    expect(original?.sessionKey).toBeUndefined()
    expect(original?.kind).toBe('history')

    const forked = state.tasks.find((item) => item.id === liveTaskId('s-fork'))
    expect(forked?.sessionKey).toBe('s-fork')
    expect(forked?.title).toContain('分叉')
    expect(forked?.filePath).toBe('C:/sessions/--work--/fork.jsonl')
    expect(state.selectedId).toBe(forked?.id)
    // 新任务已按新会话文件回放了上下文
    expect(state.chats[forked?.id ?? '']?.messages).toHaveLength(2)
    // fork 编排的回放必须带 allowMissing（B1：首条消息分叉 = 空会话、文件未落盘）
    expect(fake.calls.find((call) => call.method === 'session.history')?.input).toEqual({
      sessionFile: 'C:/sessions/--work--/fork.jsonl',
      allowMissing: true
    })
  })

  /**
   * ① B1：从**第一条用户消息**分叉 → pi 建空会话、新会话文件尚未落盘。
   * 修复前：`session:history` 报 PATH_DENIED → 误导性错误条（且与「已分叉」信息条共存）。
   */
  it('从首条消息分叉（文件未落盘）：无错误条、空会话、可直接发首条消息', async () => {
    const fake = createFakeApi({
      fork: { ok: true, data: { sessionKey: 's-fork' } },
      state: {
        ok: true,
        data: { ...AGENT_STATE, sessionFile: 'C:/sessions/--work--/fork-empty.jsonl' }
      },
      // 主进程侧（allowMissing）对「文件不存在」返回空会话 + fileAbsent
      history: {
        ok: true,
        data: {
          records: [],
          truncated: false,
          messageCount: 0,
          totalRecords: 0,
          fileAbsent: true
        }
      }
    })
    await newTask({ api: fake.api })
    const off = subscribeEvents(fake.api)

    await forkTask('entry-1', { api: fake.api })

    const banners = useRunStore.getState().banners
    // 没有错误条（这是 B1 的可见症状）
    expect(banners.filter((banner) => banner.level === 'error')).toEqual([])
    // 取而代之的是一条可操作的信息条
    expect(banners.some((banner) => banner.message.includes('空会话'))).toBe(true)
    expect(banners.some((banner) => banner.detail?.includes('A4'))).toBe(true)

    const state = useSessionStore.getState()
    const forkedId = liveTaskId('s-fork')
    expect(state.selectedId).toBe(forkedId)
    const forked = state.tasks.find((item) => item.id === forkedId)
    expect(forked?.sessionKey).toBe('s-fork')
    expect(forked?.filePath).toBe('C:/sessions/--work--/fork-empty.jsonl')
    // 空会话：没有任何消息，也不被误标为「回放被截断」
    expect(state.chats[forkedId]?.messages).toEqual([])
    expect(state.truncated[forkedId]).toBeUndefined()
    expect(useRunStore.getState().phases[forkedId]).toBe('idle')

    // 可以直接发首条消息：prompt 打到新 sessionKey，不需要先 resume
    await sendMessage('分叉后的第一句', { api: fake.api })
    expect(fake.calls.find((call) => call.method === 'session.prompt')?.input).toMatchObject({
      sessionKey: 's-fork',
      message: '分叉后的第一句'
    })
    expect(useSessionStore.getState().chats[forkedId]?.messages).toHaveLength(1)

    // ③ 发消息后新会话真正有内容：事件到达后聊天区正常累积（相等于回放效果）
    fake.emitRecord('s-fork', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '分叉后的回答' }],
        timestamp: 100
      }
    } as { type: string })
    const messages = useSessionStore.getState().chats[forkedId]?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages[1]?.text).toBe('分叉后的回答')
    off()
  })

  it('分叉回放真的越界（PATH_DENIED）时仍如实报错（fail-closed 未被篡改）', async () => {
    const fake = createFakeApi({
      fork: { ok: true, data: { sessionKey: 's-fork' } },
      state: {
        ok: true,
        data: { ...AGENT_STATE, sessionFile: 'C:/elsewhere/fork.jsonl' }
      },
      history: {
        ok: false,
        error: {
          code: 'PATH_DENIED',
          message: '会话文件真实路径不在当前会话根目录内（疑似符号链接/junction 逃逸），拒绝回放'
        }
      }
    })
    await newTask({ api: fake.api })

    await forkTask('entry-1', { api: fake.api })

    const errors = useRunStore.getState().banners.filter((banner) => banner.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('PATH_DENIED')
  })

  it('没有运行中的会话时分叉给出可操作提示', async () => {
    const fake = createFakeApi({
      list: { ok: true, data: { items: [summary()] } },
      history: {
        ok: true,
        data: { records: [], truncated: false, messageCount: 0, totalRecords: 0 }
      }
    })
    await loadTasks({ api: fake.api })

    await forkTask('entry-1', { api: fake.api })

    expect(fake.calls.some((call) => call.method === 'session.fork')).toBe(false)
    expect(useRunStore.getState().banners[0]?.message).toContain('继续对话')
  })

  it('loadForkPoints 返回 pi 的用户消息分叉点', async () => {
    const fake = createFakeApi({
      forkPoints: {
        ok: true,
        data: { points: [{ entryId: 'e1', text: '第一个问题' }] }
      }
    })
    await newTask({ api: fake.api })

    const points = await loadForkPoints({ api: fake.api })
    expect(points).toEqual([{ entryId: 'e1', text: '第一个问题' }])
  })
})

describe('A12：定位 pi 后回写自检状态', () => {
  it('自检通过 → boot.piStatus 变为 ok（头部与「1. 确认 pi 可用」即时可见）', async () => {
    useAppStore.setState({
      bridge: {
        phase: 'ok',
        boot: { config: BOOT_CONFIG, piStatus: { state: 'unknown' }, appVersion: '0.0.0-test' },
        sessionCount: 0
      }
    })
    const fake = createFakeApi()

    const status = await locatePi({}, { api: fake.api })

    expect(status?.state).toBe('ok')
    const bridge = useAppStore.getState().bridge
    expect(bridge.phase).toBe('ok')
    if (bridge.phase !== 'ok') return
    expect(bridge.boot.piStatus.state).toBe('ok')
    // 成功不该弹告警条（自检结果本身即可见）
    expect(useRunStore.getState().banners).toHaveLength(0)
  })

  it('自检未通过 → 同样回写状态，并给一条可操作的告警条', async () => {
    useAppStore.setState({
      bridge: {
        phase: 'ok',
        boot: { config: BOOT_CONFIG, piStatus: { state: 'unknown' }, appVersion: '0.0.0-test' },
        sessionCount: 0
      }
    })
    const fake = createFakeApi()
    fake.api.pi.locate = () =>
      Promise.resolve({
        ok: true as const,
        data: {
          state: 'missing' as const,
          message: '找不到 pi：请在设置中指定完整路径'
        }
      })

    await locatePi({}, { api: fake.api })

    const bridge = useAppStore.getState().bridge
    if (bridge.phase !== 'ok') throw new Error('bridge 不该被改坏')
    expect(bridge.boot.piStatus.state).toBe('missing')
    expect(useRunStore.getState().banners[0]?.message).toContain('找不到 pi')
  })
})

describe('M4：设置持久化（config:update）', () => {
  it('保存后回写 appStore 的当前配置', async () => {
    const fake = createFakeApi({
      configUpdate: { ok: true, data: { ...BOOT_CONFIG, maxActiveSessions: 5 } }
    })

    const saved = await saveSettings({ maxActiveSessions: 5 }, { api: fake.api })

    expect(saved?.maxActiveSessions).toBe(5)
    expect(fake.calls.find((call) => call.method === 'config.update')?.input).toEqual({
      maxActiveSessions: 5
    })
    expect(useAppStore.getState().config?.maxActiveSessions).toBe(5)
  })

  it('保存失败给错误条且不覆盖当前配置', async () => {
    const fake = createFakeApi({
      configUpdate: {
        ok: false,
        error: { code: 'VALIDATION', message: '配置不得包含疑似密钥字段' }
      }
    })
    useAppStore.getState().setConfig(BOOT_CONFIG)

    const saved = await saveSettings({ piCommand: 'pi' }, { api: fake.api })

    expect(saved).toBeUndefined()
    expect(useRunStore.getState().banners[0]?.message).toContain('VALIDATION')
    expect(useAppStore.getState().config?.piCommand).toBe('pi')
  })
})

describe('A36：结束会话（session:dispose → 本地降级）', () => {
  /** 造一个活跃任务：newTask 建会话，再补会话文件（模拟首条消息已落盘） */
  async function seedLive(fake: ReturnType<typeof createFakeApi>): Promise<string> {
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    useSessionStore.getState().setFilePatch(taskId, 'C:/sessions/--work--/live.jsonl')
    return taskId
  }

  it('成功（已有会话文件）：释放 sessionKey、降级为历史、保留可回放', async () => {
    const fake = createFakeApi()
    const taskId = await seedLive(fake)
    useRunStore.getState().setPhase(taskId, 'streaming')

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(true)
    const disposeCalls = fake.calls.filter((call) => call.method === 'session.dispose')
    expect(disposeCalls).toHaveLength(1)
    expect(disposeCalls[0]?.input).toEqual({ sessionKey: 's1' })

    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.kind).toBe('history')
    expect(task?.sessionKey).toBeUndefined()
    expect(task?.filePath).toBe('C:/sessions/--work--/live.jsonl')
    expect(useSessionStore.getState().taskIdForSession('s1')).toBeUndefined()
    expect(useRunStore.getState().phases[taskId]).toBe('idle')
    expect(useRunStore.getState().ending[taskId]).toBeUndefined()
    expect(
      useRunStore
        .getState()
        .banners.some((item) => item.level === 'info' && item.message.includes('历史已保留'))
    ).toBe(true)
  })

  it('成功（首条消息前结束，没有会话文件）：移除空任务并选中下一条', async () => {
    const fake = createFakeApi({ list: { ok: true, data: { items: [summary()] } } })
    await loadTasks({ api: fake.api })
    await newTask({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    expect(taskId.startsWith('live:')).toBe(true)

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(true)
    expect(fake.calls.filter((call) => call.method === 'session.dispose')).toHaveLength(1)
    expect(useSessionStore.getState().tasks.some((item) => item.id === taskId)).toBe(false)
    expect(useSessionStore.getState().tasks).toHaveLength(1)
    // removeTask 清掉 selectedId → 回落到第一条任务
    expect(useSessionStore.getState().selectedId).toBe('sess-1')
    expect(
      useRunStore.getState().banners.some((item) => item.message.includes('没有历史需要保留'))
    ).toBe(true)
  })

  it('历史任务（没有运行中的会话）零 IPC，只给告警条', async () => {
    const fake = createFakeApi({ list: { ok: true, data: { items: [summary()] } } })
    await loadTasks({ api: fake.api })
    const taskId = useSessionStore.getState().selectedId as string
    const before = fake.calls.length

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(false)
    expect(fake.calls).toHaveLength(before)
    expect(useRunStore.getState().banners[0]?.level).toBe('warn')
    expect(useRunStore.getState().banners[0]?.message).toContain('没有运行中的会话')
  })

  it('SESSION_NOT_FOUND：本地降级成功，不弹红色错误条', async () => {
    const fake = createFakeApi({
      disposed: { ok: false, error: { code: 'SESSION_NOT_FOUND', message: '会话已释放' } }
    })
    const taskId = await seedLive(fake)

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(true)
    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.sessionKey).toBeUndefined()
    expect(task?.kind).toBe('history')
    expect(useRunStore.getState().banners.some((item) => item.level === 'error')).toBe(false)
    expect(
      useRunStore.getState().banners.some((item) => item.message.includes('会话已不存在'))
    ).toBe(true)
  })

  it('其它错误（INTERNAL）：红条 + store 完全不动', async () => {
    const fake = createFakeApi({
      disposed: { ok: false, error: { code: 'INTERNAL', message: 'dispose 失败' } }
    })
    const taskId = await seedLive(fake)

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(false)
    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.sessionKey).toBe('s1')
    expect(task?.kind).toBe('live')
    expect(useSessionStore.getState().taskIdForSession('s1')).toBe(taskId)
    expect(useRunStore.getState().banners[0]?.level).toBe('error')
    expect(useRunStore.getState().banners[0]?.message).toContain('INTERNAL')
    expect(useRunStore.getState().ending[taskId]).toBeUndefined()
  })

  it('并发点击只发一次 dispose（ending 在 await 之前置位）', async () => {
    const fake = createFakeApi()
    const taskId = await seedLive(fake)

    const first = endTask(taskId, { api: fake.api })
    const second = endTask(taskId, { api: fake.api })

    expect(await second).toBe(false)
    expect(await first).toBe(true)
    expect(fake.calls.filter((call) => call.method === 'session.dispose')).toHaveLength(1)
  })

  it('运行中结束（busy）：不调用 session:abort，结束后回 idle', async () => {
    const fake = createFakeApi()
    const taskId = await seedLive(fake)
    useRunStore.getState().setPhase(taskId, 'streaming')

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(true)
    expect(fake.calls.some((call) => call.method === 'session.abort')).toBe(false)
    expect(fake.calls.filter((call) => call.method === 'session.dispose')).toHaveLength(1)
    expect(useRunStore.getState().phases[taskId]).toBe('idle')
  })

  it('exited 事件先于 dispose 响应到达：不提前降级、不弹「子进程退出」条', async () => {
    const fake = createFakeApi()
    const taskId = await seedLive(fake)
    const off = subscribeEvents(fake.api)
    let kindAtExit: string | undefined
    let keyAtExit: string | undefined
    fake.api.session.dispose = (input: { sessionKey: string }) => {
      fake.emitStatus(input.sessionKey, 'exited')
      const at = useSessionStore.getState().tasks.find((item) => item.id === taskId)
      kindAtExit = at?.kind
      keyAtExit = at?.sessionKey
      return Promise.resolve({ ok: true as const, data: { ok: true as const } })
    }

    const ok = await endTask(taskId, { api: fake.api })

    expect(ok).toBe(true)
    // 事件到达那一刻：任务仍是 live、sessionKey 未释放（降级只由 endTask 做）
    expect(kindAtExit).toBe('live')
    expect(keyAtExit).toBe('s1')
    expect(useRunStore.getState().banners.some((item) => item.message.includes('子进程退出'))).toBe(
      false
    )
    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.kind).toBe('history')
    expect(task?.filePath).toBe('C:/sessions/--work--/live.jsonl')
    expect(useRunStore.getState().phases[taskId]).toBe('idle')
    off()
  })
})
