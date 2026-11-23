/**
 * 生成应用图标 PNG（可复现，不引入图像库依赖）。
 *
 * 实现：`resources/icon.svg` 是唯一真源；本脚本用 Electron（项目已有的 Chromium）
 * 渲出 `resources/icon.png`（默认 1024×1024，透明底），electron-builder 再据此
 * 自动生成 Windows `.ico`（`win.icon` 指向该 PNG，要求 ≥256×256）。
 *
 * 用法：
 *   node scripts/build-icon.mjs             # 只生成 resources/icon.png
 *   node scripts/build-icon.mjs --preview   # 额外派生 16/24/32/48/64/128/256 预览到 docs/screenshots/
 *
 * 依赖 Electron 可执行文件（`node_modules/electron`，与 E2E 同一份）。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const SVG_PATH = join(ROOT, 'resources', 'icon.svg')
const RESOURCES_DIR = join(ROOT, 'resources')
const PREVIEW_DIR = join(ROOT, 'docs', 'screenshots')
const RENDERER = join(ROOT, 'scripts', 'icon-render.cjs')

/** Windows 会缩放到 16/24/32/48/64/128/256，1024 覆盖全部档位且留足余量 */
const MASTER = 1024
const PREVIEW_SIZES = [16, 24, 32, 48, 64, 128, 256]

/** electron 的可执行文件路径（用模块导出的路径，不依赖 PATH） */
async function electronBinary() {
  const mod = await import('electron')
  const electronPath = mod.default
  if (typeof electronPath !== 'string' || electronPath.length === 0) {
    throw new Error('无法定位 Electron 可执行文件（node_modules/electron）')
  }
  return electronPath
}

function render(exe, outDir, derived, template, writeMaster = true) {
  const args = [RENDERER, '--', SVG_PATH, outDir, String(MASTER), derived.join(','), template]
  if (!writeMaster) args.push('--no-master')
  const result = spawnSync(exe, args, { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(result.stdout ?? '')
  if (result.status !== 0) {
    throw new Error(
      `图标渲染失败（exit ${String(result.status)}）：${result.stderr || result.stdout}`
    )
  }
}

const svg = await readFile(SVG_PATH, 'utf8')
if (!svg.includes('<svg')) throw new Error('resources/icon.svg 看起来不是有效 SVG')

const exe = await electronBinary()
await mkdir(RESOURCES_DIR, { recursive: true })
render(exe, RESOURCES_DIR, [], 'icon.png')
console.log(`已生成 ${resolve(RESOURCES_DIR, 'icon.png')}`)

if (process.argv.includes('--preview')) {
  await mkdir(PREVIEW_DIR, { recursive: true })
  render(exe, PREVIEW_DIR, PREVIEW_SIZES, 'icon-{size}.png', false)
  console.log(`已派生预览图到 ${PREVIEW_DIR}`)
}
