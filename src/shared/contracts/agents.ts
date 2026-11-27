import { z } from 'zod'

/**
 * Agent 目录的共享契约（A18：以某个 agent 身份开始会话）。
 *
 * 为什么这两个类型在 shared 而不是 main：`api.ts`（preload/renderer 的类型来源）要引用它，
 * 而 shared 不能反向依赖 main。主进程的扫描逻辑在 `services/agent-catalog.ts`。
 *
 * 两个必须先弄清的事实（实测得出）：
 * 1. `--agent <name>` **不是 pi core 的参数**，而是 `pi-open-agents` 扩展注册的启动 flag；
 *    扩展没装时传它会直接 `Error: Unknown option: --agent` 起不来 → 必须探测能力再决定是否传。
 * 2. **非法 agent 名会被静默忽略**（pi 照常启动、回落到默认模型，不报错）
 *    → 客户端必须用扫描出的名单自己校验。
 */

export const agentSummarySchema = z.object({
  /** 传给 `--agent` 的名字（frontmatter 的 name，缺省用文件名） */
  name: z.string(),
  description: z.string().optional(),
  /** pi-open-agents 的 `mode`：`all` / `primary` / `subagent`（仅供参考） */
  mode: z.string().optional(),
  model: z.string().optional(),
  scope: z.enum(['global', 'project']),
  /**
   * 目录分组（A29）：agent 定义所在子目录的分段，如 `['intranet']`；根目录为 `[]`。
   *
   * 为什么用它表达「父子」：pi / pi-open-agents 的 frontmatter **没有 parent 字段**，
   * 唯一的层级信息就是文件所在目录（`agents/intranet/architect.md` 属于 intranet 组）。
   * 选择器据此渲染成树。
   */
  group: z.array(z.string()),
  /** 定义文件绝对路径（诊断用；不返回正文） */
  file: z.string()
})

export type AgentSummary = z.infer<typeof agentSummarySchema>

export const agentCatalogViewSchema = z.object({
  agents: z.array(agentSummarySchema),
  /** pi 是否支持 `--agent`（`pi --help` 探测）；false 时 UI 不应显示选择器 */
  supportsAgentFlag: z.boolean(),
  /** 探测失败或未定位 pi 时的可读说明 */
  note: z.string().optional()
})

export type AgentCatalogView = z.infer<typeof agentCatalogViewSchema>

/* ------------------------------------------------------------------ *
 * A38 / A40：专家标记的解析与切换命令（main / renderer 共用纯函数）
 * ------------------------------------------------------------------ */

/**
 * 会话文件里表示「当前专家」的两类自定义条目（由 pi-open-agents 写入）。
 * 两者统一按**文件顺序取最后一条**，不设类型优先级。
 */
export const AGENT_ENTRY_CUSTOM_TYPES = ['open-agents-state', 'active_agent'] as const

/** 扩展的清除 token（`/agent none`；扩展同时接受 clear，客户端固定用 none） */
export const AGENT_CLEAR_TOKEN = 'none'

const AGENT_CUSTOM_TYPE_SET: ReadonlySet<string> = new Set(AGENT_ENTRY_CUSTOM_TYPES)

/** 控制字符（U+0000–U+001F、U+007F）：用码点构造，避免 lint 对字面控制字符的误报 */
const CONTROL_CHARS_GLOBAL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
  // 必须带 g：`replace` 只换第一个匹配，漏掉 g 会留下第 2 个控制字符
  'g'
)
/** 同一个字符集但不带 g：带 g 的 `test` 会推进 lastIndex，产生假阴性 */
const CONTROL_CHARS_TEST_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
)

/**
 * 名字净化：控制字符会污染 UI/日志，超长会撑爆输入区。
 * 规则与 A38 读会话文件时完全一致（去控制字符 → trim → 截 64 字符）；净化后为空 → `null`。
 */
export function sanitizeAgentName(value: string): string | null {
  const cleaned = value.replace(CONTROL_CHARS_GLOBAL_RE, '').trim().slice(0, 64)
  return cleaned.length === 0 ? null : cleaned
}

/**
 * 单条会话 entry → 三态：`string` 当前专家 / `null` 显式清除 / `undefined` 与该标记无关。
 *
 * 事实来源（A38）：pi 的 `get_state` 与 RPC 事件**都不携带 agent**，专家身份完全由
 * `pi-open-agents` 扩展以自定义条目写进会话文件：
 *   {"type":"custom","customType":"open-agents-state","data":{"name":"scout"}}
 *   {"type":"custom","customType":"active_agent",     "data":{"name":"scout"}}
 */
export function agentNameFromEntry(entry: unknown): string | null | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  if (record['type'] !== 'custom') return undefined
  const customType = record['customType']
  if (typeof customType !== 'string' || !AGENT_CUSTOM_TYPE_SET.has(customType)) return undefined

  const data = record['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const name = (data as Record<string, unknown>)['name']
  // 非字符串（含缺失）不是「清除」，只是这条不匹配
  if (name === undefined) return undefined
  if (name === null) return null
  if (typeof name !== 'string') return undefined
  return sanitizeAgentName(name)
}

/**
 * 记录级解析（F2）：除裸 `custom` 外，还接受 pi 的 `entry_appended` 包装
 * （`{type:'entry_appended', entry:{...}}` —— 扩展每次 `appendEntry` 都会发）。
 *
 * 其余 `customType`（如 `web-search-results`）与 compaction 记录一律 `undefined`。
 */
export function agentNameFromRecord(record: {
  type?: string
  [key: string]: unknown
}): string | null | undefined {
  if (record.type === 'entry_appended') return agentNameFromEntry(record['entry'])
  if (record.type === 'custom') return agentNameFromEntry(record)
  return undefined
}

/** 切换命令文本（`null` → 清除）：扩展只认单 token 参数（F4） */
export function agentSwitchCommand(name: string | null): string {
  return name === null ? `/agent ${AGENT_CLEAR_TOKEN}` : `/agent ${name}`
}

/**
 * 能否用扩展命令切换（F4）。
 *
 * `pi-open-agents` 把 `args.trim()` **整体**当名字，所以含空白的名字会被解析错；
 * 因此运行中切换只接受「单个 token」：无空白、无控制字符、1..64 字符，
 * 且不是 `none` / `clear` 这两个保留字（它们表示「清除」，不是专家名）。
 * 名字含空白的专家仍可在**新建任务**时用 `--agent` 指定（那条路径能接受）。
 */
export function isAgentNameSwitchable(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (CONTROL_CHARS_TEST_RE.test(name)) return false
  if (/\s/.test(name)) return false
  const lowered = name.toLowerCase()
  return lowered !== AGENT_CLEAR_TOKEN && lowered !== 'clear'
}
