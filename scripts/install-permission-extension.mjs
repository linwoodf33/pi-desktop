#!/usr/bin/env node
/**
 * 安装 / 卸载 pi-desktop 审批扩展（M5）。
 *
 * 用法：
 *   node scripts/install-permission-extension.mjs                 # 装到 ~/.pi/agent/extensions（全局）
 *   node scripts/install-permission-extension.mjs --project       # 装到 <cwd>/.pi/extensions（项目本地）
 *   node scripts/install-permission-extension.mjs --target <dir>  # 指定扩展根目录
 *   node scripts/install-permission-extension.mjs --status        # 只打印当前状态
 *   node scripts/install-permission-extension.mjs --uninstall     # 卸载（只删本客户端装的）
 *
 * pi 的扩展发现规则（docs/extensions.md#extension-locations）：
 *   ~/.pi/agent/extensions/<name>/index.ts   → 全局
 *   .pi/extensions/<name>/index.ts           → 项目本地（项目被信任后加载）
 * 因此安装目标是 `<扩展根目录>/pi-desktop-permission/index.ts`。
 *
 * 幂等与安全：
 * - 重复执行不会产生差别：内容相同的文件不重写，标记文件按内容比对；
 * - 目标目录已存在但**不是**本客户端安装的（没有标记文件 / 标记不匹配）→ 报错退出，
 *   绝不覆盖用户自己的同名扩展；
 * - `--uninstall` 同样只删带正确标记的目录；
 * - 目标路径必须落在用户主目录或当前工作目录之内，否则拒绝。
 *
 * 退出码：0 成功/无需改动；2 参数错误；3 冲突（已存在他人扩展）；4 路径校验失败；5 IO 失败。
 *
 * 注：本脚本显式从 `node:process` 取 `process`/`stdout`/`stderr`，不依赖任何环境全局，
 * 这样 eslint 无论用哪套 globals 解析都能通过（脚本本身是独立 CLI，不属于任何 tsconfig 项目）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process, { stdout, stderr } from 'node:process'
import { fileURLToPath } from 'node:url'

export const EXTENSION_DIR_NAME = 'pi-desktop-permission'
/** 标记文件：只有带正确标记的目录才被视为「本客户端安装的」 */
export const MARKER_FILE = 'pi-desktop-permission.json'
export const MANAGED_BY = 'pi-desktop'

/** 需要复制的源文件（相对 src/extensions/permission/） */
export const SOURCE_FILES = ['index.ts', 'protocol.ts', 'types.ts']

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')
export const SOURCE_DIR = join(REPO_ROOT, 'src', 'extensions', 'permission')

/** 从 protocol.ts 里读扩展版本（单一来源，避免脚本里再写一遍版本号） */
export function readExtensionVersion(sourceDir = SOURCE_DIR) {
  const text = readFileSync(join(sourceDir, 'protocol.ts'), 'utf8')
  const match = /export const EXTENSION_VERSION = '([^']+)'/.exec(text)
  if (!match?.[1]) throw new Error('无法从 protocol.ts 读取 EXTENSION_VERSION')
  return match[1]
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class PathError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PathError'
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConflictError'
  }
}

/**
 * 目标路径校验：绝对化 → 必须在主目录或 cwd 之内 → 不能是已存在的普通文件。
 * `..` 逃逸在 resolve 之后由「是否落在允许根内」统一拦掉。
 */
