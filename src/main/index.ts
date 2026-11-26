import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { IPC_EVENT_CHANNELS, type EventChannel } from '../shared/ipc-channels'
import type { StatusEvent } from '../shared/contracts/types'
import { IpcFailure } from '../shared/contracts/result'

import { createRouter } from './ipc/handlers'
import { createAgentCatalog } from './services/agent-catalog'
import { createSkillCatalog } from './services/skill-catalog'
import { createModelConfigStore } from './services/model-config-store'
import { createArtifactsService } from './services/artifacts'
import { createAuditLog } from './services/audit-log'
import { createConfigStore } from './services/config-store'
import { createFsBridge } from './services/fs-bridge'
import { buildPermissionPolicyEnv } from './services/permission-extension'
import { createPiLocator, defaultRunCapture } from './services/pi-locator'
import {
  createFileUpdateCache,
  createPiUpdateService,
  type PiUpdateService
} from './services/pi-update'
import { createPiPackageCatalog } from './services/pi-package-catalog'
import { createPiPackageInstaller } from './services/pi-package-installer'
import { readSessionAgent } from './services/session-agent'
import { createSessionDelete } from './services/session-delete'
import { createSessionHistory } from './services/session-history'
import { createSessionIndex } from './services/session-index'
import { createSessionService, type SessionService } from './services/session-service'
import { createWorkspaceResolver } from './services/workspace-resolver'
import { LocalConnection } from './transport/local-connection'
import { createMainWindow, resolvePreloadPath, resolveRendererIndexPath } from './window'

/**
 * 应用入口：app 生命周期 + 单实例 + 窗口 + IPC 注册（架构文档 §6.1 启动流程）。
 *
 * M2 在 M1 骨架上接通通道层：LocalConnection（一会话一 pi 子进程）+ SessionService
 * + SessionIndex + PiLocator，并把 `evt:record/status/diagnostic/extui` 推给 renderer。
 */
const devServerUrl = process.env.ELECTRON_RENDERER_URL

let mainWindow: BrowserWindow | null = null
let activeServices: { sessionService: SessionService; connection: LocalConnection } | null = null
/** A34：更新服务（`before-quit` 需要读它判断是否有更新正在跑） */
let activePiUpdate: PiUpdateService | null = null
/** 用户已确认「更新中继续退出」：置 true 后 `before-quit` 不再拦截，避免弹窗死循环 */
let allowQuit = false

