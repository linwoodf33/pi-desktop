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
  /** M7：pi 的模型配置读写（`models:*`；apiKey 只进不出） */
  modelConfigStore: ModelConfigStore
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
  [IPC_INVOKE_CHANNELS.modelsRemoveModel]: 10_000
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
  const defaultCwd = deps.defaultCwd ?? ((): string => process.cwd())
  const service = deps.sessionService

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

    [IPC_INVOKE_CHANNELS.fsPickDirectory]: (raw) => {
      const input = raw as FsPickDirectoryInput
      return deps.fsBridge.pickDirectory({
        ...(input.defaultPath === undefined ? {} : { defaultPath: input.defaultPath })
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
      return service.create({
        cwd: input.cwd,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.name === undefined ? {} : { name: input.name })
      })
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

    [IPC_INVOKE_CHANNELS.sessionStats]: (raw) =>
      service.stats({ sessionKey: (raw as SessionKeyInput).sessionKey }),

    /**
     * M7 模型管理：直接读写 pi 的 models.json / settings.json#defaultModel。
     *
     * 与 `model:set`（会话内切换）不同，这里改的是磁盘配置，**对已在运行的会话不生效**。
     * 入参已由 router 的 zod schema 校验过；服务层再做一次（纵深防御）。
     */
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
