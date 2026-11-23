/**
 * 事件归约纯函数（§5.5 lib/reducer.ts）：`(state, record) => state`。
 *
 * 实现要点（§7 约束 7）：
 * - `text_delta` 拼接增量（与 main 侧 16ms 合并窗口配合）；
 * - `text_end` / `message_end` 用权威内容整体替换增量；
 * - **`agent_end` ≠ 结束**：进入 `settling`，只有 `agent_settled` 才回 `idle`
 *   （retry / compaction / steer / followUp 可能在 `agent_end` 之后继续）。
 *
 * M3 扩展（同一套归约同时服务「实时事件」与「历史回放」）：
 * - 工具卡片的生命周期按 `toolCallId` 关联（docs/json.md 的
 *   `tool_execution_start/update/end`），历史回放则来自 `toolResult` 消息；
 * - 运行态细分 `idle / streaming / tool_running / settling`（§8.1 M3）；
 * - 纯函数、无副作用、不引 React，便于 §9.1 U5/U6/U7/U12 单测。
 */
export type RunPhase = 'idle' | 'streaming' | 'tool_running' | 'settling'

/** 工具状态：pending = 已声明但还没开始执行（历史回放里也可能没有结果） */
export type ToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface ToolItem {
  toolCallId: string
  toolName: string
  /** 参数全文（格式化 JSON / 原始字符串），供「展开」查看 */
  argsText: string
  /** 一行参数摘要（工具卡片折叠态显示） */
  argsSummary: string
  status: ToolStatus
  /** 输出全文（组件决定预览前 N 行） */
  output: string
  isError: boolean
  /** 输出因超长被 reducer 截断（不是工具侧截断） */
  outputTruncated?: boolean
  /** `tool_execution_end.durationMs`（工具侧单调时钟测得） */
  durationMs?: number
  /** 输出被工具截断时的完整输出文件路径（§7 约束 14；M3 只提示，不读取） */
  fullOutputPath?: string
}

export interface ChatMessage {
  /** 去重键：role + timestamp + 文本（`message_end` 可能重复到达） */
  key: string
  role: string
  text: string
  timestamp?: number
  /** 该消息声明/关联的工具调用（按 toolCallId 去重） */
  tools?: ToolItem[]
}

export interface ChatState {
  messages: ChatMessage[]
  /** 正在流式拼接的助手文本（尚未被权威消息覆盖） */
  streaming: string
  /** 流式中助手消息已声明的工具调用 */
  streamingTools: ToolItem[]
  phase: RunPhase
}

export const initialChatState: ChatState = {
  messages: [],
  streaming: '',
  streamingTools: [],
  phase: 'idle'
}

/** 单条工具输出在 renderer 中的上限（防止超大输出打爆渲染进程内存）；超出部分显式标记 */
export const MAX_TOOL_OUTPUT_CHARS = 200_000

type JsonRecord = { type: string; [key: string]: unknown }

/** 归约一条 `evt:record` 里的 pi 记录（单条路径，等价于 `reduceRecords(state, [record])`） */
export function reduceRecord(state: ChatState, record: JsonRecord): ChatState {
  return buildRecords(state, [record])
}

/**
 * 批量归约（回放 / 测试用）。
 *
 * **性能约束（M4 前置修复）**：历史回放动辄上万条记录，若每条 `message_end` 都
 * 全量拷贝 messages 并线性扫一遍 key，整体就是 O(n²)（30k 条实测约 4.9s）。
 * 因此单条与批量共用同一套「可变游标 + 懒建索引」的引擎：
 * - messages 只在首次写入时**拷贝一次**（copy-on-write），之后原地 push/替换；
 * - `key → 下标` 与 `toolCallId → 消息下标` 两个索引**懒建**，之后 O(1) 维护。
 */
export function reduceRecords(state: ChatState, records: JsonRecord[]): ChatState {
  return buildRecords(state, records)
}

/* ------------------------------------------------------------------ *
 * 归约引擎（内部）：可变游标，避免 O(n²)
 * ------------------------------------------------------------------ */

/** 写前拷贝的工作游标；索引懒建，只在真正需要时扫描一次 */
interface Build {
  messages: ChatMessage[]
  /** messages 是否为游标私有的可写副本 */
  ownedMessages: boolean
  /** 去重键 → 消息下标（重复 message_end 的幂等判定） */
  keyIndex: Map<string, number> | undefined
  /** toolCallId → 所属消息下标（工具卡片的 O(1) 定位） */
  toolIndex: Map<string, number> | undefined
  streaming: string
  streamingTools: ToolItem[]
  phase: RunPhase
  /** 有任何字段变化（false 时返回原 state 引用，保持幂等语义） */
  touched: boolean
}

