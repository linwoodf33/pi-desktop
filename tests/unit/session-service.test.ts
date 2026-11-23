import { describe, expect, it } from 'vitest'

import type { EventChannel } from '../../src/shared/ipc-channels'
import type {
  AgentState,
  RecordEvent,
  RunStatus,
  StatusEvent
} from '../../src/shared/contracts/types'
import { createSessionService } from '../../src/main/services/session-service'
import {
  splitModelRef,
  toImageContent,
  toModelList,
  toSessionStats
} from '../../src/main/services/session-service'
import type {
  ConnectionState,
  OpenChannelOptions,
  PiConnection,
  PiTransport,
  RpcCommand,
  RpcRecord,
  TransportExitInfo,
  TransportStartOptions
} from '../../src/main/transport/types'

/**
 * SessionService 单测（§6.2 关键语义 + §7 约束 4/5/6 + §9.2 I2/I8）。
 * 用内存里的 FakeConnection / FakeTransport，不启动真实子进程。
 */

type RespondResult = { respond: boolean; data?: unknown }
type Responder = (command: RpcCommand, id: string) => RespondResult

const STATE_DATA = {
  model: { id: 'mock-model', provider: 'mock', name: 'Mock Model' },
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  sessionFile: 'C:/sessions/mock.jsonl',
  sessionId: 'mock-session-id',
  messageCount: 0,
  pendingMessageCount: 0
}

const defaultResponder: Responder = (command) => {
  switch (command.type) {
    case 'get_state':
      return { respond: true, data: STATE_DATA }
    case 'get_available_models':
      return { respond: true, data: { models: [STATE_DATA.model] } }
    case 'prompt':
      return { respond: true, data: { disposition: 'started' } }
    case 'set_model':
    case 'set_thinking_level':
    case 'abort':
      return { respond: true }
    case 'fork':
      return { respond: true, data: { text: 'forked', cancelled: false } }
    default:
      return { respond: true }
  }
}

class FakeTransport implements PiTransport {
  static seq = 0
  readonly channelId: string
  readonly link = 'local' as const
  readonly startOptions: TransportStartOptions[] = []
  readonly sent: Array<{ command: RpcCommand; id?: string }> = []
  stopped = false
  responder: Responder

  private readonly recordListeners = new Set<(record: RpcRecord) => void>()
  private readonly exitListeners = new Set<(info: TransportExitInfo) => void>()

  constructor(responder: Responder = defaultResponder) {
    FakeTransport.seq += 1
    this.channelId = `fake#${FakeTransport.seq}`
    this.responder = responder
  }

  start(opts: TransportStartOptions): Promise<void> {
    this.startOptions.push(opts)
    return Promise.resolve()
  }

  send(command: RpcCommand, id?: string): void {
    this.sent.push(id === undefined ? { command } : { command, id })
    if (id === undefined) return
    const result = this.responder(command, id)
    if (!result.respond) return
    const record: RpcRecord =
      result.data === undefined
        ? { type: 'response', id, command: command.type, success: true }
        : { type: 'response', id, command: command.type, success: true, data: result.data }
    queueMicrotask(() => {
      this.emit(record)
    })
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  onExit(listener: (info: TransportExitInfo) => void): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  stop(): Promise<void> {
    this.stopped = true
    return Promise.resolve()
  }

  emit(record: RpcRecord): void {
    for (const listener of [...this.recordListeners]) listener(record)
  }

  emitExit(info: TransportExitInfo): void {
    for (const listener of [...this.exitListeners]) listener(info)
  }

  commandsSent(): string[] {
    return this.sent.map((item) => item.command.type)
  }
}

class FakeConnection implements PiConnection {
  readonly id = 'fake'
  readonly channels: FakeTransport[] = []
  private stateValue: ConnectionState = 'ready'
  readonly openOptions: OpenChannelOptions[] = []
  private readonly responder: Responder | undefined
  /** 下一次 openChannel 要抛的错误（只生效一次） */
  failNextOpen: Error | null = null

  constructor(responder?: Responder) {
    this.responder = responder
  }

