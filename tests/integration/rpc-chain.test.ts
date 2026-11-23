import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { EventChannel } from '../../src/shared/ipc-channels'
import type { RecordEvent, RunStatus, StatusEvent } from '../../src/shared/contracts/types'
import { createSessionHistory } from '../../src/main/services/session-history'
import { createSessionService } from '../../src/main/services/session-service'
import { LocalConnection, LocalTransport } from '../../src/main/transport/local-connection'

/**
 * 集成链路（§8.1 M2 交付判定 + §9.2 I1/I2/I4）：
 * 创建会话 → 发一句 → 流式收完 → agent_settled → 优雅退出。
 *
 * 用 `tests/integration/fixtures/mock-pi.mjs` 按协议回放记录；
 * 走的是真实子进程 + 真实管道 + 真实 JsonlReader 分帧（不用 readline）。
 */

const mockPiPath = fileURLToPath(new URL('./fixtures/mock-pi.mjs', import.meta.url))

interface Harness {
  service: ReturnType<typeof createSessionService>
  connection: LocalConnection
  records: RecordEvent[]
  /** evt:status 载荷（带 sessionKey） */
  statusEvents: StatusEvent[]
  /** 只取状态串，保持旧断言写法可读 */
  statuses: RunStatus[]
  diagnostics: Array<{ level: string; message: string; stderrTail?: string }>
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>
}

function createHarness(
  env: Record<string, string> = {},
  limits?: { maxActiveSessions: number }
): Harness {
  const records: RecordEvent[] = []
  const statusEvents: StatusEvent[] = []
  const statuses: RunStatus[] = []
  const diagnostics: Array<{ level: string; message: string; stderrTail?: string }> = []

  const connection = new LocalConnection({
    // mock 用 node 直接跑脚本：等价于「解析出的 pi 启动命令」
    resolveLaunch: () =>
      Promise.resolve({
        command: process.execPath,
        prefixArgs: [mockPiPath],
        displayPath: mockPiPath
      }),
    baseEnv: { ...process.env, ...env }
  })

  const service = createSessionService({
    connection,
    emit: (channel: EventChannel, payload: unknown) => {
      if (channel === 'evt:record') records.push(payload as RecordEvent)
      else if (channel === 'evt:status') {
        statusEvents.push(payload as StatusEvent)
        statuses.push((payload as StatusEvent).status)
      } else if (channel === 'evt:diagnostic') {
        diagnostics.push(payload as { level: string; message: string; stderrTail?: string })
      }
    },
    limits: () => ({ maxActiveSessions: limits?.maxActiveSessions ?? 3, idleRecycleMinutes: 30 }),
    commandTimeoutMs: 10_000,
    settleTimeoutMs: 10_000,
    reaperIntervalMs: 10_000_000,
    textDeltaWindowMs: 16
  })

  const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`等待条件超时（${timeoutMs}ms）`)
  }

  return { service, connection, records, statuses, statusEvents, diagnostics, waitFor }
}

