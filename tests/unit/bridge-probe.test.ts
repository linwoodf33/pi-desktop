import { describe, expect, it, vi } from 'vitest'

import { createAppStore, runBridgeProbe } from '../../src/renderer/stores/appStore'
import type { BootState } from '../../src/shared/contracts/types'
import type { PiApi } from '../../src/shared/contracts/api'
import { ok, fail } from '../../src/shared/contracts/result'

const bootState: BootState = {
  config: {
    piCommand: 'pi',
    workspaceRoots: [],
    maxActiveSessions: 3,
    idleRecycleMinutes: 30,
    theme: 'system',
    permission: { enabled: true, tools: ['bash', 'powershell', 'write', 'edit'], timeoutMs: 120_000 }
  },
  piStatus: { state: 'unknown', message: 'M1 未实现' }
}

/** 只桩掉探测用到的两个方法，其余方法不会被调用 */
function fakeApi(overrides: {
  getBoot?: PiApi['app']['getBoot']
  list?: PiApi['session']['list']
} = {}): PiApi {
  return {
    app: { getBoot: overrides.getBoot ?? vi.fn(() => Promise.resolve(ok(bootState))) },
    session: {
      list: overrides.list ?? vi.fn(() => Promise.resolve(ok({ items: [] })))
    }
  } as unknown as PiApi
}

describe('runBridgeProbe（M1 联通验证）', () => {
  it('两个通道都成功 → ok，并带上启动态与会话数', async () => {
    const status = await runBridgeProbe({ api: fakeApi() })
    expect(status).toEqual({ phase: 'ok', boot: bootState, sessionCount: 0 })
  })

  it('无 globalThis.pi（preload 未加载）→ NO_BRIDGE 错误', async () => {
    const status = await runBridgeProbe({ api: undefined })
    expect(status.phase).toBe('error')
    if (status.phase !== 'error') return
    expect(status.code).toBe('NO_BRIDGE')
  })

  it('app:getBoot 返回业务错误 → 透出错误码', async () => {
    const status = await runBridgeProbe({
      api: fakeApi({ getBoot: () => Promise.resolve(fail('INTERNAL', '配置读取失败')) })
    })
    expect(status).toEqual({ phase: 'error', code: 'INTERNAL', message: '配置读取失败' })
  })

  it('session:list 失败也判定桥接异常', async () => {
    const status = await runBridgeProbe({
      api: fakeApi({ list: () => Promise.resolve(fail('VALIDATION', '游标非法')) })
    })
    expect(status.phase).toBe('error')
    if (status.phase !== 'error') return
    expect(status.code).toBe('VALIDATION')
  })

  it('invoke 抛异常（IPC 层故障）→ IPC_FAILED', async () => {
    const status = await runBridgeProbe({
      api: fakeApi({
        getBoot: () => Promise.reject(new Error('No handler registered for app:getBoot'))
      })
    })
    expect(status.phase).toBe('error')
    if (status.phase !== 'error') return
    expect(status.code).toBe('IPC_FAILED')
    expect(status.message).toContain('No handler registered')
  })
})

describe('setPiStatus（A12 收口：定位 pi 后回写自检结果）', () => {
  it('桥接就绪时更新 boot.piStatus，其余字段保持不动', () => {
    const store = createAppStore()
    store.setState({
      bridge: { phase: 'ok', boot: bootState, sessionCount: 7 }
    })
    store.getState().setPiStatus({ state: 'ok', version: '1.5.2' })

    const bridge = store.getState().bridge
    expect(bridge.phase).toBe('ok')
    if (bridge.phase !== 'ok') return
    expect(bridge.boot.piStatus).toEqual({ state: 'ok', version: '1.5.2' })
    // 其它 boot 字段（config）与会话数不受影响
    expect(bridge.boot.config).toEqual(bootState.config)
    expect(bridge.sessionCount).toBe(7)
  })

  it('桥接未就绪（error/probing/idle）时不伪造 boot', () => {
    const store = createAppStore()
    store.setState({ bridge: { phase: 'error', code: 'NO_BRIDGE', message: 'x' } })

    store.getState().setPiStatus({ state: 'ok' })

    expect(store.getState().bridge).toEqual({ phase: 'error', code: 'NO_BRIDGE', message: 'x' })
  })
})
