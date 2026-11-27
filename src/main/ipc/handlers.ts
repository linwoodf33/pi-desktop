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
  sessionCompactInputSchema,
  sessionDeleteInputSchema,
  sessionForkInputSchema,
  sessionHistoryInputSchema,
  sessionKeyInputSchema,
  sessionListInputSchema,
  sessionPromptInputSchema,
  sessionResumeInputSchema,
  sessionSwitchAgentInputSchema
} from '../../shared/contracts/schemas'
import type {
  ModelConfigView,
  ModelEntryInput,
  UpsertProviderInput
} from '../../shared/contracts/model-config'
import type {
  AppConfigView,
  BootState,
  Diagnostics,
  PermissionStatus
} from '../../shared/contracts/types'
import type { PiUpdateApplyInput } from '../../shared/contracts/update'

import { isAgentNameSwitchable } from '../../shared/contracts/agents'
import { IpcFailure } from '../../shared/contracts/result'

import { statSync } from 'node:fs'
import { homedir } from 'node:os'

import type { AgentCatalog } from '../services/agent-catalog'
import { installSkill, previewSkill } from '../services/skill-installer'
import type { SkillCatalog } from '../services/skill-catalog'
import { appendSessionName } from '../services/pi-session-name'
import { listDirectoryContent } from '../services/workspace-listing'
import {
  isInsideRoot,
  normalizeForCompare,
  resolveWorkspaceTarget,
  toPosixRelative
} from '../services/path-guard'
import { realpathNative } from '../services/realpath-native'
import type { ModelConfigStore } from '../services/model-config-store'

import { IpcRouter, type HandlerMap } from './router'
import type { ArtifactsService } from '../services/artifacts'
import type { ConfigStore } from '../services/config-store'
import type { FsBridge } from '../services/fs-bridge'
import type { PermissionExtensionDeps } from '../services/permission-extension'
import { detectPermissionExtension } from '../services/permission-extension'
import type { PiLocator } from '../services/pi-locator'
import type { PiPackageCatalog } from '../services/pi-package-catalog'
import type { PiPackageInstaller } from '../services/pi-package-installer'
import type { PiUpdateService } from '../services/pi-update'
import type { SessionDelete } from '../services/session-delete'
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
  /**
   * A39：删除本地会话文件（移到系统回收站）。
   *
   * **必填**是刻意的：这是破坏性通道，缺依赖时不能静默「当作成功」，也不该在装配期被忘掉
   * （与 `pkgInstaller` / `piUpdate` 这类「没接线就报 NOT_IMPLEMENTED」的可选服务不同）。
   * 授权（根内布局 / 索引成员 / 活跃会话拒绝 / 回收站失败）全在服务层，本层只搬移。
   */
  sessionDelete: SessionDelete
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
  /** A31：技能清单（只读；扫描 SKILL.md） */
  skillCatalog: SkillCatalog
  /**
   * A37：插件清单（只读 settings.json + 受管目录里的 package.json）。
   * 与 `piUpdate` 同样可选：既有测试装配点不必改动；缺失时 `pkg:list` 报 `NOT_IMPLEMENTED`。
   */
  pkgCatalog?: PiPackageCatalog
  /** A37：插件安装/预览/取消（会执行第三方代码）；缺失时相关通道报 `NOT_IMPLEMENTED`。 */
  pkgInstaller?: PiPackageInstaller
  /**
   * A34：pi 版本检测 / 更新服务（`pi:updateCheck` / `pi:updateApply` / `pi:updateCancel`）。
   * 可选是刻意的：① 现有测试装配点（unit/integration 各一处）不必改动；
   * ② `session:create/resume` 的「更新中」gate 用可选链表达「没接线 = 不可能在更新」。
   * 缺失时三个更新通道统一报 `NOT_IMPLEMENTED`，不会被静默当成成功。
   */
  piUpdate?: PiUpdateService
  /** A25：客户端版本（`app.getVersion()`，由 main 注入；测试可覆盖） */
  appVersion?: () => string
  /** A26：写系统剪贴板（file:// 下 renderer 的 navigator.clipboard 不可用） */
  writeClipboard?: (text: string) => void
}