describe('M2 集成链路：创建会话 → 一句话 → 流式 → agent_settled → 优雅退出', () => {
  it('完整跑通并保持事件顺序（I1）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'Hello from mock pi' })
    const { service, records, statuses, waitFor } = harness

    const created = await service.create({ cwd: process.cwd(), name: '集成测试' })
    expect(created.sessionKey).toBeTruthy()

    const prompt = await service.prompt({ sessionKey: created.sessionKey, message: '你好' })
    expect(prompt.disposition).toBe('started')

    // 完成只认 agent_settled（不是 agent_end，也不是 prompt 的响应）
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
    await waitFor(() => statuses.filter((status) => status === 'settled').length >= 2)

    const types = records.map((payload) => payload.record.type)
    expect(types).toContain('agent_start')
    expect(types).toContain('agent_end')
    expect(types.at(-1)).toBe('agent_settled')
    expect(types.indexOf('agent_start')).toBeLessThan(types.indexOf('agent_end'))
    expect(types.indexOf('agent_end')).toBeLessThan(types.indexOf('agent_settled'))

    // 流式增量被合并后拼接成完整文本
    const deltas = records
      .map((payload) => payload.record['assistantMessageEvent'])
      .filter((inner): inner is { type: string; delta: string } => {
        return (
          typeof inner === 'object' &&
          inner !== null &&
          (inner as { type?: string }).type === 'text_delta'
        )
      })
      .map((inner) => inner.delta)
    expect(deltas.join('')).toBe('Hello from mock pi')

    // 权威 message_end 覆盖增量
    const assistantEnd = records.find(
      (payload) =>
        payload.record.type === 'message_end' &&
        (payload.record['message'] as { role?: string } | undefined)?.role === 'assistant'
    )
    expect(assistantEnd).toBeDefined()
    const authoritative = (assistantEnd?.record['message'] as { content: Array<{ text: string }> })
      .content[0]?.text
    expect(authoritative).toBe('Hello from mock pi')

    // session 状态：settled 且拿到 pi 侧 sessionFile/sessionId
    const state = await service.state({ sessionKey: created.sessionKey })
    expect(state.busy).toBe(false)
    expect(state.messageCount).toBeGreaterThanOrEqual(0)
    expect(state.sessionId).toBe('mock-session-0001')

    // 优雅退出：关 stdin → 进程自己 exit(0)；正常退出不产生错误诊断（§6.4）
    await service.disposeAll()
    expect(service.keys()).toHaveLength(0)
    expect(harness.statuses).toContain('exited')
    expect(harness.diagnostics).toHaveLength(0)
  })

  it('LocalTransport 层面：优雅退出后 stderr 尾部可读（§6.4 诊断来源）', async () => {
    const transport = new LocalTransport({
      channelId: 'it#stderr',
      launch: { command: process.execPath, prefixArgs: [mockPiPath] },
      gracefulExitTimeoutMs: 5000
    })
    const records: Array<{ type: string }> = []
    transport.onRecord((record) => records.push({ type: record.type }))

    await transport.start({ cwd: process.cwd() })
    transport.send({ type: 'get_state' }, 'q1')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(records.some((record) => record.type === 'response')).toBe(true)

    const exit = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
      transport.onExit((info) => resolve(info))
    })
    await transport.stop()
    const info = await exit

    expect(info.code).toBe(0)
    expect(info.stderrTail).toContain('stdin closed')
    expect(info.stderrTail).toContain('mock-pi rpc ready')
  })

  it('busy 时无 streamingBehavior → 明确报错而不是挂起（I2）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'a b c d e f g h', MOCK_PI_DELAY_MS: '40' })
    const { service, waitFor } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: 'first' })

    // 等第一个 agent_start 到达，确认真的在流式中
    await waitFor(() => harness.records.some((payload) => payload.record.type === 'agent_start'))

    await expect(service.prompt({ sessionKey, message: 'second' })).rejects.toMatchObject({
      code: 'SESSION_BUSY'
    })

    // 带 followUp 的排队请求被接受
    const queued = await service.prompt({
      sessionKey,
      message: 'queued',
      streamingBehavior: 'followUp'
    })
    expect(queued.disposition).toBe('queued')

    await service.disposeAll()
  })

  it('运行中 abort → 回到 idle，进程仍可继续使用（I4）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'x y z w', MOCK_PI_DELAY_MS: '30' })
    const { service, waitFor } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: 'long running' })
    await waitFor(() => harness.records.some((payload) => payload.record.type === 'agent_start'))

    await expect(service.abort({ sessionKey })).resolves.toEqual({ ok: true })
    const state = await service.state({ sessionKey })
    expect(state.busy).toBe(false)

    // abort 的事件序列与真实 pi 对齐（docs/json.md）：
    // message_end(assistant, stopReason='aborted') → turn_end → agent_end → agent_settled{aborted:true}
    const abortedTypes = harness.records.map((payload) => payload.record.type)
    const abortedMessageEnd = harness.records.find(
      (payload) =>
        payload.record.type === 'message_end' &&
        (payload.record['message'] as { role?: string; stopReason?: string } | undefined)
          ?.stopReason === 'aborted'
    )
    expect(abortedMessageEnd).toBeDefined()
    expect(abortedTypes).toContain('turn_end')
    const settled = harness.records.filter((payload) => payload.record.type === 'agent_settled')
    expect(settled).toHaveLength(1)
    expect(settled[0]?.record['aborted']).toBe(true)

    // 进程仍可继续对话
    const again = await service.prompt({ sessionKey, message: 'after abort' })
    expect(again.disposition).toBe('started')

    await service.disposeAll()
  })

  it('model:list 返回 mock 的模型清单', async () => {
    const harness = createHarness()
    const models = await harness.service.listModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'mock-model', provider: 'mock' })
    await harness.service.disposeAll()
  })
})