  openChannel(opts: OpenChannelOptions): Promise<PiTransport> {
    this.openOptions.push(opts)
    const failure = this.failNextOpen
    if (failure !== null) {
      this.failNextOpen = null
      return Promise.reject(failure)
    }
    const transport =
      this.responder === undefined ? new FakeTransport() : new FakeTransport(this.responder)
    this.channels.push(transport)
    return Promise.resolve(transport)
  }

  last(): FakeTransport {
    const transport = this.channels.at(-1)
    if (!transport) throw new Error('没有打开的通道')
    return transport
  }

  state(): ConnectionState {
    return this.stateValue
  }

  setState(state: ConnectionState): void {
    this.stateValue = state
  }

  onStateChange(): () => void {
    return () => {}
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function setup(
  overrides: {
    limits?: { maxActiveSessions: number; idleRecycleMinutes: number }
    commandTimeoutMs?: number
    textDeltaWindowMs?: number
    responder?: Responder
  } = {}
): {
  service: ReturnType<typeof createSessionService>
  connection: FakeConnection
  events: Array<{ channel: EventChannel; payload: unknown }>
  records: RecordEvent[]
  /** evt:status 的完整载荷（带 sessionKey） */
  statusEvents: () => StatusEvent[]
  /** 只取状态串，便于断言顺序 */
  statuses: () => RunStatus[]
} {
  const connection = new FakeConnection(overrides.responder)
  const events: Array<{ channel: EventChannel; payload: unknown }> = []
  const service = createSessionService({
    connection,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    },
    limits: () => overrides.limits ?? { maxActiveSessions: 3, idleRecycleMinutes: 30 },
    commandTimeoutMs: overrides.commandTimeoutMs ?? 1000,
    settleTimeoutMs: 1000,
    reaperIntervalMs: 10_000_000,
    ...(overrides.textDeltaWindowMs === undefined
      ? {}
      : { textDeltaWindowMs: overrides.textDeltaWindowMs }),
    baseCwd: () => 'C:/work'
  })
  const records = events
    .filter((event) => event.channel === 'evt:record')
    .map((event) => event.payload as RecordEvent)
  void records
  return {
    service,
    connection,
    events,
    records,
    statusEvents: () =>
      events
        .filter((event) => event.channel === 'evt:status')
        .map((event) => event.payload as StatusEvent),
    statuses: () =>
      events
        .filter((event) => event.channel === 'evt:status')
        .map((event) => (event.payload as StatusEvent).status)
  }
}

describe('create / resume：会话生命周期', () => {
  it('create 启动通道并读取 pi 侧身份', async () => {
    const { service, connection } = setup()
    const created = await service.create({ cwd: 'C:/work', name: '任务一' })

    expect(created.sessionKey).toMatch(/^s1-/)
    expect(created.sessionId).toBe('mock-session-id')
    expect(connection.openOptions[0]).toMatchObject({ cwd: 'C:/work', sessionName: '任务一' })
    expect(connection.last().commandsSent()).toEqual(['get_state'])
  })

  it('create 过程推送 starting → settled 状态', async () => {
    const { service, statuses } = setup()
    await service.create({ cwd: 'C:/work' })
    expect(statuses()).toEqual(['starting', 'settled'])
  })

  it('evt:status 载荷带 sessionKey（多会话关联，M3 依赖）', async () => {
    const { service, statusEvents } = setup()
    const created = await service.create({ cwd: 'C:/work' })

    const payloads = statusEvents()
    expect(payloads.length).toBeGreaterThan(0)
    for (const payload of payloads) {
      expect(payload.sessionKey).toBe(created.sessionKey)
    }
    expect(payloads.map((payload) => payload.status)).toEqual(['starting', 'settled'])
  })

  it('resume 用 --session 打开既有文件', async () => {
    const { service, connection } = setup()
    await service.resume({ sessionFile: 'C:/sessions/a.jsonl' })
    expect(connection.openOptions[0]).toMatchObject({ sessionFile: 'C:/sessions/a.jsonl' })
  })

  it('未知 sessionKey → SESSION_NOT_FOUND', async () => {
    const { service } = setup()
    await expect(service.state({ sessionKey: 'nope' })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('prompt：success 只代表接受/排队（§6.2）', () => {
  it('空闲时直接 prompt，返回 disposition=started 并进入 running', async () => {
    const { service, connection, statuses } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const result = await service.prompt({ sessionKey, message: 'hello' })

    expect(result.disposition).toBe('started')
    const prompt = connection.last().sent.find((item) => item.command.type === 'prompt')
    expect(prompt?.command).toEqual({ type: 'prompt', message: 'hello' })
    expect(statuses()).toContain('running')
  })

  it('I2：busy 且没有 streamingBehavior → SESSION_BUSY，且不发命令', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().emit({ type: 'agent_start' })

    await expect(service.prompt({ sessionKey, message: 'again' })).rejects.toMatchObject({
      code: 'SESSION_BUSY'
    })
    expect(connection.last().commandsSent()).not.toContain('prompt')
  })

  it('busy 时带 steer / followUp 会随命令透传（§7 约束 5）', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().emit({ type: 'agent_start' })

    await service.prompt({ sessionKey, message: 'stop and do this', streamingBehavior: 'steer' })
    await service.prompt({ sessionKey, message: 'after done', streamingBehavior: 'followUp' })

    const prompts = connection
      .last()
      .sent.filter((item) => item.command.type === 'prompt')
      .map((item) => item.command)
    expect(prompts).toEqual([
      { type: 'prompt', message: 'stop and do this', streamingBehavior: 'steer' },
      { type: 'prompt', message: 'after done', streamingBehavior: 'followUp' }
    ])
  })

  it('空闲时误带 streamingBehavior 会被剔除（pi 只在流式中接受该字段）', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    await service.prompt({ sessionKey, message: 'hi', streamingBehavior: 'followUp' })

    const prompt = connection.last().sent.find((item) => item.command.type === 'prompt')
    expect(prompt?.command).toEqual({ type: 'prompt', message: 'hi' })
  })

  it('disposition=handled（扩展命令）不进入 running', async () => {
    const connection = new FakeConnection()
    const statuses: unknown[] = []
    const service = createSessionService({
      connection,
      emit: (channel, payload) => {
        if (channel === 'evt:status') statuses.push((payload as StatusEvent).status)
      },
      limits: () => ({ maxActiveSessions: 3, idleRecycleMinutes: 30 }),
      commandTimeoutMs: 1000,
      reaperIntervalMs: 10_000_000,
      baseCwd: () => 'C:/work'
    })
    // create 之后把 prompt 的响应改成 handled
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().responder = (command) =>
      command.type === 'prompt'
        ? { respond: true, data: { disposition: 'handled' } }
        : defaultResponder(command, 'x')

    const result = await service.prompt({ sessionKey, message: '/mycommand' })

    expect(result.disposition).toBe('handled')
    expect(statuses).not.toContain('running')
  })

  it('prompt 缺 disposition → PROTOCOL 错误', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().responder = () => ({ respond: true, data: { oops: true } })

    await expect(service.prompt({ sessionKey, message: 'x' })).rejects.toMatchObject({
      code: 'PROTOCOL'
    })
  })

  it('命令响应按 id 关联：未知 id 不影响在途命令（§7 约束 4）', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    const transport = connection.last()
    transport.responder = () => ({ respond: false })

    const pending = service.state({ sessionKey })
    // 先来一条 id 不匹配的响应
    transport.emit({ type: 'response', id: 'bogus', command: 'get_state', success: true, data: {} })
    await sleep(1)

    const id = transport.sent.at(-1)?.id
    expect(id).toBeDefined()
    transport.emit({ type: 'response', id, command: 'get_state', success: true, data: STATE_DATA })

    await expect(pending).resolves.toMatchObject({ sessionId: 'mock-session-id' })
  })

  it('命令超时 → TIMEOUT（IpcRouter 之外的 pi 侧预算）', async () => {
    const { service, connection } = setup({ commandTimeoutMs: 20 })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().responder = () => ({ respond: false })

    await expect(service.state({ sessionKey })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('pi 拒绝命令（success:false）→ PI_COMMAND_FAILED', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    const transport = connection.last()
    transport.responder = (command, id) => {
      if (command.type !== 'prompt') return defaultResponder(command, id)
      queueMicrotask(() => {
        transport.emit({
          type: 'response',
          id,
          command: 'prompt',
          success: false,
          error: 'Model not found: invalid/model'
        })
      })
      return { respond: false }
    }

    await expect(service.prompt({ sessionKey, message: 'x' })).rejects.toMatchObject({
      code: 'PI_COMMAND_FAILED'
    })
  })
})

describe('busy 语义：agent_end ≠ 结束（§7 约束 7）', () => {
  it('agent_end 之后仍 busy，agent_settled 才回 idle', async () => {
    const { service, connection, statuses } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    const transport = connection.last()

    transport.emit({ type: 'agent_start' })
    transport.emit({ type: 'agent_end', willRetry: true })

    const afterEnd = await service.state({ sessionKey })
    expect(afterEnd.busy).toBe(true)
    expect(afterEnd.status).toBe('running')
    // create 时已有一次 settled（建会话即空闲），agent_end 之后不应再出现新的 settled
    expect(statuses()).toEqual(['starting', 'settled', 'running'])

    transport.emit({ type: 'agent_settled', aborted: false })
    const settled = await service.state({ sessionKey })
    expect(settled.busy).toBe(false)
    expect(settled.status).toBe('settled')
    expect(statuses().filter((status) => status === 'settled')).toHaveLength(2)
  })

  it('abort 会等 pi 确认并复位为 settled', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    connection.last().emit({ type: 'agent_start' })

    await expect(service.abort({ sessionKey })).resolves.toEqual({ ok: true })
    const state = await service.state({ sessionKey })
    expect(state.busy).toBe(false)
    expect(state.status).toBe('settled')
    expect(connection.last().commandsSent()).toContain('abort')
  })
})

describe('事件推送：evt:record 合并与 evt:extui', () => {
  it('text_delta 在窗口内合并成一条 evt:record', async () => {
    const { service, connection, events } = setup({ textDeltaWindowMs: 5 })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    const transport = connection.last()
    const before = events.length

    transport.emit({ type: 'agent_start' })
    transport.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'He' }
    })
    transport.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'llo' }
    })
    await sleep(30)