function createBuild(state: ChatState): Build {
  return {
    messages: state.messages,
    ownedMessages: false,
    keyIndex: undefined,
    toolIndex: undefined,
    streaming: state.streaming,
    streamingTools: state.streamingTools,
    phase: state.phase,
    touched: false
  }
}

function buildRecords(state: ChatState, records: readonly JsonRecord[]): ChatState {
  if (records.length === 0) return state
  const build = createBuild(state)
  for (const record of records) applyRecord(build, record)
  if (!build.touched) return state
  return {
    messages: build.messages,
    streaming: build.streaming,
    streamingTools: build.streamingTools,
    phase: build.phase
  }
}

/** 写前拷贝：整批归约只发生一次 */
function ownMessages(build: Build): ChatMessage[] {
  if (!build.ownedMessages) {
    build.messages = build.messages.slice()
    build.ownedMessages = true
  }
  return build.messages
}

function keyIndexOf(build: Build): Map<string, number> {
  if (build.keyIndex === undefined) {
    const index = new Map<string, number>()
    for (let i = 0; i < build.messages.length; i += 1) {
      const message = build.messages[i]
      if (message === undefined) continue
      // 重复 key 取首次出现（判重只需要「是否存在」）
      if (!index.has(message.key)) index.set(message.key, i)
    }
    build.keyIndex = index
  }
  return build.keyIndex
}

function toolIndexOf(build: Build): Map<string, number> {
  if (build.toolIndex === undefined) {
    const index = new Map<string, number>()
    for (let i = 0; i < build.messages.length; i += 1) {
      const tools = build.messages[i]?.tools
      if (tools === undefined) continue
      for (const tool of tools) index.set(tool.toolCallId, i)
    }
    build.toolIndex = index
  }
  return build.toolIndex
}

function registerTools(build: Build, message: ChatMessage, index: number): void {
  const tools = message.tools
  if (tools === undefined || tools.length === 0) return
  if (build.toolIndex === undefined) return
  for (const tool of tools) build.toolIndex.set(tool.toolCallId, index)
}

function appendMessage(build: Build, message: ChatMessage): void {
  const messages = ownMessages(build)
  messages.push(message)
  const index = messages.length - 1
  keyIndexOf(build).set(message.key, index)
  registerTools(build, message, index)
}

function replaceMessage(build: Build, index: number, message: ChatMessage): void {
  const messages = ownMessages(build)
  const previous = messages[index]
  messages[index] = message
  const keyIndex = keyIndexOf(build)
  if (previous !== undefined && keyIndex.get(previous.key) === index) keyIndex.delete(previous.key)
  if (!keyIndex.has(message.key)) keyIndex.set(message.key, index)
  if (build.toolIndex !== undefined && previous?.tools !== undefined) {
    for (const tool of previous.tools) {
      if (build.toolIndex.get(tool.toolCallId) === index) build.toolIndex.delete(tool.toolCallId)
    }
  }
  registerTools(build, message, index)
}