/** 短命令的通道级超时预算（§7 约束 13；比 pi 侧单命令 60s 略宽，pi 侧先超时） */
const DEFAULT_TIMEOUTS: Partial<Record<InvokeChannel, number>> = {
  [IPC_INVOKE_CHANNELS.appGetBoot]: 5_000,
  [IPC_INVOKE_CHANNELS.piLocate]: 30_000,
  [IPC_INVOKE_CHANNELS.sessionList]: 5_000,
  [IPC_INVOKE_CHANNELS.sessionHistory]: 10_000,
  // A39：移到回收站是单次 shell 调用（可能遇到占用/重试）；失败要能及时报 DELETE_FAILED
  [IPC_INVOKE_CHANNELS.sessionDelete]: 10_000,
  [IPC_INVOKE_CHANNELS.fsPickDirectory]: 300_000,
  [IPC_INVOKE_CHANNELS.sessionState]: 65_000,
  [IPC_INVOKE_CHANNELS.sessionStats]: 65_000,
  [IPC_INVOKE_CHANNELS.sessionForkPoints]: 65_000,
  // A40：目录探测(≤20s)+扩展切换(≤60s)+余量
  [IPC_INVOKE_CHANNELS.sessionSwitchAgent]: 120_000,
  // A41：服务层 240s，router 留余量（摘要由模型生成，可能很慢）
  [IPC_INVOKE_CHANNELS.sessionCompact]: 300_000,
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
  // A31：扫本地技能目录（只读 readdir）
  [IPC_INVOKE_CHANNELS.skillsList]: 15_000,
  // A32：下载技能（网络请求，给 20s；服务层自身有 15s 下载超时）
  [IPC_INVOKE_CHANNELS.skillsPreview]: 20_000,
  [IPC_INVOKE_CHANNELS.skillsInstall]: 20_000,
  // A34：检测＝单次 5s × 2 次重试 + 余量；执行＝服务内部已有 10min 总超时，通道预算必须更宽
  [IPC_INVOKE_CHANNELS.piUpdateCheck]: 15_000,
  [IPC_INVOKE_CHANNELS.piUpdateApply]: 660_000,
  [IPC_INVOKE_CHANNELS.piUpdateCancel]: 5_000,
  // A37：清单只读本地 JSON；预览＝一次 registry 请求（服务内 8s）；安装＝服务内 10min 总超时
  [IPC_INVOKE_CHANNELS.pkgList]: 10_000,
  [IPC_INVOKE_CHANNELS.pkgPreview]: 15_000,
  [IPC_INVOKE_CHANNELS.pkgInstall]: 660_000,
  [IPC_INVOKE_CHANNELS.pkgInstallCancel]: 5_000,
  // 选文件走原生对话框（用户可能停留很久），给足预算；取消不算失败
  [IPC_INVOKE_CHANNELS.fsPickWorkspaceFile]: 300_000,
  // A27：列个工作区目录（只读 readdir）
  [IPC_INVOKE_CHANNELS.fsListWorkspaceDir]: 15_000
}

