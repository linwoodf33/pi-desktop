import type { EventChannel } from '../ipc-channels'
import type { AgentCatalogView } from './agents'
import type { SkillCatalogView } from './skills'
import type {
  ModelEntryInput,
  ModelConfigView,
  ModelConfigWriteResult,
  UpsertProviderInput
} from './model-config'
import type { ConfigUpdateInput, ExtUiResponseInputDto } from './schemas'
import type { Result } from './result'
import type {
  AgentState,
  ArtifactList,
  AppConfigView,
  BootState,
  DiagnosticEvent,
  Diagnostics,
  DirListing,
  ExtUiEvent,
  ModelInfo,
  PermissionStatus,
  PiSelfCheckStatus,
  PromptDisposition,
  ReadTextResult,
  SessionToolMode,
  RecordEvent,
  SessionListOutput,
  SessionForkPointsOutput,
  SessionHistoryOutput,
  SessionStats,
  StatusEvent,
  UnifiedDiff
} from './types'

/**
 * preload 通过 contextBridge 暴露到 `window.pi` 的形状（架构文档 §4.1、§5.4）。
 *
 * 强约束：
 * - 方法集合 == §5.4 白名单，且每个方法绑定固定通道，**没有** channel 字符串参数；
 * - renderer 只能调用这些方法，拿不到 ipcRenderer，因此无法构造任意通道调用（§9.4 S2）。
 */
export type Unsubscribe = () => void

/**
 * 产物通道的会话引用（M6）：活跃会话用 `sessionKey`，已回放的历史任务用 `sessionFile`。
 * 两者互斥；都不传时只能使用绝对路径 + 主进程已知的工作区白名单。
 */
export interface ArtifactRefInput {
  sessionKey?: string
  sessionFile?: string
}

