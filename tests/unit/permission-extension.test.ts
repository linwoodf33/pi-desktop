import { describe, expect, it } from 'vitest'

import piDesktopPermission, { blocked, decide } from '../../src/extensions/permission/index'
import { APPROVAL_OPTIONS, type PermissionPolicy } from '../../src/extensions/permission/protocol'
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  LifecycleHandler,
  ToolCallHandler,
  ToolCallEventLike,
  ToolCallResultLike
} from '../../src/extensions/permission/types'

/**
 * 扩展侧行为测试（M5）：`tool_call` 前置钩子的每个分支都必须 fail-closed。
 *
 * 覆盖矩阵（§8.1 M5 / §9.1）：
 * 允许一次 / 本会话允许 / 拒绝 / 超时（undefined）/ 未预期取值 / 抛异常 / 无 UI /
 * 策略关闭 / 工具不在清单 / 本会话允许的作用域（同会话复用、跨会话失效）。
 *
 * 用结构化的假 ExtensionAPI 直接驱动工厂，不启动 pi（真实 pi 链路另见集成测试）。
 */

interface Harness {
  handlers: {
    tool_call: ToolCallHandler[]
    session_start: LifecycleHandler[]
    session_shutdown: LifecycleHandler[]
  }
  asks: Array<{ title: string; options: string[]; timeout?: number }>
  statuses: Array<{ key: string; text: string | undefined }>
}

function createPi(policy: PermissionPolicy | undefined): Harness {
  const harness: Harness = {
    handlers: { tool_call: [], session_start: [], session_shutdown: [] },
    asks: [],
    statuses: []
  }
  const api: ExtensionApiLike = {
    on(event: string, handler: never) {
      ;(harness.handlers as unknown as Record<string, unknown[]>)[event] ??= []
      ;(harness.handlers as unknown as Record<string, unknown[]>)[event]?.push(handler)
    }
  }
  piDesktopPermission(api, {
    readPolicy: () => policy ?? defaultPolicy()
  })
  return harness
}

function defaultPolicy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    enabled: true,
    tools: ['bash', 'powershell', 'write', 'edit'],
    timeoutMs: 120_000,
    clientProtocol: 1,
    compatible: true,
    ...overrides
  }
}

interface CtxOptions {
  choice?: string | undefined
  hasUI?: boolean
  throws?: boolean
  sessionId?: string
}

function createCtx(harness: Harness, options: CtxOptions = {}): ExtensionContextLike {
  return {
    hasUI: options.hasUI ?? true,
    sessionManager: { getSessionId: () => options.sessionId ?? 'sess-1' },
    ui: {
      select: (title, opts, dialogOptions) => {
        harness.asks.push({
          title,
          options: opts,
          ...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout })
        })
        if (options.throws === true) return Promise.reject(new Error('ui boom'))
        return Promise.resolve(options.choice)
      },
      setStatus: (key, text) => {
        harness.statuses.push({ key, text })
      }
    }
  }
}

function bashEvent(command = 'ls -la'): ToolCallEventLike {
  return { type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: { command } }
}

async function runToolCall(
  harness: Harness,
  ctx: ExtensionContextLike,
  event: ToolCallEventLike = bashEvent()
): Promise<ToolCallResultLike | undefined> {
  const handler = harness.handlers.tool_call[0]
  if (handler === undefined) throw new Error('tool_call 处理器未注册')
  return handler(event, ctx)
}

function expectBlocked(result: ToolCallResultLike | undefined): void {
  expect(result).toBeDefined()
  expect(result?.block).toBe(true)
}

describe('decision 映射（不是「允许」就是「拒绝」）', () => {
  it('三个已知选项 + 一切异常取值', () => {
    expect(decide(APPROVAL_OPTIONS[0])).toBe('allow_once')
    expect(decide(APPROVAL_OPTIONS[1])).toBe('allow_session')
    expect(decide(APPROVAL_OPTIONS[2])).toBe('deny')
    expect(decide(undefined)).toBe('deny')
    expect(decide('随便写的值')).toBe('deny')
    expect(decide('')).toBe('deny')
  })

  it('blocked() 返回结构化阻止结果', () => {
    expect(blocked('reason')).toEqual({ block: true, reason: 'reason' })
  })
})

