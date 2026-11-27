import { describe, expect, it } from 'vitest'

import { describeModelError, retryLine } from '../../src/renderer/lib/message-error'

/**
 * 错误可读化（§5.3）：规则表**顺序即优先级**，文案改动只发生在 `lib/message-error.ts`，
 * 所以这里锁的是「输入原文 → 分类 + 中文标题」的映射与 `retryLine` 的边界。
 */
describe('describeModelError：错误归类', () => {
  it('Request timed out.: Connect Timeout Error (...) → timeout（先于 connection 命中）', () => {
    const info = describeModelError('Request timed out.: Connect Timeout Error (mock)')
    expect(info.kind).toBe('timeout')
    expect(info.title).toBe('模型请求超时')
    expect(info.hint.length).toBeGreaterThan(0)
  })

  it('connect ECONNREFUSED 127.0.0.1:443 → connection', () => {
    const info = describeModelError('connect ECONNREFUSED 127.0.0.1:443')
    expect(info.kind).toBe('connection')
    expect(info.title).toBe('无法连接模型服务')
  })

  it('401 Unauthorized / 403 Forbidden / invalid api key → auth', () => {
    expect(describeModelError('401 Unauthorized').kind).toBe('auth')
    expect(describeModelError('Request failed: 403 Forbidden').kind).toBe('auth')
    expect(describeModelError('invalid api key').kind).toBe('auth')
  })

  it('429 Too Many Requests / rate limit exceeded → rate_limit', () => {
    expect(describeModelError('429 Too Many Requests').kind).toBe('rate_limit')
    expect(describeModelError('rate limit exceeded').kind).toBe('rate_limit')
  })

  it('maximum context length exceeded → context', () => {
    const info = describeModelError('maximum context length exceeded')
    expect(info.kind).toBe('context')
    expect(info.title).toBe('上下文超出模型上限')
  })

  it('未知文本 / undefined / 空串 → unknown 兜底且不抛', () => {
    for (const input of ['something weird happened', undefined, ''] as Array<string | undefined>) {
      const info = describeModelError(input)
      expect(info.kind).toBe('unknown')
      expect(info.title).toBe('模型调用失败')
    }
  })
})

describe('retryLine：连续失败提示', () => {
  it('单次及以下失败不提示重试（返回空串）', () => {
    expect(retryLine(1)).toBe('')
    expect(retryLine(0)).toBe('')
  })

  it('多次失败给出连续次数与自动重试次数', () => {
    expect(retryLine(3)).toContain('连续 3 次')
    expect(retryLine(3)).toContain('重试 2 次')
    expect(retryLine(4)).toBe('连续 4 次尝试失败（pi 已自动重试 3 次）')
  })
})
