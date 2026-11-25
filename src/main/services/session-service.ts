import type { EventChannel } from '../../shared/ipc-channels'
import { IpcFailure } from '../../shared/contracts/result'
import type {
  AgentState,
  DiagnosticEvent,
  ExtUiEvent,
  ForkPoint,
  ModelInfo,
  PromptDisposition,
  SessionToolMode,
  RecordEvent,
  RunStatus,
  SessionForkPointsOutput,
  SessionStats,
  StatusEvent
} from '../../shared/contracts/types'
import { modelInfoSchema } from '../../shared/contracts/types'

import { toExtensionUiResponse, type ExtUiResponseInput } from '../../shared/contracts/permission'

import { readArrayField, readDisposition, type RpcResponseRecord } from '../transport/protocol'
import type { PiConnection, PiTransport, RpcCommand, RpcRecord } from '../transport/types'

import { createExtUiRegistry, type ExtUiRegistry } from './extui-registry'
import { RecordBatcher } from './record-batcher'

/**
 * SessionService（架构文档 §5.2、§5.3、§6.2）：
 * 会话生命周期 create/resume/fork/prompt/abort/dispose + 进程级串行化 +
 * 按 id 关联响应（§7 约束 4）+ 并行上限与空闲回收。
 *
 * 关键语义（§6.2）：
 * - `prompt` 的成功只代表「已接受 / 已排队 / 已被扩展处理」，完成只认 `agent_settled`；
 * - busy 时 `prompt` 必须带 `streamingBehavior`（steer/followUp），缺失直接报 SESSION_BUSY；
 * - `agent_end` ≠ 结束（后面可能还有 retry/compaction/队列），busy 保持到 `agent_settled`。
 */

export interface SessionLimits {
  /** 并行活跃会话上限（默认 3，§Q3 / §10 A8） */
  maxActiveSessions: number
  /** 已 settled 会话的空闲回收分钟数（默认 30，§6.4） */
  idleRecycleMinutes: number
}

export interface SessionServiceOptions {
  connection: PiConnection
  /** main → renderer 事件推送（evt:record / evt:status / evt:diagnostic / evt:extui） */
  emit: (channel: EventChannel, payload: unknown) => void
  /** 读取当前配置里的并行/回收设置 */
  limits: () => SessionLimits
  /** 可选：`--session-dir` 覆盖（§Q7） */
  sessionDir?: () => string | undefined
  /**
   * A38：从会话文件里读当前 agent（`open-agents-state` / `active_agent` 条目）。
   * fail-soft：读不到必须返回 `undefined`（未知），不能把「没读到」当成「没有 agent」。
   */
  readAgent?: (filePath: string) => Promise<string | null | undefined>
  /** 单命令超时（§7 约束 13：默认 60s；prompt 的接受/排队响应仍受此约束，跑完不受） */
  commandTimeoutMs?: number
  /** abort / fork 前等待 idle 的上限 */
  settleTimeoutMs?: number
  /** 空闲回收扫描间隔（默认 60s） */
  reaperIntervalMs?: number
  /** text_delta 合并窗口（默认 16ms，§5.4） */
  textDeltaWindowMs?: number
  now?: () => number
  /** 临时进程的 cwd（默认 process.cwd()） */
  baseCwd?: () => string
  /**
   * 未决 extension_ui_request 登记表（M5，§9.4 S9/S10）。
   * 省略时自建一个（单测友好）；main 侧注入带 `onReject` 诊断的实例。
   */
  extUiRegistry?: ExtUiRegistry
}

type PendingCommand = {
  command: string
  resolve: (data: unknown) => void
  reject: (error: unknown) => void
  timer: NodeJS.Timeout
}

interface SessionRecord {
  key: string
  transport: PiTransport
  cwd: string
  status: RunStatus
  /** 是否仍有自动工作未完（只有 agent_settled 才置 false） */
  busy: boolean
  sessionId?: string
  sessionFile?: string
  model?: string
  thinkingLevel?: string
  lastActivityAt: number
  pending: Map<string, PendingCommand>
  cmdSeq: number
  /** 串行化：同一会话的命令严格顺序执行 */
  lock: Promise<unknown>
  settledWaiters: Array<() => void>
  unsubscribes: Array<() => void>
  batcher: RecordBatcher
  /** 主动关停时为 true：区分「预期退出」与「崩溃」 */
  closing: boolean
}