/** main → renderer 事件推送；窗口未就绪时静默丢弃（事件是流式的，不需要补发） */
function emitEvent(channel: EventChannel, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function bootstrappedWindow(): void {
  // M4：偏好持久化到 `userData/config.json`（schema 校验 + 迁移，§5.2 ConfigStore）
  const configStore = createConfigStore({ filePath: join(app.getPath('userData'), 'config.json') })
  const config = (): ReturnType<typeof configStore.getConfigView> => configStore.getConfigView()

  const sessionIndex = createSessionIndex({ sessionDir: () => config().sessionDir })
  const piLocator = createPiLocator()

  // 审计：产物打开（M6）与会话删除（A39）共用同一实例，便于按时间线对照「谁动过这条会话」
  const audit = createAuditLog()

  // §5.3：连接层只负责「拿到可执行的 pi 命令 + 开通道」，不关心业务状态
  const connection = new LocalConnection({
    // M5：审批策略随子进程环境注入（扩展读取后生效）；策略变化在下次 spawn 时生效
    extraEnv: () => buildPermissionPolicyEnv(config().permission),
    resolveLaunch: async () => {
      const existing = piLocator.launch()
      if (existing) return existing
      const status = await piLocator.locate(config().piCommand)
      const launch = piLocator.launch()
      if (!launch) {
        throw new IpcFailure('PI_NOT_FOUND', status.message ?? '找不到 pi 可执行文件')
      }
      return launch
    }
  })

  const sessionService = createSessionService({
    // A38：`get_state` 不返回 agent，由主进程读会话文件尾部顺带取（fail-soft）
    readAgent: readSessionAgent,
    connection,
    emit: (channel, payload) => {
      emitEvent(channel, payload)
      // M6：会话开始即（为非 git 工作区）建立「会话开始快照」，后续 diff 才有基线。
      // 只在这个时机 + 用户手动刷新时扫描，不轮询。
      if (channel === 'evt:status') {
        const status = payload as StatusEvent
        if (status.status === 'starting') artifacts.onSessionStarted(status.sessionKey)
      }
    },
    limits: () => ({
      maxActiveSessions: config().maxActiveSessions,
      idleRecycleMinutes: config().idleRecycleMinutes
    }),
    sessionDir: () => config().sessionDir
  })

  activeServices = { sessionService, connection }

  // M6：产物层（列表 / diff / 预览 / 系统程序打开）。
  // 工作区根**只能**由主进程推导：sessionKey → SessionService.workspaceOf，
  // sessionFile → 会话 header 的 cwd（路径先按会话根校验）。
  const workspaceResolver = createWorkspaceResolver({
    liveCwd: (sessionKey) => sessionService.workspaceOf(sessionKey),
    liveCwds: () => sessionService.workspaces(),
    sessionRoot: () => sessionIndex.root(),
    configRoots: () => config().workspaceRoots
  })
  const artifacts = createArtifactsService({
    resolver: workspaceResolver,
    // 只用 shell.openPath（**不用** openExternal）：本地路径交给系统默认程序，
    // 且返回值是错误串（空串 = 成功），可映射成可操作提示 + 审计记录。
    openPath: (target) => shell.openPath(target),
    audit
  })

  // M3：新建任务选目录（原生对话框）
  const fsBridge = createFsBridge({
    showOpenDialog: async (options) => {
      const result = await dialog.showOpenDialog({
        title: options.title,
        ...(options.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
        // **必须透传调用方的 properties**：之前这里硬编码成目录选择器，
        // 导致「引用文件」永远只弹目录（用户反馈的就是这个）。
        properties: [...options.properties]
      })
      return { canceled: result.canceled, filePaths: result.filePaths }
    }
  })

  // M3：选中历史任务时只读回放 JSONL（不启动子进程，§6.1）
  // M4：默认回放上限 2000 条（避免 3 万条会话把 renderer 拖成 O(n²)）
  const sessionHistory = createSessionHistory({
    sessionRoot: () => sessionIndex.root()
  })

  // A39：删除本地会话文件（移到系统回收站）。授权全在服务层：
  // 会话根布局 + 索引成员（`SessionIndex.find`）+ 活跃会话拒绝 + 普通文件闸。
  // `activeSessionFiles` 必须是**函数**：会话集合随时变化，只能在删除那一刻取。
  const sessionDelete = createSessionDelete({
    sessionRoot: () => sessionIndex.root(),
    findSession: (filePath) => sessionIndex.find(filePath),
    activeSessionFiles: () =>
      sessionService.keys().flatMap((key) => {
        const file = sessionService.sessionFileOf(key)
        return file === undefined || file.length === 0 ? [] : [file]
      }),
    // 只用 shell.trashItem：pi 自己也优先用 trash，系统回收站是唯一可信的恢复渠道
    trash: (absPath) => shell.trashItem(absPath),
    audit
  })

  // M5：审批扩展的安装状态探测（只读）。开发/未打包时能逐文件比对仓库源；
  // 打包后仓库源不在应用内，只报版本不判「落后」。
  const permissionSourceDir = (() => {
    const candidate = join(app.getAppPath(), 'src', 'extensions', 'permission')
    return existsSync(candidate) ? candidate : undefined
  })()
  const permissionDeps = {
    ...(permissionSourceDir === undefined ? {} : { sourceDir: permissionSourceDir }),
    projectExtensionsDir: join(app.getAppPath(), '.pi', 'extensions')
  }

  // 模型管理：默认指向 `<agent-dir>/models.json`（`PI_CODING_AGENT_DIR` 可覆盖）
  const modelConfigStore = createModelConfigStore()

  // A18：agent 目录。`--agent` 是否可用由 `pi --help` 探测（60s 缓存），
  // 未定位到 pi 时退回「不支持」，UI 就不显示 agent 选择器。
  const skillCatalog = createSkillCatalog()

  const agentCatalog = createAgentCatalog({
    launch: () => piLocator.launch(),
    runCapture: defaultRunCapture
  })

  // A34：pi 版本检测 / 更新。
  // 检测源与超时都在服务内部固定（renderer 不能指定地址，避免把主进程变成 SSRF 代理）；
  // 检测缓存落 `userData`，只在「本次检测失败」时才被读，用于告诉用户上次查到什么。
  const updateCache = createFileUpdateCache(join(app.getPath('userData'), 'pi-update-check.json'))
  const piUpdate = createPiUpdateService({
    // 只有「定位成功且读到版本」才算可用；其余情况返回 undefined（服务映射成 not-located）
    locatePi: async () => {
      const status = await piLocator.locate(config().piCommand)
      if (status.state !== 'ok' || status.version === undefined) return undefined
      return { command: status.path ?? config().piCommand, version: status.version }
    },
    launchPi: () => Promise.resolve(piLocator.launch()),
    activeSessionKeys: () => sessionService.keys(),
    disposeAllSessions: () => sessionService.disposeAll(),
    emit: (event) => {
      // 走独立事件通道推给所有窗口（renderer 重建后仍能看到进度）
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_CHANNELS.piUpdate, event)
      }
    },
    readCache: () => updateCache.read(),
    writeCache: (result) => updateCache.write(result)
  })
  activePiUpdate = piUpdate

  // A37：插件（pi package）清单 + 安装。
  // `agentDir` 统一取自 catalog（它内部已解析 `PI_CODING_AGENT_DIR` / `~/.pi/agent`）：
  // 清单与安装后的复验必须是同一个目录事实，否则会出现「清单说装在这、复验读那里」。
  const pkgCatalog = createPiPackageCatalog()
  const pkgInstaller = createPiPackageInstaller({
    // 与 piUpdate.locatePi 同构：只有「定位成功且读到版本」才算可用
    locatePi: async () => {
      const status = await piLocator.locate(config().piCommand)
      if (status.state !== 'ok' || status.version === undefined) return undefined
      return { command: status.path ?? config().piCommand, version: status.version }
    },
    launchPi: () => Promise.resolve(piLocator.launch()),
    agentDir: () => pkgCatalog.agentDir(),
    emit: (event) => {
      // 走独立事件通道推给所有窗口（renderer 重建后仍能看到安装日志）
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_CHANNELS.pkgInstall, event)
      }
    },
    isUpdating: () => piUpdate.isRunning()
  })

  const router = createRouter(
    {
      configStore,
      modelConfigStore,
      agentCatalog,
      skillCatalog,
      // 顶栏版本号：Electron 的 app.getVersion() 读的是打包时写入的版本资源
      appVersion: () => app.getVersion(),
      // 剪贴板：渲染进程在 file:// 下拿不到 navigator.clipboard，必须由主进程写
      writeClipboard: (text) => {
        clipboard.writeText(text)
      },
      sessionIndex,
      piLocator,
      sessionService,
      // A34：检测/执行/取消更新（执行期间 gate 住 session:create / session:resume）
      piUpdate,
      // A37：插件清单 + 安装/预览/取消（安装与更新互斥）
      pkgCatalog,
      pkgInstaller,
      fsBridge,
      sessionHistory,
      // A39：删除本地会话（仅历史任务；活跃会话由服务层 SESSION_BUSY 兜底）
      sessionDelete,
      artifacts,
      permissionDeps
    },
    (channel, error) => {
      console.error('[ipc] 处理器抛出异常', channel, error instanceof Error ? error.message : error)
    }
  )
  router.registerAll(ipcMain)

  // 启动即做一次 pi 自检（§3.3）：结果通过 app:getBoot / pi:locate 暴露
  void piLocator.locate(config().piCommand).catch((error: unknown) => {
    console.error('[pi] 自检失败', error instanceof Error ? error.message : error)
  })

  const mainDir = __dirname

  const windowOptions = {
    rendererIndexPath: resolveRendererIndexPath(mainDir),
    preloadPath: resolvePreloadPath(mainDir),
    ...(devServerUrl === undefined ? {} : { devServerUrl })
  }

  mainWindow = createMainWindow(windowOptions)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 退出前按 §7 约束 6 优雅关停所有 pi 子进程（关 stdin → 等退出 → 超时 kill） */
