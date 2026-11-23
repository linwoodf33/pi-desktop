import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { EventChannel } from '../../src/shared/ipc-channels'
import type {
  DiagnosticEvent,
  ExtUiEvent,
  RecordEvent,
  StatusEvent
} from '../../src/shared/contracts/types'
import { classifyExtUi } from '../../src/shared/contracts/permission'
// 选项文案/顺序的单一来源是扩展侧协议模块
import { APPROVAL_OPTIONS } from '../../src/extensions/permission/protocol'
import type { ApprovalRequest } from '../../src/shared/contracts/permission'
import { IpcFailure } from '../../src/shared/contracts/result'
import { createExtUiRegistry } from '../../src/main/services/extui-registry'
import { createSessionService } from '../../src/main/services/session-service'
import { LocalConnection } from '../../src/main/transport/local-connection'

/**
 * 审批链路集成测试（M5，§9.2 I1 家族的审批版）。
 *
 * 真实要素：真实子进程 + 真实管道 + 真实 JsonlReader 分帧 + 真实 SessionService 登记表。
 * mock pi 用 `MOCK_PI_APPROVAL=1` 模拟扩展侧行为（先发 setStatus 握手，工具执行前发
 * `extension_ui_request{method:'select'}` 并阻塞等待）。
 *
 * 覆盖三条链路（验收要求）：
 * 1. 允许 → 工具真的执行（tool_execution_end / toolResult 为非错误）；
 * 2. 拒绝 → 工具**未执行**（toolResult 是「用户拒绝」，没有成功输出）；
 * 3. 超时 → 客户端回 cancel，扩展侧按拒绝处理，工具同样未执行。
 * 外加 S10：伪造 requestId / 跨会话回包在主进程被丢弃并记诊断。
 */

const mockPiPath = fileURLToPath(new URL('./fixtures/mock-pi.mjs', import.meta.url))

interface Harness {
  service: ReturnType<typeof createSessionService>
  connection: LocalConnection
  records: RecordEvent[]
  extUi: ExtUiEvent[]
  diagnostics: DiagnosticEvent[]
  statuses: StatusEvent[]
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>
}

function createHarness(env: Record<string, string> = {}): Harness {
  const records: RecordEvent[] = []
  const extUi: ExtUiEvent[] = []
  const diagnostics: DiagnosticEvent[] = []
  const statuses: StatusEvent[] = []

  const registry = createExtUiRegistry({
    onReject: (error, context) => {
      diagnostics.push({
        level: 'warn',
        message: `审批响应被丢弃：${error.code}（requestId=${context.requestId}）`
      })
    }
  })

  const connection = new LocalConnection({
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
      else if (channel === 'evt:extui') extUi.push(payload as ExtUiEvent)
      else if (channel === 'evt:diagnostic') diagnostics.push(payload as DiagnosticEvent)
      else if (channel === 'evt:status') statuses.push(payload as StatusEvent)
    },
    limits: () => ({ maxActiveSessions: 3, idleRecycleMinutes: 30 }),
    commandTimeoutMs: 15_000,
    settleTimeoutMs: 15_000,
    reaperIntervalMs: 10_000_000,
    textDeltaWindowMs: 1,
    extUiRegistry: registry
  })

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`等待条件超时（${timeoutMs}ms）`)
  }

  return { service, connection, records, extUi, diagnostics, statuses, waitFor }
}

/** 从 evt:extui 里取出第一条审批请求（并断言它确实是本扩展的 select） */
function firstApproval(events: ExtUiEvent[]): ApprovalRequest {
  for (const event of events) {
    const classified = classifyExtUi(event)
    if (classified.kind === 'approval') return classified.request
  }
  throw new Error('没有收到审批请求')
}

/** 工具结果（toolResult message_end）的文本与 isError */
function toolResults(records: RecordEvent[]): Array<{ text: string; isError: boolean }> {
  return records
    .filter((payload) => payload.record.type === 'message_end')
    .map(
      (payload) =>
        payload.record['message'] as { role?: string; content?: unknown; isError?: boolean }
    )
    .filter((message) => message?.role === 'toolResult')
    .map((message) => {
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .map((item) =>
          typeof item === 'object' && item !== null
            ? String((item as { text?: string }).text ?? '')
            : ''
        )
        .join('')
      return { text, isError: message.isError === true }
    })
}

describe('M5 审批链路：允许 → 工具执行', () => {
  it('推荐选项「允许一次」→ 工具正常执行并产出输出', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, records, extUi, waitFor } = harness

    const created = await service.create({ cwd: process.cwd(), name: '审批-允许' })
    await service.prompt({ sessionKey: created.sessionKey, message: '列出目录' })

    // 扩展先做版本握手
    await waitFor(() => extUi.some((event) => event.request['method'] === 'setStatus'))
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    const request = firstApproval(extUi)
    expect(request.meta.tool).toBe('bash')
    expect(request.meta.risk).toBe('high')
    expect(request.meta.summary).toBe('ls -la')

    // 用请求里给出的选项文案回答（renderer 也是这样做的）
    const allowOnce = request.options[request.meta.choices.indexOf('allow_once')]
    expect(allowOnce).toBeDefined()
    await service.respondExtUi({
      sessionKey: created.sessionKey,
      requestId: request.requestId,
      response: { kind: 'select', value: allowOnce ?? '' }
    })

    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
    const results = toolResults(records)
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(false)
    expect(results[0]?.text).toContain('a.txt')

    await service.dispose({ sessionKey: created.sessionKey })
  })

  it('审批请求带 options / timeout，且选项顺序与 choices 对齐', async () => {
    const harness = createHarness({
      MOCK_PI_APPROVAL: '1',
      MOCK_PI_TOOL: '1',
      MOCK_PI_APPROVAL_TIMEOUT_MS: '9000'
    })
    const { service, extUi, waitFor } = harness
    const created = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey: created.sessionKey, message: 'go' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    const request = firstApproval(extUi)
    expect(request.options).toEqual([...APPROVAL_OPTIONS])
    expect(request.meta.choices).toEqual(['allow_once', 'allow_session', 'deny'])
    expect(request.timeoutMs).toBe(9000)

    await service.respondExtUi({
      sessionKey: created.sessionKey,
      requestId: request.requestId,
      response: { kind: 'cancel' }
    })
    await service.dispose({ sessionKey: created.sessionKey })
  })
})

