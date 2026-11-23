import { z } from 'zod'

/**
 * DTO 定义（架构文档 §5.4 出参）。M1 只落到骨架需要的字段，
 * M2+ 的 AgentState / ModelInfo 等按里程碑补齐，避免提前设计业务语义。
 */

/**
 * M5 审批策略（设置页可配置：是否默认开启 + 哪些工具触发审批）。
 *
 * 默认值与 §Q4 一致：默认开启，仅 bash / powershell / write / edit（删除类走 shell，被前两者覆盖）。
 * `tools` 只接受具名工具（小写、去重），不接受通配，避免「配错一个 "*" 就静默放大权限」。
 */
export const permissionPolicySchema = z
  .object({
    enabled: z.boolean(),
    tools: z
      .array(z.string().min(1).max(64))
      .max(32)
      .transform((tools) => [
        ...new Set(tools.map((tool) => tool.trim().toLowerCase()).filter((tool) => tool.length > 0))
      ]),
    /** 审批时钟（§6.3 唯一时钟，由扩展侧权威判定；这里随策略下发） */
    timeoutMs: z.number().int().min(5_000).max(600_000)
  })
  .strict()
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>

/** 客户端偏好视图（§3.2 local 连接配置；不含任何密钥，§7 约束 9/12） */
export const appConfigViewSchema = z.object({
  piCommand: z.string(),
  /** 可选覆盖 pi 默认会话目录（Q7）：M1 仅作为设置项占位，不参与流程 */
  sessionDir: z.string().optional(),
  workspaceRoots: z.array(z.string()),
  maxActiveSessions: z.number().int().positive(),
  idleRecycleMinutes: z.number().int().positive(),
  theme: z.enum(['dark', 'light', 'system']),
  /** M5：工具审批策略（随子进程环境下发给 pi-desktop-permission 扩展） */
  permission: permissionPolicySchema
})
export type AppConfigView = z.infer<typeof appConfigViewSchema>

/** 审批扩展的安装/兼容状态（`permission:status` 出参；只读，不返回任何内容） */
export const permissionStatusSchema = z.object({
  /** 扩展目录是否存在且带本客户端标记 */
  installed: z.boolean(),
  /** 已检查的扩展目录（诊断用，路径本身不敏感） */
  extensionDir: z.string(),
  installedVersion: z.string().optional(),
  /** 客户端支持的协议版本（与扩展侧握手值比较） */
  protocolVersion: z.number().int(),
  /** 安装是否落后于仓库内的源（true = 需要重跑安装脚本） */
  upToDate: z.boolean()
})
export type PermissionStatus = z.infer<typeof permissionStatusSchema>

/** pi 可执行文件自检状态（§3.3 三步自检；M2 实现，M4 补 steps 可视化） */
export const piSelfCheckStepSchema = z.object({
  /** locate = 定位可执行文件，version = `--version`，rpc = `--mode rpc` 连通性 */
  id: z.enum(['locate', 'version', 'rpc']),
  label: z.string(),
  state: z.enum(['ok', 'failed', 'skipped']),
  detail: z.string().optional()
})
export type PiSelfCheckStep = z.infer<typeof piSelfCheckStepSchema>

export const piSelfCheckStatusSchema = z.object({
  state: z.enum(['unknown', 'ok', 'missing', 'failed']),
  version: z.string().optional(),
  message: z.string().optional(),
  /** 三步自检的逐步结果（M4 设置页可视化）；旧路径不填也能工作 */
  steps: z.array(piSelfCheckStepSchema).optional(),
  /** 已解析的可执行文件路径（给设置页回填） */
  path: z.string().optional()
})
export type PiSelfCheckStatus = z.infer<typeof piSelfCheckStatusSchema>

/** `app:getBoot` 出参：启动态聚合（§5.4） */
export const bootStateSchema = z.object({
  config: appConfigViewSchema,
  piStatus: piSelfCheckStatusSchema,
  lastCwd: z.string().optional()
})
export type BootState = z.infer<typeof bootStateSchema>

/** 会话摘要（来自 session JSONL 只读索引，§5.2 SessionIndex） */
export const sessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  /** ISO 8601；排序用 mtime */
  updatedAt: z.string(),
  filePath: z.string(),
  totalTokens: z.number().optional(),
  totalCostUsd: z.number().optional()
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

/** `session:list` 出参 */
export const sessionListOutputSchema = z.object({
  items: z.array(sessionSummarySchema),
  nextCursor: z.string().optional()
})
export type SessionListOutput = z.infer<typeof sessionListOutputSchema>

/** `session:prompt` 出参：只表示「已接受 / 已排队 / 已被扩展处理」，完成只认 agent_settled */
export const promptDispositionSchema = z.enum(['started', 'queued', 'handled'])
export type PromptDisposition = z.infer<typeof promptDispositionSchema>

