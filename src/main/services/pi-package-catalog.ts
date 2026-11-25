import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

import type { PkgCatalogView, PkgKind, PkgSummary } from '../../shared/contracts/packages'

/**
 * 插件清单（A37 阶段 2a，只读）。
 *
 * 「插件」= **pi package**：在 `settings.json#packages` 里登记，可来自 npm / git / 本地路径。
 * 本服务只做两件事：
 * 1. 读 `<agentDir>/settings.json`（+ 可选 `<projectRoot>/.pi/settings.json`）里的登记项；
 * 2. 把登记项映射到 pi 的**受管目录**（`<agentDir>/npm/node_modules/**`、
 *    `<agentDir>/git/<host>/<path>`、本地路径），再读该目录里的 `package.json` 取
 *    name / version / description，并探测 extensions / skills / prompts / themes 是否存在。
 *
 * 三条边界：
 * - **只读**：绝不写 settings.json / package.json。
 * - **清单 ≠ 已加载**：`resources` 只表示「包目录里可能有这些资源」，不代表 pi 本会话真的加载成功
 *   （加载失败只出现在 pi 启动日志里）。因此契约里也没有任何写入字段。
 * - **容错到底**：settings 坏了降级为空清单 + 可读原因，不抛；单个包目录缺失也不报错。
 */

/** 资源目录名：固定顺序输出（UI 与断言都依赖这个顺序） */
const RESOURCE_NAMES = ['extensions', 'skills', 'prompts', 'themes'] as const
type ResourceName = (typeof RESOURCE_NAMES)[number]

const MAX_ERROR_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 512

/** scp 形式 git 地址：`git@github.com:user/repo`（`@` 是用户分隔符，不是 ref 分隔符） */
const GIT_SCP_PATTERN = /^[^/@]+@([^/:]+):(.+)$/

export interface PiPackageCatalogOptions {
  /** pi agent 目录；默认 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` */
  agentDir?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** 读文本文件，默认 fs（单测可注入） */
  readTextFile?: (path: string) => Promise<string>
  /** 判断目录是否存在，默认 fs.stat（单测可注入） */
  dirExists?: (path: string) => Promise<boolean>
  /** 判断文件是否存在（探测资源目录用），默认 fs.stat */
  fileExists?: (path: string) => Promise<boolean>
}

export interface PiPackageCatalog {
  /** pi 配置目录（UI 展示「受管位置」用） */
  agentDir: () => string
  /** `projectRoot` 缺省时只读全局清单 */
  list: (projectRoot?: string) => Promise<PkgCatalogView>
}

interface JsonObject {
  [key: string]: unknown
}

/** settings 里单条登记项解析后的形态 */
interface EntrySpec {
  source: string
  /** 是否带资源过滤规则（只表示「用户自定义过过滤」，不代表整包禁用） */
  filtered: boolean
  autoload?: boolean
}

/** source → 受管目录 / kind / 推导名 */
interface ResolvedSource {
  kind: PkgKind
  /** 受管目录绝对路径（`unknown` 时没有） */
  dir?: string
  /** 目录里没有可用 package.json 时的兜底名 */
  derivedName: string
  /** 无法解析 source 时的可读原因 */
  error?: string
}

