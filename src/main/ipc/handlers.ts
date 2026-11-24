import { type z } from 'zod'

import { IPC_INVOKE_CHANNELS, type InvokeChannel } from '../../shared/ipc-channels'
import type {
  configUpdateInputSchema,
  extuiRespondInputSchema,
  fsDiffInputSchema,
  fsListArtifactsInputSchema,
  fsPickDirectoryInputSchema,
  fsReadTextInputSchema,
  artifactOpenInputSchema,
  modelSetInputSchema,
  piLocateInputSchema,
  sessionCreateInputSchema,
  sessionForkInputSchema,
  sessionHistoryInputSchema,
  sessionKeyInputSchema,
  sessionListInputSchema,
  sessionPromptInputSchema,
  sessionResumeInputSchema
} from '../../shared/contracts/schemas'
import type {
  ModelConfigView,
  ModelEntryInput,
  UpsertProviderInput
} from '../../shared/contracts/model-config'
import type { AppConfigView, BootState, PermissionStatus } from '../../shared/contracts/types'

import { IpcFailure } from '../../shared/contracts/result'

import { homedir } from 'node:os'

import type { AgentCatalog } from '../services/agent-catalog'
import { appendSessionName } from '../services/pi-session-name'
import { isInsideRoot, normalizeForCompare, toPosixRelative } from '../services/path-guard'
import { realpathNative } from '../services/realpath-native'
import type { ModelConfigStore } from '../services/model-config-store'

import { IpcRouter, type HandlerMap } from './router'
import type { ArtifactsService } from '../services/artifacts'
import type { ConfigStore } from '../services/config-store'
import type { FsBridge } from '../services/fs-bridge'
import type { PermissionExtensionDeps } from '../services/permission-extension'
import { detectPermissionExtension } from '../services/permission-extension'
import type { PiLocator } from '../services/pi-locator'
import type { SessionHistory } from '../services/session-history'
import type { SessionIndex } from '../services/session-index'
import type { SessionService } from '../services/session-service'

/**
 * 主进程侧 IPC 处理器装配（§5.1 `ipc/router.ts` 的装配点）。
 *
 * M2 打通的通道：`app:getBoot`、`pi:locate`、`session:list/create/resume/fork/prompt/abort/dispose/state`、
 * `model:list/set`。
 * M3 新增：`fs:pickDirectory`（新建任务选目录）、`session:history`（选中历史任务只读回放，§6.1）。
 * M4 新增（均在 §5.4 记录）：
 * - `session:stats`：pi `get_session_stats` → token/成本（客户端不估算）；
 * - `session:forkPoints`：pi `get_fork_messages` → 可分叉点（只列用户消息）；
 * - `config:update`：ConfigStore 偏好持久化（zod 校验 + 拒疑似密钥字段）。
 * `extui:*`（M5）、`fs:listArtifacts/readText/diff` 与 `artifact:open`（M6）均已注册：
 * M6 的四个通道全部走 `services/artifacts.ts`（统一路径校验器 + 上限 + 审计），
 * 本层只做入参搬移，不重复任何校验逻辑。
 *
 * 入参类型一律由 zod schema 推导（`z.input` / `z.output`），不再手写断言。
 */
export interface RouterDeps {
  configStore: ConfigStore
  sessionIndex: SessionIndex
  piLocator: PiLocator
  sessionService: SessionService
  /** M3：原生目录对话框（`fs:pickDirectory`） */
  fsBridge: FsBridge
  /** M3：会话 JSONL 只读回放（`session:history`） */
  sessionHistory: SessionHistory
  /** M6：产物列表 / diff / 预览 / 系统程序打开（`fs:listArtifacts` / `fs:diff` / `fs:readText` / `artifact:open`） */
  artifacts: ArtifactsService
  /** 进程级 cwd，作为「新建任务」的默认目录（M3 起只作为对话框初值） */
  defaultCwd?: () => string
  /** M5：审批扩展的安装状态检测（`permission:status`） */
  permissionDeps?: PermissionExtensionDeps
  /** A14：pi 的模型配置读写（`models:*`；apiKey 只进不出） */
  modelConfigStore: ModelConfigStore
  /** A18：agent 目录（只读；同时回报 pi 是否支持 `--agent`） */
  agentCatalog: AgentCatalog
}