/**
 * 并行多会话（§D3「一会话一子进程」/ §10 A8「3 个活跃会话」/ §9.2 I8 等价场景）。
 *
 * 这是当初阻塞问题 #1 的回归门槛：必须用**真实 LocalConnection**，
 * 不能用 FakeConnection 绕过状态机。
 */
describe('M2 集成链路：并行多会话（真实 LocalConnection）', () => {
  it('并行创建 3 个会话 → 各自 prompt → 各自 settled', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'par ok', MOCK_PI_DELAY_MS: '10' })
    const { service, connection, records, waitFor, diagnostics } = harness

    const created = await Promise.all([
      service.create({ cwd: process.cwd(), name: '并行-1' }),
      service.create({ cwd: process.cwd(), name: '并行-2' }),
      service.create({ cwd: process.cwd(), name: '并行-3' })
    ])

    expect(new Set(created.map((item) => item.sessionKey)).size).toBe(3)
    expect(service.keys()).toHaveLength(3)
    expect(connection.state()).toBe('ready')
    // mock 每个进程都回同一个 sessionId，这里关键是三个通道都真的起来了
    expect(created.every((item) => item.sessionId === 'mock-session-0001')).toBe(true)

    const settledCount = (sessionKey: string): number =>
      records.filter(
        (payload) => payload.sessionKey === sessionKey && payload.record.type === 'agent_settled'
      ).length

    const dispositions = await Promise.all(
      created.map((item) => service.prompt({ sessionKey: item.sessionKey, message: 'hi' }))
    )
    expect(dispositions.map((item) => item.disposition)).toEqual(['started', 'started', 'started'])

    await waitFor(() => created.every((item) => settledCount(item.sessionKey) >= 1))

    // 每个会话的流式文本都完整，且事件不串会话
    for (const item of created) {
      const text = records
        .filter((payload) => payload.sessionKey === item.sessionKey)
        .map((payload) => payload.record['assistantMessageEvent'])
        .filter(
          (inner): inner is { type: string; delta: string } =>
            typeof inner === 'object' &&
            inner !== null &&
            (inner as { type?: string }).type === 'text_delta'
        )
        .map((inner) => inner.delta)
        .join('')
      expect(text).toBe('par ok')
    }

    // 三个会话各自处于 settled
    const states = await Promise.all(
      created.map((item) => service.state({ sessionKey: item.sessionKey }))
    )
    expect(states.every((state) => state.busy === false && state.status === 'settled')).toBe(true)

    // evt:status 带 sessionKey：三个会话各自都发过 starting/settled
    for (const item of created) {
      const own = harness.statusEvents.filter((event) => event.sessionKey === item.sessionKey)
      expect(own.map((event) => event.status)).toContain('starting')
      expect(own.map((event) => event.status)).toContain('settled')
    }

    await service.disposeAll()
    expect(service.keys()).toHaveLength(0)
    expect(diagnostics).toHaveLength(0)
  })

  it('I8：3 个会话都在跑（无空闲可回收）时第 4 个被拒绝', async () => {
    const harness = createHarness(
      { MOCK_PI_REPLY: 'a b c d e f g h', MOCK_PI_DELAY_MS: '80' },
      { maxActiveSessions: 3 }
    )
    const { service, connection, waitFor } = harness

    const created = await Promise.all([
      service.create({ cwd: process.cwd() }),
      service.create({ cwd: process.cwd() }),
      service.create({ cwd: process.cwd() })
    ])
    expect(service.keys()).toHaveLength(3)

    // 让三个会话都进入流式（busy），此时没有可回收的空闲会话
    await Promise.all(
      created.map((item) => service.prompt({ sessionKey: item.sessionKey, message: 'busy' }))
    )
    await waitFor(() =>
      created.every((item) =>
        harness.records.some(
          (payload) =>
            payload.sessionKey === item.sessionKey && payload.record.type === 'agent_start'
        )
      )
    )

    await expect(service.create({ cwd: process.cwd() })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED'
    })
    expect(service.keys()).toHaveLength(3)
    expect(connection.state()).toBe('ready')

    await service.disposeAll()
  })

  it('I8：并发 4 个 create 也不突破上限（占位生效）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'ok' }, { maxActiveSessions: 3 })
    const { service } = harness

    const results = await Promise.allSettled([
      service.create({ cwd: process.cwd() }),
      service.create({ cwd: process.cwd() }),
      service.create({ cwd: process.cwd() }),
      service.create({ cwd: process.cwd() })
    ])

    // 允许两种收敛方式：拒绝（LIMIT_EXCEEDED）或回收空闲旧会话后创建；
    // 不变量是「活跃会话数绝不超过上限」，这是 I8 真正要保证的。
    expect(service.keys().length).toBeLessThanOrEqual(3)
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected'
    )
    for (const item of rejected) {
      expect(item.reason).toMatchObject({ code: 'LIMIT_EXCEEDED' })
    }

    await service.disposeAll()
  })
})