interface SettingsReadResult {
  entries: unknown[]
  error?: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 单行化 + 截断：错误与描述只用于展示，不能撑爆 IPC */
function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * settings.json 里的 `packages` 元素：字符串，或
 * `{ source, extensions?, skills?, prompts?, themes?, autoload? }`。
 * 其它形态一律跳过（不产生条目，也不报错）。
 */
function parseEntry(raw: unknown): EntrySpec | undefined {
  if (typeof raw === 'string') {
    const source = raw.trim()
    return source.length === 0 ? undefined : { source, filtered: false }
  }
  if (!isObject(raw)) return undefined
  const source = asNonEmptyString(raw['source'])
  if (source === undefined) return undefined

  const filtered = RESOURCE_NAMES.some((name) => {
    const value = raw[name]
    return Array.isArray(value) && value.length > 0
  })

  const spec: EntrySpec = { source, filtered }
  // `autoload:false` 是 pi 语义里的「装上但默认不自动加载」；只有显式 false 才透出
  if (raw['autoload'] === false) spec.autoload = false
  return spec
}

/** 去掉 npm 源的版本后缀；`@scope/name` 开头的 `@` 不是版本分隔符 */
function stripNpmVersion(spec: string): string {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return spec
  return spec.slice(0, at)
}

/** git ref 在最后一个 `@` 之后；`git@github.com:...` 的 `@` 后面是 `host:path`，不能误切 */
function stripGitRef(spec: string): string {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return spec
  const ref = spec.slice(at + 1)
  if (ref.length === 0 || ref.includes(':')) return spec
  return spec.slice(0, at)
}

/** 去掉前导/结尾斜杠与结尾 `.git` */
function normalizeRepoPath(value: string): string {
  return value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
}

/** 从 `host/a/b` 或 `git@host:a/b` 里取 host 与仓库路径；取不到返回 undefined */
function splitHostPath(value: string): { host: string; path: string } | undefined {
  const scp = GIT_SCP_PATTERN.exec(value)
  if (scp !== null) {
    const host = scp[1]
    const path = normalizeRepoPath(scp[2] ?? '')
    if (host === undefined || host.length === 0 || path.length === 0) return undefined
    return { host, path }
  }
  const trimmed = normalizeRepoPath(value)
  const slash = trimmed.indexOf('/')
  if (slash <= 0) return undefined
  const host = trimmed.slice(0, slash)
  const path = normalizeRepoPath(trimmed.slice(slash + 1))
  if (host.length === 0 || path.length === 0) return undefined
  return { host, path }
}

/** source → kind / 受管目录 / 推导名（对齐 pi 的目录布局） */
function resolveSource(source: string, agentDir: string, home: string): ResolvedSource {
  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length).trim()
    const name = stripNpmVersion(spec)
    if (name.length === 0) {
      return { kind: 'unknown', derivedName: source, error: 'npm 源缺少包名' }
    }
    const segments = name.split('/').filter((segment) => segment.length > 0)
    return {
      kind: 'npm',
      // scoped 包要落到 `node_modules/@scope/name`
      dir: join(agentDir, 'npm', 'node_modules', ...segments),
      derivedName: name
    }
  }

  if (source.startsWith('git:')) {
    const spec = stripGitRef(source.slice('git:'.length).trim())
    const parsed = splitHostPath(spec)
    if (parsed === undefined) {
      return { kind: 'unknown', derivedName: source, error: 'git 源缺少主机名或仓库路径' }
    }
    return {
      kind: 'git',
      dir: join(agentDir, 'git', parsed.host, ...parsed.path.split('/')),
      derivedName: `${parsed.host}/${parsed.path}`
    }
  }

  if (/^https?:\/\//i.test(source)) {
    let url: URL
    try {
      url = new URL(source)
    } catch (error) {
      return {
        kind: 'unknown',
        derivedName: source,
        error: truncate(`URL 无法解析：${describe(error)}`, MAX_ERROR_LENGTH)
      }
    }
    // `#ref` 落在 url.hash 里，pathname 天然不含它
    const path = normalizeRepoPath(url.pathname)
    if (url.hostname.length === 0 || path.length === 0) {
      return { kind: 'unknown', derivedName: source, error: 'URL 缺少主机名或仓库路径' }
    }
    return {
      kind: 'git',
      dir: join(agentDir, 'git', url.hostname, ...path.split('/')),
      derivedName: `${url.hostname}/${path}`
    }
  }

  // 其余（相对路径 / `~` 开头 / 绝对路径 / `file:`）一律按本地目录处理，基准是 agentDir
  const dir = isAbsolute(source)
    ? source
    : source.startsWith('~')
      ? join(home, source.slice(1).replace(/^[\\/]+/, ''))
      : resolve(agentDir, source)
  return { kind: 'local', dir, derivedName: basename(dir).length > 0 ? basename(dir) : source }
}