/**
 * `session:history` 出参（M3 补充通道，见 docs/architecture.md §5.4 注）。
 *
 * 选中历史任务时**只回放 JSONL 到 UI，不启动子进程**（§6.1 第 4 步）。
 * `records` 已归一成与 `evt:record` 同形（`message_end`）的记录，直接喂给 `lib/reducer.ts`。
 */
export interface SessionHistoryRecord {
  type: string
  [key: string]: unknown
}

export interface SessionHistoryOutput {
  records: SessionHistoryRecord[]
  /** 因超过回放上限（字节或条数）只回放了尾部，必须显式提示（§7 约束 14） */
  truncated: boolean
  /** 回放的消息条目数（诊断/测试用） */
  messageCount: number
  /** 文件里的消息条目总数（不只回放部分）；`truncated` 时用它显示「x/y 条」 */
  totalRecords: number
  /**
   * 会话文件**尚未落盘**（M4 复核修复 B1）：只有 `allowMissing: true`（fork 编排）时可能出现。
   * pi 从首条用户消息分叉得到空会话，新会话文件要等下一条 prompt 才写盘；
   * 此时返回空记录 + 本标志，renderer 按「空会话」处理，不当成错误。
   */
  fileAbsent?: boolean
}

/**
 * `session:stats` 出参（M4 补充通道）：pi `get_session_stats` 的客户端视图
 * （docs/rpc-commands.md#get_session_stats）。
 *
 * **数据完整来自 pi**：客户端不做任何本地估算；字段缺失时 UI 显示「—」（A3 同源约束）。
 */
export const sessionTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number()
})
export type SessionTokens = z.infer<typeof sessionTokensSchema>

export const sessionContextUsageSchema = z.object({
  /** 刚 compaction 后 pi 会给 null，直到下一次有 usage 的回复 */
  tokens: z.number().nullable().optional(),
  contextWindow: z.number().optional(),
  percent: z.number().nullable().optional()
})

export const sessionStatsSchema = z.object({
  sessionFile: z.string().optional(),
  sessionId: z.string().optional(),
  userMessages: z.number().int().nonnegative(),
  assistantMessages: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolResults: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  /** pi 未提供 tokens 时整块缺失（UI 显示「—」） */
  tokens: sessionTokensSchema.optional(),
  cost: z.number().optional(),
  contextUsage: sessionContextUsageSchema.optional()
})
export type SessionStats = z.infer<typeof sessionStatsSchema>

/**
 * `session:forkPoints` 出参（M4 补充通道）：pi `get_fork_messages` 的结果。
 *
 * pi 的 `fork` 只接受**用户消息** entry 的 id（docs/rpc-commands.md#fork），
 * 所以可分叉点在语义上就是「可以回到的那几条用户消息」。
 */
export const forkPointSchema = z.object({
  entryId: z.string(),
  text: z.string()
})
export type ForkPoint = z.infer<typeof forkPointSchema>

export const sessionForkPointsOutputSchema = z.object({
  points: z.array(forkPointSchema)
})
export type SessionForkPointsOutput = z.infer<typeof sessionForkPointsOutputSchema>

/**
 * 产物条目（M6）。
 *
 * `path` 一律是**工作区相对路径**（POSIX 分隔符，与 `git status` 同形）：
 * 主进程不把绝对路径当作展示口径，renderer 拿 `ArtifactList.root` 拼绝对路径
 * 再做 `fs:readText` / `artifact:open`（主进程仍会按工作区根重新校验，不信 renderer）。
 */
export const artifactChangeSchema = z.enum(['added', 'modified', 'deleted', 'renamed'])
export type ArtifactChange = z.infer<typeof artifactChangeSchema>

export const artifactEntrySchema = z.object({
  /** 工作区相对路径（POSIX 分隔符） */
  path: z.string(),
  change: artifactChangeSchema,
  /** 重命名前的旧路径（仅 `change:'renamed'`）；M6 对 §5.4 的补充字段 */
  oldPath: z.string().optional(),
  /** 当前大小（已删除条目没有该字段） */
  sizeBytes: z.number().optional(),
  /** 二进制文件（UI 不渲染预览/diff，改为「系统程序打开」引导） */
  binary: z.boolean().optional(),
  /** git 未跟踪文件（`??`），UI 可额外标注 */
  untracked: z.boolean().optional()
})
export type ArtifactEntry = z.infer<typeof artifactEntrySchema>

/**
 * 产物扫描方式（M6）：
 * - `git`：`git status --porcelain=v1`（只读执行，cwd = 会话工作目录）；
 * - `snapshot`：非 git 工作区的「会话开始快照 → 重扫」比对（UI 必须显式说明）。
 */
export const artifactModeSchema = z.enum(['git', 'snapshot'])
export type ArtifactMode = z.infer<typeof artifactModeSchema>