describe('M5 审批链路：拒绝 → 工具未执行', () => {
  it('回 cancelled → 工具被阻止，toolResult 是错误且没有真实输出', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, records, extUi, waitFor } = harness

    const created = await service.create({ cwd: process.cwd(), name: '审批-拒绝' })
    await service.prompt({ sessionKey: created.sessionKey, message: '列出目录' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    const request = firstApproval(extUi)
    await service.respondExtUi({
      sessionKey: created.sessionKey,
      requestId: request.requestId,
      response: { kind: 'cancel' }
    })

    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))
    const results = toolResults(records)
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.text).toContain('拒绝')
    // 工具没有真正执行：不出现 bash 的真实输出
    expect(results[0]?.text).not.toContain('a.txt')

    await service.dispose({ sessionKey: created.sessionKey })
  })
})

describe('M5 审批链路：超时 → 自动拒绝', () => {
  it('客户端侧到点回 cancel（等价扩展侧 120s 超时），工具未执行', async () => {
    const harness = createHarness({
      MOCK_PI_APPROVAL: '1',
      MOCK_PI_TOOL: '1',
      MOCK_PI_APPROVAL_TIMEOUT_MS: '1200'
    })
    const { service, records, extUi, waitFor } = harness

    const created = await service.create({ cwd: process.cwd(), name: '审批-超时' })
    await service.prompt({ sessionKey: created.sessionKey, message: '列出目录' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    // 完全不作答：等 pi 侧 timeout 到期（mock 用 1.2s，客户端 120s 语义一致只是数值缩小）
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'), 20_000)

    const results = toolResults(records)
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(results[0]?.text).toContain('拒绝')

    await service.dispose({ sessionKey: created.sessionKey })
  })
})

describe('M5 安全：伪造 / 跨会话 / 过期响应被丢弃（S9/S10）', () => {
  it('伪造 requestId → REQUEST_NOT_FOUND，且不写任何东西进 pi', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, extUi, waitFor, diagnostics } = harness
    const created = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey: created.sessionKey, message: 'go' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    await expect(
      service.respondExtUi({
        sessionKey: created.sessionKey,
        requestId: 'forged-request-id',
        response: { kind: 'cancel' }
      })
    ).rejects.toBeInstanceOf(IpcFailure)

    expect(diagnostics.some((item) => item.message.includes('forged-request-id'))).toBe(true)
    await service.dispose({ sessionKey: created.sessionKey })
  })

  it('跨会话：用真实 requestId 但换一个 sessionKey → 拒绝，原请求仍可正常作答', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, records, extUi, waitFor } = harness
    const first = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey: first.sessionKey, message: 'go' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))
    const request = firstApproval(extUi)

    // 另开一个会话（真实存在），用它去回答第一个会话的请求
    const second = await service.create({ cwd: process.cwd() })
    await expect(
      service.respondExtUi({
        sessionKey: second.sessionKey,
        requestId: request.requestId,
        response: { kind: 'cancel' }
      })
    ).rejects.toBeInstanceOf(IpcFailure)

    // 原会话仍能正常作答（没被别人的失败尝试消耗掉）
    await service.respondExtUi({
      sessionKey: first.sessionKey,
      requestId: request.requestId,
      response: { kind: 'cancel' }
    })
    await waitFor(() => records.some((payload) => payload.record.type === 'agent_settled'))

    await service.dispose({ sessionKey: first.sessionKey })
    await service.dispose({ sessionKey: second.sessionKey })
  })

  it('不在选项内的取值 → 拒绝（防伪造非预期响应）', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, extUi, waitFor } = harness
    const created = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey: created.sessionKey, message: 'go' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))
    const request = firstApproval(extUi)

    await expect(
      service.respondExtUi({
        sessionKey: created.sessionKey,
        requestId: request.requestId,
        response: { kind: 'select', value: '我要全部权限' }
      })
    ).rejects.toBeInstanceOf(IpcFailure)

    await service.dispose({ sessionKey: created.sessionKey })
  })
})

describe('M5：会话销毁时对所有未决请求回拒绝', () => {
  it('dispose 会把未决审批按取消处理，并记一条诊断', async () => {
    const harness = createHarness({ MOCK_PI_APPROVAL: '1', MOCK_PI_TOOL: '1' })
    const { service, extUi, waitFor, diagnostics } = harness
    const created = await service.create({ cwd: process.cwd() })
    await service.prompt({ sessionKey: created.sessionKey, message: 'go' })
    await waitFor(() => extUi.some((event) => classifyExtUi(event).kind === 'approval'))

    await service.dispose({ sessionKey: created.sessionKey })

    expect(
      diagnostics.some(
        (item) => item.message.includes('已拒绝') && item.message.includes('未决审批')
      )
    ).toBe(true)
  })
})