async function defaultDirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function createPiPackageCatalog(options: PiPackageCatalogOptions = {}): PiPackageCatalog {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const agentDir = resolve(
    options.agentDir ?? asNonEmptyString(env['PI_CODING_AGENT_DIR']) ?? join(home, '.pi', 'agent')
  )

  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, 'utf8'))
  const dirExists = options.dirExists ?? defaultDirExists
  const fileExists = options.fileExists ?? defaultFileExists

  /**
   * 读 settings.json：不存在 = 正常（还没装插件）；读失败 / 非法 JSON = 降级为空清单 +
   * 可读原因。绝不抛 —— 清单读不出来不应该让整个面板挂掉（用户仍然可以安装）。
   */
  async function readSettings(path: string, label: string): Promise<SettingsReadResult> {
    let present: boolean
    try {
      present = await fileExists(path)
    } catch {
      present = false
    }
    if (!present) return { entries: [] }

    let text: string
    try {
      text = await readTextFile(path)
    } catch (error) {
      return {
        entries: [],
        error: truncate(`读取 ${label} 失败：${describe(error)}`, MAX_ERROR_LENGTH)
      }
    }
    if (text.trim().length === 0) return { entries: [] }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        entries: [],
        error: truncate(`解析 ${label} 失败：${describe(error)}`, MAX_ERROR_LENGTH)
      }
    }
    if (!isObject(parsed)) return { entries: [], error: `${label} 不是 JSON 对象` }

    // 显式标成 unknown：`Array.isArray` 对 unknown 收窄成 any[] 会触发 no-unsafe-assignment
    const rawPackages: unknown = parsed['packages']
    const entries: unknown[] = Array.isArray(rawPackages) ? rawPackages : []
    return { entries }
  }

  /** 探测资源：`<dir>/<name>` 目录 或 `<dir>/<name>.ts`，存在即计入（顺序固定） */
  async function probeResources(dir: string): Promise<ResourceName[]> {
    const found: ResourceName[] = []
    for (const name of RESOURCE_NAMES) {
      if (await dirExists(join(dir, name))) {
        found.push(name)
        continue
      }
      if (await fileExists(join(dir, `${name}.ts`))) found.push(name)
    }
    return found
  }

  async function buildSummary(spec: EntrySpec, scope: 'global' | 'project'): Promise<PkgSummary> {
    const resolved = resolveSource(spec.source, agentDir, home)
    const summary: PkgSummary = {
      source: spec.source,
      scope,
      kind: resolved.kind,
      name: resolved.derivedName.length > 0 ? resolved.derivedName : spec.source,
      filtered: spec.filtered,
      resources: []
    }
    if (spec.autoload !== undefined) summary.autoload = spec.autoload

    if (resolved.dir === undefined) {
      summary.manifestError = resolved.error ?? '无法解析该源的受管目录'
      return summary
    }

    const installed = await dirExists(resolved.dir)
    if (!installed) {
      // 为什么这里省略 installedPath 而不是报「未安装」：
      // settings 里的登记是用户意图，目录可能被手动删掉、或由别的 pi 版本/位置管理。
      // 断言「未安装」等于断言我们并不知道的事实，会误导用户去重装；只呈现
      // 「没在受管位置找到目录」这个事实 —— 条目本身照样保留，UI 自有降级展示。
      return summary
    }

    summary.installedPath = resolved.dir
    summary.resources = await probeResources(resolved.dir)

    let text: string
    try {
      text = await readTextFile(join(resolved.dir, 'package.json'))
    } catch (error) {
      summary.manifestError = truncate(
        `读取 package.json 失败：${describe(error)}`,
        MAX_ERROR_LENGTH
      )
      return summary
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      summary.manifestError = truncate(
        `解析 package.json 失败：${describe(error)}`,
        MAX_ERROR_LENGTH
      )
      return summary
    }
    if (!isObject(parsed)) {
      summary.manifestError = 'package.json 不是 JSON 对象'
      return summary
    }

    const name = asNonEmptyString(parsed['name'])
    if (name !== undefined) summary.name = name
    const version = asNonEmptyString(parsed['version'])
    if (version !== undefined) summary.version = version
    const description = asNonEmptyString(parsed['description'])
    if (description !== undefined) {
      summary.description = truncate(description, MAX_DESCRIPTION_LENGTH)
    }
    return summary
  }

  async function list(projectRoot?: string): Promise<PkgCatalogView> {
    const globalSettings = await readSettings(join(agentDir, 'settings.json'), 'settings.json')
    const packages: PkgSummary[] = []
    for (const raw of globalSettings.entries) {
      const spec = parseEntry(raw)
      if (spec === undefined) continue
      packages.push(await buildSummary(spec, 'global'))
    }

    const root =
      projectRoot !== undefined && projectRoot.trim().length > 0 ? projectRoot : undefined
    let projectSettingsError: string | undefined
    if (root !== undefined) {
      // `.pi/settings.json` 不存在不产生项目条目，也没有 error（很常见）
      const projectSettings = await readSettings(
        join(root, '.pi', 'settings.json'),
        '.pi/settings.json'
      )
      projectSettingsError = projectSettings.error
      for (const raw of projectSettings.entries) {
        const spec = parseEntry(raw)
        if (spec === undefined) continue
        packages.push(await buildSummary(spec, 'project'))
      }
    }

    // 按 name 升序（同名按 source，保证结果确定，便于 UI 与断言）
    packages.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))

    const view: PkgCatalogView = { packages, agentDir }
    if (globalSettings.error !== undefined) view.globalSettingsError = globalSettings.error
    if (projectSettingsError !== undefined) view.projectSettingsError = projectSettingsError
    if (root !== undefined) view.projectRoot = root
    return view
  }

  return { agentDir: () => agentDir, list }
}