type SessionListInput = z.infer<typeof sessionListInputSchema>
type SessionHistoryInput = z.infer<typeof sessionHistoryInputSchema>
type SessionDeleteInput = z.infer<typeof sessionDeleteInputSchema>
type FsPickDirectoryInput = z.infer<typeof fsPickDirectoryInputSchema>
type SessionCreateInput = z.infer<typeof sessionCreateInputSchema>
type SessionResumeInput = z.infer<typeof sessionResumeInputSchema>
type SessionForkInput = z.infer<typeof sessionForkInputSchema>
type SessionPromptInput = z.infer<typeof sessionPromptInputSchema>
type SessionKeyInput = z.infer<typeof sessionKeyInputSchema>
type SessionSwitchAgentInput = z.infer<typeof sessionSwitchAgentInputSchema>
type SessionCompactInput = z.infer<typeof sessionCompactInputSchema>
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
  /** 客户端版本：main 注入 `app.getVersion()`；测试/无 Electron 环境下给占位值 */
  const appVersion = deps.appVersion ?? ((): string => '0.0.0')
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

  /** A37：安装器兜底（未注入时给明确错误码，而不是 undefined 崩溃） */
  function requirePkgInstaller(): PiPackageInstaller {
    const pkgInstaller = deps.pkgInstaller
    if (pkgInstaller === undefined) {
      throw new IpcFailure('NOT_IMPLEMENTED', '插件安装服务未注入')
    }
    return pkgInstaller
  }

  /** A34：更新通道的服务兜底（主进程漏注入时给明确错误码，而不是 undefined 崩溃） */
  function requirePiUpdate(): PiUpdateService {
    const piUpdate = deps.piUpdate
    if (piUpdate === undefined) {
      throw new IpcFailure('NOT_IMPLEMENTED', '更新服务未注入')
    }
    return piUpdate
  }

  /**
   * A34：更新期间禁止新建 / 恢复会话。
   *
   * 依据是「更新会替换磁盘上的 pi 二进制/入口脚本，而活跃会话正持有那个子进程」——
   * 此时新建会话要么拿到半装的版本，要么让替换失败。检查是同步的、无 I/O，所以放在
   * handler 最前面（在 agent 目录扫描之前）。
   */
  function assertNotUpdating(): void {
    if (deps.piUpdate?.isRunning() === true) {
      throw new IpcFailure('PI_UPDATE_BUSY', '正在更新 pi，请等更新结束后再新建/恢复会话')
    }
  }

  const handlers: HandlerMap = {
    [IPC_INVOKE_CHANNELS.appGetBoot]: (): Promise<BootState> =>
      Promise.resolve({
        config: deps.configStore.getConfigView(),
        piStatus: deps.piLocator.status(),
        lastCwd: defaultCwd(),
        appVersion: appVersion()
      }),

    /**
     * A26：写系统剪贴板。
     *
     * 为什么必须在主进程：打包后 renderer 跑在 `file://` 下，`navigator.clipboard`
     * 受安全上下文限制（非 https/localhost）会直接拒绝，表现为「点复制没反应」。
     */
    [IPC_INVOKE_CHANNELS.appCopyText]: (raw) => {
      const input = raw as { text: string }
      if (deps.writeClipboard === undefined) {
        throw new IpcFailure('NOT_IMPLEMENTED', '剪贴板未接线（主进程未注入 writeClipboard）')
      }
      deps.writeClipboard(input.text)
      return Promise.resolve({ ok: true } as const)
    },

    /**
     * A25：诊断信息（只读、脱敏）。用户反馈问题时一眼看到版本与目录，
     * 不必来回猜「你跑的是哪一版」。**不含任何密钥**。
     */
    [IPC_INVOKE_CHANNELS.appDiagnostics]: async (): Promise<Diagnostics> => {
      const config = deps.configStore.getConfigView()
      const piStatus = deps.piLocator.status()
      const paths = deps.modelConfigStore.paths()
      const sessions = await deps.sessionIndex.list({})
      const versions = process.versions
      const view: Diagnostics = {
        appVersion: appVersion(),
        electron: versions['electron'] ?? 'unknown',
        chrome: versions['chrome'] ?? 'unknown',
        node: versions['node'] ?? 'unknown',
        platform: process.platform,
        arch: process.arch,
        piState: piStatus.state,
        agentDir: paths.agentDir,
        sessionDir: deps.sessionIndex.root(),
        modelsPath: paths.modelsPath,
        settingsPath: paths.settingsPath,
        theme: String(config.theme),
        sessionCount: sessions.items.length,
        lastCwd: defaultCwd()
      }
      if (piStatus.version !== undefined) view.piVersion = piStatus.version
      if (piStatus.path !== undefined) view.piPath = piStatus.path
      if (piStatus.message !== undefined) view.piMessage = piStatus.message
      return view
    },

    [IPC_INVOKE_CHANNELS.piLocate]: (raw) => {
      const input = raw as PiLocateInput
      return deps.piLocator.locate(input.path)
    },

    /**
     * A34：只读检测远端最新版。
     *
     * **永远** `Result.ok`：`check()` 自己保证不抛错，把离线/超时/源不可用折成
     * `state: 'unknown'`（或回落到 `source: 'cache'`）。把它转成错误码只会让 UI
     * 丢失「上次查到什么」的信息。
     */
    [IPC_INVOKE_CHANNELS.piUpdateCheck]: () => requirePiUpdate().check(),

    /**
     * A34：执行 `pi update`。
     *
     * 服务返回的是判别联合（`accepted`），错误码映射**只在这里做一次**：
     * - `accepted: false` 的 gate 拒绝 → 对应错误码（这是「没开始执行」，属调用方问题）；
     * - `accepted: true` 的 `outcome: 'failed'` → **仍是 `Result.ok`**：UI 要展示
     *   `logTail` / `manualCommand` / `message`，伪装成异常只会丢掉诊断信息。
     */
    [IPC_INVOKE_CHANNELS.piUpdateApply]: async (raw) => {
      const piUpdate = requirePiUpdate()
      // A37：与插件安装互斥（安装器只挡住了「更新中装插件」，反向也要挡：
      // 两者都在改 pi 的受管目录/全局包，同时跑会把版本与登记写成混合态）。
      if (deps.pkgInstaller?.isRunning() === true) {
        throw new IpcFailure('PKG_INSTALL_BUSY', '正在安装插件，请等安装结束后再更新 pi')
      }
      const outcome = await piUpdate.apply(raw as PiUpdateApplyInput)
      if (outcome.accepted) return outcome.result

      switch (outcome.reason) {
        case 'busy':
          throw new IpcFailure('PI_UPDATE_BUSY', outcome.message)
        case 'session-busy':
          throw new IpcFailure('SESSION_BUSY', outcome.message, outcome.sessionKeys?.join(', '))
        case 'unavailable':
          // 手动命令是这条路径上唯一可操作的信息，必须带出去
          throw new IpcFailure(
            'PI_UPDATE_UNAVAILABLE',
            outcome.message,
            outcome.manualCommand ?? outcome.logTail
          )
        case 'not-located':
          throw new IpcFailure('PI_NOT_FOUND', outcome.message)
        case 'failed':
          throw new IpcFailure('INTERNAL', outcome.message, outcome.logTail)
      }
    },

    /** A34：取消进行中的更新（幂等：没有任务也返回 ok）。 */
    [IPC_INVOKE_CHANNELS.piUpdateCancel]: () => {
      requirePiUpdate().cancel()
      return Promise.resolve({ ok: true } as const)
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
     * A27：列出工作区目录内容（应用内「引用文件/文件夹」选择器）。
     *
     * 一个按钮同时支持选文件与文件夹 —— Windows 上原生对话框做不到，
     * 所以由应用内列表实现；`path` 一律交给 path-guard 收敛，边界只有这一处。
     */
    [IPC_INVOKE_CHANNELS.fsListWorkspaceDir]: async (raw) => {
      const input = raw as { sessionKey?: string; sessionFile?: string; path?: string }
      const root = await resolveWorkspaceRootForPick(input)
      if (root === undefined) {
        throw new IpcFailure('NOT_FOUND', '无法确定该任务的工作区（会话缺少目录信息）')
      }
      const realRoot = await realpathNative(root).catch(() => root)
      const target = await resolveWorkspaceTarget({
        root: realRoot,
        raw: input.path === undefined || input.path.length === 0 ? '.' : input.path
      })
      const stats = statSync(target.realPath)
      if (!stats.isDirectory()) {
        throw new IpcFailure('VALIDATION', '该路径不是目录', target.relative)
      }
      return listDirectoryContent({ absoluteDir: target.realPath, relative: target.relative })
    },

    /**
     * A22：选工作区文件。
     *
     * 为什么需要主进程做：① 原生对话框只能在主进程弹；② **工作区边界必须由主进程判定** ——
     * 用户可以在对话框里导航到工作区外，renderer 无权决定「这算不算这个任务的文件」。
     * 返回工作区相对路径（POSIX），消息里直接引用，模型用自己的 read 工具读取。
     */
    [IPC_INVOKE_CHANNELS.fsPickWorkspaceFile]: async (raw) => {
      const input = raw as {
        sessionKey?: string
        sessionFile?: string
        defaultPath?: string
        kind?: 'file' | 'directory'
      }

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

      const picked = await deps.fsBridge.pickFile({
        defaultPath,
        ...(input.kind === undefined ? {} : { kind: input.kind })
      })
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
        // A34：gate 放在最前面 —— 更新期间连 agent 目录扫描都不该做
        assertNotUpdating()
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

    [IPC_INVOKE_CHANNELS.sessionResume]: (raw) => {
      assertNotUpdating()
      return service.resume({ sessionFile: (raw as SessionResumeInput).sessionFile })
    },

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
     * A40：运行中切换专家（扩展命令 `/agent <name|none>`，不重建会话）。
     *
     * 三层前置校验（R1）：
     * ① 扩展必须支持 `--agent` —— 未装扩展时 `/agent x` 会变成普通聊天消息；
     * ② 名字必须在目录里 —— F1：扩展对未知名字**静默失败**且仍回 `handled`；
     * ③ 名字必须是单 token —— F4：扩展把 `args.trim()` 整体当名。
     * 扫描根来自主进程核实的会话工作区（`workspaceOf`），不接受 renderer 指定 cwd。
     */
    [IPC_INVOKE_CHANNELS.sessionSwitchAgent]: (raw) => {
      const input = raw as SessionSwitchAgentInput
      return (async () => {
        const cwd = service.workspaceOf(input.sessionKey) ?? defaultCwd()
        const view = await deps.agentCatalog.list(cwd)
        if (!view.supportsAgentFlag) {
          throw new IpcFailure(
            'VALIDATION',
            '当前 pi 未注册 --agent（需要安装 pi-open-agents 扩展）'
          )
        }
        if (input.agent !== null) {
          if (!deps.agentCatalog.has(view, input.agent)) {
            throw new IpcFailure('VALIDATION', `未知专家：${input.agent}`)
          }
          if (!isAgentNameSwitchable(input.agent)) {
            throw new IpcFailure(
              'VALIDATION',
              `专家名包含空白或控制字符，暂不支持运行中切换：${input.agent}`
            )
          }
        }
        return service.switchAgent({ sessionKey: input.sessionKey, agent: input.agent })
      })()
    },

    /**
     * A41：手动压缩上下文（pi `compact`）。
     *
     * 本层只搬移入参：仅 idle、超时、状态翻转全在服务层（重复一遍就有了第二个事实来源）。
     * `customInstructions` 目前只搬移不透传（V1 无 UI，V2 再落 RPC）。
     */
    [IPC_INVOKE_CHANNELS.sessionCompact]: (raw) => {
      const input = raw as SessionCompactInput
      return service.compact({
        sessionKey: input.sessionKey,
        ...(input.customInstructions === undefined
          ? {}
          : { customInstructions: input.customInstructions })
      })
    },

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
        const result = await service.setName({ sessionKey: input.sessionKey, name: input.name })
        /**
         * pi 已把 `session_info` 追加到会话文件尾；索引靠 mtime 也能发现变化，
         * 但同一毫秒内的两次 append 可能让 mtime 不变，所以这里显式失效一次。
         * 拿不到会话文件（还没落盘 / 已释放）就跳过 —— 不能让失效失败影响改名结果。
         */
        const sessionFile = service.sessionFileOf(input.sessionKey)
        if (sessionFile !== undefined && sessionFile.length > 0) {
          deps.sessionIndex.invalidate(sessionFile)
        }
        return result
      }
      const sessionFile = input.sessionFile
      if (sessionFile === undefined) {
        throw new IpcFailure('VALIDATION', '需要 sessionKey 或 sessionFile')
      }
      const realFile = await realpathNative(sessionFile).catch(() => {
        throw new IpcFailure('NOT_FOUND', '会话文件不存在', sessionFile)
      })
      /**
       * 授权依据用「**SessionIndex.find 认同的会话文件**」，而不是比对根目录字符串：
       * 会话目录可以由 `PI_CODING_AGENT_SESSION_DIR` 配置改变，根字符串比对很容易在
       * 真实环境里误判（用户报的「改名无法保存」就是这个方向）。索引是我们自己的事实来源。
       *
       * F1（A39 顺带修复）：旧实现拿 `sessionIndex.list({})` 的**首页**（默认 20 条）逐条比对，
       * 第 21 条及之后的历史会话改名必然 PATH_DENIED。`find` 不分页、只查一条路径，
       * 并在内部做 realpath 归一（8.3 短名 / 大小写 / junction），语义正是
       * 「这条路径会出现在全量列表里」。
       */
      const summary = await deps.sessionIndex.find(realFile)
      if (summary === undefined) {
        throw new IpcFailure('PATH_DENIED', '只能修改本地会话索引里的会话文件', sessionFile)
      }
      appendSessionName({ sessionFile: realFile, name: input.name })
      // 名字写在文件尾，索引需要重算（尾部窗口才有最新 session_info）
      deps.sessionIndex.invalidate(realFile)
      return { ok: true }
    },

    /**
     * A39：删除本地会话文件（移到回收站）。
     *
     * 授权全在 `SessionDelete`：会话根布局 + 索引成员 + 活跃会话拒绝 + 普通文件闸；
     * 本层只做搬移与索引失效，不重复校验（重复一遍就有了第二个事实来源）。
     * `.invalidate` 是必需的：删除后紧接着 `session:list` 时文件已不在，
     * 缓存里仍是旧摘要（同一毫秒内 mtime 不变也会命中缓存）。
     */
    [IPC_INVOKE_CHANNELS.sessionDelete]: async (raw) => {
      const input = raw as SessionDeleteInput
      const result = await deps.sessionDelete.remove({
        sessionFile: input.sessionFile,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
      })
      deps.sessionIndex.invalidate(result.filePath)
      return result
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
    /** A31：可用技能清单（只读）。 */
    [IPC_INVOKE_CHANNELS.skillsList]: (raw) => {
      const input = raw as { cwd?: string }
      return Promise.resolve(deps.skillCatalog.list(input.cwd))
    },

    /**
     * A32：从 URL 预览公开技能（不落盘）。
     * 安全约束全在服务层（https-only、禁内网、≤512KB、名字白名单），这里只负责取工作区。
     */
    [IPC_INVOKE_CHANNELS.skillsPreview]: async (raw) => {
      const input = raw as {
        url: string
        scope: 'global' | 'project'
        sessionKey?: string
        sessionFile?: string
      }
      const projectRoot =
        input.scope === 'project' ? await resolveWorkspaceRootForPick(input) : undefined
      if (input.scope === 'project' && projectRoot === undefined) {
        throw new IpcFailure('VALIDATION', '项目级安装需要当前任务的工作区')
      }
      return previewSkill({
        url: input.url,
        scope: input.scope,
        agentDir: deps.skillCatalog.agentDir(),
        ...(projectRoot === undefined ? {} : { projectRoot }),
        // 测试用：e2e 通过本地 http 服务器验证安装链路（生产恒为 false）
        allowLocalhost: process.env['PI_DESKTOP_ALLOW_LOCAL_SKILL_FETCH'] === '1'
      })
    },

    /** A32：安装到全局或项目级技能目录。 */
    [IPC_INVOKE_CHANNELS.skillsInstall]: async (raw) => {
      const input = raw as {
        url: string
        scope: 'global' | 'project'
        overwrite?: boolean
        sessionKey?: string
        sessionFile?: string
      }
      const projectRoot =
        input.scope === 'project' ? await resolveWorkspaceRootForPick(input) : undefined
      if (input.scope === 'project' && projectRoot === undefined) {
        throw new IpcFailure('VALIDATION', '项目级安装需要当前任务的工作区')
      }
      return installSkill({
        url: input.url,
        scope: input.scope,
        agentDir: deps.skillCatalog.agentDir(),
        ...(projectRoot === undefined ? {} : { projectRoot }),
        ...(input.overwrite === true ? { overwrite: true } : {}),
        allowLocalhost: process.env['PI_DESKTOP_ALLOW_LOCAL_SKILL_FETCH'] === '1'
      })
    },

    [IPC_INVOKE_CHANNELS.agentsList]: (raw) => {
      const input = raw as { cwd?: string }
      return deps.agentCatalog.list(input.cwd)
    },

    /**
     * A37：插件清单（只读）。
     *
     * 项目级 `.pi/settings.json` 的工作区根**只能**由主进程推导（活跃会话的 cwd /
     * 会话索引里该 JSONL 的 cwd），与 `fs:*` 走同一个 `resolveWorkspaceRootForPick`：
     * renderer 传路径一律不采信。会话引用缺失时 `projectRoot` 为 undefined，只读全局清单。
     */
    [IPC_INVOKE_CHANNELS.pkgList]: async (raw) => {
      const input = raw as { sessionKey?: string; sessionFile?: string }
      const catalog = deps.pkgCatalog
      if (catalog === undefined) {
        throw new IpcFailure('NOT_IMPLEMENTED', '插件清单服务未注入')
      }
      const projectRoot = await resolveWorkspaceRootForPick(input)
      return catalog.list(projectRoot)
    },

    /**
     * A37：预览 npm 源（只读 registry 元数据，不落盘、不执行任何第三方代码）。
     *
     * `preview` 只在校验失败时抛错 —— 那是**入参问题**，必须映射成 `VALIDATION`；
     * 网络/格式问题服务层已折进 `PkgPreview.error`（预览失败不阻断安装）。
     */
    [IPC_INVOKE_CHANNELS.pkgPreview]: async (raw) => {
      const input = raw as { source: string }
      const installer = requirePkgInstaller()
      try {
        return await installer.preview(input.source)
      } catch (error) {
        throw new IpcFailure(
          'VALIDATION',
          error instanceof Error ? error.message : '无法校验该插件源'
        )
      }
    },

    /**
     * A37：执行 `pi install <source>`。
     *
     * 错误码映射只在这里做一次：
     * - `accepted: false` → 对应 gate 错误码（没开始执行，属调用方问题）；
     * - `accepted: true` 的 `outcome: 'failed' / 'canceled'` → **仍是 `Result.ok`**：
     *   UI 要展示 `logTail` / `manualCommand`，伪装成异常只会丢掉诊断信息。
     */
    [IPC_INVOKE_CHANNELS.pkgInstall]: async (raw) => {
      const installer = requirePkgInstaller()
      // 复用 A34 的 gate：更新期间不许装插件（服务内部还会再判一次，防止绕过本层）
      assertNotUpdating()
      const outcome = await installer.install((raw as { source: string }).source)
      if (outcome.accepted) return outcome.result

      switch (outcome.reason) {
        case 'busy':
          throw new IpcFailure('PKG_INSTALL_BUSY', outcome.message)
        case 'updating':
          throw new IpcFailure('PI_UPDATE_BUSY', outcome.message)
        case 'not-located':
          throw new IpcFailure('PI_NOT_FOUND', outcome.message)
        case 'invalid':
          throw new IpcFailure('VALIDATION', outcome.message)
      }
    },

    /** A37：取消进行中的安装（幂等：没有任务也返回 ok，未接线同样安全）。 */
    [IPC_INVOKE_CHANNELS.pkgInstallCancel]: () => {
      deps.pkgInstaller?.cancel()
      return Promise.resolve({ ok: true } as const)
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