/** 失败后免重启恢复（§3.3 三步 / §10 A12）：长在真实 LocalConnection 上 */
describe('M2 集成链路：失败后重新定位即可恢复（真实 LocalConnection）', () => {
  it('首次 create 失败（failed）→ 重新 resolveLaunch 成功 → create 成功', async () => {
    let attempts = 0
    const connection = new LocalConnection({
      resolveLaunch: () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(new Error('ENOENT: pi 不在 PATH 里'))
        }
        return Promise.resolve({ command: process.execPath, prefixArgs: [mockPiPath] })
      }
    })
    const service = createSessionService({
      connection,
      emit: () => {},
      limits: () => ({ maxActiveSessions: 3, idleRecycleMinutes: 30 }),
      commandTimeoutMs: 10_000,
      settleTimeoutMs: 10_000,
      reaperIntervalMs: 10_000_000
    })

    await expect(service.create({ cwd: process.cwd() })).rejects.toThrowError(/ENOENT/)
    expect(connection.state()).toBe('failed')

    // 用户修正 pi 路径（等价于 pi:locate 成功后 resolveLaunch 可用）——无需重启应用
    const created = await service.create({ cwd: process.cwd() })
    expect(created.sessionKey).toBeTruthy()
    expect(connection.state()).toBe('ready')
    expect(service.keys()).toHaveLength(1)

    await service.disposeAll()
  })
})

/**
 * 真实 pi 链路（可选，默认跳过）：
 *   PI_DESKTOP_REAL_PI=1 npm run test:integration
 *
 * 走真实 pi 子进程（`pi --mode rpc`），验证定位 → 建会话 → 一句话 → 流式 → agent_settled
 * → 优雅退出。会消耗一次真实模型调用，因此不作为默认用例。
 */
const realPi = process.env['PI_DESKTOP_REAL_PI'] === '1'