/** `fs:listArtifacts` 出参（M6 把 §5.4 的 `ArtifactEntry[]` 包成带上限/模式信息） */
export const artifactListSchema = z.object({
  items: z.array(artifactEntrySchema),
  mode: artifactModeSchema,
  /** 已校验（realpath 归一后）的工作区根绝对值 */
  root: z.string(),
  /** 条目数超过上限（默认 1000）被截断，必须显式提示（§7 约束 14） */
  truncated: z.boolean(),
  /** 截断前的总数 */
  totalCount: z.number(),
  /** 扫描时间（ISO 8601） */
  scannedAt: z.string(),
  /** 需要向用户解释的事实（非 git 快照比对 / 快照在扫描时补建 / git 不可用回退等） */
  note: z.string().optional()
})
export type ArtifactList = z.infer<typeof artifactListSchema>

/**
 * 统一 diff（M6 产物面板）。
 *
 * M6 在 §5.4 的 `{path, patch}` 上补齐 `truncated` / `mode` / 二进制标记 / 说明字段：
 * 超限截断必须显式标注（§7 约束 14），二进制文件不能假装自己是文本补丁。
 */
export const unifiedDiffSchema = z.object({
  path: z.string(),
  patch: z.string(),
  /** patch 因超过 2MB 上限被截断（末尾按行边界裁剪） */
  truncated: z.boolean(),
  mode: artifactModeSchema,
  change: artifactChangeSchema.optional(),
  oldPath: z.string().optional(),
  binary: z.boolean().optional(),
  note: z.string().optional()
})
export type UnifiedDiff = z.infer<typeof unifiedDiffSchema>

/** `fs:readText` 出参（M6 在 §5.4 的 `{text, truncated}` 上补二进制/分页信息） */
export const readTextResultSchema = z.object({
  /** 工作区相对路径（回显，便于多选场景对账） */
  path: z.string(),
  /** 二进制文件时为空串（renderer 走「系统程序打开」引导，不渲染乱码） */
  text: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
  sizeBytes: z.number(),
  /** 本次读取的起始字节偏移（分页） */
  offset: z.number()
})
export type ReadTextResult = z.infer<typeof readTextResultSchema>

/** 运行状态事件载荷（§5.4 事件表 evt:status） */
export const runStatusSchema = z.enum(['starting', 'running', 'settled', 'exited', 'recycled'])
export type RunStatus = z.infer<typeof runStatusSchema>

/**
 * `evt:status` 载荷：**必须带 `sessionKey`**（M3 多会话依赖）。
 * 只给裸状态串时，renderer 无法把状态关联到具体会话。
 */
export const statusEventSchema = z.object({
  sessionKey: z.string(),
  status: runStatusSchema
})
export type StatusEvent = z.infer<typeof statusEventSchema>

/** 诊断事件载荷（stderr 尾部 / 崩溃信息，§5.4 事件表 evt:diagnostic） */
export const diagnosticEventSchema = z.object({
  sessionKey: z.string().optional(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  stderrTail: z.string().optional()
})
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>

/**
 * 推理档位（docs/rpc-commands.md#set_thinking_level）。
 *
 * pi 会自行 clamp 不支持的值（`xhigh`/`max` 仅部分模型支持），因此客户端给全集，
 * 不自己发明「当前模型支持哪些档位」的判断。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** 模型信息（`model:list` / `AgentState.model`，取自 pi RPC 的 Model 对象） */
export const modelInfoSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  provider: z.string(),
  api: z.string().optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  /** 每百万 token 的美元价格 */
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number()
    })
    .optional()
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

/** `session:state` 出参（§5.4 AgentState）：pi `get_state` 的客户端视图 */
export const agentStateSchema = z.object({
  /** 客户端会话状态机位置（与 evt:status 同源） */
  status: runStatusSchema,
  /** 是否有自动工作未完（只有 agent_settled 才置 false，§7 约束 7） */
  busy: z.boolean(),
  sessionFile: z.string().optional(),
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  model: modelInfoSchema.optional(),
  thinkingLevel: z.string().optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  steeringMode: z.string().optional(),
  followUpMode: z.string().optional(),
  messageCount: z.number(),
  pendingMessageCount: z.number()
})
export type AgentState = z.infer<typeof agentStateSchema>

/**
 * `evt:record` 载荷：一条已归一的 pi 会话事件（§5.4）。
 * `record` 保留 pi 原始记录形状；`mergedCount` 表示本次为 16ms 窗口合并后的
 * text_delta（>1 时 delta 已拼接）。
 */
export interface RecordEvent {
  sessionKey: string
  record: { type: string; [key: string]: unknown }
  mergedCount?: number
}

/** `evt:extui` 载荷：pi 的 extension_ui_request（M5 处理 select / setStatus 两种） */
export interface ExtUiEvent {
  sessionKey: string
  request: { type: string; [key: string]: unknown }
}
