import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * window.ts 的安全配置断言（架构文档 §5.2、§9.4 S1/S4）。
 *
 * window.ts 依赖 electron 运行时，这里整体 mock 掉，只验证常量与拦截逻辑。
 */
interface FakeWebContents {
  on: Mock
  setWindowOpenHandler: Mock
  getURL: Mock
  session: { setPermissionRequestHandler: Mock }
}

interface FakeWindow {
  options: { webPreferences: Record<string, unknown> }
  webContents: FakeWebContents
  loadURL: Mock
  loadFile: Mock
  show: Mock
}

const createdWindows: FakeWindow[] = []

vi.mock('electron', () => {
  const showMessageBox = vi.fn(() => Promise.resolve({ response: 0 }))
  const openExternal = vi.fn(() => Promise.resolve())

  class BrowserWindow implements FakeWindow {
    options: { webPreferences: Record<string, unknown> }
    webContents: FakeWebContents
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    show = vi.fn()
    on = vi.fn()
    once = vi.fn()

    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.options = options
      this.webContents = {
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        getURL: vi.fn(() => ''),
        session: { setPermissionRequestHandler: vi.fn() }
      }
      createdWindows.push(this)
    }
  }

  return { BrowserWindow, dialog: { showMessageBox }, shell: { openExternal } }
})

const {
  WEB_PREFERENCES,
  createMainWindow,
  isAllowedExternalUrl,
  createNavigationAllowList,
  isAllowedNavigationTarget,
  normalizeFsPath
} = await import('../../src/main/window')

beforeEach(() => {
  createdWindows.length = 0
})

/** 当前平台上可被 `file:` URL 表达的渲染入口路径 */
const TEST_ENTRY_PATH = resolve('out/renderer/index.html')

function createTestWindow(): FakeWindow {
  createMainWindow({
    // 用平台合法路径：Windows 上 `file:///app/...` 无盘符会解析失败，无法验证白名单
    rendererIndexPath: TEST_ENTRY_PATH,
    preloadPath: '/app/out/preload/index.js',
    show: false
  })
  const window = createdWindows[0]
  if (!window) throw new Error('窗口未创建')
  return window
}

describe('WEB_PREFERENCES 安全开关', () => {
  it('四项必需开关全部符合 §5.2 要求', () => {
    expect(WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(WEB_PREFERENCES.nodeIntegration).toBe(false)
    expect(WEB_PREFERENCES.sandbox).toBe(true)
    expect(WEB_PREFERENCES.webSecurity).toBe(true)
  })

  it('额外收窄项：不开 node integration in worker / subframes，禁用 webview 与不安全内容', () => {
    expect(WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false)
    expect(WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false)
    expect(WEB_PREFERENCES.webviewTag).toBe(false)
    expect(WEB_PREFERENCES.allowRunningInsecureContent).toBe(false)
  })

  it('常量被冻结，运行期不可被改写', () => {
    expect(Object.isFrozen(WEB_PREFERENCES)).toBe(true)
  })
})

describe('isAllowedExternalUrl 协议白名单', () => {
  it('http/https 放行', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://localhost:3000/x')).toBe(true)
  })

  it('危险协议一律拒绝', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'not a url'
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false)
    }
  })
})