export interface PiInvokeApi {
  app: {
    getBoot(): Promise<Result<BootState>>
    /** A25：诊断信息（版本 / 目录 / pi 状态；不含密钥） */
    diagnostics(): Promise<Result<Diagnostics>>
    /** A26：写系统剪贴板（主进程执行；`file://` 下 renderer 的 navigator.clipboard 不可用） */
    copyText(input: { text: string }): Promise<Result<{ ok: true }>>
  }
  pi: {
    locate(input?: { path?: string }): Promise<Result<PiSelfCheckStatus>>
  }
  session: {
    list(input?: { cwd?: string; cursor?: string }): Promise<Result<SessionListOutput>>
    /**
     * M3 补充：只读回放会话 JSONL（§5.4 注；不启动子进程）。
     * `allowMissing`（M4 复核修复 B1）：fork 后新会话文件可能尚未落盘（首条消息分叉 = 空会话），
     * 传 `true` 时主进程按「空会话」返回并带 `fileAbsent: true`，不报 `PATH_DENIED`。
     */
    history(input: {
      sessionFile: string
      maxRecords?: number
      allowMissing?: boolean
    }): Promise<Result<SessionHistoryOutput>>
    create(input: {
      cwd: string
      model?: string
      name?: string
      /** 起始模式 = pi 的工具选择（full / readonly / no-tools） */
      toolMode?: SessionToolMode
      /** 会话身份 agent（`--agent`）：必须先由 `agents:list` 校验过 */
      agent?: string
    }): Promise<Result<{ sessionKey: string; sessionId: string }>>
    resume(input: { sessionFile: string }): Promise<Result<{ sessionKey: string }>>
    /**
     * 分叉（§6.5 / A4）。
     *
     * pi 语义（docs/rpc-commands.md#fork）：`entryId` 是**用户消息** entry 的 id，
     * 运行中进程执行 RPC `fork` 后切到新会话；原 key 释放、通道移交给新 key（复用同一进程）。
     * 省略 `entryId` 时用 CLI `--fork <sessionFile>` 新起进程，原会话文件字节不变。
     */
    fork(input: {
      sessionKey: string
      entryId?: string
      /** @deprecated 用 entryId */
      messageId?: string
    }): Promise<Result<{ sessionKey: string }>>
    /** M4：可分叉点（pi `get_fork_messages`，只列用户消息） */
    forkPoints(input: { sessionKey: string }): Promise<Result<SessionForkPointsOutput>>
    prompt(input: {
      sessionKey: string
      message: string
      images?: string[]
      streamingBehavior?: 'steer' | 'followUp'
    }): Promise<Result<{ disposition: PromptDisposition }>>
    abort(input: { sessionKey: string }): Promise<Result<{ ok: true }>>
    dispose(input: { sessionKey: string }): Promise<Result<{ ok: true }>>
    /** M2：pi `get_state` 的客户端视图（§5.4 AgentState） */
    state(input: { sessionKey: string }): Promise<Result<AgentState>>
    /** M4：pi `get_session_stats` 的客户端视图（token/成本，不在客户端估算） */
    stats(input: { sessionKey: string }): Promise<Result<SessionStats>>
    /**
     * A23：改会话显示名。活跃会话走 RPC；历史任务由主进程追加 `session_info` 记录
     * （只 append，不改写既有会话内容）。
     */
    setName(input: {
      sessionKey?: string
      sessionFile?: string
      name: string
    }): Promise<Result<{ ok: true }>>
  }
  /**
   * 模型管理（A14）：直接管理 pi 的 `models.json` 与 `settings.json#defaultModel`。
   *
   * 与上面的 `model`（会话切换当前模型）不同：这里改的是**磁盘上的配置**，
   * 影响之后启动的会话，不影响已经在跑的会话。
   */
  skills: {
    /** A31：可用技能清单（只读）。带 `cwd` 时一并扫描项目级 `.pi/skills`。 */
    list(input?: { cwd?: string }): Promise<Result<SkillCatalogView>>
  }
  agents: {
    /**
     * 可用 agent 目录（只读）。`supportsAgentFlag=false` 表示 pi 没注册 `--agent`
     * （通常是没装 pi-open-agents 扩展），此时 UI 不应显示选择器。
     */
    list(input?: { cwd?: string }): Promise<Result<AgentCatalogView>>
  }
  models: {
    /** apiKey 只返回 `hasApiKey` / `apiKeyHint`，明文不出主进程 */
    read(): Promise<Result<ModelConfigView>>
    /** `null` = 清除默认模型，恢复 pi 的自动选择 */
    setDefault(input: { modelId: string | null }): Promise<Result<ModelConfigWriteResult>>
    upsertProvider(input: UpsertProviderInput): Promise<Result<ModelConfigWriteResult>>
    removeProvider(input: { id: string }): Promise<Result<ModelConfigWriteResult>>
    upsertModel(input: {
      providerId: string
      model: ModelEntryInput
    }): Promise<Result<ModelConfigWriteResult>>
    removeModel(input: {
      providerId: string
      modelId: string
    }): Promise<Result<ModelConfigWriteResult>>
  }
  model: {
    list(): Promise<Result<ModelInfo[]>>
    set(input: {
      sessionKey: string
      model: string
      thinkingLevel?: string
    }): Promise<Result<{ ok: true }>>
  }
  /** M4：偏好持久化（ConfigStore）；只接受偏好字段，不含任何密钥（§7 约束 9/12） */
  config: {
    update(input: ConfigUpdateInput): Promise<Result<AppConfigView>>
  }
  /**
   * 回 `extension_ui_response`（M5）。
   *
   * 主进程强校验：requestId 必须属于该 sessionKey 且来自该会话**当前**通道的未决请求，
   * 且 `response.value` 必须是该请求给出的选项之一；否则 `REQUEST_NOT_FOUND` 且写诊断（§9.4 S9/S10）。
   */
  extui: {
    respond(input: {
      sessionKey: string
      requestId: string
      response: ExtUiResponseInputDto
    }): Promise<Result<{ ok: true }>>
  }
  /** M5：审批扩展安装/协议状态（只读） */
  permission: {
    status(): Promise<Result<PermissionStatus>>
  }
  /**
   * M6 产物通道。
   *
   * 入参只带「会话引用 + 工作区相对路径」，**不带工作区根**：根由主进程根据
   * `sessionKey`（活跃会话）或 `sessionFile`（会话 header 的 cwd）推导，
   * renderer 无法指定任意目录（§9.4 S6 等价项）。
   */
  fs: {
    pickDirectory(input?: { defaultPath?: string }): Promise<Result<{ path: string }>>
    /**
     * A22：选择工作区内的文件，返回**工作区相对路径**（POSIX）。
     * 为什么不是 `@path`：pi 的 `@file` 只在 CLI 生效，RPC 模式明确拒绝；
     * 所以这里只把相对路径插进消息，让模型用自己的 read 工具去读。
     * 取消返回 `canceled: true`（不是错误）。
     */
    /** A27：列出工作区目录（应用内引用选择器；与 pickWorkspaceFile 二选一的入口） */
    listWorkspaceDir(input: {
      sessionKey?: string
      sessionFile?: string
      path?: string
    }): Promise<Result<DirListing>>
    pickWorkspaceFile(input: {
      /** 活跃会话 */
      sessionKey?: string
      /** 历史（回放）任务：主进程从会话索引读该 JSONL 的 cwd 作为工作区根 */
      sessionFile?: string
      defaultPath?: string
      /** 选文件（默认）还是文件夹；Windows 上原生对话框只能二选一 */
      kind?: 'file' | 'directory'
    }): Promise<Result<{ canceled: boolean; path?: string; relative?: string }>>
    /** 产物列表（会话 settled 后 / 手动刷新时调用；仅 git 与非 git 快照两种模式） */
    listArtifacts(input: ArtifactRefInput): Promise<Result<ArtifactList>>
    /** 文本预览（默认前 64KB，`offset` 分页；二进制文件返回 `binary: true` 且 text 为空） */
    readText(
      input: ArtifactRefInput & { path: string; maxBytes?: number; offset?: number }
    ): Promise<Result<ReadTextResult>>
    /** unified diff（git：暂存+未暂存；非 git：快照比对合成） */
    diff(input: ArtifactRefInput & { path: string }): Promise<Result<UnifiedDiff>>
  }
  /** `artifact:open`：校验路径后用系统默认程序打开（`shell.openPath`，非 openExternal） */
  artifact: {
    open(input: ArtifactRefInput & { path: string }): Promise<Result<{ ok: true }>>
  }
}

export interface PiEventsApi {
  onRecord(cb: (event: RecordEvent) => void): Unsubscribe
  onExtUi(cb: (event: ExtUiEvent) => void): Unsubscribe
  onStatus(cb: (event: StatusEvent) => void): Unsubscribe
  onDiagnostic(cb: (event: DiagnosticEvent) => void): Unsubscribe
}

export type PiApi = PiInvokeApi & { events: PiEventsApi }

/** preload 内部用来做通道绑定，导出便于单测断言白名单一致性 */
export type { EventChannel }