    const emitted = events.slice(before).map((event) => event.payload as RecordEvent)
    const merged = emitted.filter((payload) => payload.mergedCount !== undefined)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.mergedCount).toBe(2)
    expect(merged[0]?.record).toMatchObject({
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
    })
    expect(merged[0]?.sessionKey).toBe(sessionKey)
  })

  it('agent_settled 之前先 flush 缓冲的 delta（不丢尾巴）', async () => {
    const { service, connection, events } = setup({ textDeltaWindowMs: 5000 })
    await service.create({ cwd: 'C:/work' })
    const transport = connection.last()
    const before = events.length

    transport.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'tail' }
    })
    transport.emit({ type: 'agent_settled', aborted: false })

    const emitted = events.slice(before).map((event) => event.payload as RecordEvent)
    expect(emitted.map((payload) => payload.record.type)).toEqual([
      'message_update',
      'agent_settled'
    ])
    expect(emitted[0]?.record).toMatchObject({ assistantMessageEvent: { delta: 'tail' } })
  })

  it('extension_ui_request 走 evt:extui', async () => {
    const { service, connection, events } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    connection.last().emit({ type: 'extension_ui_request', requestId: 'r1', kind: 'select' })

    const extui = events.filter((event) => event.channel === 'evt:extui')
    expect(extui).toHaveLength(1)
    expect(extui[0]?.payload).toMatchObject({ sessionKey })
  })

  /**
   * 收口债 #4：pi 发 `extension_ui_cancel` 时，登记表条目必须一并清掉。
   *
   * 可见行为：之后再用同一个 id 回答 → `REQUEST_NOT_FOUND`（而不是“能回答一个已取消的请求”）。
   * 若只透传不清理，长会话里反复取消会让 Map 无限长（纯内存泄漏）。
   */
  it('extension_ui_cancel 清掉登记表条目，之后回答同一 id 是 REQUEST_NOT_FOUND', async () => {
    const { service, connection, events } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })
    const transport = connection.last()

    // 登记（带 id + options，才是真实 pi 的 extension_ui_request 形状）
    transport.emit({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'select',
      options: ['允许一次', '本会话允许', '拒绝']
    })
    // 取消（扩展撤回了这条请求）
    transport.emit({ type: 'extension_ui_cancel', id: 'ui-1' })

    // 取消仍然透传（UI 据此收起弹窗）
    const extui = events.filter((event) => event.channel === 'evt:extui')
    expect(
      extui.map((event) => (event.payload as { request: { type: string } }).request.type)
    ).toEqual(['extension_ui_request', 'extension_ui_cancel'])

    await expect(
      service.respondExtUi({
        sessionKey,
        requestId: 'ui-1',
        response: { kind: 'select', value: '允许一次' }
      })
    ).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' })
  })

  it('进程意外退出 → evt:diagnostic + status=exited，会话被移除', async () => {
    const { service, connection, events } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    connection.last().emitExit({ code: 1, signal: null, stderrTail: 'boom' })

    const diagnostic = events.find((event) => event.channel === 'evt:diagnostic')
    expect(diagnostic?.payload).toMatchObject({ level: 'error', stderrTail: 'boom' })
    expect(
      events.filter((e) => e.channel === 'evt:status').map((e) => (e.payload as StatusEvent).status)
    ).toContain('exited')
    await expect(service.state({ sessionKey })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })
})