describe('createMainWindow', () => {
  it('创建窗口时套用全部安全 webPreferences 并带上 preload', () => {
    const window = createTestWindow()
    expect(window.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: '/app/out/preload/index.js'
    })
  })

  it('注册 will-navigate 拦截与 setWindowOpenHandler（拒绝开新窗口）', () => {
    const contents = createTestWindow().webContents

    expect(contents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    expect(contents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))

    const handler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string
    }) => { action: string }
    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
  })

  it('默认拒绝所有权限请求', () => {
    const session = createTestWindow().webContents.session
    const handler = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void
    ) => void

    const callback = vi.fn()
    handler(null, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
  })

  it('will-navigate 对外部链接阻断导航（§9.4 S4）', () => {
    const contents = createTestWindow().webContents
    const handler = contents.on.mock.calls.find((call) => call[0] === 'will-navigate')?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void

    const event = { preventDefault: vi.fn() }
    handler(event, 'https://example.com/evil')
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

/**
 * M3 前置修复：生产模式的 `file://` 白名单必须收紧到**具体渲染入口文件**，
 * 不能是「任何 file: URL」（§9.4 S4 的绕过面）。
 */
describe('导航白名单：生产模式只放行渲染入口文件', () => {
  const entry = resolve('/tmp/pi-desktop/out/renderer/index.html')
  const allowed = createNavigationAllowList({ rendererIndexPath: entry })
  const entryUrl = pathToFileURL(entry).href

  it('入口文件本身放行（含 hash / query 后缀导航）', () => {
    expect(isAllowedNavigationTarget(entryUrl, allowed)).toBe(true)
    expect(isAllowedNavigationTarget(`${entryUrl}#/settings`, allowed)).toBe(true)
    expect(isAllowedNavigationTarget(`${entryUrl}?a=1`, allowed)).toBe(true)
  })

  it('其他 file:// 一律拦截（同目录其它文件、系统目录、目录本身）', () => {
    const siblings = [
      pathToFileURL(resolve('/tmp/pi-desktop/out/renderer/other.html')).href,
      'file:///C:/Windows/System32/calc.exe',
      'file:///etc/passwd',
      pathToFileURL(resolve('/tmp/pi-desktop/out/renderer/index.html.bak')).href,
      pathToFileURL(resolve('/tmp/pi-desktop/out/renderer')).href
    ]
    for (const url of siblings) {
      expect(isAllowedNavigationTarget(url, allowed)).toBe(false)
    }
  })

  it('非 file 协议（javascript/data/http）在无 devServer 时一律拦截', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://example.com/',
      'about:blank'
    ]) {
      expect(isAllowedNavigationTarget(url, allowed)).toBe(false)
    }
  })

  it('路径归一：反斜杠/分隔符差异不影响放行（Windows 语义下大小写不敏感）', () => {
    expect(normalizeFsPath(String.raw`C:\App\Out\Renderer\Index.HTML`)).toBe(
      'c:/app/out/renderer/index.html'
    )
    expect(normalizeFsPath('C:/App/Out/Renderer/')).toBe('c:/app/out/renderer')
    // 未归一的话大小写差异会让合法入口被误拦
    expect(normalizeFsPath('C:/A/b') === normalizeFsPath('c:/a/B')).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('Windows 上大小写不同的同一入口仍放行', () => {
    const winEntry = resolve('C:/tmp/pi-desktop/out/renderer/index.html')
    const winAllowed = createNavigationAllowList({ rendererIndexPath: winEntry })
    const upper = pathToFileURL(winEntry.replace(/index\.html$/, 'INDEX.HTML')).href
    expect(isAllowedNavigationTarget(upper, winAllowed)).toBe(true)
  })

  it('will-navigate 用白名单拦聚：入口放行，系统 file:// 拦截', () => {
    const contents = createTestWindow().webContents
    const handler = contents.on.mock.calls.find((call) => call[0] === 'will-navigate')?.[1] as (
      event: { preventDefault: () => void },
      url: string
    ) => void

    // createMainWindow 以 TEST_ENTRY_PATH 作为入口
    const allowedEntry = pathToFileURL(TEST_ENTRY_PATH).href
    const allowedEvent = { preventDefault: vi.fn() }
    handler(allowedEvent, allowedEntry)
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled()

    const blockedEvent = { preventDefault: vi.fn() }
    handler(blockedEvent, 'file:///C:/Windows/System32/calc.exe')
    expect(blockedEvent.preventDefault).toHaveBeenCalled()
  })
})

describe('导航白名单：dev 模式只放行 dev server 来源', () => {
  const allowed = createNavigationAllowList({
    devServerUrl: 'http://localhost:5173/',
    rendererIndexPath: resolve('/tmp/pi-desktop/out/renderer/index.html')
  })

  it('同源 http 放行（含路径与 hash）', () => {
    expect(isAllowedNavigationTarget('http://localhost:5173/', allowed)).toBe(true)
    expect(isAllowedNavigationTarget('http://localhost:5173/app/main.tsx#x', allowed)).toBe(true)
  })

  it('其它端口、其它主机、file:// 一律拦截', () => {
    expect(isAllowedNavigationTarget('http://localhost:5174/', allowed)).toBe(false)
    expect(isAllowedNavigationTarget('http://evil.example/', allowed)).toBe(false)
    expect(isAllowedNavigationTarget('file:///C:/Windows/System32/calc.exe', allowed)).toBe(false)
  })
})