/** 归约一条记录到游标上（原地修改，不产生中间 state） */
function applyRecord(build: Build, record: JsonRecord): void {
  switch (record.type) {
    case 'agent_start':
      build.phase = 'streaming'
      build.streaming = ''
      build.streamingTools = []
      build.touched = true
      return

    case 'message_start': {
      const message = asRecord(record['message'])
      if (message?.['role'] !== 'assistant') return
      build.phase = 'streaming'
      build.streaming = ''
      build.streamingTools = []
      build.touched = true
      return
    }

    case 'message_update':
      applyMessageUpdate(build, record)
      return

    case 'message_end':
      applyMessageEnd(build, record)
      return

    case 'tool_execution_start': {
      const toolCallId = asString(record['toolCallId'])
      const toolName = asString(record['toolName'])
      if (toolCallId === undefined || toolName === undefined) return
      upsertTool(build, {
        ...createToolItem(toolCallId, toolName, record['args']),
        status: 'running'
      })
      // settling 不被降级（§7 约束 7）
      if (build.phase !== 'settling') build.phase = 'tool_running'
      build.touched = true
      return
    }

    case 'tool_execution_update': {
      const toolCallId = asString(record['toolCallId'])
      const toolName = asString(record['toolName'])
      if (toolCallId === undefined || toolName === undefined) return
      const partial = extractToolOutput(record['partialResult'])
      upsertTool(build, {
        ...createToolItem(toolCallId, toolName, record['args']),
        status: 'running',
        output: partial.output,
        ...(partial.fullOutputPath === undefined ? {} : { fullOutputPath: partial.fullOutputPath }),
        isError: partial.isError
      })
      build.touched = true
      return
    }

    case 'tool_execution_end': {
      const toolCallId = asString(record['toolCallId'])
      const toolName = asString(record['toolName'])
      if (toolCallId === undefined || toolName === undefined) return
      const result = extractToolOutput(record['result'])
      const isError = record['isError'] === true || result.isError
      const durationMs =
        typeof record['durationMs'] === 'number' && Number.isFinite(record['durationMs'])
          ? record['durationMs']
          : undefined
      upsertTool(build, {
        ...createToolItem(toolCallId, toolName, record['args']),
        status: isError ? 'error' : 'success',
        output: result.output,
        isError,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath })
      })
      // 工具收尾后回到 streaming；`settling`/`idle` 不被降级（§7 约束 7）
      if (build.phase === 'tool_running') build.phase = 'streaming'
      build.touched = true
      return
    }

    case 'agent_end':
      // 低层 run 结束，但可能有 retry / compaction / 排队消息继续
      build.phase = 'settling'
      build.touched = true
      return

    case 'agent_settled': {
      // 没有归属消息的工具卡片（扩展/适配器只在 stream 期声明）在 settled 时落成一条
      // 助手消息，保证「切回历史 / 下一轮渲染」时卡片不会丢
      const orphans = build.streamingTools
      if (orphans.length > 0) {
        appendMessage(build, {
          key: `assistant:tools:${orphans.map((tool) => tool.toolCallId).join(',')}`,
          role: 'assistant',
          text: '',
          tools: orphans
        })
      }
      build.phase = 'idle'
      build.streaming = ''
      build.streamingTools = []
      build.touched = true
      return
    }

    default:
      return
  }
}

/* ------------------------------------------------------------------ *
 * message_update
 * ------------------------------------------------------------------ */

function applyMessageUpdate(build: Build, record: JsonRecord): void {
  const inner = asRecord(record['assistantMessageEvent'])
  if (!inner) return

  if (inner['type'] === 'text_delta' && typeof inner['delta'] === 'string') {
    if (build.phase === 'idle') build.phase = 'streaming'
    build.streaming += inner['delta']
    build.touched = true
    return
  }

  if (inner['type'] === 'text_end' && typeof inner['content'] === 'string') {
    // 权威文本块：整体替换增量
    build.streaming = inner['content']
    build.touched = true
    return
  }

  if (inner['type'] === 'toolcall_end') {
    // 工具调用声明先落地成 pending 卡片，等 tool_execution_start 再转 running
    const toolCall = asRecord(inner['toolCall'])
    if (!toolCall) return
    const toolCallId = asString(toolCall['id'])
    const toolName = asString(toolCall['name'])
    if (toolCallId === undefined || toolName === undefined) return
    upsertTool(build, createToolItem(toolCallId, toolName, toolCall['arguments']))
    build.touched = true
  }
}

/* ------------------------------------------------------------------ *
 * message_end
 * ------------------------------------------------------------------ */

function applyMessageEnd(build: Build, record: JsonRecord): void {
  const message = asRecord(record['message'])
  if (!message) return

  const role = typeof message['role'] === 'string' ? message['role'] : 'assistant'
  if (role === 'toolResult') {
    applyToolResult(build, message)
    return
  }

  const text = extractText(message['content'])
  const timestamp = message['timestamp']
  const key = `${role}:${typeof timestamp === 'number' ? timestamp : 'na'}:${text}`
  if (keyIndexOf(build).has(key)) {
    // 重复到达：幂等，连引用都不变（U6）
    if (build.streaming === '' && build.streamingTools.length === 0) return
    build.streaming = ''
    build.streamingTools = []
    build.touched = true
    return
  }

  const declared = collectToolCalls(message['content'])
  const tools =
    role === 'assistant' ? mergeTools(build.streamingTools, declared) : mergeTools([], declared)

  const nextMessage: ChatMessage = {
    key,
    role,
    text,
    ...(typeof timestamp === 'number' ? { timestamp } : {}),
    ...(tools.length === 0 ? {} : { tools })
  }

  // optimistic 插入的用户消息会被 pi 原样回显一条 message_end(user)：
  // 用权威消息**就地替换**，避免同一句话出现两轮（§6.2 第一步的实现细节）
  const optimistic = findReplacedOptimisticUser(build.messages, role, text)
  if (optimistic !== undefined) {
    replaceMessage(build, optimistic, nextMessage)
  } else {
    appendMessage(build, nextMessage)
  }

  // 用权威消息覆盖增量（§7 约束 7）
  build.streaming = ''
  build.streamingTools = []
  build.touched = true
}