function shutdownServices(): void {
  const services = activeServices
  if (!services) return
  activeServices = null
  void services.sessionService.disposeAll().finally(() => {
    void services.connection.dispose()
  })
}

// §7 约束 10：单实例锁，第二实例聚焦已有窗口并退出
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    bootstrappedWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) bootstrappedWindow()
    })
  })

  /**
   * A34：更新进行中退出要先问一次。
   *
   * `before-quit` 里**不能** await（Electron 会忽略返回值直接继续退出），所以：
   * 先同步 `preventDefault()`，再在异步回调里弹窗；选「继续退出」时置 `allowQuit`
   * （否则 `app.quit()` 会再次进入本回调、再次弹窗），并先 `cancel()` 结束安装进程。
   */
  app.on('before-quit', (event) => {
    const piUpdate = activePiUpdate
    if (piUpdate !== null && piUpdate.isRunning() && !allowQuit) {
      event.preventDefault()
      void (async () => {
        const choice = await dialog.showMessageBox({
          type: 'warning',
          title: 'pi 正在更新',
          message: '更新正在执行，退出可能导致安装不完整',
          detail: '建议等更新结束后再退出。若继续退出，将先尝试结束更新进程。',
          buttons: ['继续退出', '取消'],
          defaultId: 1,
          cancelId: 1
        })
        if (choice.response !== 0) return
        allowQuit = true
        piUpdate.cancel()
        shutdownServices()
        app.quit()
      })()
      return
    }
    shutdownServices()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