describe('dispose 与并行上限（§6.4、I8）', () => {
  it('dispose 走优雅停止并释放会话', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    await expect(service.dispose({ sessionKey })).resolves.toEqual({ ok: true })
    expect(connection.last().stopped).toBe(true)
    expect(service.keys()).toHaveLength(0)
  })

  it('超过上限时回收最久未活动的空闲会话', async () => {
    const { service, connection, statuses } = setup({
      limits: { maxActiveSessions: 1, idleRecycleMinutes: 30 }
    })
    const first = await service.create({ cwd: 'C:/work' })
    const firstTransport = connection.last()

    await service.create({ cwd: 'C:/work' })

    expect(firstTransport.stopped).toBe(true)
    expect(statuses()).toContain('recycled')
    expect(service.keys()).not.toContain(first.sessionKey)
    expect(service.keys()).toHaveLength(1)
  })

  it('上限之外没有空闲会话 → LIMIT_EXCEEDED', async () => {
    const { service, connection } = setup({
      limits: { maxActiveSessions: 1, idleRecycleMinutes: 30 }
    })
    await service.create({ cwd: 'C:/work' })
    connection.last().emit({ type: 'agent_start' })

    await expect(service.create({ cwd: 'C:/work' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    })
  })

  it('disposeAll 停掉所有通道', async () => {
    const { service, connection } = setup()
    await service.create({ cwd: 'C:/work' })
    await service.create({ cwd: 'C:/work' })

    await service.disposeAll()

    expect(connection.channels.every((transport) => transport.stopped)).toBe(true)
    expect(service.keys()).toHaveLength(0)
  })

  it('并发 create 时占位生效：不会突破上限', async () => {
    const { service } = setup({ limits: { maxActiveSessions: 2, idleRecycleMinutes: 30 } })

    const results = await Promise.allSettled([
      service.create({ cwd: 'C:/work' }),
      service.create({ cwd: 'C:/work' }),
      service.create({ cwd: 'C:/work' })
    ])

    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected'
    )
    expect(fulfilled).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(service.keys()).toHaveLength(2)
  })

  it('开通道失败会释放占位，不会永久吃掉名额', async () => {
    const { service, connection } = setup({
      limits: { maxActiveSessions: 1, idleRecycleMinutes: 30 }
    })
    connection.failNextOpen = new Error('spawn 失败')

    await expect(service.create({ cwd: 'C:/work' })).rejects.toThrowError(/spawn 失败/)
    // 如果占位泄漏，这里会因为「0 会话 + 1 占位 = 上限」而被 LIMIT_EXCEEDED 拒掉
    await expect(service.create({ cwd: 'C:/work' })).resolves.toMatchObject({
      sessionKey: expect.stringMatching(/^s/) as string
    })
    expect(service.keys()).toHaveLength(1)
  })
})

