import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearApprovalTimers,
  forgetSession,
  handleExtUiEvent,
  respondApproval
} from '../../src/renderer/lib/approval'
import { usePermissionStore } from '../../src/renderer/stores/permissionStore'
import { useRunStore } from '../../src/renderer/stores/runStore'
import { useSessionStore } from '../../src/renderer/stores/sessionStore'
import type { PiApi } from '../../src/shared/contracts/api'
import { ok, fail } from '../../src/shared/contracts/result'
import {
  PERMISSION_MARKER_PREFIX,
  PERMISSION_STATUS_KEY,
  PERMISSION_DEFAULT_TIMEOUT_MS,
  clientApprovalTimeoutMs
} from '../../src/shared/contracts/permission'
// 选项文案与顺序的单一来源是扩展侧协议模块（客户端按 choices 下标取值，不硬编码文案）
import { APPROVAL_OPTIONS } from '../../src/extensions/permission/protocol'
import type { ExtUiEvent } from '../../src/shared/contracts/types'

/**
 * renderer 侧审批编排测试（M5，§9.1 U10 超时自动拒绝）。
 *
 * 覆盖：允许一次 / 本会话允许的记忆作用域 / 拒绝 / 超时自动拒绝 / 伪造或过期响应 /
 * 协议不兼容时自动拒绝 / 会话销毁清空未决。
 */

const ALLOW_ONCE = APPROVAL_OPTIONS[0] as string

function approvalTitle(options: { tool?: string; timeoutMs?: number; protocol?: number }): string {
  const meta = {
    protocol: options.protocol ?? 1,
    version: '1.0.0',
    tool: options.tool ?? 'bash',
    risk: 'high',
    summary: 'ls -la',
    args: [{ k: 'command', v: 'ls -la' }],
    timeoutMs: options.timeoutMs ?? PERMISSION_DEFAULT_TIMEOUT_MS,
    options: [...APPROVAL_OPTIONS],
    choices: ['allow_once', 'allow_session', 'deny'],
    sessionId: 'sess-1'
  }
  return `需要批准：${meta.tool}\nls -la\n风险：执行 shell\n\n${PERMISSION_MARKER_PREFIX}${JSON.stringify(meta)}`
}

function approvalEvent(
  requestId: string,
  sessionKey = 's1',
  meta: Parameters<typeof approvalTitle>[0] = {}
): ExtUiEvent {
  return {
    sessionKey,
    request: {
      type: 'extension_ui_request',
      id: requestId,
      method: 'select',
      title: approvalTitle(meta),
      options: [...APPROVAL_OPTIONS],
      timeout: meta.timeoutMs ?? PERMISSION_DEFAULT_TIMEOUT_MS
    }
  }
}

function handshakeEvent(protocol: number, sessionKey = 's1'): ExtUiEvent {
  return {
    sessionKey,
    request: {
      type: 'extension_ui_request',
      id: `hs-${sessionKey}`,
      method: 'setStatus',
      statusKey: PERMISSION_STATUS_KEY,
      statusText: JSON.stringify({
        ext: 'pi-desktop-permission',
        version: '1.0.0',
        protocol,
        enabled: true,
        tools: ['bash'],
        timeoutMs: PERMISSION_DEFAULT_TIMEOUT_MS,
        compatible: protocol === 1
      })
    }
  }
}

interface Recorded {
  respond: Array<{ sessionKey: string; requestId: string; response: unknown }>
}

function createApi(result: 'ok' | 'not-found' = 'ok'): { api: PiApi; recorded: Recorded } {
  const recorded: Recorded = { respond: [] }
  const api = {
    extui: {
      respond: (input: { sessionKey: string; requestId: string; response: unknown }) => {
        recorded.respond.push(input)
        return Promise.resolve(
          result === 'ok'
            ? ok({ ok: true as const })
            : fail('REQUEST_NOT_FOUND', '审批请求不存在、已过期或不属于该会话，已丢弃')
        )
      }
    }
  } as unknown as PiApi
  return { api, recorded }
}

function pendingOf(sessionKey: string): Array<{ requestId: string }> {
  return usePermissionStore.getState().sessions[sessionKey]?.pending ?? []
}

function banners(): string[] {
  return useRunStore.getState().banners.map((banner) => banner.message)
}

beforeEach(() => {
  usePermissionStore.getState().reset()
  useRunStore.getState().clearBanners()
  useSessionStore.setState({ bySessionKey: {} })
})

afterEach(() => {
  clearApprovalTimers()
  vi.useRealTimers()
})

describe('审批事件 → 弹窗状态', () => {
  it('审批请求入队，并在回答「允许一次」后发送对应选项文案', async () => {
    const { api, recorded } = createApi()
    expect(handleExtUiEvent(api, approvalEvent('req-1'))).toBe('approval')
    expect(pendingOf('s1')).toHaveLength(1)

    expect(await respondApproval(api, 'req-1', 'allow_once')).toBe(true)
    expect(recorded.respond).toEqual([
      { sessionKey: 's1', requestId: 'req-1', response: { kind: 'select', value: ALLOW_ONCE } }
    ])
    // 回答后立刻出队（不会二次发送）
    expect(pendingOf('s1')).toHaveLength(0)
    expect(await respondApproval(api, 'req-1', 'allow_once')).toBe(false)
    expect(recorded.respond).toHaveLength(1)
  })

  it('「拒绝」发 cancelled（pi 收到 undefined → 扩展按拒绝处理）', async () => {
    const { api, recorded } = createApi()
    handleExtUiEvent(api, approvalEvent('req-2'))
    await respondApproval(api, 'req-2', 'deny')
    expect(recorded.respond[0]?.response).toEqual({ kind: 'cancel' })
  })

  it('同 requestId 重复入队不会重复弹窗', () => {
    const { api } = createApi()
    handleExtUiEvent(api, approvalEvent('req-3'))
    handleExtUiEvent(api, approvalEvent('req-3'))
    expect(pendingOf('s1')).toHaveLength(1)
  })
})