describe.skipIf(!realPi)('真实 pi 链路（PI_DESKTOP_REAL_PI=1）', () => {
  it('定位 pi → 建会话 → 一句话 → 流式 → settled → 退出', async () => {
    const { createPiLocator } = await import('../../src/main/services/pi-locator')
    const locator = createPiLocator()
    const status = await locator.locate()
    process.stdout.write(`[real-pi] 自检: ${JSON.stringify(status)}\n`)
    expect(status.state).toBe('ok')

    const launch = locator.launch()
    expect(launch).toBeDefined()
    const records: RecordEvent[] = []
    const statuses: RunStatus[] = []
    const diagnostics: Array<{ level: string; message: string; stderrTail?: string }> = []

    const connection = new LocalConnection({
      resolveLaunch: () => Promise.resolve(launch as NonNullable<typeof launch>)
    })
    const service = createSessionService({
      connection,
      emit: (channel, payload) => {
        if (channel === 'evt:record') records.push(payload as RecordEvent)
        else if (channel === 'evt:status') statuses.push(payload as RunStatus)
        else if (channel === 'evt:diagnostic') diagnostics.push(payload as never)
      },
      limits: () => ({ maxActiveSessions: 1, idleRecycleMinutes: 30 }),
      commandTimeoutMs: 120_000,
      settleTimeoutMs: 180_000,
      reaperIntervalMs: 10_000_000
    })

    const cwd = await mkdtemp(join(tmpdir(), 'pi-desktop-real-'))
    let created: { sessionKey: string; sessionId: string }
    try {
      created = await service.create({ cwd, name: 'pi-desktop M2 真实链路' })
    } catch (error) {
      process.stdout.write(`[real-pi] create 失败: ${String(error)}
`)
      process.stdout.write(`[real-pi] 诊断=${JSON.stringify(diagnostics, null, 2)}
`)
      throw error
    }
    const prompt = await service.prompt({
      sessionKey: created.sessionKey,
      message: '只回复两个字符：OK（不要使用任何工具）'
    })
    process.stdout.write(
      `[real-pi] sessionKey=${created.sessionKey} sessionId=${created.sessionId}\n`
    )
    process.stdout.write(`[real-pi] disposition=${prompt.disposition}\n`)

    const deadline = Date.now() + 180_000
    let text = ''
    while (Date.now() < deadline) {
      text = records
        .map((payload) => payload.record)
        .filter((record) => record.type === 'message_update')
        .map((record) => {
          const inner = record['assistantMessageEvent'] as { type?: string; delta?: string }
          return inner.type === 'text_delta' ? (inner.delta ?? '') : ''
        })
        .join('')
      if (records.some((payload) => payload.record.type === 'agent_settled')) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const settled = records.some((payload) => payload.record.type === 'agent_settled')
    process.stdout.write(`[real-pi] agent_settled=${settled} 流式文本=${JSON.stringify(text)}\n`)
    process.stdout.write(`[real-pi] status 序列=${JSON.stringify(statuses)}\n`)
    process.stdout.write(`[real-pi] 诊断=${JSON.stringify(diagnostics)}\n`)

    expect(settled).toBe(true)
    expect(text.length).toBeGreaterThan(0)

    await service.disposeAll()
    expect(service.keys()).toHaveLength(0)
    await rm(cwd, { recursive: true, force: true })
  }, 240_000)
})

/**
 * M4 集成：mock pi 保真度补齐后的 steer / followUp / stats / fork（§9.2 I3）。
 *
 * 这些用例同时验证「客户端没有自己编造语义」：所有断言都来自 mock 按 pi 文档回放的协议记录。
 */
describe('M4 集成链路：steer / followUp 真正生效（I3）', () => {
  it('followUp 在本轮 settled 之后被真正执行', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'a b c d e f', MOCK_PI_DELAY_MS: '30' })
    const { service, records, waitFor } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: '第一句' })
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_start'))

    const queued = await service.prompt({
      sessionKey,
      message: '排队的一句',
      streamingBehavior: 'followUp'
    })
    expect(queued.disposition).toBe('queued')

    // 第一轮 settled 之后，mock 会把排队的 prompt 当成下一轮真正跑起来
    await waitFor(
      () => records.filter((payload) => payload.record.type === 'agent_start').length >= 2
    )
    const userTexts = records
      .filter((payload) => payload.record.type === 'message_end')
      .map((payload) => payload.record['message'] as { role?: string; content?: unknown })
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
    expect(userTexts).toContain('第一句')
    expect(userTexts).toContain('排队的一句')

    await waitFor(
      () => records.filter((payload) => payload.record.type === 'agent_settled').length >= 2
    )
    await service.disposeAll()
  })

  it('steer 立即插入当前轮（用户消息当轮可见），不等 settled', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'a b c d e f g h', MOCK_PI_DELAY_MS: '40' })
    const { service, records, waitFor } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: '开始' })
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_start'))

    const steered = await service.prompt({
      sessionKey,
      message: '顺便看下日志',
      streamingBehavior: 'steer'
    })
    expect(steered.disposition).toBe('queued')

    // 当轮内就能看到这条用户消息（不是等下一轮）
    await waitFor(() => {
      const settledCount = records.filter(
        (payload) => payload.record.type === 'agent_settled'
      ).length
      const hasSteer = records.some(
        (payload) =>
          payload.record.type === 'message_end' &&
          (payload.record['message'] as { role?: string; content?: unknown }).role === 'user' &&
          (payload.record['message'] as { content?: unknown }).content === '顺便看下日志'
      )
      return hasSteer && settledCount === 0
    })

    // 只有一轮（steer 不新起一轮）
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
    expect(records.filter((payload) => payload.record.type === 'agent_settled')).toHaveLength(1)
    await service.disposeAll()
  })
})