describe('连接 failed 后的重试路径（§3.3 / §10 A12：免重启恢复）', () => {
  it('连接处于 failed 时 create 仍会真的尝试，不会硬拒', async () => {
    const { service, connection } = setup()
    connection.setState('failed')

    const created = await service.create({ cwd: 'C:/work' })

    expect(created.sessionKey).toBeTruthy()
    expect(connection.openOptions).toHaveLength(1)
  })

  it('create 失败（openChannel 抛错）后再 create 仍可成功', async () => {
    const { service, connection } = setup()
    connection.failNextOpen = new Error('ENOENT: pi 不在 PATH')

    await expect(service.create({ cwd: 'C:/work' })).rejects.toThrowError(/ENOENT/)

    await expect(service.create({ cwd: 'C:/work' })).resolves.toBeDefined()
    expect(service.keys()).toHaveLength(1)
  })
})

describe('M4：session:stats（token/成本来自 pi）', () => {
  const statsData = {
    sessionFile: 'C:/sessions/mock.jsonl',
    sessionId: 'mock-session-id',
    userMessages: 5,
    assistantMessages: 5,
    toolCalls: 12,
    toolResults: 12,
    totalMessages: 22,
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
    contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 }
  }

  it('透传 pi 的 token/成本（客户端不做任何估算）', async () => {
    const { service, connection } = setup({
      responder: (command, id) =>
        command.type === 'get_session_stats'
          ? { respond: true, data: statsData }
          : defaultResponder(command, id)
    })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const stats = await service.stats({ sessionKey })

    expect(connection.last().commandsSent()).toContain('get_session_stats')
    expect(stats.tokens).toEqual({
      input: 50000,
      output: 10000,
      cacheRead: 40000,
      cacheWrite: 5000,
      total: 105000
    })
    expect(stats.cost).toBe(0.45)
    expect(stats.totalMessages).toBe(22)
    expect(stats.contextUsage).toEqual({ tokens: 60000, contextWindow: 200000, percent: 30 })
  })

  it('pi 未提供 tokens 时整块缺失（UI 显示「—」，而不是 0）', async () => {
    const { service } = setup({
      responder: (command, id) =>
        command.type === 'get_session_stats'
          ? { respond: true, data: { sessionId: 'x', totalMessages: 3 } }
          : defaultResponder(command, id)
    })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const stats = await service.stats({ sessionKey })
    expect(stats.tokens).toBeUndefined()
    expect(stats.cost).toBeUndefined()
    expect(stats.totalMessages).toBe(3)
  })

  it('compaction 后 pi 给 null 的上下文用量原样保留', () => {
    expect(
      toSessionStats({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } })
        .contextUsage
    ).toEqual({ tokens: null, contextWindow: 200000, percent: null })
  })
})

