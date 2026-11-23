import { describe, expect, it } from 'vitest'

import { createExtUiRegistry } from '../../src/main/services/extui-registry'
import { IpcFailure } from '../../src/shared/contracts/result'

/**
 * 未决审批登记表测试（M5，§9.4 S9/S10）。
 *
 * 这里守的是「伪造 / 跨会话 / 跨通道 / 过期 / 非预期选项」五类攻击面：
 * 只有主进程自己见过、且属于当前通道的请求才允许回包。
 */

const ALLOW_ONCE = '允许一次'
const OPTIONS = [ALLOW_ONCE, '本会话允许', '拒绝']

function seed(registry: ReturnType<typeof createExtUiRegistry>): void {
  registry.register({
    requestId: 'req-a',
    sessionKey: 'sA',
    channelId: 'local#1',
    method: 'select',
    options: OPTIONS
  })
  registry.register({
    requestId: 'req-b',
    sessionKey: 'sB',
    channelId: 'local#2',
    method: 'select',
    options: OPTIONS
  })
}

describe('extui 登记表：正常路径', () => {
  it('登记后可以用同一 sessionKey + 通道消费一次', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    const entry = registry.consume({
      sessionKey: 'sA',
      requestId: 'req-a',
      currentChannelId: 'local#1',
      response: { kind: 'select', value: ALLOW_ONCE }
    })
    expect(entry.requestId).toBe('req-a')
    // 一次性：再消费一次就是「不存在」
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: 'local#1',
        response: { kind: 'cancel' }
      })
    ).toThrow(IpcFailure)
  })

  it('cancel 响应不需要匹配选项', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: 'local#1',
        response: { kind: 'cancel' }
      }).requestId
    ).toBe('req-a')
  })

  it('list / size / clearSession', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(registry.size()).toBe(2)
    expect(registry.list('sA')).toHaveLength(1)
    expect(registry.clearSession('sA')).toHaveLength(1)
    expect(registry.size()).toBe(1)
    expect(registry.list('sA')).toHaveLength(0)
  })

  /**
   * 收口债 #4：`extension_ui_cancel` 必须真正清掉登记表条目。
   *
   * 现实触发场景：扩展侧超时兜底 / 用户在被问的瞬间关掉 pi —— 长会话里反复出现。
   * 只透传不清理的话，Map 会一直长（纯内存泄漏），且 `size()` 诊断数字失真。
   */
  it('discard：按 requestId 丢弃一条，且被丢弃的请求不再可消费', () => {
    const registry = createExtUiRegistry()
    seed(registry)

    const discarded = registry.discard('sA', 'req-a')
    expect(discarded?.requestId).toBe('req-a')
    expect(registry.size()).toBe(1)
    expect(registry.list('sA')).toHaveLength(0)

    // 一次性语义：已丢弃的 id 不能再回答（同「已过期」）
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: 'local#1',
        response: { kind: 'cancel' }
      })
    ).toThrow(IpcFailure)
  })

  it('discard：不存在 / 跨会话的 id 返回 undefined，不抛错、不误删别的会话', () => {
    const registry = createExtUiRegistry()
    seed(registry)

    expect(registry.discard('sA', 'nope')).toBeUndefined()
    // 用 sB 的会话去丢 sA 的 id：不算命中
    expect(registry.discard('sB', 'req-a')).toBeUndefined()
    expect(registry.size()).toBe(2)
  })

  it('discard：清空后回收空桶（不留空 Map）', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    registry.discard('sA', 'req-a')
    registry.discard('sB', 'req-b')
    expect(registry.size()).toBe(0)
    // 空桶被回收：再次 list / clearSession 都是空
    expect(registry.list('sA')).toHaveLength(0)
    expect(registry.clearSession('sB')).toHaveLength(0)
  })
})

describe('extui 登记表：攻击面（一律 REQUEST_NOT_FOUND + 诊断）', () => {
  it('伪造 requestId → 拒绝', () => {
    const rejections: string[] = []
    const registry = createExtUiRegistry({
      onReject: (error, context) => rejections.push(`${error.code}:${context.requestId}`)
    })
    seed(registry)
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'forged-id',
        currentChannelId: 'local#1',
        response: { kind: 'select', value: ALLOW_ONCE }
      })
    ).toThrow(IpcFailure)
    expect(rejections).toEqual(['REQUEST_NOT_FOUND:forged-id'])
  })

  it('跨会话：用 A 的 requestId 冒充 B 的会话 → 拒绝', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(() =>
      registry.consume({
        sessionKey: 'sB',
        requestId: 'req-a',
        currentChannelId: 'local#2',
        response: { kind: 'select', value: ALLOW_ONCE }
      })
    ).toThrow(IpcFailure)
    // A 的请求没有被 B 的这次尝试消费掉
    expect(registry.list('sA')).toHaveLength(1)
  })

  it('通道不匹配（会话已被新通道接管 / 旧请求过期）→ 拒绝并清理', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: 'local#999',
        response: { kind: 'cancel' }
      })
    ).toThrow(IpcFailure)
    expect(registry.list('sA')).toHaveLength(0)
  })

  it('select 的取值不在请求选项内 → 拒绝（防伪造非预期响应）', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: 'local#1',
        response: { kind: 'select', value: '我要全部权限' }
      })
    ).toThrow(IpcFailure)
    expect(registry.list('sA')).toHaveLength(0)
  })

  it('通道 id 缺失（会话已释放）→ 拒绝', () => {
    const registry = createExtUiRegistry()
    seed(registry)
    expect(() =>
      registry.consume({
        sessionKey: 'sA',
        requestId: 'req-a',
        currentChannelId: undefined,
        response: { kind: 'cancel' }
      })
    ).toThrow(IpcFailure)
  })

  it('拒绝的错误码是 REQUEST_NOT_FOUND（renderer 可据此区分“过期”与“内部错误”）', () => {
    const registry = createExtUiRegistry()
    try {
      registry.consume({
        sessionKey: 'sX',
        requestId: 'nope',
        currentChannelId: 'local#1',
        response: { kind: 'cancel' }
      })
      expect.unreachable('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcFailure)
      expect((error as IpcFailure).code).toBe('REQUEST_NOT_FOUND')
    }
  })
})