/** 工具结果消息：把 `toolCallId` 对应的卡片置为 success/error 并写入输出 */
function applyToolResult(build: Build, message: Record<string, unknown>): void {
  const toolCallId = asString(message['toolCallId'])
  if (toolCallId === undefined) return
  const output = extractToolOutput(message)
  const isError = message['isError'] === true
  updateTool(build, toolCallId, (tool) => ({
    ...tool,
    status: isError ? 'error' : 'success',
    output: output.output,
    isError,
    ...(output.fullOutputPath === undefined ? {} : { fullOutputPath: output.fullOutputPath })
  }))
}

/* ------------------------------------------------------------------ *
 * 工具卡片：创建、合并、更新
 * ------------------------------------------------------------------ */

const ARG_SUMMARY_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
  'name'
] as const

export function createToolItem(toolCallId: string, toolName: string, rawArgs: unknown): ToolItem {
  const args = asRecord(rawArgs)
  const argsText = formatArgs(rawArgs)
  return {
    toolCallId,
    toolName,
    argsText,
    argsSummary: summarizeToolArgs(args),
    status: 'pending',
    output: '',
    isError: false
  }
}

/** 一行参数摘要：优先取常见语义字段，否则退化到 JSON 片段 */
export function summarizeToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  for (const key of ARG_SUMMARY_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return `${key}: ${firstLine(value, 100)}`
    }
  }
  // 退化：单行紧凑 JSON（不要多行缩进，否则首行只有 `{`）
  try {
    return firstLine(JSON.stringify(args) ?? '', 100)
  } catch {
    return ''
  }
}

/** 参数全文（展开视图）：字符串原样，对象用 2 空格缩进 JSON */
export function formatArgs(rawArgs: unknown): string {
  if (typeof rawArgs === 'string') return rawArgs
  if (rawArgs === undefined || rawArgs === null) return ''
  return safeJson(rawArgs, 20_000)
}

/** 合并两批工具卡片（按 toolCallId 去重，后者覆盖状态但保留已有输出） */
function mergeTools(base: ToolItem[], extra: ToolItem[]): ToolItem[] {
  if (extra.length === 0) return base
  const merged = [...base]
  for (const item of extra) {
    const index = merged.findIndex((existing) => existing.toolCallId === item.toolCallId)
    if (index === -1) {
      merged.push(item)
      continue
    }
    const existing = merged[index]
    if (!existing) continue
    merged[index] = {
      ...item,
      status: existing.status === 'pending' ? item.status : existing.status,
      output: existing.output.length > 0 ? existing.output : item.output,
      ...(existing.durationMs === undefined && item.durationMs === undefined
        ? {}
        : { durationMs: existing.durationMs ?? item.durationMs }),
      ...(existing.fullOutputPath === undefined && item.fullOutputPath === undefined
        ? {}
        : { fullOutputPath: existing.fullOutputPath ?? item.fullOutputPath })
    }
  }
  return merged
}

/** 工具卡片的位置：流式卡片，或某条消息内的卡片 */
type ToolLocation = { kind: 'streaming' } | { kind: 'message'; index: number }

/**
 * 新建或更新工具卡片。
 *
 * 定位顺序：流式卡片 → 消息内卡片（索引给出最近一条）。
 * 这样工具即使先于 `message_end` 到达也能挂到正确的助手段上。
 */
function upsertTool(build: Build, item: ToolItem): void {
  if (findToolLocation(build, item.toolCallId) !== undefined) {
    updateTool(build, item.toolCallId, () => item)
    return
  }
  build.streamingTools = [...build.streamingTools, item]
  build.touched = true
}