describe('M4：session:forkPoints / fork 语义', () => {
  it('fork 用 entryId（pi fork.entryId）并释放原 sessionKey', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const forked = await service.fork({ sessionKey, entryId: 'entry-9' })

    const forkCommand = connection.last().sent.find((item) => item.command.type === 'fork')
    expect(forkCommand?.command).toEqual({ type: 'fork', entryId: 'entry-9' })
    // 通道移交：旧 key 释放，新 key 接管，同一个进程
    expect(service.keys()).toEqual([forked.sessionKey])
    expect(connection.channels).toHaveLength(1)
    await expect(service.state({ sessionKey })).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND'
    })
  })

  it('pi 扩展取消 fork 时报 PI_COMMAND_FAILED', async () => {
    const { service } = setup({
      responder: (command, id) =>
        command.type === 'fork'
          ? { respond: true, data: { cancelled: true } }
          : defaultResponder(command, id)
    })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    await expect(service.fork({ sessionKey, entryId: 'entry-1' })).rejects.toMatchObject({
      code: 'PI_COMMAND_FAILED'
    })
  })

  it('forkPoints 返回 pi 的可分叉点（只保留 entryId + text）', async () => {
    const { service } = setup({
      responder: (command, id) =>
        command.type === 'get_fork_messages'
          ? {
              respond: true,
              data: {
                messages: [
                  { entryId: 'e1', text: '第一个问题' },
                  { entryId: 'e2', text: '第二个问题' },
                  { text: '缺 entryId' }
                ]
              }
            }
          : defaultResponder(command, id)
    })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const points = await service.forkPoints({ sessionKey })
    expect(points.points).toEqual([
      { entryId: 'e1', text: '第一个问题' },
      { entryId: 'e2', text: '第二个问题' }
    ])
  })
})