/** 短命令的通道级超时预算（§7 约束 13；比 pi 侧单命令 60s 略宽，pi 侧先超时） */
const DEFAULT_TIMEOUTS: Partial<Record<InvokeChannel, number>> = {
  [IPC_INVOKE_CHANNELS.appGetBoot]: 5_000,
  [IPC_INVOKE_CHANNELS.piLocate]: 30_000,
  [IPC_INVOKE_CHANNELS.sessionList]: 5_000,
  [IPC_INVOKE_CHANNELS.sessionHistory]: 10_000,
  [IPC_INVOKE_CHANNELS.fsPickDirectory]: 300_000,
  [IPC_INVOKE_CHANNELS.sessionState]: 65_000,
  [IPC_INVOKE_CHANNELS.sessionStats]: 65_000,
  [IPC_INVOKE_CHANNELS.sessionForkPoints]: 65_000,
  [IPC_INVOKE_CHANNELS.permissionStatus]: 5_000,
  [IPC_INVOKE_CHANNELS.modelList]: 65_000,
  // M6：扫描/diff 会起 git 子进程或扫目录树，给 20s（§7 约束 14 的产物上限在这之内）
  [IPC_INVOKE_CHANNELS.fsListArtifacts]: 20_000,
  [IPC_INVOKE_CHANNELS.fsDiff]: 20_000,
  [IPC_INVOKE_CHANNELS.fsReadText]: 10_000,
  [IPC_INVOKE_CHANNELS.artifactOpen]: 15_000,
  // 模型管理：只读写本地 JSON（原子替换 + 备份），正常是毫秒级
  [IPC_INVOKE_CHANNELS.modelsRead]: 10_000,
  [IPC_INVOKE_CHANNELS.modelsSetDefault]: 10_000,
  [IPC_INVOKE_CHANNELS.modelsUpsertProvider]: 10_000,
  [IPC_INVOKE_CHANNELS.modelsRemoveProvider]: 10_000,
  [IPC_INVOKE_CHANNELS.modelsUpsertModel]: 10_000,
  [IPC_INVOKE_CHANNELS.modelsRemoveModel]: 10_000,
  // agent 目录：扫本地目录 + 一次 `pi --help` 能力探测（有 60s 缓存）
  [IPC_INVOKE_CHANNELS.agentsList]: 20_000,
  // 选文件走原生对话框（用户可能停留很久），给足预算；取消不算失败
  [IPC_INVOKE_CHANNELS.fsPickWorkspaceFile]: 300_000
}

type SessionListInput = z.infer<typeof sessionListInputSchema>
type SessionHistoryInput = z.infer<typeof sessionHistoryInputSchema>
type FsPickDirectoryInput = z.infer<typeof fsPickDirectoryInputSchema>
type SessionCreateInput = z.infer<typeof sessionCreateInputSchema>
type SessionResumeInput = z.infer<typeof sessionResumeInputSchema>
type SessionForkInput = z.infer<typeof sessionForkInputSchema>
type SessionPromptInput = z.infer<typeof sessionPromptInputSchema>
type SessionKeyInput = z.infer<typeof sessionKeyInputSchema>
type ModelSetInput = z.infer<typeof modelSetInputSchema>
type PiLocateInput = z.infer<typeof piLocateInputSchema>
type ConfigUpdateInput = z.infer<typeof configUpdateInputSchema>
type ExtuiRespondInput = z.infer<typeof extuiRespondInputSchema>
type FsListArtifactsInput = z.infer<typeof fsListArtifactsInputSchema>
type FsDiffInput = z.infer<typeof fsDiffInputSchema>
type FsReadTextInput = z.infer<typeof fsReadTextInputSchema>
type ArtifactOpenInput = z.infer<typeof artifactOpenInputSchema>

