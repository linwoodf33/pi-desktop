/**
 * 图标渲染器（Electron 主进程，由 `scripts/build-icon.mjs` 调用）。
 *
 * 为什么用 Electron 而不是 playwright 的 chromium：项目只装了 `playwright-core`
 * （无浏览器二进制），而 Electron 本身就是 Chromium —— 复用它即可，不必再下载一套。
 *
 * 两个关键细节：
 * 1. **必须先关掉系统 DPI 缩放**（`--force-device-scale-factor=1`）。否则在 200% 缩放的
 *    机器上 `capturePage()` 返回的是物理像素（1024 的窗口产出 2048×2048），
 *    图标尺寸就错了。
 * 2. 只渲**一张母版**，其余档位用 `nativeImage.resize` 派生：比给每个尺寸单开一个窗口
 *    更稳（小窗口有时还没画完就截图），也更接近系统真实的缩放算法链。
 *
 * 入参（`--` 之后的 argv）：
 *   argv[2] = SVG 路径
 *   argv[3] = 输出目录
 *   argv[4] = 母版尺寸（如 1024）
 *   argv[5] = 派生尺寸列表（逗号分隔，可为空串）
 *   argv[6] = 派生文件名模板（含 `{size}`，如 `icon-{size}.png`）
 *
 * 产物：`<outDir>/icon.png`（母版，透明底）+ 可选的派生预览图。
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// 必须在 app ready 之前：把渲染侧的缩放比钉死为 1，capturePage 才等于逻辑尺寸
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const argv = process.argv.slice(process.argv.indexOf('--') + 1)
const [svgPath, outDir, masterArg, derivedArg, template] = argv

if (svgPath === undefined || outDir === undefined || masterArg === undefined) {
  console.error(
    '用法：electron scripts/icon-render.cjs -- <svg> <outDir> <master> [derived] [template]'
  )
  app.exit(2)
}

const master = Number.parseInt(masterArg, 10)
const derived = (derivedArg ?? '')
  .split(',')
  .map((item) => Number.parseInt(item.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0)
const nameTemplate = template ?? 'icon-{size}.png'

app.whenReady().then(async () => {
  try {
    mkdirSync(outDir, { recursive: true })

    const win = new BrowserWindow({
      width: master,
      height: master,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true
    })

    // 直接把 SVG 当文档加载（`<img src="data:...">` 那套在这台机器上解码失败，
    // 实测产出空白图）。独立 SVG 文档由 Chromium 自己按视口缩放，最稳。
    await win.loadURL(pathToFileURL(svgPath).href)
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    )

    // 自检：页面里必须真的有绘制内容（避免再次静默产出空白图标）
    const drawn = await win.webContents.executeJavaScript(
      "(() => { const svg = document.querySelector('svg'); return svg ? svg.getBoundingClientRect().width : 0 })()"
    )
    if (!(drawn > 0)) throw new Error('SVG 未渲染（页面里找不到有尺寸的 svg 元素）')

    const captured = await win.webContents.capturePage()
    const size = captured.getSize()
    if (size.width !== master || size.height !== master) {
      throw new Error(`截图尺寸异常：期望 ${master}×${master}，实际 ${size.width}×${size.height}`)
    }

    if (!process.argv.includes('--no-master')) {
      const masterPath = path.join(outDir, 'icon.png')
      writeFileSync(masterPath, captured.toPNG())
      console.log(`母版 ${master}×${master} → ${masterPath}`)
    }

    for (const target of derived) {
      const resized = nativeImage.createFromBuffer(captured.toPNG()).resize({
        width: target,
        height: target,
        quality: 'best'
      })
      const out = path.join(outDir, nameTemplate.replace('{size}', String(target)))
      writeFileSync(out, resized.toPNG())
      console.log(`派生 ${target}×${target} → ${out}`)
    }

    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error('渲染失败：', error)
    app.exit(1)
  }
})
