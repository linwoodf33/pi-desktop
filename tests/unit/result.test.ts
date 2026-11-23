import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  IpcFailure,
  ERROR_CODES,
  formatZodError,
  normalizeError,
  ok,
  fail
} from '../../src/shared/contracts/result'

describe('Result 构造', () => {
  it('ok() 生成成功结果', () => {
    expect(ok(42)).toEqual({ ok: true, data: 42 })
  })

  it('fail() 省略 detail 时不产生该字段', () => {
    const result = fail('TIMEOUT', '超时')
    expect(result).toEqual({ ok: false, error: { code: 'TIMEOUT', message: '超时' } })
    if (result.ok) throw new Error('expected failure')
    expect('detail' in result.error).toBe(false)
  })

  it('fail() 带 detail 时保留', () => {
    expect(fail('PROTOCOL', '污染', 'first line: banner')).toEqual({
      ok: false,
      error: { code: 'PROTOCOL', message: '污染', detail: 'first line: banner' }
    })
  })
})

describe('normalizeError 错误规范化', () => {
  it('IpcFailure 保留错误码', () => {
    expect(normalizeError(new IpcFailure('PATH_DENIED', '越权路径', '../etc'))).toEqual({
      code: 'PATH_DENIED',
      message: '越权路径',
      detail: '../etc'
    })
  })

  it('ZodError → VALIDATION，并给出字段路径', () => {
    const schema = z.object({ cwd: z.string() }).strict()
    const parsed = schema.safeParse({ cwd: 1 })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    const normalized = normalizeError(parsed.error)
    expect(normalized.code).toBe('VALIDATION')
    expect(normalized.detail).toContain('cwd')
    // 不泄露 stack
    expect(normalized.detail ?? '').not.toContain('    at ')
  })

  it('普通 Error → INTERNAL，只保留 message', () => {
    const normalized = normalizeError(new Error('boom'))
    expect(normalized).toEqual({ code: 'INTERNAL', message: 'boom' })
  })

  it('字符串与非 Error 对象 → INTERNAL 兜底', () => {
    expect(normalizeError('plain string').code).toBe('INTERNAL')
    expect(normalizeError({ weird: true })).toEqual({
      code: 'INTERNAL',
      message: '未捕获的内部错误'
    })
  })

  it('错误码集合包含 M1 需要的全部代码', () => {
    for (const code of ['VALIDATION', 'UNKNOWN_CHANNEL', 'NOT_IMPLEMENTED', 'INTERNAL'] as const) {
      expect(ERROR_CODES).toContain(code)
    }
  })
})

describe('formatZodError', () => {
  it('根级错误标记为 (root)', () => {
    const schema = z.string()
    const parsed = schema.safeParse(1)
    if (parsed.success) throw new Error('expected failure')
    expect(formatZodError(parsed.error)).toContain('(root)')
  })
})
