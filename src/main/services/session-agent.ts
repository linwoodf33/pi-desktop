import { open } from 'node:fs/promises'

import { parseEntries } from './session-history'

/**
 * A38：从会话 JSONL 里提取「当前 agent」。
 *
 * 事实来源：pi 的核心（`get_state` / RPC 事件）**不携带 agent**，agent 身份完全由
 * `pi-open-agents` 扩展以自定义条目的形式写进会话文件：
 *
 *   {"type":"custom","customType":"open-agents-state","data":{"name":"scout"},...}
 *   {"type":"custom","customType":"active_agent",     "data":{"name":"scout"},...}
 *
 * 规则固定（便于写测试）：
 * - 只认 `type === 'custom'` 且 `customType` 是上面两种之一；
 * - 两种类型**统一按文件顺序取最后一条**（不设类型优先级）；
 * - `data.name === null` 或空串 → 归为 `null`（显式清除，回落到默认 agent）；
 * - `data.name` 不是字符串（缺失/数字/对象）→ 该条跳过，**不**当作清除；
 * - 名字净化：去控制字符、trim、截 64 字符；净化后为空 → `null`。
 *
 * 返回三态语义（调用方据此决定「保持现值 / 清除 / 更新」）：
 * - `string`  当前 agent
 * - `null`    显式清除
 * - `undefined` 文件里没有该标记 / 读不出来 → **未知**，调用方必须保持现值
 */

const AGENT_CUSTOM_TYPES: ReadonlySet<string> = new Set(['open-agents-state', 'active_agent'])

/** 读取会话文件尾部时默认扫多少字节（长会话里 agent 条目通常出现在开头，故给足 256KB） */
const DEFAULT_MAX_BYTES = 256 * 1024

/** 控制字符（U+0000–U+001F、U+007F）：用码点构造，避免 lint 对字面控制字符的误报 */
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  // 必须带 g：`replace` 只换第一个匹配，漏掉 g 会留下第 2 个控制字符
  'g'
)

/** 名字净化：控制字符会污染 UI/日志，超长会撑爆输入区 */
function sanitizeAgentName(value: string): string | null {
  const cleaned = value.replace(CONTROL_CHARS_RE, '').trim().slice(0, 64)
  return cleaned.length === 0 ? null : cleaned
}

/** 从已解析的 entries 提取（`session-history` 已有 entries 时直接复用，避免二次解析） */
export function extractAgentFromEntries(
  entries: ReadonlyArray<Record<string, unknown>>
): string | null | undefined {
  let result: string | null | undefined
  for (const entry of entries) {
    if (entry['type'] !== 'custom') continue
    const customType = entry['customType']
    if (typeof customType !== 'string' || !AGENT_CUSTOM_TYPES.has(customType)) continue

    const data = entry['data']
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    const name = (data as Record<string, unknown>)['name']
    // 非字符串（含缺失）不是「清除」，只是这条不匹配
    if (name === undefined) continue
    if (name === null) {
      result = null
      continue
    }
    if (typeof name !== 'string') continue
    result = sanitizeAgentName(name)
  }
  return result
}

/** 从 JSONL 文本提取（内部复用 `parseEntries`，坏行会被跳过） */
export function extractAgentFromJsonl(text: string): string | null | undefined {
  return extractAgentFromEntries(parseEntries(text))
}

/**
 * 读文件尾部并提取 agent（`session:state` 用）。
 *
 * **fail-soft**：这不是会话状态本体，读不到/不是 jsonl/路径不存在一律返回 `undefined`
 * （= 未知），绝不把「没读到」升级成「没有 agent」，更不抛给调用方。
 */
export async function readSessionAgent(
  filePath: string,
  options: { maxBytes?: number } = {}
): Promise<string | null | undefined> {
  if (!filePath.toLowerCase().endsWith('.jsonl')) return undefined
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  let handle
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    const size = stat.size
    const start = size > maxBytes ? size - maxBytes : 0
    const length = size - start
    if (length <= 0) return undefined
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const text = buffer.toString('utf8')
    // 起始位置可能落在某行中间：`parseEntries` 会因该行 JSON 不完整而跳过它
    return extractAgentFromJsonl(text)
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