describe('M4 集成链路：session:stats / session:forkPoints / fork', () => {
  it('stats 透传 mock 的 token/成本（客户端不估算）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'ok', MOCK_PI_DELAY_MS: '5' })
    const { service, waitFor, records } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: '一句话' })
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))

    const stats = await service.stats({ sessionKey })
    expect(stats.tokens?.input).toBeGreaterThan(0)
    expect(stats.cost).toBeGreaterThan(0)
    expect(stats.contextUsage?.contextWindow).toBe(128000)
    await service.disposeAll()
  })

  it('forkPoints 列出用户消息；fork 后通道移交、新会话文件、原文件不变（A4）', async () => {
    const harness = createHarness({ MOCK_PI_REPLY: 'ok', MOCK_PI_DELAY_MS: '5' })
    const { service, waitFor, records } = harness

    const { sessionKey } = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey, message: '第一句' })
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
    await service.prompt({ sessionKey, message: '第二句' })
    await waitFor(
      () => records.filter((payload) => payload.record.type === 'agent_settled').length >= 2
    )

    const points = await service.forkPoints({ sessionKey })
    expect(points.points.map((point) => point.text)).toEqual(['第一句', '第二句'])

    const before = await service.state({ sessionKey })
    const forked = await service.fork({ sessionKey, entryId: points.points[1]?.entryId ?? '' })

    // 通道移交：旧 key 释放，新 key 接管
    expect(forked.sessionKey).not.toBe(sessionKey)
    expect(service.keys()).toEqual([forked.sessionKey])

    const after = await service.state({ sessionKey: forked.sessionKey })
    // 新会话文件由 pi 另存，原会话文件路径不再被当前会话使用（A4：不写回原文件）
    expect(after.sessionFile).not.toBe(before.sessionFile)
    expect(after.sessionFile).toContain('fork')
    await service.disposeAll()
  })
})

/**
 * M4 复核修复 B1 的**真实链路**回归（session-service → mock pi → session-history）。
 *
 * 背景：pi 从**第一条用户消息**分叉时 `targetLeafId = null` → `newSession({parentSession})` 得到
 * 空会话，新会话文件直到下一条 prompt 才落盘。旧实现里 renderer 立刻回放 → `PATH_DENIED`
 * → 误导性错误条（真实 pi 1.5.2 已复现）。
 *
 * 这里走真实主进程服务 + 真实子进程 + 真实 JSONL 读取，断言：
 * ① 不给 `allowMissing` 时仍是 `PATH_DENIED`（fail-closed 语义没被放宽）；
 * ② fork 编排给的 `allowMissing: true` 把它当空会话（`fileAbsent: true`，不抛错）；
 * ③ 文件落盘后同一路径可正常回放（模拟 pi 的懒落盘：mock 不写文件，由用例写入）。
 */
