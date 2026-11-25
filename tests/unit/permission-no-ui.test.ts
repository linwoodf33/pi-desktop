import { afterEach, describe, expect, it, vi } from 'vitest'

import piDesktopPermission from '../../src/extensions/permission/index'
import { parsePolicy, type PermissionPolicy } from '../../src/extensions/permission/protocol'
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  ToolCallEventLike,
  ToolCallHandler,
  ToolCallResultLike
} from '../../src/extensions/permission/types'

/**
 * A35：无 UI 会话的审批策略（`noUi: 'deny' | 'allow'`）。
 *
 * 这里只测**行为后果**，线上格式（`parsePolicy` 的取值归一、握手字段）由
 * `permission-wire.test.ts` 钉死；两者分工：格式对了但行为错了，本文件会红。
 *
 * 不可退让的两条：
 * - 默认 `deny`：没有审批界面时拒绝，不许把「审批」悄悄退化成自动执行；
 * - `allow` 只是「不询问」，**不是**用户授权——不得写 `allowSession`、不得跨实例记忆。
 */

interface Harness {
  handlers: ToolCallHandler[]
  /** select 被调用次数（0 = 没问过任何人） */
  selects: number
}

function createPi(policy: PermissionPolicy): Harness {
  const harness: Harness = { handlers: [], selects: 0 }
  const api: ExtensionApiLike = {
    on(event: string, handler: never) {
      if (event === 'tool_call') harness.handlers.push(handler)
    }
  }
  piDesktopPermission(api, { readPolicy: () => policy })
  return harness
}

function policyFrom(overrides: Record<string, unknown> = {}): PermissionPolicy {
  return parsePolicy(
    JSON.stringify({
      enabled: true,
      tools: ['bash', 'powershell', 'write', 'edit'],
      timeoutMs: 120_000,
      protocolVersion: 1,
      noUi: 'deny',
      ...overrides
    })
  )
}

function createCtx(
  harness: Harness,
  options: { hasUI: boolean; sessionId?: string }
): ExtensionContextLike {
  return {
    hasUI: options.hasUI,
    sessionManager: { getSessionId: () => options.sessionId ?? 'sess-1' },
    ui: {
      select: () => {
        harness.selects += 1
        return Promise.resolve(undefined)
      }
    }
  }
}

async function runTool(
  harness: Harness,
  ctx: ExtensionContextLike,
  toolName: string,
  input: unknown = { command: 'ls -la' }
): Promise<ToolCallResultLike | undefined> {
  const handler = harness.handlers[0]
  if (handler === undefined) throw new Error('tool_call 处理器未注册')
  const event: ToolCallEventLike = { type: 'tool_call', toolName, toolCallId: 'c1', input }
  const result = await handler(event, ctx)
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('无 UI 会话：默认拒绝（fail-closed）', () => {
  it('N1 策略缺 noUi（默认 deny）+ 无 UI + write → block，原因点明没有审批界面', async () => {
    const policy = parsePolicy(JSON.stringify({ enabled: true, tools: ['write'] }))
    expect(policy.noUi).toBe('deny')

    const harness = createPi(policy)
    const result = await runTool(harness, createCtx(harness, { hasUI: false }), 'write', {
      path: 'a.txt'
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('没有可用的审批界面')
    expect(harness.selects).toBe(0)
  })
})

describe('无 UI 会话：显式 allow 只放行、不询问', () => {
  it('N2 noUi:allow + 无 UI + write → 放行，且没有调用 select', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const policy = policyFrom({ noUi: 'allow' })
    expect(policy.noUi).toBe('allow')

    const harness = createPi(policy)
    const result = await runTool(harness, createCtx(harness, { hasUI: false }), 'write', {
      path: 'a.txt'
    })
    expect(result).toBeUndefined()
    expect(harness.selects).toBe(0)
  })

  it('N3 工具不在清单（read）→ 放行，且不产生 noUi 审计行', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const harness = createPi(policyFrom({ noUi: 'allow' }))
    const result = await runTool(harness, createCtx(harness, { hasUI: false }), 'read', {
      path: 'a.txt'
    })
    expect(result).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('N4 noUi:allow 但 hasUI=true → 仍然弹审批（noUi 不越界到有 UI 会话）', async () => {
    const harness = createPi(policyFrom({ noUi: 'allow' }))
    const result = await runTool(harness, createCtx(harness, { hasUI: true }), 'write', {
      path: 'a.txt'
    })
    expect(harness.selects).toBe(1)
    expect(result?.block).toBe(true)
  })
})

describe('协议不兼容压过 noUi', () => {
  it('N5 protocolVersion:7 + noUi:allow + 无 UI → 仍 block，且解析结果已强制 deny', async () => {
    const policy = parsePolicy(JSON.stringify({ protocolVersion: 7, noUi: 'allow' }))
    expect(policy.compatible).toBe(false)
    expect(policy.noUi).toBe('deny')

    const harness = createPi(policy)
    const result = await runTool(harness, createCtx(harness, { hasUI: false }), 'write', {
      path: 'a.txt'
    })
    expect(result?.block).toBe(true)
    expect(harness.selects).toBe(0)
  })
})

describe('noUi 取值归一（只认字符串 deny/allow）', () => {
  it('N6 非法值一律 deny 且带 warning；大小写/空白容忍', () => {
    for (const value of ['yes', 1, true, null, [], {}]) {
      const policy = parsePolicy(JSON.stringify({ noUi: value }))
      expect(policy.noUi).toBe('deny')
      expect(policy.warning).toContain('noUi')
    }
    const trimmed = parsePolicy(JSON.stringify({ noUi: 'Allow ' }))
    expect(trimmed.noUi).toBe('allow')
    expect(trimmed.warning).toBeUndefined()
  })
})

describe('放行不留下任何「已授权」痕迹', () => {
  it('N7 新实例（仍 allow）再放行一次；换成 deny 实例 → 立即被拒', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const first = createPi(policyFrom({ noUi: 'allow' }))
    expect(await runTool(first, createCtx(first, { hasUI: false }), 'write')).toBeUndefined()
    expect(await runTool(first, createCtx(first, { hasUI: false }), 'write')).toBeUndefined()
    expect(first.selects).toBe(0)

    const second = createPi(policyFrom({ noUi: 'allow' }))
    expect(await runTool(second, createCtx(second, { hasUI: false }), 'write')).toBeUndefined()

    const third = createPi(policyFrom({ noUi: 'deny' }))
    const blockedResult = await runTool(third, createCtx(third, { hasUI: false }), 'write')
    expect(blockedResult?.block).toBe(true)
  })

  it('N8 放行时 stderr 留痕，且只含工具/会话/风险，不含入参', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const harness = createPi(policyFrom({ noUi: 'allow' }))
    await runTool(harness, createCtx(harness, { hasUI: false }), 'write', {
      path: 'C:/secret-place/a.txt'
    })

    const text = write.mock.calls.map((call) => String(call[0])).join('')
    expect(text).toContain('noUi-allow tool=write')
    expect(text).toContain('session=sess-1')
    expect(text).not.toContain('C:/secret-place/a.txt')
  })
})
