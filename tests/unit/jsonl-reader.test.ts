import { describe, expect, it, vi } from 'vitest'

import { JsonlReader } from '../../src/main/transport/jsonl-reader'

/**
 * §9.1 U1–U4：LF-only 分帧读取器。
 * 严禁 readline —— 它会把 U+2028/U+2029 当行分隔符（JSON 字符串内合法）。
 */
function collect(): {
  reader: JsonlReader
  records: unknown[]
  invalid: Array<{ line: string; message: string }>
} {
  const records: unknown[] = []
  const invalid: Array<{ line: string; message: string }> = []
  const reader = new JsonlReader({
    onRecord: (record) => records.push(record),
    onInvalid: (line, error) => invalid.push({ line, message: error.message })
  })
  return { reader, records, invalid }
}

describe('JsonlReader（U1）：跨 chunk 边界的半个 JSON', () => {
  it('补齐后才产出 1 条记录，不产出半条', () => {
    const { reader, records } = collect()
    const line = '{"type":"message_end","message":{"role":"assistant"}}\n'
    const cut = 15

    reader.push(line.slice(0, cut))
    expect(records).toHaveLength(0)

    reader.push(line.slice(cut))
    expect(records).toEqual([{ type: 'message_end', message: { role: 'assistant' } }])
  })

  it('多字节 UTF-8 字符被切开也能正确解码', () => {
    const { reader, records } = collect()
    const payload = Buffer.from('{"delta":"中文流式"}\n', 'utf8')
    // 在 UTF-8 字节流中间切开，制造半个码点
    reader.push(payload.subarray(0, 12))
    reader.push(payload.subarray(12))
    expect(records).toEqual([{ delta: '中文流式' }])
  })

  it('一个 chunk 内含多行时逐行产出', () => {
    const { reader, records } = collect()
    reader.push('{"a":1}\n{"a":2}\n{"a":3}\n')
    expect(records).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })
})

describe('JsonlReader（U2）：字符串内 U+2028 / U+2029 不切分', () => {
  it('把 U+2028 与 U+2029 当作普通内容', () => {
    const { reader, records } = collect()
    const text = 'line\u2028break\u2029paragraph'
    reader.push(`${JSON.stringify({ type: 'message_end', text })}\n`)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ text })
  })

  it('U+2028 在同一 chunk 内也不会被当成换行', () => {
    const { reader, records } = collect()
    reader.push('{"text":"a\u2028b"}\n{"text":"c"}')
    expect(records).toEqual([{ text: 'a\u2028b' }])

    reader.flush()
    expect(records).toEqual([{ text: 'a\u2028b' }, { text: 'c' }])
  })
})

describe('JsonlReader（U3）：CRLF 行', () => {
  it('剥离行尾可选 CR 后正常解析', () => {
    const { reader, records, invalid } = collect()
    reader.push('{"type":"agent_start"}\r\n{"type":"agent_settled","aborted":false}\r\n')

    expect(records).toEqual([{ type: 'agent_start' }, { type: 'agent_settled', aborted: false }])
    expect(invalid).toHaveLength(0)
  })

  it('行内 CR 属于内容，不被剥离', () => {
    const { reader, records } = collect()
    reader.push('{"text":"a\\rb"}\r\n')
    expect(records).toEqual([{ text: 'a\rb' }])
  })
})

describe('JsonlReader（U4）：非法 JSON 行', () => {
  it('不崩溃，产出诊断，后续行继续解析', () => {
    const { reader, records, invalid } = collect()
    reader.push('{"ok":1}\nnot-json\n{"ok":2}\n')

    expect(records).toEqual([{ ok: 1 }, { ok: 2 }])
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.line).toBe('not-json')
    expect(invalid[0]?.message.length).toBeGreaterThan(0)
  })

  it('合法但不是对象的行（null / 数字 / 字符串 / 数组）走 onInvalid 而不是 onRecord', () => {
    const { reader, records, invalid } = collect()
    reader.push('null\n42\n"text"\n[1,2]\n{"ok":true}\n')

    expect(records).toEqual([{ ok: true }])
    expect(invalid).toHaveLength(4)
    expect(invalid.every((item) => item.message.includes('JSON 对象'))).toBe(true)
  })

  it('空行与纯空白行被忽略，不算诊断', () => {
    const { reader, records, invalid } = collect()
    reader.push('\n   \n\t\n{"ok":1}\n')
    expect(records).toEqual([{ ok: 1 }])
    expect(invalid).toHaveLength(0)
  })
})

describe('JsonlReader.flush：冲洗剩余缓冲', () => {
  it('最后一行没有 LF 也要产出', () => {
    const { reader, records } = collect()
    reader.push('{"last":true}')
    expect(records).toHaveLength(0)

    reader.flush()
    expect(records).toEqual([{ last: true }])
  })

  it('重复 flush 不重复产出', () => {
    const { reader, records } = collect()
    reader.push('{"last":true}')
    reader.flush()
    reader.flush()
    expect(records).toHaveLength(1)
  })
})

describe('JsonlReader：超长行保护（§7 约束 14 同类）', () => {
  it('超过 maxLineBytes 的行被丢弃并给出一条诊断，不阻塞后续行', () => {
    const records: unknown[] = []
    const invalid: string[] = []
    const reader = new JsonlReader({
      onRecord: (record) => records.push(record),
      onInvalid: (line, error) => invalid.push(`${error.message}:${line.length}`),
      maxLineBytes: 64
    })

    reader.push(`${'x'.repeat(200)}\n{"ok":1}\n`)

    expect(records).toEqual([{ ok: 1 }])
    expect(invalid).toHaveLength(1)
    expect(invalid[0]).toContain('64')
  })

  it('流式写入的超长行（无 LF）也只报一次诊断', () => {
    const records: unknown[] = []
    const onInvalid = vi.fn()
    const reader = new JsonlReader({
      onRecord: (record) => records.push(record),
      onInvalid,
      maxLineBytes: 32
    })

    for (let i = 0; i < 5; i += 1) reader.push('y'.repeat(20))
    reader.push('\n{"ok":2}\n')

    expect(records).toEqual([{ ok: 2 }])
    expect(onInvalid).toHaveBeenCalledTimes(1)
  })
})