export function createRouter(
  deps: RouterDeps,
  onError?: (channel: string, error: unknown) => void,
  timeouts: Partial<Record<InvokeChannel, number>> = DEFAULT_TIMEOUTS
): IpcRouter {
  /**
   * 默认工作目录 = **用户主目录**。
   *
   * 之前是 `process.cwd()`（主进程启动目录）：从快捷方式启动时它是安装目录，
   * 从终端启动时是终端所在目录 —— 两个都不是用户想要的「默认工作区」，
   * 而且会直接体现在新建任务弹层与原生目录对话框的初始位置上。
   */
  const defaultCwd = deps.defaultCwd ?? ((): string => homedir())
  const service = deps.sessionService

  /**
   * 「引用文件」用：把会话引用解析成工作区根。
   * 只认主进程能核实的两类事实（活跃会话 cwd / 会话索引里的 cwd），不接受 renderer 直接给根。
   */
  async function resolveWorkspaceRootForPick(input: {
    sessionKey?: string
    sessionFile?: string
  }): Promise<string | undefined> {
    if (input.sessionKey !== undefined) {
      const live = service.workspaceOf(input.sessionKey)
      if (live !== undefined) return live
    }
    if (input.sessionFile !== undefined) {
      // 历史任务：从会话索引（读 JSONL header）取该文件的 cwd
      const listed = await deps.sessionIndex.list({})
      const wanted = normalizeForCompare(input.sessionFile)
      const match = listed.items.find((item) => normalizeForCompare(item.filePath) === wanted)
      if (match !== undefined && match.cwd.length > 0) return match.cwd
    }
    return undefined
  }

  const handlers: HandlerMap = {
    [IPC_INVOKE_CHANNELS.appGetBoot]: (): Promise<BootState> =>
      Promise.resolve({
        config: deps.configStore.getConfigView(),
        piStatus: deps.piLocator.status(),
        lastCwd: defaultCwd()
      }),

    [IPC_INVOKE_CHANNELS.piLocate]: (raw) => {
      const input = raw as PiLocateInput
      return deps.piLocator.locate(input.path)
    },

    [IPC_INVOKE_CHANNELS.sessionList]: (raw) => {
      const input = raw as SessionListInput
      return deps.sessionIndex.list({
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor })
      })
    },

    [IPC_INVOKE_CHANNELS.sessionHistory]: (raw) => {
      const input = raw as SessionHistoryInput
      return deps.sessionHistory.read({
        sessionFile: input.sessionFile,
        ...(input.maxRecords === undefined ? {} : { maxRecords: input.maxRecords }),
        ...(input.allowMissing === undefined ? {} : { allowMissing: input.allowMissing })
      })
    },

    /**
     * A22：选工作区文件。
     *
     * 为什么需要主进程做：① 原生对话框只能在主进程弹；② **工作区边界必须由主进程判定** ——
     * 用户可以在对话框里导航到工作区外，renderer 无权决定「这算不算这个任务的文件」。
     * 返回工作区相对路径（POSIX），消息里直接引用，模型用自己的 read 工具读取。
     */
    [IPC_INVOKE_CHANNELS.fsPickWorkspaceFile]: async (raw) => {
      const input = raw as { sessionKey?: string; sessionFile?: string; defaultPath?: string }

      // 工作区根必须来自主进程能核实的事实：
      // - 活跃会话 → SessionService 的 cwd；
      // - 历史（回放）任务 → 会话索引里该 JSONL 记录的 cwd。
      // 都不能用时明确报错，**不要**退回到进程启动目录（那正是之前的 bug）。
      const workspaceRoot = await resolveWorkspaceRootForPick(input)
      if (workspaceRoot === undefined) {
        throw new IpcFailure('NOT_FOUND', '无法确定该任务的工作区（会话缺少目录信息）')
      }
      const realRoot = await realpathNative(workspaceRoot).catch(() => workspaceRoot)

      // 默认打开位置限制在工作区内：默认路径在工作区外时退回工作区根
      const requested = input.defaultPath
      const defaultPath =
        requested !== undefined && isInsideRoot(realRoot, requested) ? requested : realRoot

      const picked = await deps.fsBridge.pickFile({ defaultPath })
      if (picked.canceled) return { canceled: true }
      const pickedPath = picked.path
      if (pickedPath === undefined) return { canceled: true }

      // 取局部常量后再传给 realpath：闭包里引用 `picked.path` 会把类型放宽回 string|undefined
      const realPicked = await realpathNative(pickedPath).catch(() => pickedPath)
      if (!isInsideRoot(realRoot, realPicked)) {
        throw new IpcFailure('VALIDATION', '只能引用工作区内的文件（选到了工作区外）', pickedPath)
      }
      return {
        canceled: false,
        path: realPicked,
        relative: toPosixRelative(realRoot, realPicked)
      }
    },

    [IPC_INVOKE_CHANNELS.fsPickDirectory]: (raw) => {
      const input = raw as FsPickDirectoryInput
      // 没给默认目录时用「默认工作目录」（现在是用户主目录）：
      // 原生对话框不给 defaultPath 会落在**进程启动目录**，那是快捷方式所在的安装目录
      return deps.fsBridge.pickDirectory({
        defaultPath: input.defaultPath ?? defaultCwd()
      })
    },

    /**
     * M6：产物列表 / diff / 预览 / 系统程序打开。
     *
     * 四个通道的入参只带「会话引用 + 工作区相对路径」，**不带**工作区根：
     * 根由主进程根据 sessionKey（SessionService）或 sessionFile（会话 header）推导，
     * renderer 无法指定任意目录（§9.4 S6 等价项）。
     */
    [IPC_INVOKE_CHANNELS.fsListArtifacts]: (raw) => {
      const input = raw as FsListArtifactsInput
      return deps.artifacts.list(toRef(input))
    },

    [IPC_INVOKE_CHANNELS.fsDiff]: (raw) => {
      const input = raw as FsDiffInput
      return deps.artifacts.diff({ ...toRef(input), path: input.path })
    },

    [IPC_INVOKE_CHANNELS.fsReadText]: (raw) => {
      const input = raw as FsReadTextInput
      return deps.artifacts.readText({
        ...toRef(input),
        path: input.path,
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        ...(input.offset === undefined ? {} : { offset: input.offset })
      })
    },

    [IPC_INVOKE_CHANNELS.artifactOpen]: (raw) => {
      const input = raw as ArtifactOpenInput
      return deps.artifacts.open({ ...toRef(input), path: input.path })
    },

    [IPC_INVOKE_CHANNELS.sessionCreate]: (raw) => {
      const input = raw as SessionCreateInput
      return (async () => {
        // agent 名字必须自己校验：pi 对未知 agent 是**静默忽略**（照常启动、回落默认模型），
        // 不校验就会出现「界面选了 architect，实际还是默认身份」的假象。
        if (input.agent !== undefined) {
          const view = await deps.agentCatalog.list(input.cwd)
          if (!view.supportsAgentFlag) {
            throw new IpcFailure(
              'VALIDATION',
              '当前 pi 未注册 --agent（需要安装 pi-open-agents 扩展）'
            )
          }
          if (!deps.agentCatalog.has(view, input.agent)) {
            throw new IpcFailure('VALIDATION', `未知 agent：${input.agent}`)
          }
        }
        return service.create({
          cwd: input.cwd,
          ...(input.model === undefined ? {} : { model: input.model }),
          // 起始模式（工具白名单）与 agent 必须逐字段透传：handler 重建对象时最容易漏字段
          ...(input.toolMode === undefined ? {} : { toolMode: input.toolMode }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.name === undefined ? {} : { name: input.name })
        })
      })()
    },

    [IPC_INVOKE_CHANNELS.sessionResume]: (raw) =>
      service.resume({ sessionFile: (raw as SessionResumeInput).sessionFile }),

    [IPC_INVOKE_CHANNELS.sessionFork]: (raw) => {
      const input = raw as SessionForkInput
      return service.fork({
        sessionKey: input.sessionKey,
        ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
        ...(input.messageId === undefined ? {} : { messageId: input.messageId })
      })
    },

    [IPC_INVOKE_CHANNELS.sessionForkPoints]: (raw) =>
      service.forkPoints({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    /**
     * A23：改会话显示名。
     *
     * 活跃会话 → RPC `set_session_name`（pi 自己写 JSONL）；
     * 历史任务 → 追加一条 `session_info`（与 pi 的写法同形，只 append）。
     * 历史路径必须校验文件在**会话根**内：否则「改名字」就变成任意文件追加。
     */
    [IPC_INVOKE_CHANNELS.sessionSetName]: async (raw) => {
      const input = raw as { sessionKey?: string; sessionFile?: string; name: string }
      if (input.sessionKey !== undefined) {
        return service.setName({ sessionKey: input.sessionKey, name: input.name })
      }
      const sessionFile = input.sessionFile
      if (sessionFile === undefined) {
        throw new IpcFailure('VALIDATION', '需要 sessionKey 或 sessionFile')
      }
      const sessionRoot = await realpathNative(deps.sessionIndex.root()).catch(() =>
        deps.sessionIndex.root()
      )
      const realFile = await realpathNative(sessionFile).catch(() => {
        throw new IpcFailure('NOT_FOUND', '会话文件不存在', sessionFile)
      })
      if (!isInsideRoot(sessionRoot, realFile)) {
        throw new IpcFailure('PATH_DENIED', '只能修改会话根内的会话文件', sessionFile)
      }
      appendSessionName({ sessionFile: realFile, name: input.name })
      return { ok: true }
    },

    [IPC_INVOKE_CHANNELS.sessionStats]: (raw) =>
      service.stats({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    /**
     * A14 模型管理：直接读写 pi 的 models.json / settings.json#defaultModel。
     *
     * 与 `model:set`（会话内切换）不同，这里改的是磁盘配置，**对已在运行的会话不生效**。
     * 入参已由 router 的 zod schema 校验过；服务层再做一次（纵深防御）。
     */
    /** A18：可用 agent 目录（只读）。`supportsAgentFlag=false` 时 UI 不显示选择器。 */
    [IPC_INVOKE_CHANNELS.agentsList]: (raw) => {
      const input = raw as { cwd?: string }
      return deps.agentCatalog.list(input.cwd)
    },

    [IPC_INVOKE_CHANNELS.modelsRead]: (): Promise<ModelConfigView> =>
      Promise.resolve(deps.modelConfigStore.read()),

    [IPC_INVOKE_CHANNELS.modelsSetDefault]: (raw) => {
      const input = raw as { modelId: string | null }
      return Promise.resolve(deps.modelConfigStore.setDefaultModel(input.modelId))
    },

    [IPC_INVOKE_CHANNELS.modelsUpsertProvider]: (raw) => {
      const input = raw as UpsertProviderInput
      return Promise.resolve(deps.modelConfigStore.upsertProvider(input))
    },

    [IPC_INVOKE_CHANNELS.modelsRemoveProvider]: (raw) => {
      const input = raw as { id: string }
      return Promise.resolve(deps.modelConfigStore.removeProvider(input.id))
    },

    [IPC_INVOKE_CHANNELS.modelsUpsertModel]: (raw) => {
      const input = raw as { providerId: string; model: ModelEntryInput }
      return Promise.resolve(deps.modelConfigStore.upsertModel(input.providerId, input.model))
    },

    [IPC_INVOKE_CHANNELS.modelsRemoveModel]: (raw) => {
      const input = raw as { providerId: string; modelId: string }
      return Promise.resolve(deps.modelConfigStore.removeModel(input.providerId, input.modelId))
    },

    [IPC_INVOKE_CHANNELS.configUpdate]: (raw): Promise<AppConfigView> =>
      deps.configStore.update(raw as ConfigUpdateInput),

    /**
     * M5：回 `extension_ui_response`。
     *
     * 只做「透传 + 校验」，不做任何审批判定：requestId 必须是该 sessionKey 当前通道
     * 上仍**未决**的请求（伪造/跨会话/过期一律 `REQUEST_NOT_FOUND` + 诊断），
     * 具体判定全部由 `SessionService.respondExtUi` 完成。
     */
    [IPC_INVOKE_CHANNELS.extuiRespond]: (raw) => {
      const input = raw as ExtuiRespondInput
      return service.respondExtUi({
        sessionKey: input.sessionKey,
        requestId: input.requestId,
        response: input.response
      })
    },

    /** M5：审批扩展安装/协议状态（只读；不做任何写入或执行） */
    [IPC_INVOKE_CHANNELS.permissionStatus]: (): Promise<PermissionStatus> =>
      Promise.resolve(detectPermissionExtension(deps.permissionDeps ?? {})),

    [IPC_INVOKE_CHANNELS.sessionPrompt]: (raw) => {
      const input = raw as SessionPromptInput
      return service.prompt({
        sessionKey: input.sessionKey,
        message: input.message,
        ...(input.images === undefined ? {} : { images: input.images }),
        ...(input.streamingBehavior === undefined
          ? {}
          : { streamingBehavior: input.streamingBehavior })
      })
    },

    [IPC_INVOKE_CHANNELS.sessionAbort]: (raw) =>
      service.abort({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    [IPC_INVOKE_CHANNELS.sessionDispose]: (raw) =>
      service.dispose({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    [IPC_INVOKE_CHANNELS.sessionState]: (raw) =>
      service.state({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    [IPC_INVOKE_CHANNELS.modelList]: () => service.listModels(),

    [IPC_INVOKE_CHANNELS.modelSet]: (raw) => {
      const input = raw as ModelSetInput
      return service.setModel({
        sessionKey: input.sessionKey,
        model: input.model,
        ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel })
      })
    }
  }

  return new IpcRouter({
    handlers,
    ...(onError === undefined ? {} : { onError }),
    timeouts
  })
}

/** zod 已校验过的会话引用 → 服务层入参（两字段互斥由 schema 保证） */
function toRef(input: { sessionKey?: string | undefined; sessionFile?: string | undefined }): {
  sessionKey?: string | undefined
  sessionFile?: string | undefined
} {
  return {
    ...(input.sessionKey === undefined ? {} : { sessionKey: input.sessionKey }),
    ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile })
  }
}