describe('fork / setModel / model:list', () => {
  it('无 sessionFile 时 fork 给出可操作错误', async () => {
    // get_state 不返回 sessionFile：模拟「会话尚未落盘」
    const noSessionFile: Responder = (command, id) => {
      if (command.type === 'get_state') {
        const { sessionFile: _omit, ...rest } = STATE_DATA
        return { respond: true, data: rest }
      }
      return defaultResponder(command, id)
    }
    const { service } = setup({ responder: noSessionFile })
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    await expect(service.fork({ sessionKey })).rejects.toMatchObject({
      code: 'PI_COMMAND_FAILED'
    })
  })

  it('不带 messageId 的 fork 用 CLI --fork 复制会话文件', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const forked = await service.fork({ sessionKey })

    const forkOptions = connection.openOptions.at(-1)
    expect(forkOptions?.extraArgs).toEqual(['--fork', 'C:/sessions/mock.jsonl'])
    expect(forked.sessionKey).not.toBe(sessionKey)
  })

  it('带 messageId 的 fork 走 RPC fork 并移交通道', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const forked = await service.fork({ sessionKey, messageId: 'entry-1' })

    const forkCommand = connection.last().sent.find((item) => item.command.type === 'fork')
    expect(forkCommand?.command).toEqual({ type: 'fork', entryId: 'entry-1' })
    expect(forked.sessionKey).not.toBe(sessionKey)
    expect(service.keys()).toEqual([forked.sessionKey])
    // 通道被复用，没有新进程
    expect(connection.channels).toHaveLength(1)
  })

  it('setModel 拆 provider/id 并设置推理档位', async () => {
    const { service, connection } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    await service.setModel({
      sessionKey,
      model: 'anthropic/claude-sonnet-4-5',
      thinkingLevel: 'high'
    })

    const commands = connection.last().sent.map((item) => item.command)
    expect(commands).toContainEqual({
      type: 'set_model',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5'
    })
    expect(commands).toContainEqual({ type: 'set_thinking_level', level: 'high' })
  })

  it('model:list 用活跃会话查询，返回归一化 ModelInfo', async () => {
    const { service } = setup()
    await service.create({ cwd: 'C:/work' })

    const models = await service.listModels()
    expect(models[0]).toMatchObject({ id: 'mock-model', provider: 'mock' })
  })

  it('model:list 在没有会话时起临时 --no-session 进程', async () => {
    const { service, connection } = setup()
    const models = await service.listModels()

    expect(models).toHaveLength(1)
    expect(connection.openOptions[0]?.extraArgs).toEqual(['--no-session'])
    expect(connection.channels[0]?.stopped).toBe(true)
    expect(service.keys()).toHaveLength(0)
  })

  it('state 返回 AgentState 形状（含 model/thinkingLevel/队列）', async () => {
    const { service } = setup()
    const { sessionKey } = await service.create({ cwd: 'C:/work' })

    const state: AgentState = await service.state({ sessionKey })
    expect(state).toMatchObject({
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
      thinkingLevel: 'medium',
      steeringMode: 'one-at-a-time'
    })
    expect(state.model).toMatchObject({ id: 'mock-model', provider: 'mock' })
  })
})

describe('纯函数辅助', () => {
  it('splitModelRef 接受 provider/id，拒绝裸 id', () => {
    expect(splitModelRef('anthropic/claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5'
    })
    expect(() => splitModelRef('claude-sonnet-4-5')).toThrowError(/provider\/id/)
    expect(() => splitModelRef('/x')).toThrowError()
  })

  it('toImageContent 只接受 data URL', () => {
    expect(toImageContent('data:image/png;base64,AAAA')).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png'
    })
    expect(() => toImageContent('AAAA')).toThrowError(/data URL/)
  })

  it('toModelList 过滤掉形状不合法的模型', () => {
    const models = toModelList({
      models: [{ id: 'a', provider: 'p' }, { nope: true }, { id: 'b' }]
    })
    expect(models.map((model) => model.id)).toEqual(['a'])
  })
})