export function resolveTargetDir(options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const raw = options.target ?? join(home, '.pi', 'agent', 'extensions')
  const resolved = resolve(cwd, raw)
  if (!isAbsolute(resolved)) throw new PathError(`目标路径必须是绝对路径：${raw}`)

  const roots = [resolve(home), resolve(cwd)]
  const inside = roots.some((root) => {
    const rel = relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`))
  })
  if (!inside) {
    throw new PathError(
      `目标路径必须位于用户主目录（${resolve(home)}）或当前工作目录（${resolve(cwd)}）之内，收到：${resolved}`
    )
  }
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new PathError(`目标路径已存在且不是目录：${resolved}`)
  }
  return resolved
}

/** 读取标记文件；不存在或不可解析返回 undefined */
export function readMarker(dir) {
  const file = join(dir, MARKER_FILE)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function isManagedByUs(dir) {
  const marker = readMarker(dir)
  return marker !== undefined && marker.managedBy === MANAGED_BY
}

/**
 * 安装（幂等）。
 * @returns {{ status: 'installed'|'updated'|'unchanged', dir: string, version: string, written: string[] }}
 */
export function install(options = {}) {
  const sourceDir = options.sourceDir ?? SOURCE_DIR
  const targetRoot = resolveTargetDir(options)
  const dir = join(targetRoot, EXTENSION_DIR_NAME)
  const version = readExtensionVersion(sourceDir)

  if (existsSync(dir) && !isManagedByUs(dir)) {
    throw new ConflictError(
      `目标已存在同名扩展且不是本客户端安装的，已中止（不覆盖用户扩展）：${dir}\n` +
        '如确认要替换，请先手动移走该目录。'
    )
  }

  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true })

  const written = []
  const files = {}
  for (const name of SOURCE_FILES) {
    const source = join(sourceDir, name)
    if (!existsSync(source)) throw new Error(`源文件缺失：${source}`)
    const content = readFileSync(source, 'utf8')
    const target = join(dir, name)
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined
    if (existing !== content) {
      writeFileSync(target, content, 'utf8')
      written.push(name)
    }
    files[name] = sha256(content)
  }

  const markerText = `${JSON.stringify({ managedBy: MANAGED_BY, extension: EXTENSION_DIR_NAME, version, files }, null, 2)}\n`
  const markerPath = join(dir, MARKER_FILE)
  const existingMarker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : undefined
  if (existingMarker !== markerText) {
    writeFileSync(markerPath, markerText, 'utf8')
    written.push(MARKER_FILE)
  }

  return {
    status: !existed ? 'installed' : written.length > 0 ? 'updated' : 'unchanged',
    dir,
    version,
    written
  }
}

/**
 * 卸载（幂等）：只删带正确标记的目录。
 * @returns {{ status: 'removed'|'absent', dir: string }}
 */
export function uninstall(options = {}) {
  const targetRoot = resolveTargetDir(options)
  const dir = join(targetRoot, EXTENSION_DIR_NAME)
  if (!existsSync(dir)) return { status: 'absent', dir }
  if (!isManagedByUs(dir)) {
    throw new ConflictError(
      `目标目录不是本客户端安装的扩展，拒绝删除：${dir}\n如确认要删除，请手动处理。`
    )
  }
  rmSync(dir, { recursive: true, force: true })
  return { status: 'removed', dir }
}

/** 只读状态：是否已安装、版本、源与已装文件是否一致 */
export function status(options = {}) {
  const sourceDir = options.sourceDir ?? SOURCE_DIR
  const targetRoot = resolveTargetDir(options)
  const dir = join(targetRoot, EXTENSION_DIR_NAME)
  const installed = existsSync(dir) && isManagedByUs(dir)
  const sourceVersion = readExtensionVersion(sourceDir)
  const marker = installed ? readMarker(dir) : undefined

  let upToDate = false
  if (installed) {
    upToDate = SOURCE_FILES.every((name) => {
      const target = join(dir, name)
      if (!existsSync(target)) return false
      return readFileSync(target, 'utf8') === readFileSync(join(sourceDir, name), 'utf8')
    })
  }

  return {
    dir,
    installed,
    ...(marker === undefined || marker.version === undefined
      ? {}
      : { installedVersion: String(marker.version) }),
    sourceVersion,
    upToDate
  }
}

export function parseArgs(argv) {
  const options = { command: 'install', target: undefined, project: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--uninstall') options.command = 'uninstall'
    else if (arg === '--status') options.command = 'status'
    else if (arg === '--project') options.project = true
    else if (arg === '--help' || arg === '-h') options.command = 'help'
    else if (arg === '--target') {
      index += 1
      const value = argv[index]
      if (value === undefined) throw new Error('--target 需要一个目录参数')
      options.target = value
    } else if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

const write = (line) => stdout.write(`${line}\n`)
const writeError = (line) => stderr.write(`${line}\n`)

export function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    writeError(`参数错误：${error.message}`)
    return 2
  }

  if (options.command === 'help') {
    write(
      [
        '安装 / 卸载 pi-desktop 审批扩展',
        '',
        '  node scripts/install-permission-extension.mjs               安装到 ~/.pi/agent/extensions',
        '  node scripts/install-permission-extension.mjs --project     安装到 ./.pi/extensions',
        '  node scripts/install-permission-extension.mjs --target <d>  安装到自定义扩展根目录',
        '  node scripts/install-permission-extension.mjs --status      打印当前状态',
        '  node scripts/install-permission-extension.mjs --uninstall   卸载（只删本客户端安装的）'
      ].join('\n')
    )
    return 0
  }

  const target =
    options.target ?? (options.project ? join(process.cwd(), '.pi', 'extensions') : undefined)
  const common = target === undefined ? {} : { target }

  try {
    if (options.command === 'uninstall') {
      const result = uninstall(common)
      write(
        result.status === 'removed' ? `已卸载：${result.dir}` : `未安装（无需卸载）：${result.dir}`
      )
      return 0
    }

    if (options.command === 'status') {
      const result = status(common)
      write(
        result.installed
          ? `已安装：${result.dir}\n  版本：${result.installedVersion ?? '?'}（源 ${result.sourceVersion}）\n  与源一致：${result.upToDate ? '是' : '否（可重新执行安装）'}`
          : `未安装：${result.dir}\n  源版本：${result.sourceVersion}`
      )
      return 0
    }

    const result = install(common)
    const messages = {
      installed: `已安装 pi-desktop-permission v${result.version}`,
      updated: `已更新 pi-desktop-permission v${result.version}`,
      unchanged: `已是最新（无需改动）pi-desktop-permission v${result.version}`
    }
    write(`${messages[result.status]}：${result.dir}`)
    if (result.written.length > 0) write(`  写入：${result.written.join(', ')}`)
    return 0
  } catch (error) {
    if (error instanceof ConflictError) {
      writeError(`冲突：${error.message}`)
      return 3
    }
    if (error instanceof PathError) {
      writeError(`路径校验失败：${error.message}`)
      return 4
    }
    writeError(`安装失败：${error.message}`)
    return 5
  }
}

// 只在作为脚本直接运行时执行 main（被单测 import 时不执行）
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