function findToolLocation(build: Build, toolCallId: string): ToolLocation | undefined {
  if (build.streamingTools.some((tool) => tool.toolCallId === toolCallId))
    return { kind: 'streaming' }
  const index = toolIndexOf(build).get(toolCallId)
  return index === undefined ? undefined : { kind: 'message', index }
}

/**
 * 更新工具卡片（找不到就什么都不做）。
 *
 * 只更新**最近一条**持有该 `toolCallId` 的消息：`toolCallId` 在 pi 里唯一，
 * 历史回放与实时事件都按它关联，重复 id 只会出现在脏数据里。
 */
function updateTool(build: Build, toolCallId: string, update: (tool: ToolItem) => ToolItem): void {
  const location = findToolLocation(build, toolCallId)
  if (location === undefined) return

  if (location.kind === 'streaming') {
    build.streamingTools = build.streamingTools.map((tool) =>
      tool.toolCallId === toolCallId ? update(tool) : tool
    )
    build.touched = true
    return
  }

  const messages = ownMessages(build)
  const message = messages[location.index]
  if (message?.tools === undefined) return
  messages[location.index] = {
    ...message,
    tools: message.tools.map((tool) => (tool.toolCallId === toolCallId ? update(tool) : tool))
  }
  build.touched = true
}

/** 从助手消息的 content 中提取 toolCall 声明 */
export function collectToolCalls(content: unknown): ToolItem[] {
  if (!Array.isArray(content)) return []
  const tools: ToolItem[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] !== 'toolCall') continue
    const toolCallId = asString(record['id'])
    const toolName = asString(record['name'])
    if (toolCallId === undefined || toolName === undefined) continue
    tools.push(createToolItem(toolCallId, toolName, record['arguments']))
  }
  return tools
}

/* ------------------------------------------------------------------ *
 * 内容提取
 * ------------------------------------------------------------------ */

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.['type'] === 'text' && typeof record['text'] === 'string')
      parts.push(record['text'])
  }
  return parts.join('')
}

/** 从工具结果（`tool_execution_end.result` / `toolResult` 消息）中取输出与完整输出路径 */
export function extractToolOutput(value: unknown): {
  output: string
  isError: boolean
  fullOutputPath?: string
} {
  const record = asRecord(value)
  if (!record) {
    return { output: typeof value === 'string' ? capOutput(value).text : '', isError: false }
  }
  const text = extractText(record['content'])
  const details = asRecord(record['details'])
  const fullOutputPath = asString(details?.['fullOutputPath']) ?? asString(record['fullOutputPath'])
  const capped = capOutput(text)
  return {
    output: capped.text,
    isError: record['isError'] === true,
    ...(fullOutputPath === undefined ? {} : { fullOutputPath })
  }
}

/** 超长输出截断并显式标记（§7 约束 14：不静默截断） */
function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return { text, truncated: false }
  return {
    text: `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[输出过长：已截断，仅渲染前 ${MAX_TOOL_OUTPUT_CHARS} 字符]`,
    truncated: true
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 乐观插入的用户消息 key 前缀（`lib/sessionStore.ts` 的 optimisticUserMessage 同源） */
export const OPTIMISTIC_USER_KEY_PREFIX = 'user:local:'

/**
 * 找一条待替换的乐观用户消息：role 一致、文本一致、仍是本地乐观项。
 * 只在**最后一条**上匹配，避免把历史回放里相同的文本误当成本次乐观消息。
 */
function findReplacedOptimisticUser(
  messages: ChatMessage[],
  role: string,
  text: string
): number | undefined {
  if (role !== 'user') return undefined
  const lastIndex = messages.length - 1
  const last = messages[lastIndex]
  if (last === undefined) return undefined
  if (!last.key.startsWith(OPTIMISTIC_USER_KEY_PREFIX)) return undefined
  return last.text === text ? lastIndex : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeJson(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  try {
    const json = JSON.stringify(value, null, 2)
    if (typeof json !== 'string') return ''
    return json.length > maxLength ? `${json.slice(0, maxLength)}\n…` : json
  } catch {
    return ''
  }
}

function firstLine(text: string, maxLength: number): string {
  const line = text.split('\n')[0] ?? ''
  const single = line.replace(/\s+/g, ' ').trim()
  return single.length > maxLength ? `${single.slice(0, maxLength)}…` : single
}