describe('M4 集成链路（B1）：从首条用户消息分叉 = 空会话、文件未落盘', () => {
  it('allowMissing 才按空会话返回；落盘后可正常回放', async () => {
    const sessionRoot = await mkdtemp(join(tmpdir(), 'pi-fork-history-'))
    const groupDir = join(sessionRoot, '--work--')
    await mkdir(groupDir, { recursive: true })
    const mockSessionFile = join(groupDir, 'mock-session.jsonl')

    const harness = createHarness({
      MOCK_PI_REPLY: 'ok',
      MOCK_PI_DELAY_MS: '5',
      MOCK_PI_SESSION_FILE: mockSessionFile
    })
    const { service, records, waitFor } = harness
    const history = createSessionHistory({ sessionRoot: () => sessionRoot })

    try {
      const { sessionKey } = await service.create({ cwd: process.cwd() })
      await service.prompt({ sessionKey, message: '第一句' })
      await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
      await service.prompt({ sessionKey, message: '第二句' })
      await waitFor(
        () => records.filter((payload) => payload.record.type === 'agent_settled').length >= 2
      )

      const points = await service.forkPoints({ sessionKey })
      expect(points.points.map((point) => point.text)).toEqual(['第一句', '第二句'])

      // 从**第一条**用户消息分叉：pi 建空会话（新 sessionFile 懒落盘）
      const forked = await service.fork({ sessionKey, entryId: points.points[0]?.entryId ?? '' })
      const forkedState = await service.state({ sessionKey: forked.sessionKey })
      const forkedFile = forkedState.sessionFile
      expect(forkedFile).toBeDefined()
      expect(forkedFile).toContain('fork')

      // 前提确认：fork 之后文件确实还不存在（这就是 B1 的触发条件）
      await expect(stat(forkedFile as string)).rejects.toMatchObject({ code: 'ENOENT' })

      // ① fail-closed 未被放宽：普通回放依旧 PATH_DENIED
      await expect(history.read({ sessionFile: forkedFile as string })).rejects.toMatchObject({
        code: 'PATH_DENIED'
      })

      // ② fork 编排（allowMissing）→ 空会话，不抛错、不伪造 truncated
      const empty = await history.read({
        sessionFile: forkedFile as string,
        allowMissing: true
      })
      expect(empty).toEqual({
        records: [],
        truncated: false,
        messageCount: 0,
        totalRecords: 0,
        fileAbsent: true
      })

      // ③ 发消息后文件落盘（mock 不持久化，这里模拟 pi 的懒落盘）→ 正常回放
      await service.prompt({ sessionKey: forked.sessionKey, message: '分叉后的第一句' })
      await waitFor(
        () => records.filter((payload) => payload.record.type === 'agent_settled').length >= 3
      )
      await writeFile(
        forkedFile as string,
        [
          JSON.stringify({
            type: 'session',
            version: 3,
            id: 'fork-empty-1',
            timestamp: '2026-11-20T00:00:00.000Z',
            cwd: process.cwd()
          }),
          JSON.stringify({
            type: 'message',
            id: 'f1',
            parentId: null,
            timestamp: '2026-11-20T00:00:01.000Z',
            message: { role: 'user', content: '分叉后的第一句', timestamp: 1735689601000 }
          }),
          ''
        ].join('\n'),
        'utf8'
      )

      const after = await history.read({ sessionFile: forkedFile as string })
      expect(after.fileAbsent).toBeUndefined()
      expect(after.messageCount).toBe(1)
      expect((after.records[0]?.['message'] as { content?: string } | undefined)?.content).toBe(
        '分叉后的第一句'
      )
    } finally {
      await service.disposeAll()
      await rm(sessionRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
