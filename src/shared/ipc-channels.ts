// pi-desktop IPC 通道白名单（架构文档 §5.4）
//
// 这里是 main / preload / renderer 共享的唯一通道来源：
//   - main  侧按 INVOKE_CHANNELS 逐个 ipcMain.handle（未列出的通道不会被注册）
//   - preload 侧只暴露与这些通道一一对应的方法，不存在任意 channel 透传
//   - renderer 侧通过 window.pi 的强类型方法调用

export const IPC_INVOKE_CHANNELS = {
  appGetBoot: 'app:getBoot',
  /** A25：诊断信息（只读、脱敏；不含任何密钥） */
  appDiagnostics: 'app:diagnostics',
  /** A26：写系统剪贴板（主进程执行；file:// 下 renderer 的 navigator.clipboard 不可用） */
  appCopyText: 'app:copyText',
  piLocate: 'pi:locate',
  /** A34：只读检测远端最新版（失败不报错，返回 unknown） */
  piUpdateCheck: 'pi:updateCheck',
  /** A34：执行 `pi update`（真正修改本机安装） */
  piUpdateApply: 'pi:updateApply',
  /** A34：取消进行中的更新任务 */
  piUpdateCancel: 'pi:updateCancel',
  sessionList: 'session:list',
  /** M3 补充：只读回放会话 JSONL（§5.4 注；不启动子进程，§6.1 第 4 步） */
  sessionHistory: 'session:history',
  sessionCreate: 'session:create',
  sessionResume: 'session:resume',
  sessionFork: 'session:fork',
  sessionPrompt: 'session:prompt',
  sessionAbort: 'session:abort',
  sessionDispose: 'session:dispose',
  sessionState: 'session:state',
  /** M4：会话 token/成本统计（pi `get_session_stats`，§5.4 注） */
  sessionStats: 'session:stats',
  /** A23：改会话显示名（活跃会话走 RPC；历史任务追加 session_info 记录） */
  sessionSetName: 'session:setName',
  /** A39：删除本地会话文件（移到回收站；仅历史任务，活跃会话拒绝） */
  sessionDelete: 'session:delete',
  /** M4：可分叉点列表（pi `get_fork_messages`，§5.4 注） */
  sessionForkPoints: 'session:forkPoints',
  /** A40：运行中切换会话专家（扩展命令 /agent，不重建会话） */
  sessionSwitchAgent: 'session:switchAgent',
  /** A41：手动压缩上下文（pi compact） */
  sessionCompact: 'session:compact',
  modelList: 'model:list',
  modelSet: 'model:set',
  /** 模型管理：读 pi 的 models.json / settings.json（apiKey 已脱敏） */
  modelsRead: 'models:read',
  /** 模型管理：设置 / 清除 pi settings.json 的 defaultModel */
  modelsSetDefault: 'models:setDefault',
  /** 模型管理：自定义 provider / model 的增删改（写 pi models.json） */
  modelsUpsertProvider: 'models:upsertProvider',
  modelsRemoveProvider: 'models:removeProvider',
  modelsUpsertModel: 'models:upsertModel',
  modelsRemoveModel: 'models:removeModel',
  /** A18：可用的 agent 目录（只读；同时回报 pi 是否支持 `--agent`） */
  agentsList: 'agents:list',
  /** A31：可用技能清单（只读；扫描 SKILL.md） */
  skillsList: 'skills:list',
  /** A32：从 URL 预览/安装公开技能（预览不落盘） */
  skillsPreview: 'skills:preview',
  skillsInstall: 'skills:install',
  /** A37：读 settings.json + package.json 的只读插件清单 */
  pkgList: 'pkg:list',
  /** A37：npm 源查 registry 元数据（失败不阻断安装） */
  pkgPreview: 'pkg:preview',
  /** A37：`pi install <source>`（会执行第三方代码） */
  pkgInstall: 'pkg:install',
  /** A37：取消进行中的安装（幂等） */
  pkgInstallCancel: 'pkg:installCancel',
  /** M4：偏好持久化（并行上限 / 空闲回收 / pi 路径 / 会话目录，§5.4 注） */
  configUpdate: 'config:update',
  /** M5：审批扩展的安装/协议状态（只读，不返回任何内容） */
  permissionStatus: 'permission:status',
  /** M5：回 `extension_ui_response`（只接受当前通道、未决的 requestId） */
  extuiRespond: 'extui:respond',
  fsPickDirectory: 'fs:pickDirectory',
  /** A22：选择工作区内的单个文件（返回工作区相对路径，供消息里引用） */
  fsPickWorkspaceFile: 'fs:pickWorkspaceFile',
  /** A27：列出工作区目录内容（应用内引用选择器） */
  fsListWorkspaceDir: 'fs:listWorkspaceDir',
  fsListArtifacts: 'fs:listArtifacts',
  fsReadText: 'fs:readText',
  fsDiff: 'fs:diff',
  artifactOpen: 'artifact:open'
} as const

export type InvokeChannel = (typeof IPC_INVOKE_CHANNELS)[keyof typeof IPC_INVOKE_CHANNELS]

/** 全部 invoke 通道，顺序稳定，便于注册与断言。 */
export const INVOKE_CHANNELS: readonly InvokeChannel[] = Object.freeze(
  Object.values(IPC_INVOKE_CHANNELS) as InvokeChannel[]
)

/** main → renderer 事件通道（§5.4 事件表）。 */
export const IPC_EVENT_CHANNELS = {
  record: 'evt:record',
  extui: 'evt:extui',
  status: 'evt:status',
  diagnostic: 'evt:diagnostic',
  /** A34：更新过程逐行输出/状态迁移 */
  piUpdate: 'evt:piUpdate',
  /** A37：插件安装过程逐行输出/状态迁移 */
  pkgInstall: 'evt:pkgInstall'
} as const

export type EventChannel = (typeof IPC_EVENT_CHANNELS)[keyof typeof IPC_EVENT_CHANNELS]

export const EVENT_CHANNELS: readonly EventChannel[] = Object.freeze(
  Object.values(IPC_EVENT_CHANNELS) as EventChannel[]
)

const invokeChannelSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventChannelSet: ReadonlySet<string> = new Set(EVENT_CHANNELS)

export function isInvokeChannel(value: string): value is InvokeChannel {
  return invokeChannelSet.has(value)
}

export function isEventChannel(value: string): value is EventChannel {
  return eventChannelSet.has(value)
}