export interface SessionService {
  create(input: {
    cwd: string
    model?: string
    name?: string
    /** 起始模式 = pi 的工具选择（full / readonly / no-tools） */
    toolMode?: SessionToolMode
    /** 会话身份 agent（`--agent`，名字已由调用方按目录校验） */
    agent?: string
  }): Promise<{
    sessionKey: string
    sessionId: string
  }>
  resume(input: { sessionFile: string }): Promise<{ sessionKey: string }>
  /**
   * 分叉（§6.5、§10 A4）。语义见实现注释：`entryId` 是 pi 的**用户消息** entry id。
   */
  fork(input: { sessionKey: string; entryId?: string; messageId?: string }): Promise<{
    sessionKey: string
  }>
  /** 可分叉点（pi `get_fork_messages`） */
  forkPoints(input: { sessionKey: string }): Promise<SessionForkPointsOutput>
  prompt(input: {
    sessionKey: string
    message: string
    images?: string[]
    streamingBehavior?: 'steer' | 'followUp'
  }): Promise<{ disposition: PromptDisposition }>
  abort(input: { sessionKey: string }): Promise<{ ok: true }>
  dispose(input: { sessionKey: string }): Promise<{ ok: true }>
  state(input: { sessionKey: string }): Promise<AgentState>
  /** 会话 token/成本统计（pi `get_session_stats`；客户端不做估算） */
  stats(input: { sessionKey: string }): Promise<SessionStats>
  listModels(): Promise<ModelInfo[]>
  /** A23：改会话显示名（活跃会话） */
  setName(input: { sessionKey: string; name: string }): Promise<{ ok: true }>
  setModel(input: { sessionKey: string; model: string; thinkingLevel?: string }): Promise<{
    ok: true
  }>
  /**
   * 回答一条未决的 `extension_ui_request`（M5）。
   *
   * 强校验（§9.4 S9/S10）：requestId 必须属于该 sessionKey 且来自该会话**当前**通道，
   * 且 select 的取值必须在请求给出的 options 内；任何不符都抛 `REQUEST_NOT_FOUND`
   * 并写 `evt:diagnostic`（伪造 / 跨会话 / 过期一律丢弃，不会到达 pi）。
   */
  respondExtUi(input: {
    sessionKey: string
    requestId: string
    response: ExtUiResponseInput
  }): Promise<{ ok: true }>
  /** 已注册的会话键（诊断 / 测试用） */
  keys(): string[]
  /**
   * 会话的工作目录（M6 产物扫用）：工作区根的唯一可信来源。
   * 未注册 / 已释放的会话返回 undefined。
   */
  workspaceOf(sessionKey: string): string | undefined
  /** 当前全部活跃会话的工作目录（M6 路径白名单用） */
  workspaces(): string[]
  disposeAll(): Promise<void>
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000
const DEFAULT_REAPER_INTERVAL_MS = 60_000

export function createSessionService(options: SessionServiceOptions): SessionService {
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  const reaperIntervalMs = options.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS
  const baseCwd = options.baseCwd ?? (() => process.cwd())
  const now = options.now ?? (() => Date.now())
  const extUi = options.extUiRegistry ?? createExtUiRegistry()

  const sessions = new Map<string, SessionRecord>()
  let keySeq = 0
  /**
   * 已占位但还没注册成会话的名额。
   * `openChannel` 的 await 窗口里会话尚未入表，并发 create 会绕过上限；
   * 因此先同步占位再开通道，开通道/注册任一失败都要释放（§9.2 I8）。
   */
  let reservedSlots = 0

  /* ---------------------------------------------------------------- *
   * 事件与状态
   * ---------------------------------------------------------------- */

  function emitStatus(session: SessionRecord, status: RunStatus): void {
    if (session.status === status) return
    session.status = status
    pushStatus(session, status)
  }

  /** 状态事件一律带 `sessionKey`：多会话下 renderer 靠它关联到具体会话 */
  function pushStatus(session: SessionRecord, status: RunStatus): void {
    const payload: StatusEvent = { sessionKey: session.key, status }
    options.emit('evt:status', payload)
    if (status === 'settled' || status === 'exited' || status === 'recycled') {
      session.lastActivityAt = now()
    }
  }

  function emitDiagnostic(payload: DiagnosticEvent): void {
    options.emit('evt:diagnostic', payload)
  }

  function emitRecord(session: SessionRecord, record: RpcRecord, mergedCount: number): void {
    const payload: RecordEvent = {
      sessionKey: session.key,
      record,
      ...(mergedCount > 1 ? { mergedCount } : {})
    }
    options.emit('evt:record', payload)
  }

  /* ---------------------------------------------------------------- *
   * 命令发送与串行化（§7 约束 4：按 id 关联，不假设顺序）
   * ---------------------------------------------------------------- */

  function trackCommand(
    session: SessionRecord,
    command: RpcCommand,
    timeoutMs: number
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = `c${session.cmdSeq + 1}`
      session.cmdSeq += 1
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(
          new IpcFailure(
            'TIMEOUT',
            `pi 命令 ${command.type} 超过 ${timeoutMs}ms 未响应`,
            `sessionKey=${session.key} id=${id}`
          )
        )
      }, timeoutMs)
      timer.unref?.()

      session.pending.set(id, { command: command.type, resolve, reject, timer })