describe('tool_call 钩子：允许路径', () => {
  it('「允许一次」→ 不阻止执行', async () => {
    const harness = createPi(defaultPolicy())
    const result = await runToolCall(harness, createCtx(harness, { choice: APPROVAL_OPTIONS[0] }))
    expect(result).toBeUndefined()
    expect(harness.asks).toHaveLength(1)
    // 审批时钟随请求下发（扩展侧权威判定，§6.3）
    expect(harness.asks[0]?.timeout).toBe(120_000)
    expect(harness.asks[0]?.options).toEqual([...APPROVAL_OPTIONS])
  })

  it('「本会话允许」→ 本会话内同工具不再询问', async () => {
    const harness = createPi(defaultPolicy())
    const ctx = createCtx(harness, { choice: APPROVAL_OPTIONS[1] })

    expect(await runToolCall(harness, ctx)).toBeUndefined()
    expect(harness.asks).toHaveLength(1)

    // 同会话第二次：不再询问，直接放行
    expect(await runToolCall(harness, ctx)).toBeUndefined()
    expect(harness.asks).toHaveLength(1)

    // 另一个工具仍要问
    await runToolCall(harness, ctx, { type: 'tool_call', toolName: 'write', input: { path: 'a' } })
    expect(harness.asks).toHaveLength(2)
  })

  it('「本会话允许」不跨会话：sessionId 变化后重新询问', async () => {
    const harness = createPi(defaultPolicy())
    const sessionA = createCtx(harness, { choice: APPROVAL_OPTIONS[1], sessionId: 'sess-A' })
    await runToolCall(harness, sessionA)
    expect(harness.asks).toHaveLength(1)

    const sessionB = createCtx(harness, { choice: APPROVAL_OPTIONS[0], sessionId: 'sess-B' })
    await runToolCall(harness, sessionB)
    expect(harness.asks).toHaveLength(2)
  })

  it('session_shutdown 清空「本会话允许」记忆', async () => {
    const harness = createPi(defaultPolicy())
    const ctx = createCtx(harness, { choice: APPROVAL_OPTIONS[1] })
    await runToolCall(harness, ctx)
    expect(harness.asks).toHaveLength(1)

    await harness.handlers.session_shutdown[0]?.({ type: 'session_shutdown' }, ctx)
    await runToolCall(harness, ctx)
    expect(harness.asks).toHaveLength(2)
  })
})

describe('tool_call 钩子：拒绝路径（fail-closed）', () => {
  it('「拒绝」→ block', async () => {
    const harness = createPi(defaultPolicy())
    expectBlocked(await runToolCall(harness, createCtx(harness, { choice: APPROVAL_OPTIONS[2] })))
  })

  it('超时（undefined）→ block，且原因里点明超时', async () => {
    const harness = createPi(defaultPolicy())
    const result = await runToolCall(harness, createCtx(harness, { choice: undefined }))
    expectBlocked(result)
    expect(result?.reason).toContain('超时')
  })

  it('未预期取值（伪造响应）→ block', async () => {
    const harness = createPi(defaultPolicy())
    expectBlocked(await runToolCall(harness, createCtx(harness, { choice: 'ALLOW-EVERYTHING' })))
  })

  it('询问过程抛异常 → block（异常绝不变放行）', async () => {
    const harness = createPi(defaultPolicy())
    const result = await runToolCall(harness, createCtx(harness, { throws: true }))
    expectBlocked(result)
    expect(result?.reason).toContain('fail-closed')
  })

  it('无 UI（print/json 模式或客户端未连接）→ 直接 block，不挂起', async () => {
    const harness = createPi(defaultPolicy())
    const result = await runToolCall(harness, { hasUI: false, ui: {} })
    expectBlocked(result)
    expect(harness.asks).toHaveLength(0)
  })
})

describe('策略生效面', () => {
  it('策略关闭（用户显式关掉）→ 不询问也不阻止', async () => {
    const harness = createPi(defaultPolicy({ enabled: false }))
    expect(
      await runToolCall(harness, createCtx(harness, { choice: APPROVAL_OPTIONS[2] }))
    ).toBeUndefined()
    expect(harness.asks).toHaveLength(0)
  })

  it('工具不在清单 → 不询问（例如 read）', async () => {
    const harness = createPi(defaultPolicy())
    await runToolCall(harness, createCtx(harness, {}), {
      type: 'tool_call',
      toolName: 'read',
      input: { path: 'a' }
    })
    expect(harness.asks).toHaveLength(0)
  })

  it('工具名大小写不敏感（策略里写 Bash 也生效）', async () => {
    const harness = createPi(defaultPolicy({ tools: ['BASH'] }))
    await runToolCall(harness, createCtx(harness, { choice: APPROVAL_OPTIONS[0] }))
    expect(harness.asks).toHaveLength(1)
  })

  it('协议不兼容时仍然审批（不因兼容性问题放行）', async () => {
    const harness = createPi(defaultPolicy({ compatible: false, clientProtocol: 9 }))
    expectBlocked(await runToolCall(harness, createCtx(harness, { choice: APPROVAL_OPTIONS[2] })))
    expect(harness.asks).toHaveLength(1)
  })

  it('未知 toolName → block（无法归类就不要执行）', async () => {
    const harness = createPi(defaultPolicy())
    expectBlocked(
      await runToolCall(harness, createCtx(harness, {}), {
        type: 'tool_call',
        toolName: '',
        input: {}
      })
    )
  })
})

describe('版本握手', () => {
  it('session_start 与首次审批都会上报握手（setStatus，含协议版本）', async () => {
    const harness = createPi(defaultPolicy())
    const ctx = createCtx(harness, { choice: APPROVAL_OPTIONS[0] })

    await harness.handlers.session_start[0]?.({ type: 'session_start' }, ctx)
    expect(harness.statuses).toHaveLength(1)
    const payload = JSON.parse(harness.statuses[0]?.text ?? '{}') as {
      protocol: number
      ext: string
    }
    expect(payload.ext).toBe('pi-desktop-permission')
    expect(payload.protocol).toBe(1)

    await runToolCall(harness, ctx)
    expect(harness.statuses).toHaveLength(2)
    expect(harness.statuses[1]?.key).toBe('pi-desktop-permission')
  })
})