describe('「本会话允许」的作用域（不跨会话、不跨进程）', () => {
  it('记住后只对该 sessionKey 生效', async () => {
    const { api } = createApi()
    handleExtUiEvent(api, approvalEvent('req-a', 's1'))
    await respondApproval(api, 'req-a', 'allow_session')

    expect(usePermissionStore.getState().isAllowedInSession('s1', 'bash')).toBe(true)
    expect(usePermissionStore.getState().isAllowedInSession('s2', 'bash')).toBe(false)
    // 大小写归一
    expect(usePermissionStore.getState().isAllowedInSession('s1', 'BASH')).toBe(true)
  })

  it('会话销毁/退出 → 未决请求与本会话记忆一起清空，其他会话不受影响', async () => {
    const { api } = createApi()
    handleExtUiEvent(api, approvalEvent('req-a', 's1'))
    await respondApproval(api, 'req-a', 'allow_session')
    handleExtUiEvent(api, approvalEvent('req-b', 's1'))
    handleExtUiEvent(api, approvalEvent('req-c', 's2'))

    forgetSession('s1')
    expect(usePermissionStore.getState().sessions['s1']).toBeUndefined()
    expect(usePermissionStore.getState().isAllowedInSession('s1', 'bash')).toBe(false)
    expect(pendingOf('s2')).toHaveLength(1)
  })
})

describe('超时自动拒绝（U10）', () => {
  it('到达「扩展 timeout − 提前量」时自动回拒绝并提示', async () => {
    vi.useFakeTimers()
    const { api, recorded } = createApi()
    const timeoutMs = 10_000
    handleExtUiEvent(api, approvalEvent('req-t', 's1', { timeoutMs }))
    expect(pendingOf('s1')).toHaveLength(1)

    // 尚未到点：不动
    vi.advanceTimersByTime(clientApprovalTimeoutMs(timeoutMs) - 100)
    expect(recorded.respond).toHaveLength(0)
    expect(pendingOf('s1')).toHaveLength(1)

    vi.advanceTimersByTime(200)
    await Promise.resolve()
    expect(recorded.respond).toEqual([
      { sessionKey: 's1', requestId: 'req-t', response: { kind: 'cancel' } }
    ])
    expect(pendingOf('s1')).toHaveLength(0)
    expect(banners().join()).toContain('审批超时')
  })

  it('用户先手回答后，超时定时器不会再发一次拒绝', async () => {
    vi.useFakeTimers()
    const { api, recorded } = createApi()
    handleExtUiEvent(api, approvalEvent('req-u', 's1', { timeoutMs: 10_000 }))
    await respondApproval(api, 'req-u', 'allow_once')
    vi.advanceTimersByTime(clientApprovalTimeoutMs(10_000) + 5_000)
    await Promise.resolve()
    expect(recorded.respond).toHaveLength(1)
  })
})

describe('伪造 / 过期响应与协议不兼容', () => {
  it('主进程拒绝（REQUEST_NOT_FOUND）→ 提示用户而不是静默失败', async () => {
    const { api } = createApi('not-found')
    handleExtUiEvent(api, approvalEvent('req-x'))
    expect(await respondApproval(api, 'req-x', 'allow_once')).toBe(false)
    expect(banners().join()).toContain('REQUEST_NOT_FOUND')
    // 无论成败都要出队，避免弹窗卡死
    expect(pendingOf('s1')).toHaveLength(0)
  })

  it('协议不兼容握手 → 显式告警', () => {
    const { api } = createApi()
    expect(handleExtUiEvent(api, handshakeEvent(7))).toBe('handshake')
    expect(usePermissionStore.getState().sessions['s1']?.compatible).toBe(false)
    expect(banners().join()).toContain('不兼容')
  })

  it('协议不兼容时的审批请求 → 自动拒绝（不弹窗、不放行）', async () => {
    const { api, recorded } = createApi()
    handleExtUiEvent(api, handshakeEvent(7))
    expect(handleExtUiEvent(api, approvalEvent('req-y'))).toBe('auto-denied')
    await Promise.resolve()
    expect(pendingOf('s1')).toHaveLength(0)
    expect(recorded.respond).toEqual([
      { sessionKey: 's1', requestId: 'req-y', response: { kind: 'cancel' } }
    ])
    expect(usePermissionStore.getState().sessions['s1']?.autoDenied).toBe(1)
    expect(banners().join()).toContain('自动拒绝')
  })

  it('握手兼容时审批正常走弹窗', () => {
    const { api } = createApi()
    handleExtUiEvent(api, handshakeEvent(1))
    expect(handleExtUiEvent(api, approvalEvent('req-z'))).toBe('approval')
    expect(pendingOf('s1')).toHaveLength(1)
  })

  it('与本扩展无关的 extui（其它状态栏 / notify）被忽略', () => {
    const { api, recorded } = createApi()
    const event: ExtUiEvent = {
      sessionKey: 's1',
      request: { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi' }
    }
    expect(handleExtUiEvent(api, event)).toBe('ignored')
    expect(recorded.respond).toHaveLength(0)
    expect(pendingOf('s1')).toHaveLength(0)
  })
})
