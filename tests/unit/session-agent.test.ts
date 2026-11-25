import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  extractAgentFromEntries,
  extractAgentFromJsonl,
  readSessionAgent
} from '../../src/main/services/session-agent'

/**
 * A38：从会话 JSONL 提取「当前 agent」。
 *
 * 这条纯函数是 UI 显示的唯一事实来源，所以把三态语义钉死：
 * - `string` = 当前 agent
 * - `null`   = 显式清除（回到默认）
 * - `undefined` = 文件里没有该标记 / 读不到 → 调用方**必须保持现值**
 *
 * 第三态最容易被误实现成「没有 = 清除」：那样会让「尾部窗口没扫到 marker」把刚
 * 由 session:create 填好的名字抹掉。
 */

const custom = (customType: string, name: unknown): Record<string, unknown> => ({
  type: 'custom',
  customType,
  data: { name },
  id: 'x',
  parentId: null,
  timestamp: '2026-01-01T00:00:00.000Z'
})

describe('extractAgentFromEntries：三态与优先级', () => {
  it('U1 多条 open-agents-state：最后一条生效', () => {
    expect(
      extractAgentFromEntries([custom('open-agents-state', 'a'), custom('open-agents-state', 'b')])
    ).toBe('b')
  })

  it('U2 最后一条 name:null → 显式清除（返回 null，不是 undefined）', () => {
    expect(
      extractAgentFromEntries([
        custom('open-agents-state', 'scout'),
        custom('open-agents-state', null)
      ])
    ).toBeNull()
  })

  it('U3 两种 customType 统一按文件顺序取最后一条（不按类型优先级）', () => {
    expect(
      extractAgentFromEntries([
        custom('open-agents-state', 'from-state'),
        custom('active_agent', 'from-active')
      ])
    ).toBe('from-active')
    expect(
      extractAgentFromEntries([
        custom('active_agent', 'from-active'),
        custom('open-agents-state', 'from-state')
      ])
    ).toBe('from-state')
  })

  it('U4 无关条目被忽略；完全没有 marker → undefined（未知）', () => {
    expect(
      extractAgentFromEntries([
        { type: 'custom', customType: 'unrelated', data: { name: 'x' } },
        { type: 'message', role: 'user' },
        { type: 'custom', customType: 'open-agents-state' }
      ])
    ).toBeUndefined()
  })

  it('U5 data.name 非字符串（数字/对象/缺失）跳过，不当作清除', () => {
    expect(
      extractAgentFromEntries([
        custom('open-agents-state', 'ok'),
        custom('open-agents-state', 42),
        custom('open-agents-state', { nested: true })
      ])
    ).toBe('ok')
  })

  it('U6 名字净化：去控制字符、trim、截 64；净化后为空 → null', () => {
    expect(extractAgentFromEntries([custom('open-agents-state', '  scout\u0000  ')])).toBe('scout')
    const long = 'a'.repeat(100)
    expect(extractAgentFromEntries([custom('open-agents-state', long)])).toBe('a'.repeat(64))
    expect(extractAgentFromEntries([custom('open-agents-state', '\u0001\u0002')])).toBeNull()
  })
})

describe('extractAgentFromJsonl：坏行跳过', () => {
  it('U7 半行/坏 JSON 跳过，仍能取到后面的有效条目', () => {
    const text = [
      '{"type":"message","role":"user"',
      JSON.stringify(custom('open-agents-state', 'first')),
      'not-json',
      JSON.stringify(custom('open-agents-state', 'second'))
    ].join('\n')
    expect(extractAgentFromJsonl(text)).toBe('second')
  })
})

describe('readSessionAgent：fail-soft', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-agent-'))
  })

  afterAll(async () => {
    if (dir.length > 0) await rm(dir, { recursive: true, force: true })
  })

  it('U8 文件不存在 / 非 .jsonl / 空文件 → undefined 且不抛', async () => {
    expect(await readSessionAgent(join(dir, 'nope.jsonl'))).toBeUndefined()
    expect(await readSessionAgent(join(dir, 'session.txt'))).toBeUndefined()

    const empty = join(dir, 'empty.jsonl')
    await writeFile(empty, '', 'utf8')
    expect(await readSessionAgent(empty)).toBeUndefined()
  })

  it('U9 真实文件：取最后一条；尾部窗口外无 marker 时返回 undefined', async () => {
    const file = join(dir, 'session.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify(custom('open-agents-state', 'old')),
        JSON.stringify(custom('open-agents-state', 'new'))
      ].join('\n') + '\n',
      'utf8'
    )
    expect(await readSessionAgent(file)).toBe('new')

    // 只扫最后 24 字节：必然把两条 marker 都切在窗口外 → 未知（不是「没有 agent」）
    expect(await readSessionAgent(file, { maxBytes: 24 })).toBeUndefined()
  })
})
