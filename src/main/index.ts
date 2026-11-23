import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { EventChannel } from '../shared/ipc-channels'
import type { StatusEvent } from '../shared/contracts/types'
import { IpcFailure } from '../shared/contracts/result'

import { createRouter } from './ipc/handlers'
import { createModelConfigStore } from './services/model-config-store'
import { createArtifactsService } from './services/artifacts'
import { createAuditLog } from './services/audit-log'
import { createConfigStore } from './services/config-store'
import { createFsBridge } from './services/fs-bridge'
import { buildPermissionPolicyEnv } from './services/permission-extension'
import { createPiLocator } from './services/pi-locator'
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
    audit: createAuditLog()
  })

  // M3：新建任务选目录（原生对话框）
  const fsBridge = createFsBridge({
    showOpenDialog: async (options) => {
      const result = await dialog.showOpenDialog({
        title: options.title,
        ...(options.defaultPath === undefined ? {} : { defaultPath: options.defaultPath }),
        properties: ['openDirectory', 'createDirectory']
      })
      return { canceled: result.canceled, filePaths: result.filePaths }
    }
  })

  // M3：选中历史任务时只读回放 JSONL（不启动子进程，§6.1）
  // M4：默认回放上限 2000 条（避免 3 万条会话把 renderer 拖成 O(n²)）
  const sessionHistory = createSessionHistory({
    sessionRoot: () => sessionIndex.root()
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

  const router = createRouter(
    {
      configStore,
      modelConfigStore,
      sessionIndex,
      piLocator,
      sessionService,
      fsBridge,
      sessionHistory,
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

  app.on('before-quit', () => {
    shutdownServices()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