      try {
        session.transport.send(command, id)
      } catch (error) {
        clearTimeout(timer)
        session.pending.delete(id)
        reject(
          error instanceof IpcFailure
            ? error
            : new IpcFailure('PI_EXITED', `发送命令失败：${describe(error)}`)
        )
      }
    })
  }

  function sendCommand(
    session: SessionRecord,
    command: RpcCommand,
    timeoutMs = commandTimeoutMs
  ): Promise<unknown> {
    return trackCommand(session, command, timeoutMs)
  }

  async function withLock<T>(session: SessionRecord, task: () => Promise<T>): Promise<T> {
    const previous = session.lock
    let release: () => void = () => {}
    session.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
    }
  }

  function rejectPending(session: SessionRecord, error: unknown): void {
    for (const [id, pending] of session.pending) {
      clearTimeout(pending.timer)
      session.pending.delete(id)
      pending.reject(error)
    }
  }

  function notifySettled(session: SessionRecord): void {
    const waiters = session.settledWaiters
    session.settledWaiters = []
    for (const waiter of waiters) waiter()
  }

  function waitForSettled(session: SessionRecord, timeoutMs: number): Promise<void> {
    if (!session.busy) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const onSettled = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        session.settledWaiters = session.settledWaiters.filter((waiter) => waiter !== onSettled)
        reject(new IpcFailure('TIMEOUT', `等待 agent_settled 超过 ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      session.settledWaiters.push(onSettled)
    })
  }

  /* ---------------------------------------------------------------- *
   * 记录归约
   * ---------------------------------------------------------------- */

  function handleRecord(session: SessionRecord, record: RpcRecord): void {
    session.lastActivityAt = now()

    if (record.type === 'response') {
      const response = record as RpcResponseRecord
      const id = response.id
      if (typeof id === 'string') {
        const pending = session.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          session.pending.delete(id)
          if (response.success === false) {
            pending.reject(
              new IpcFailure(
                'PI_COMMAND_FAILED',
                `pi 拒绝了命令 ${pending.command}：${response.error ?? '未给出原因'}`,
                `id=${id}`
              )
            )
          } else {
            pending.resolve(response.data)
          }
          return
        }
      }
      // 无 id（如 parse 失败响应）或未知 id：作为诊断记录透传，不影响在途命令
      session.batcher.push(record)
      return
    }

    if (record.type === 'extension_ui_request') {
      // M5：登记未决请求（带通道 id），`extui:respond` 只认这里登记过的 id
      const requestId = record['id']
      if (typeof requestId === 'string' && requestId.length > 0) {
        const method = typeof record['method'] === 'string' ? record['method'] : 'unknown'
        const optionsField = Array.isArray(record['options'])
          ? record['options'].filter((item): item is string => typeof item === 'string')
          : undefined
        extUi.register({
          requestId,
          sessionKey: session.key,
          channelId: session.transport.channelId,
          method,
          ...(optionsField === undefined ? {} : { options: optionsField })
        })
      }
      const payload: ExtUiEvent = { sessionKey: session.key, request: record }
      options.emit('evt:extui', payload)
      return
    }

    if (record.type === 'extension_ui_cancel') {
      // pi 取消了某个未决请求（扩展撤销 / 超时兜底）：透传给 renderer 收起弹窗，
      // **同时**清掉登记表条目。不清理的话，被取消的请求会一直留在 Map 里
      // （长会话 + 反复拒绝/超时 = 纯内存泄漏），且应为一次性的 id 下次再来会被当成「已存在」。
      const cancelledId = record['id']
      if (typeof cancelledId === 'string' && cancelledId.length > 0) {
        extUi.discard(session.key, cancelledId)
      }
      const payload: ExtUiEvent = { sessionKey: session.key, request: record }
      options.emit('evt:extui', payload)
      return
    }

    if (record.type === 'agent_start') {
      session.busy = true
      emitStatus(session, 'running')
    } else if (record.type === 'agent_settled') {
      // 先吐出缓冲的 delta 再宣告 settled，保证 UI 收到完整文本
      session.batcher.flush()
      session.busy = false
      emitStatus(session, 'settled')
      notifySettled(session)
    }
    // agent_end 不改变 busy：retry/compaction/steer/followUp 仍可能继续（§6.2）

    session.batcher.push(record)
  }

  function attachTransport(session: SessionRecord): void {
    session.unsubscribes.push(
      session.transport.onRecord((record) => {
        try {
          handleRecord(session, record)
        } catch (error) {
          emitDiagnostic({
            sessionKey: session.key,
            level: 'error',
            message: `记录归约失败：${describe(error)}`
          })
        }
      })
    )

    session.unsubscribes.push(
      session.transport.onExit((info) => {
        session.batcher.flush()
        denyPendingExtUi(session, 'pi 进程已退出')
        if (session.closing) return
        emitDiagnostic({
          sessionKey: session.key,
          level: 'error',
          message: `pi 进程意外退出（code=${String(info.code)} signal=${String(info.signal)}）`,
          ...(info.stderrTail.length > 0 ? { stderrTail: info.stderrTail } : {})
        })
        session.busy = false
        emitStatus(session, 'exited')
        rejectPending(session, new IpcFailure('PI_EXITED', 'pi 子进程已退出', info.stderrTail))
        notifySettled(session)
        detachSession(session)
      })
    )
  }

  /* ---------------------------------------------------------------- *
   * 会话表管理
   * ---------------------------------------------------------------- */

  function detachSession(session: SessionRecord): void {
    for (const unsubscribe of session.unsubscribes) unsubscribe()
    session.unsubscribes = []
    session.batcher.dispose()
    sessions.delete(session.key)
  }

  function requireSession(sessionKey: string): SessionRecord {
    const session = sessions.get(sessionKey)
    if (!session) {
      throw new IpcFailure('SESSION_NOT_FOUND', `会话不存在或已释放：${sessionKey}`)
    }
    return session
  }

  /**
   * 连接级前置检查（§3.3 / §10 A12）。
   *
   * `failed` **不是终态**：它只说明上一次解析/启动失败。用户重新 `pi:locate` 成功后，
   * 下一次 create/resume 必须能重新尝试（openChannel 内部会重新 resolveLaunch），
   * 所以这里不再硬拒；真的找不到 pi 时由 openChannel 抛出 PI_NOT_FOUND，消息同样可操作。
   */
  function requireLaunchable(): void {
    // 仅用于语义说明：保持调用点可读，且未来接入 gateway 时在此加真正的连接闸门。
  }

  /** 占位一个并行名额（真正的注册成功后才释放） */
  function reserveSlot(): void {
    reservedSlots += 1
  }

  function releaseSlot(): void {
    if (reservedSlots > 0) reservedSlots -= 1
  }

  /**
   * 先占位再开通道（§9.2 I8）。
   *
   * 占位是**同步**的：`create` 并发时第二个请求立即就能看到第一个的占位，
   * 不会出现「都以为还有空位 → 一起冲破上限」的竞态。任何一步失败都会释放占位。
   */
  async function openReservedChannel<T>(
    open: () => Promise<PiTransport>,
    register: (transport: PiTransport) => T,
    exceptKey?: string
  ): Promise<T> {
    reserveSlot()
    try {
      await ensureCapacityForReserved(exceptKey)
      const transport = await open()
      return register(transport)
    } finally {
      releaseSlot()
    }
  }

  /**
   * 已占位的前提下做容量判定：活跃会话达上限时回收最久未活动的空闲会话（§6.4、§10 A8）。
   * 判断时排除本请求自己的占位，否则会多回收一个会话。
   */
  async function ensureCapacityForReserved(exceptKey?: string): Promise<void> {
    const limit = options.limits().maxActiveSessions
    const others = reservedSlots - 1
    while (sessions.size + others >= limit) {
      const victim = [...sessions.values()]
        .filter((session) => !session.busy && !session.closing && session.key !== exceptKey)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0]
      if (!victim) {
        throw new IpcFailure(
          'LIMIT_EXCEEDED',
          `活跃会话已达上限（${limit}）且没有可回收的空闲会话，请先结束一个会话`,
          `maxActiveSessions=${limit}`
        )
      }
      await stopSession(victim, 'recycled')
    }
  }

  /**
   * 对所有未决审批请求回「拒绝」（§6.3：会话销毁 / 进程退出 / 断连）。
   *
   * 尽力而为：通道可能已经关闭（send 抛 PI_EXITED），这里吞掉并只做诊断。
   * 语义上不会「假装成功」——扩展侧即使一个包都没收到，也会在 timeout 后 fail-closed 拒绝。
   */
  function denyPendingExtUi(session: SessionRecord, reason: string): void {
    const pending = extUi.clearSession(session.key)
    if (pending.length === 0) return
    for (const entry of pending) {
      try {
        session.transport.send(toExtensionUiResponse(entry.requestId, { kind: 'cancel' }))
      } catch {
        // 通道已关闭：忽略（扩展侧还有 120s 兜底拒绝）
      }
    }
    emitDiagnostic({
      sessionKey: session.key,
      level: 'warn',
      message: `已拒绝 ${pending.length} 个未决审批请求（${reason}）`
    })
  }

  async function stopSession(session: SessionRecord, status: 'exited' | 'recycled'): Promise<void> {
    if (session.closing) return
    session.closing = true
    // 先回拒绝再关通道：让扩展立刻拿到「拒绝」而不是等 120s 超时
    denyPendingExtUi(session, status === 'recycled' ? '会话被回收' : '会话已释放')
    session.batcher.flush()
    rejectPending(session, new IpcFailure('PI_EXITED', '会话已释放', session.key))
    emitStatus(session, status)
    try {
      // §7 约束 6：关 stdin → 等有序退出 → 超时才 kill（由 transport 实现）
      await session.transport.stop()
    } catch (error) {
      emitDiagnostic({
        sessionKey: session.key,
        level: 'warn',
        message: `停止 pi 进程时出错：${describe(error)}`
      })
    } finally {
      detachSession(session)
    }
  }

  function registerSession(
    transport: PiTransport,
    cwd: string,
    extras: { model?: string; thinkingLevel?: string }
  ): SessionRecord {
    keySeq += 1
    const key = `s${keySeq}-${Math.random().toString(36).slice(2, 8)}`
    const session: SessionRecord = {
      key,
      transport,
      cwd,
      status: 'starting',
      busy: false,
      lastActivityAt: now(),
      pending: new Map(),
      cmdSeq: 0,
      lock: Promise.resolve(),
      settledWaiters: [],
      unsubscribes: [],
      batcher: new RecordBatcher({
        emit: (record, mergedCount) => emitRecord(session, record, mergedCount),
        ...(options.textDeltaWindowMs === undefined ? {} : { windowMs: options.textDeltaWindowMs })
      }),
      closing: false,
      ...(extras.model === undefined ? {} : { model: extras.model }),
      ...(extras.thinkingLevel === undefined ? {} : { thinkingLevel: extras.thinkingLevel })
    }
    sessions.set(key, session)
    attachTransport(session)
    pushStatus(session, 'starting')
    return session
  }

  /** 用 `get_state` 刷新身份并确认通道可用，返回客户端 AgentState */
  async function readState(session: SessionRecord): Promise<AgentState> {
    const data = toRecord(
      await withLock(session, () => sendCommand(session, { type: 'get_state' }))
    )

    if (typeof data['sessionFile'] === 'string') session.sessionFile = data['sessionFile']
    if (typeof data['sessionId'] === 'string') session.sessionId = data['sessionId']
    if (typeof data['thinkingLevel'] === 'string') session.thinkingLevel = data['thinkingLevel']
    const model = toModelInfo(data['model'])
    if (model) session.model = `${model.provider}/${model.id}`

    // A38：agent 不在 `get_state` 里，只能读会话文件。放在 `withLock` 之外，
    // 且整段 fail-soft —— 读不到就当作「未知」（不返回该字段），不能让 state 失败。
    let agent: string | null | undefined
    if (session.sessionFile !== undefined && options.readAgent !== undefined) {
      try {
        agent = await options.readAgent(session.sessionFile)
      } catch {
        agent = undefined
      }
    }

    return {
      status: session.status,
      busy: session.busy,
      isStreaming: data['isStreaming'] === true,
      isCompacting: data['isCompacting'] === true,
      messageCount: typeof data['messageCount'] === 'number' ? data['messageCount'] : 0,
      pendingMessageCount:
        typeof data['pendingMessageCount'] === 'number' ? data['pendingMessageCount'] : 0,
      ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(typeof data['sessionName'] === 'string' ? { sessionName: data['sessionName'] } : {}),
      ...(model === undefined ? {} : { model }),
      ...(typeof data['thinkingLevel'] === 'string'
        ? { thinkingLevel: data['thinkingLevel'] }
        : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(typeof data['steeringMode'] === 'string' ? { steeringMode: data['steeringMode'] } : {}),
      ...(typeof data['followUpMode'] === 'string' ? { followUpMode: data['followUpMode'] } : {})
    }
  }

  /** 起一个临时通道执行一次性命令（model:list 在没有活跃会话时用） */
  async function withEphemeralTransport<T>(
    task: (transport: PiTransport) => Promise<T>
  ): Promise<T> {
    requireLaunchable()
    const sessionDir = options.sessionDir?.()
    const transport = await options.connection.openChannel({
      cwd: baseCwd(),
      extraArgs: ['--no-session'],
      ...(sessionDir === undefined ? {} : { sessionDir })
    })
    try {
      return await task(transport)
    } finally {
      await transport.stop().catch(() => {})
    }
  }

  /** 在无会话环境下按 id 关联执行一条命令 */
  function queryTransport(transport: PiTransport, command: RpcCommand): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = 'q1'
      const timer = setTimeout(() => {
        unsubscribe()
        reject(
          new IpcFailure('TIMEOUT', `pi 命令 ${command.type} 超过 ${commandTimeoutMs}ms 未响应`)
        )
      }, commandTimeoutMs)
      timer.unref?.()

      const unsubscribe = transport.onRecord((record) => {
        if (record.type !== 'response') return
        const response = record as RpcResponseRecord
        if (response.id !== id) return
        clearTimeout(timer)
        unsubscribe()
        if (response.success === false) {
          reject(
            new IpcFailure(
              'PI_COMMAND_FAILED',
              `pi 拒绝了命令 ${command.type}：${response.error ?? '未给出原因'}`
            )
          )
          return
        }
        resolve(response.data)
      })

      try {
        transport.send(command, id)
      } catch (error) {
        clearTimeout(timer)
        unsubscribe()
        reject(new IpcFailure('PI_EXITED', `发送命令失败：${describe(error)}`))
      }
    })
  }

  /* ---------------------------------------------------------------- *
   * 空闲回收（只回收已 settled 的会话，§6.4）
   * ---------------------------------------------------------------- */

  const reaper = setInterval(() => {
    const idleMs = options.limits().idleRecycleMinutes * 60_000
    const timestamp = now()
    for (const session of [...sessions.values()]) {
      if (session.busy || session.closing) continue
      if (timestamp - session.lastActivityAt < idleMs) continue
      void stopSession(session, 'recycled')
    }
  }, reaperIntervalMs)
  reaper.unref?.()

  /* ---------------------------------------------------------------- *
   * 对外 API
   * ---------------------------------------------------------------- */

  return {
    keys: () => [...sessions.keys()],

    workspaceOf: (sessionKey) => sessions.get(sessionKey)?.cwd,

    workspaces: () => [...sessions.values()].map((session) => session.cwd),

    respondExtUi(input): Promise<{ ok: true }> {
      // 同步校验 + 消费（跨会话 / 伪造 / 过期 / 选项不符都在这里被拒绝并记诊断）。
      // 注意：内部是同步抛错，必须转成 rejected Promise——对外契约始终是 Promise，
      // 否则调用方（IPC router / 集成测试）拿不到 Promise 而是拿到一个同步异常。
      try {
        const session = requireSession(input.sessionKey)
        const entry = extUi.consume({
          sessionKey: input.sessionKey,
          requestId: input.requestId,
          currentChannelId: session.transport.channelId,
          response: input.response
        })
        // `extension_ui_response` 用 pi 给的 request id 关联，本身**不带**命令 id
        // （docs/rpc.md：它不产生普通 command response）
        session.transport.send(toExtensionUiResponse(entry.requestId, input.response))
        return Promise.resolve({ ok: true as const })
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },

    async create(input) {
      requireLaunchable()
      const sessionDir = options.sessionDir?.()
      const session = await openReservedChannel(
        () =>
          options.connection.openChannel({
            cwd: input.cwd,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.toolMode === undefined ? {} : { toolMode: input.toolMode }),
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            ...(input.name === undefined ? {} : { sessionName: input.name }),
            ...(sessionDir === undefined ? {} : { sessionDir })
          }),
        (transport) =>
          registerSession(transport, input.cwd, {
            ...(input.model === undefined ? {} : { model: input.model })
          })
      )

      try {
        const state = await readState(session)
        emitStatus(session, 'settled')
        return { sessionKey: session.key, sessionId: state.sessionId ?? session.key }
      } catch (error) {
        await stopSession(session, 'exited')
        throw error
      }
    },

    async resume(input) {
      requireLaunchable()

      const sessionDir = options.sessionDir?.()
      // pi 会用 session 文件里记录的 cwd 作为工作目录（docs/sessions.md），
      // 这里只需保证 spawn 的 cwd 存在
      const session = await openReservedChannel(
        () =>
          options.connection.openChannel({
            cwd: baseCwd(),
            sessionFile: input.sessionFile,
            ...(sessionDir === undefined ? {} : { sessionDir })
          }),
        (transport) => {
          const record = registerSession(transport, baseCwd(), {})
          record.sessionFile = input.sessionFile
          return record
        }
      )

      try {
        await readState(session)
        emitStatus(session, 'settled')
        return { sessionKey: session.key }
      } catch (error) {
        await stopSession(session, 'exited')
        throw error
      }
    },

    /**
     * 分叉（§5.4、§6.5、§10 A4）。
     *
     * **pi 语义（已核 docs/rpc-commands.md#fork、docs/sessions.md）**：
     * - RPC `fork {entryId}` 的 `entryId` 是**用户消息** entry 的 id（由 `get_fork_messages` 给出），
     *   不是 assistant 消息——pi 只支持「回到某句话」重开分支；
     * - fork 后**同一 pi 进程**切到新会话（新 session 文件，header 带 `parentSession`），
     *   所以客户端的会话句柄（sessionKey）必须移交：旧 key 释放（再调 → SESSION_NOT_FOUND），
     *   新 key 接管同一 transport；原会话文件**字节不变**（A4），
     * - 不带 entryId 时用 CLI `--fork <sessionFile>` 新起进程复制整条分支（同样不改原文件）。
     */
    async fork(input) {
      const session = requireSession(input.sessionKey)
      await waitForSettled(session, settleTimeoutMs)

      const entryId = input.entryId ?? input.messageId
      if (entryId !== undefined) {
        const data = toRecord(
          await withLock(session, () => sendCommand(session, { type: 'fork', entryId }))
        )
        if (data['cancelled'] === true) {
          throw new IpcFailure('PI_COMMAND_FAILED', '分叉被 pi 扩展取消')
        }
        const stateData = toRecord(
          await withLock(session, () => sendCommand(session, { type: 'get_state' }))
        )

        const previousKey = session.key
        const previousFile = session.sessionFile
        const transport = session.transport
        detachSession(session)
        const forked = registerSession(transport, session.cwd, {
          ...(session.model === undefined ? {} : { model: session.model })
        })
        if (typeof stateData['sessionFile'] === 'string')
          forked.sessionFile = stateData['sessionFile']
        if (typeof stateData['sessionId'] === 'string') forked.sessionId = stateData['sessionId']
        emitStatus(forked, 'settled')
        emitDiagnostic({
          level: 'info',
          message: `会话已分叉：${previousKey} → ${forked.key}（复用同一 pi 进程，新会话文件）`,
          ...(previousFile === undefined ? {} : { detail: previousFile })
        })
        return { sessionKey: forked.key }
      }

      if (session.sessionFile === undefined) {
        throw new IpcFailure(
          'PI_COMMAND_FAILED',
          '当前会话还没有 session 文件，无法分叉；先发送一条消息再分叉'
        )
      }

      requireLaunchable()
      const sourceFile = session.sessionFile
      const sessionDir = options.sessionDir?.()
      const forked = await openReservedChannel(
        () =>
          options.connection.openChannel({
            cwd: session.cwd,
            extraArgs: ['--fork', sourceFile],
            ...(sessionDir === undefined ? {} : { sessionDir })
          }),
        (transport) =>
          registerSession(transport, session.cwd, {
            ...(session.model === undefined ? {} : { model: session.model })
          }),
        session.key
      )

      try {
        await readState(forked)
        emitStatus(forked, 'settled')
        return { sessionKey: forked.key }
      } catch (error) {
        await stopSession(forked, 'exited')
        throw error
      }
    },

    async prompt(input) {
      const session = requireSession(input.sessionKey)
      const images = input.images === undefined ? undefined : input.images.map(toImageContent)

      // busy 判定必须在锁内做：等锁期间会话可能已经从 idle 变成 streaming
      const data = await withLock(session, async () => {
        if (session.busy && input.streamingBehavior === undefined) {
          // §6.2 / §7 约束 5：busy 时必须显式选择 steer 或 followUp
          throw new IpcFailure(
            'SESSION_BUSY',
            '会话正在运行：请指定 streamingBehavior（steer = 插入当前步，followUp = 排到本轮之后）'
          )
        }
        const command: RpcCommand = {
          type: 'prompt',
          message: input.message,
          ...(images === undefined ? {} : { images }),
          // 空闲时不带 streamingBehavior：pi 只在流式中接受该字段
          ...(session.busy && input.streamingBehavior !== undefined
            ? { streamingBehavior: input.streamingBehavior }
            : {})
        }
        return sendCommand(session, command)
      })
      const disposition = readDisposition(data)
      if (disposition === undefined) {
        throw new IpcFailure(
          'PROTOCOL',
          'pi 的 prompt 响应缺少合法 disposition（started/queued/handled）',
          JSON.stringify(data).slice(0, 200)
        )
      }

      // disposition === 'handled'：扩展命令，本轮不会有 agent_settled（§6.2）
      if (disposition === 'started') {
        session.busy = true
        emitStatus(session, 'running')
      }
      return { disposition }
    },

    async abort(input) {
      const session = requireSession(input.sessionKey)
      // pi 的 abort 会等会话 idle 后才响应（docs/rpc-commands.md#abort）
      await withLock(session, () => sendCommand(session, { type: 'abort' }, settleTimeoutMs))
      session.busy = false
      emitStatus(session, 'settled')
      notifySettled(session)
      return { ok: true }
    },

    async dispose(input) {
      const session = requireSession(input.sessionKey)
      await stopSession(session, 'exited')
      return { ok: true }
    },

    async state(input) {
      const session = requireSession(input.sessionKey)
      return readState(session)
    },

    async stats(input) {
      const session = requireSession(input.sessionKey)
      const data = await withLock(session, () =>
        sendCommand(session, { type: 'get_session_stats' })
      )
      return toSessionStats(data)
    },

    async forkPoints(input) {
      const session = requireSession(input.sessionKey)
      const data = await withLock(session, () =>
        sendCommand(session, { type: 'get_fork_messages' })
      )
      return { points: toForkPoints(data) }
    },

    async listModels() {
      const idle = [...sessions.values()].find((session) => !session.busy && !session.closing)
      if (idle) {
        const data = await withLock(idle, () => sendCommand(idle, { type: 'get_available_models' }))
        return toModelList(data)
      }
      return withEphemeralTransport(async (transport) =>
        toModelList(await queryTransport(transport, { type: 'get_available_models' }))
      )
    },

    /** A23：改会话显示名（活跃会话）→ RPC `set_session_name`，由 pi 自己写进 JSONL */
    async setName(input) {
      const session = requireSession(input.sessionKey)
      const name = input.name.trim()
      if (name.length === 0) throw new IpcFailure('VALIDATION', '会话名不能为空')
      await withLock(session, async () => {
        await sendCommand(session, { type: 'set_session_name', name })
      })
      return { ok: true }
    },

    async setModel(input) {
      const session = requireSession(input.sessionKey)
      const { provider, modelId } = splitModelRef(input.model)
      await withLock(session, async () => {
        await sendCommand(session, { type: 'set_model', provider, modelId })
        if (input.thinkingLevel !== undefined) {
          await sendCommand(session, { type: 'set_thinking_level', level: input.thinkingLevel })
          session.thinkingLevel = input.thinkingLevel
        }
      })
      session.model = input.model
      return { ok: true }
    },

    async disposeAll() {
      clearInterval(reaper)
      await Promise.allSettled(
        [...sessions.values()].map((session) => stopSession(session, 'exited'))
      )
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数辅助
 * ------------------------------------------------------------------ */

/** `provider/id` → `set_model` 需要的两个字段（裸 id 无法确定 provider，直接拒绝） */
export function splitModelRef(model: string): { provider: string; modelId: string } {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) {
    throw new IpcFailure(
      'VALIDATION',
      `模型必须写成 provider/id 形式（例如 anthropic/claude-sonnet-4-5），收到：${model}`
    )
  }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
}

/** data URL → pi 的 ImageContent（`session:prompt` 的 images 约定用 data URL，避免裸 base64 的歧义） */
export function toImageContent(value: string): { type: 'image'; data: string; mimeType: string } {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value)
  const mimeType = match?.[1]
  const data = match?.[2]
  if (mimeType === undefined || data === undefined) {
    throw new IpcFailure(
      'VALIDATION',
      'images 只接受 data URL（data:image/png;base64,...）',
      value.slice(0, 32)
    )
  }
  return { type: 'image', data: data.replace(/\s+/g, ''), mimeType }
}

export function toModelInfo(value: unknown): ModelInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const parsed = modelInfoSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function toModelList(data: unknown): ModelInfo[] {
  const models = readArrayField(data, 'models') ?? (Array.isArray(data) ? data : [])
  return models.map(toModelInfo).filter((model): model is ModelInfo => model !== undefined)
}

/**
 * `get_session_stats` → `SessionStats`（docs/rpc-commands.md#get_session_stats）。
 *
 * 完全透传 pi 的数字，**不做任何本地估算**；pi 没给的字段就不填（UI 显示「—」）。
 */
export function toSessionStats(data: unknown): SessionStats {
  const record = toRecord(data)
  const tokens = toRecord(record['tokens'])
  const context = toRecord(record['contextUsage'])
  const tokenCount = (key: string): number => {
    const value = tokens[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const hasTokens = Object.keys(tokens).length > 0

  // contextUsage：pi 在刚 compaction 后会显式给 null，因此 null 也要原样保留（UI 显示「—」）
  const contextUsage: NonNullable<SessionStats['contextUsage']> = {}
  const contextTokens = numericOrNull(context['tokens'])
  if (contextTokens !== undefined) contextUsage.tokens = contextTokens
  if (typeof context['contextWindow'] === 'number')
    contextUsage.contextWindow = context['contextWindow']
  const contextPercent = numericOrNull(context['percent'])
  if (contextPercent !== undefined) contextUsage.percent = contextPercent

  return {
    userMessages: countOf(record['userMessages']),
    assistantMessages: countOf(record['assistantMessages']),
    toolCalls: countOf(record['toolCalls']),
    toolResults: countOf(record['toolResults']),
    totalMessages: countOf(record['totalMessages']),
    ...(hasTokens
      ? {
          tokens: {
            input: tokenCount('input'),
            output: tokenCount('output'),
            cacheRead: tokenCount('cacheRead'),
            cacheWrite: tokenCount('cacheWrite'),
            total: tokenCount('total')
          }
        }
      : {}),
    ...(typeof record['cost'] === 'number' && Number.isFinite(record['cost'])
      ? { cost: record['cost'] }
      : {}),
    ...(Object.keys(contextUsage).length > 0 ? { contextUsage } : {}),
    ...(typeof record['sessionFile'] === 'string' ? { sessionFile: record['sessionFile'] } : {}),
    ...(typeof record['sessionId'] === 'string' ? { sessionId: record['sessionId'] } : {})
  }
}

/** `get_fork_messages` → 可分叉点（只保留能用于 `fork` 的必要字段） */
export function toForkPoints(data: unknown): ForkPoint[] {
  const messages = readArrayField(data, 'messages') ?? []
  const points: ForkPoint[] = []
  for (const item of messages) {
    const record = toRecord(item)
    const entryId = record['entryId']
    if (typeof entryId !== 'string' || entryId.length === 0) continue
    const text = typeof record['text'] === 'string' ? record['text'] : ''
    points.push({ entryId, text })
  }
  return points
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** 数字或 null 都算「pi 明确给了值」；其余（缺失/字符串）视为未提供 */
function numericOrNull(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
