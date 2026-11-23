import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BrowserWindow, dialog, shell } from 'electron'

/**
 * BrowserWindow 安全配置集中处（架构文档 §5.2 window.ts）。
 *
 * 四条安全开关缺一不可（§5.2、§9.4 S1）：
 *   contextIsolation: true   —— preload 与页面上下文隔离
 *   nodeIntegration: false   —— 页面拿不到 require/process
 *   sandbox: true            —— 渲染进程走 Chromium 沙箱
 *   webSecurity: true        —— 保持同源策略
 *
 * 导出为常量而非内联，便于单测直接断言（tests/unit/window-security.test.ts）。
 */
export const WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  /** 只允许加载 https 外链与本地 dev server，其余协议一律拒绝 */
  spellcheck: false
} as const)

export const ALLOWED_EXTERNAL_PROTOCOLS: readonly string[] = Object.freeze(['https:', 'http:'])

/** 外链是否允许交给系统浏览器（协议白名单，拒绝 javascript:/file: 等） */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return ALLOWED_EXTERNAL_PROTOCOLS.includes(url.protocol)
  } catch {
    return false
  }
}

/**
 * 导航白名单（M3 前置修复）。
 *
 * 生产模式**不能**把「任意 `file:` URL」都当作同源导航放行——那样 `file:///C:/Windows/...`
 * 也能被导航过去（绕过 §9.4 S4）。这里收紧为「唯一渲染入口文件」的精确路径比较。
 */
export interface NavigationAllowList {
  /** dev server 来源（`http://host:port`）；生产模式下为 undefined */
  devOrigin?: string
  /** 生产模式下唯一允许的渲染入口文件绝对路径（`out/renderer/index.html`） */
  rendererIndexPath: string
}

/**
 * 路径归一：统一正斜杠 + 去掉末尾分隔符；Windows 语义（含盘符/UNC）下大小写不敏感。
 *
 * `fileURLToPath` 在 Windows 上给出 `\\C:\\app\\...`，而配置/测试里通常是 `C:/app/...`，
 * 因此比较前必须先归一（§7 约束 8 的同类要求）。
 */
export function normalizeFsPath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
  const windowsLike = /^[A-Za-z]:\//.test(trimmed) || trimmed.startsWith('//')
  const caseInsensitive = process.platform === 'win32' || windowsLike
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

/** 从窗口配置构造导航白名单 */
export function createNavigationAllowList(options: {
  devServerUrl?: string | undefined
  rendererIndexPath: string
}): NavigationAllowList {
  const devOrigin = options.devServerUrl === undefined ? undefined : originOf(options.devServerUrl)
  return {
    ...(devOrigin === undefined ? {} : { devOrigin }),
    rendererIndexPath: options.rendererIndexPath
  }
}

/**
 * 导航目标是否放行（纯函数，便于单测）。
 *
 * 放行集合**只有两项**：dev 模式下的 dev server 来源、生产模式下的渲染入口文件本身。
 * 其它 `file:`（含 `file:///C:/Windows/...`）、`javascript:`、`data:` 一律不放行。
 */
export function isAllowedNavigationTarget(targetUrl: string, allowed: NavigationAllowList): boolean {
  if (allowed.devOrigin !== undefined) {
    const origin = originOf(targetUrl)
    return origin !== undefined && origin === allowed.devOrigin
  }

  const targetPath = filePathOf(targetUrl)
  if (targetPath === undefined) return false
  return normalizeFsPath(targetPath) === normalizeFsPath(allowed.rendererIndexPath)
}

function originOf(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

/** `file:` URL → 本地路径；非 file 协议或非法 URL 返回 undefined */
function filePathOf(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'file:') return undefined
    // query / hash 由 fileURLToPath 忽略：同一入口文件的 hash 导航仍然放行
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

export interface CreateWindowOptions {
  /** electron-vite dev server URL；生产环境为 undefined（加载打包后的 index.html） */
  devServerUrl?: string
  /** 打包后 renderer 的入口文件绝对路径 */
  rendererIndexPath: string
  preloadPath: string
  show?: boolean
}

/**
 * 创建主窗口。
 *
 * 所有导航与开窗行为都被拦截：
 * - `will-navigate`：只允许留在应用自身来源内；
 * - `setWindowOpenHandler`：一律 deny，http(s) 外链在**用户二次确认**后交给系统浏览器（§9.4 S4）。
 */
export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: options.show ?? false,
    autoHideMenuBar: true,
    backgroundColor: '#111418',
    title: 'pi-desktop',
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: options.preloadPath
    }
  })

  installNavigationGuards(window, createNavigationAllowList(options))
  installPermissionGuards(window)

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl)
  } else {
    void window.loadFile(options.rendererIndexPath)
  }

  return window
}

/**
 * 拦截导航与新开窗口。
 * 外链必须在用户确认后才 `shell.openExternal`，未确认不得放行。
 */
export function installNavigationGuards(window: BrowserWindow, allowed: NavigationAllowList): void {
  window.webContents.on('will-navigate', (event, targetUrl) => {
    // 只有「渲染入口本身」或 dev server 来源放行，其余全部阻断（§9.4 S4）
    if (isAllowedNavigationTarget(targetUrl, allowed)) return
    event.preventDefault()
    if (isAllowedExternalUrl(targetUrl)) void confirmAndOpenExternal(window, targetUrl)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    // 一律不开新 Electron 窗口
    if (isAllowedExternalUrl(url)) void confirmAndOpenExternal(window, url)
    return { action: 'deny' }
  })
}

/** 默认拒绝所有权限请求（摄像头、麦克风、通知等），需要时按通道显式放开 */
function installPermissionGuards(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

/**
 * 外链二次确认（M1 为最小可用实现；后续可替换为产品化确认弹层）。
 * 只在用户明确选择「打开」时调用 openExternal。
 */
async function confirmAndOpenExternal(window: BrowserWindow, url: string): Promise<void> {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    buttons: ['取消', '在浏览器中打开'],
    defaultId: 0,
    cancelId: 0,
    title: '打开外部链接',
    message: '即将用系统默认浏览器打开外部链接：',
    detail: url
  })
  if (response === 1) {
    await shell.openExternal(url)
  }
}

export function resolveRendererIndexPath(mainDir: string): string {
  return join(mainDir, '../renderer/index.html')
}

export function resolvePreloadPath(mainDir: string): string {
  return join(mainDir, '../preload/index.js')
}
