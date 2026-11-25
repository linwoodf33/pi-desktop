import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'

import type {
  PkgInstallEvent,
  PkgInstallResult,
  PkgKind,
  PkgPreview
} from '../../shared/contracts/packages'
import type { PiLaunchSpec } from '../transport/types'

import type { RequestJsonOptions, SpawnHandle } from './pi-update'
import { defaultSpawnPi, redactLine, stripAnsi } from './pi-update'

/**
 * 插件安装器（A37 阶段 2b）：`preview`（只读 registry 预览）+ `install`（执行 `pi install`）。
 *
 * 这是**安全关键**服务：安装一个插件 = clone 第三方代码并让 pi 在下次启动时执行它的扩展。
 * 因此这里的边界比 `pi-update` 更硬：
 *
 * 1. **source 是唯一输入，且只走参数数组**：argv 恒为 `['install', source]`，绝不拼接字符串、
 *    绝不追加 `-l` / `-a` / `--force` 之类的开关（那是 CLI 的语义，不是 UI 该猜的）。
 * 2. **只收三类形状**：`npm:<包名>[@版本]`、`git:<4 个已知 host>/<owner>/<repo>[@ref]`、
 *    `https://<同一批 host>/<owner>/<repo>[.git][#ref]`。
 *    本地路径 / `ssh://` / `git@host:path` / `file:` / 盘符 / `~` 一律拒绝 —— 这些源的
 *    "身份"取决于当前工作目录或 SSH 配置，主进程没法可靠校验，用户自己开终端执行更安全。
 * 3. **exit 0 不等于装好**：`pi install` 的退出码只说明它自己跑完了。是否真的登记成功，
 *    只能靠复验 `<agentDir>/settings.json` 里出现了这条声明；这也是唯一能回答
 *    "到底装上没有"的证据。
 *
 * 分层与 `pi-update` 保持一致：纯函数（校验 / 解析 / 身份归一）→ 默认实现（node:https、
 * spawn）→ 服务本体（单飞、流式日志、超时/取消、终态）。
 */

/** source 上限（与 `pkgPreviewInputSchema` 的 512 对齐） */
const MAX_SOURCE_LENGTH = 512

/** npm 源：`npm:` + 可选 scope + 包名 + 可选版本片段 */
const NPM_SOURCE_RE =
  /^npm:(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:@[A-Za-z0-9._^~<>=*+-]{1,64})?$/

/** git 简写源：`git:<已知 host>/<owner>/<repo>[@ref]` */
const GIT_SHORTHAND_RE =
  /^git:(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}(?:@[A-Za-z0-9._/-]{1,128})?$/

/** 已知的代码托管域名（预览/安装都不允许把主进程变成任意 URL 的请求器） */
const ALLOWED_GIT_HOSTS: readonly string[] = [
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org'
]

/** https 源必须是 `<owner>/<repo>` 两段（可带 `.git`），不允许更深路径或根路径 */
const HTTPS_PATH_RE = /^\/[^/]+\/[^/]+(?:\.git)?$/
/** `#ref` 允许的字符 */
const GIT_REF_RE = /^[A-Za-z0-9._/-]{1,128}$/
/** 控制字符（含换行/制表/ESC） */
/** 控制字符（含换行/制表/ESC）。用码点构造，避免 lint 对字面控制字符的误报。 */
const CONTROL_CHAR_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`
)
/**
 * 一律拒绝的字符：任何一个都能在某个层面的字符串拼接里改变语义
 * （空白分词、`;`/`|`/`&` 串命令、`$`/反引号展开、`<>` 重定向、引号破坏参数边界、`*`/`?` 通配）。
 * 我们的 argv 是数组、`shell:false`，理论上用不到这些字符；正因如此，出现它们就是
 * "这个 source 不像正常包名/URL"，直接拒绝比逐个证明无害更可靠。
 */
const FORBIDDEN_CHARS: readonly string[] = [
  ' ',
  ';',
  '|',
  '&',
  '$',
  '`',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '*',
  '?',
  '!',
  '"',
  "'"
]

/** 预览探针的超时与体积上限（registry 元数据是个小 JSON，不是下载） */
const PREVIEW_TIMEOUT_MS = 8_000
const PREVIEW_MAX_BYTES = 1024 * 1024
/** registry 重定向最多 2 跳，且每一跳都要重新过 host 校验 */
const PREVIEW_MAX_REDIRECTS = 2

/** 整个 `pi install` 的总预算 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 取消宽限期：SIGTERM → 2s → SIGKILL */
const CANCEL_GRACE_MS = 2_000

/** 单行日志上限 / 日志尾部上限（与 A34 一致，便于复用同一个日志组件） */
const MAX_LOG_LINE = 2_000
const LOG_TAIL_LIMIT = 32 * 1024

/** 错误 / 描述类文案上限 */
const MAX_ERROR_LENGTH = 300
const MAX_DESCRIPTION_LENGTH = 1024

/** scp 形式 git 地址：`git@github.com:user/repo`（`@` 是用户分隔符，不是 ref 分隔符） */
const GIT_SCP_PATTERN = /^[^/@]+@([^/:]+):(.+)$/

/* ------------------------------------------------------------------ *
 * 纯函数：source 校验与分类（安全边界）
 * ------------------------------------------------------------------ */

export type PackageSourceDecision =
  | { ok: true; source: string; kind: PkgKind; npmName?: string; npmVersion?: string }
  | { ok: false; reason: string }

/**
 * `..` 路径段检测（同时认 `/` 与 `\`）。
 *
 * 为什么必须单独查：仔细看形状正则就知道，`git:github.com/../..` 里 `..` 能匹配
 * `[A-Za-z0-9._-]{1,100}`。字符串层面它"合法"，但一旦参与目录解析就会跳出受管目录。
 */
function hasParentSegment(value: string): boolean {
  return value.split(/[/\\]/).some((segment) => segment === '..')
}

/**
 * 校验并分类 source —— **唯一入口**。
 *
 * 约定：返回值里的 `source` 与入参**逐字符相同**（否则拒绝）。下游只允许使用
 * 返回值里的 `source` 去 spawn，不得再对原始字符串做任何处理。
 */
export function validatePackageSource(raw: string): PackageSourceDecision {
  // ① 长度
  if (raw.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: `源过长（上限 ${String(MAX_SOURCE_LENGTH)} 字符）` }
  }

  // ② trim 后必须逐字符相等。
  //
  // 为什么这么严：经典的绕过方式是「校验 A、执行 B」。只要放行 `" npm:foo"` 这种
  // 前后带空白的字符串，后面任何一次 trim / 规范化都可能让真正交给 spawn 的字符串
  // 与这里校验过的不是同一个对象意义上的字符串；而 argv 数组里一个前导空格就足以
  // 让 CLI 看到完全不同的包名。直接拒绝，成本为零，收益是整类问题消失。
  const source = raw.trim()
  if (source.length === 0) return { ok: false, reason: '源不能为空' }
  if (source !== raw) {
    return { ok: false, reason: '源首尾不能包含空白字符（校验与执行必须是同一个字符串）' }
  }

  // ③ 控制字符 + 元字符
  if (CONTROL_CHAR_RE.test(source)) {
    const index = source.search(CONTROL_CHAR_RE)
    return { ok: false, reason: `源含控制字符（位置 ${String(index)}）` }
  }
  for (const char of FORBIDDEN_CHARS) {
    if (source.includes(char)) {
      return { ok: false, reason: `源含不允许的字符「${char}」` }
    }
  }

  // ④ 以 `-` 开头：防止把 `--force` / `-a` 之类伪装成"源"传给 CLI
  if (source.startsWith('-')) {
    return { ok: false, reason: '源不能以 - 开头（不允许把 CLI 开关当作源传入）' }
  }

  // ⑤ 路径穿越段
  if (hasParentSegment(source)) {
    return { ok: false, reason: '源不能包含 .. 路径段' }
  }

  // ⑥ npm 源
  if (source.startsWith('npm:')) {
    if (!NPM_SOURCE_RE.test(source)) {
      return { ok: false, reason: 'npm 源格式不正确（应为 npm:<包名>[@版本]，可用 @scope/name）' }
    }
    // 注意：版本片段里的 `*` 会先被 ③ 的字符检查拒掉 —— 这是刻意的，通配符不该进安装参数。
    const spec = source.slice('npm:'.length)
    const at = spec.lastIndexOf('@')
    const npmName = at > 0 ? spec.slice(0, at) : spec
    if (at > 0) {
      const npmVersion = spec.slice(at + 1)
      return { ok: true, source, kind: 'npm', npmName, npmVersion }
    }
    return { ok: true, source, kind: 'npm', npmName }
  }

  // ⑦ git 简写（host 白名单写死在正则里）
  if (source.startsWith('git:')) {
    if (!GIT_SHORTHAND_RE.test(source)) {
      return {
        ok: false,
        reason:
          'git 源格式不正确（应为 git:github.com/<owner>/<repo>[@ref]，仅支持 ' +
          `${ALLOWED_GIT_HOSTS.join(' / ')}）`
      }
    }
    return { ok: true, source, kind: 'git' }
  }

  // ⑧ 带 scheme 的 URL：只接受 https，且形状必须规整
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
    let url: URL
    try {
      url = new URL(source)
    } catch {
      return { ok: false, reason: 'URL 无法解析' }
    }
    if (url.protocol !== 'https:') {
      return {
        ok: false,
        reason: `只支持 https 源（收到 ${url.protocol}）；该形式请到终端执行：pi install <source>`
      }
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, reason: '源不能包含用户名或密码（凭据不得进入日志与进程参数）' }
    }
    if (url.port !== '') {
      return { ok: false, reason: '源不能指定端口' }
    }
    if (url.search !== '') {
      return { ok: false, reason: '源不能带查询参数' }
    }
    // ⑦ IP 字面量：即使是 https，也不要让主进程去请求任意 IP（内网探测面）
    if (isIP(url.hostname) !== 0) {
      return { ok: false, reason: '源主机不能是 IP 字面量' }
    }
    if (!ALLOWED_GIT_HOSTS.includes(url.hostname)) {
      return {
        ok: false,
        reason: `仅支持 ${ALLOWED_GIT_HOSTS.join(' / ')} 的 https 源；其它地址请到终端执行：pi install <source>`
      }
    }
    if (!HTTPS_PATH_RE.test(url.pathname)) {
      return { ok: false, reason: 'https 源必须是 <host>/<owner>/<repo>[.git] 形式' }
    }
    // `#ref` 落在 url.hash 里（pathname 天然不含它）
    const ref = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    if (ref.length > 0 && !GIT_REF_RE.test(ref)) {
      return { ok: false, reason: '源里的 #ref 含不允许的字符' }
    }
    return { ok: true, source, kind: 'git' }
  }

  // ⑨ 其余（相对/绝对路径、`~`、盘符、`file:`、`git@host:path`）一律拒绝。
  //
  // 为什么前提就是"拒绝本地与 ssh 源"：这两类源的"装什么"取决于运行上下文
  // （cwd、`~` 展开、SSH 配置、known_hosts），主进程无法在不执行的前提下确定它指向哪里，
  // 也就无法给出任何有意义的确认提示。把它们留给用户自己的终端，是唯一诚实的做法。
  return {
    ok: false,
    reason:
      '仅支持 npm:<包名>、git:<host>/<owner>/<repo> 与 https://<host>/<owner>/<repo> 三类源；' +
      '本地路径 / ssh:// / git@ 形式请到终端执行：pi install <source>'
  }
}

/* ------------------------------------------------------------------ *
 * 纯函数：source 身份归一（用于 settings.json 复验 / 受管目录定位）
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
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

/** 按字符数截断（日志行不做空白折叠，保留缩进便于看懂 npm 输出） */
function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
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

/**
 * source → 归一身份。
 *
 * 为什么需要"身份"而不是字符串相等：pi 写进 settings.json 的字符串可能与用户输入不完全
 * 一样（比如补上解析后的版本号、把 git 简写展开成 https）。我们关心的是"同一个包/仓库"：
 * - npm 只比包名（去掉版本）；
 * - git 简写与 https 都归一成 `git:<host>/<path>`（去掉 ref / `.git` / 前导斜杠）。
 */
function sourceIdentity(source: string): string | undefined {
  if (source.startsWith('npm:')) {
    const spec = source.slice('npm:'.length).trim()
    if (spec.length === 0) return undefined
    return `npm:${stripNpmVersion(spec)}`
  }
  if (source.startsWith('git:')) {
    const parsed = splitHostPath(stripGitRef(source.slice('git:'.length).trim()))
    return parsed === undefined ? undefined : `git:${parsed.host}/${parsed.path}`
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source)
      const path = normalizeRepoPath(url.pathname)
      if (url.hostname.length === 0 || path.length === 0) return undefined
      return `git:${url.hostname}/${path}`
    } catch {
      return undefined
    }
  }
  // 本地源在本服务里已被 validate 拒绝；这里保留一个稳定形态以便将来放宽时复用
  const local = source.replace(/[\\/]+$/, '')
  return local.length === 0 ? undefined : `local:${local}`
}

/**
 * source → pi 的受管目录（**与 `pi-package-catalog` 同一规则**的独立最小实现）。
 *
 * 为什么不 import catalog 里的函数：那是 catalog 的私有细节，安装器若跟着它一起变，
 * 会让"清单说装在这、安装器读到那"这种错位难以发现；两边各自独立但同规则，反而更容易
 * 在测试里钉住（也避免把只读模块的 imports 拖进执行路径）。
 */
function managedDir(source: string, kind: PkgKind, agentDir: string): string | undefined {
  if (kind === 'npm') {
    const name = stripNpmVersion(source.slice('npm:'.length))
    const segments = name.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) return undefined
    // scoped 包落在 `node_modules/@scope/name`
    return join(agentDir, 'npm', 'node_modules', ...segments)
  }
  if (source.startsWith('git:')) {
    const parsed = splitHostPath(stripGitRef(source.slice('git:'.length)))
    if (parsed === undefined) return undefined
    return join(agentDir, 'git', parsed.host, ...parsed.path.split('/'))
  }
  if (/^https:\/\//i.test(source)) {
    try {
      const url = new URL(source)
      const path = normalizeRepoPath(url.pathname)
      if (url.hostname.length === 0 || path.length === 0) return undefined
      return join(agentDir, 'git', url.hostname, ...path.split('/'))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** settings.json 里的单条登记项 → source 字符串（字符串形态或 `{ source }` 对象） */
function entrySourceOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (!isObject(entry)) return undefined
  return asNonEmptyString(entry['source'])
}

/* ------------------------------------------------------------------ *
 * 默认实现：npm registry 预览请求（node:https，不是 fetch）
 * ------------------------------------------------------------------ */

interface RegistryBase {
  base: URL
  /** 只有测试用的本机 registry 才允许 http */
  allowLocalHttp: boolean
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

/**
 * registry 基址：默认官方源；`PI_DESKTOP_NPM_REGISTRY_URL` 只有在 **host 是本机**
 * 时才生效（否则覆盖地址就是一条通往任意 http 源的旁路）。
 */
function resolveRegistryBase(env: NodeJS.ProcessEnv): RegistryBase {
  const raw = (env['PI_DESKTOP_NPM_REGISTRY_URL'] ?? '').trim()
  if (raw.length > 0) {
    try {
      const url = new URL(raw)
      if (isLoopbackHost(url.hostname)) return { base: url, allowLocalHttp: true }
    } catch {
      /* 覆盖地址非法：回落到官方源（测试开关坏了不该让预览直接崩） */
    }
  }
  return { base: new URL('https://registry.npmjs.org'), allowLocalHttp: false }
}

/** scoped 包要编码成 `@scope%2fname`（registry 用 `%2f` 当路径分隔符） */
function packageMetadataUrl(registry: RegistryBase, npmName: string): URL {
  const encoded = npmName.startsWith('@') ? npmName.replace('/', '%2f') : npmName
  const basePath = registry.base.pathname.replace(/\/+$/, '')
  // 用 origin + 手工路径，避免 `new URL('/x', base)` 把 base 的路径前缀丢掉
  return new URL(`${registry.base.origin}${basePath}/${encoded}`)
}

/**
 * 默认 JSON GET（`node:https`）。
 *
 * 与 A34 的 `defaultRequestJson` 同构但**独立**：这里允许的是"registry 基址"，不是
 * 单一固定端点；因此每一跳都重新校验 `protocol` 与 `host`（必须仍是 registry host），
 * 重定向最多 2 跳，超限立刻 `destroy()`。
 */
function createDefaultRequestJson(
  env: NodeJS.ProcessEnv
): (url: URL, opts: RequestJsonOptions) => Promise<unknown> {
  return (url, opts) => {
    const registry = resolveRegistryBase(env)

    const rejection = (target: URL): string | undefined => {
      const isHttps = target.protocol === 'https:'
      const isLocalHttp =
        target.protocol === 'http:' && registry.allowLocalHttp && isLoopbackHost(target.hostname)
      if (!isHttps && !isLocalHttp) {
        return `只允许 https registry（收到 ${target.protocol}）`
      }
      if (target.host !== registry.base.host) {
        return `只允许请求 registry 主机 ${registry.base.host}`
      }
      return undefined
    }

    const once = (target: URL, redirectLeft: number): Promise<unknown> =>
      new Promise<unknown>((resolve, reject) => {
        const denied = rejection(target)
        if (denied !== undefined) {
          reject(new Error(`拒绝请求：${denied}`))
          return
        }

        let settled = false
        const fail = (error: Error): void => {
          if (settled) return
          settled = true
          reject(error)
        }
        const succeed = (value: unknown): void => {
          if (settled) return
          settled = true
          resolve(value)
        }

        const client = target.protocol === 'https:' ? httpsRequest : httpRequest
        const req = client(
          target,
          { method: 'GET', headers: { accept: 'application/json' } },
          (response) => {
            const status = response.statusCode ?? 0

            if (status >= 300 && status < 400 && response.headers.location !== undefined) {
              response.resume()
              if (redirectLeft <= 0) {
                fail(new Error('重定向次数过多'))
                return
              }
              let next: URL
              try {
                next = new URL(response.headers.location, target)
              } catch {
                fail(new Error('重定向地址无效'))
                return
              }
              // 每一跳重新校验协议与 host
              const hopDenied = rejection(next)
              if (hopDenied !== undefined) {
                fail(new Error(`重定向被拒绝：${hopDenied}`))
                return
              }
              void once(next, redirectLeft - 1).then(succeed, fail)
              return
            }

            if (status < 200 || status >= 300) {
              response.resume()
              fail(new Error(`HTTP ${String(status)}`))
              return
            }

            const chunks: Buffer[] = []
            let total = 0
            response.on('data', (chunk: Buffer) => {
              if (settled) return
              total += chunk.length
              if (total > opts.maxBytes) {
                req.destroy()
                fail(new Error(`响应超过 ${String(opts.maxBytes)} B`))
                return
              }
              chunks.push(chunk)
            })
            response.on('end', () => {
              if (settled) return
              let parsed: unknown
              try {
                parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
              } catch {
                fail(new Error('响应不是合法 JSON'))
                return
              }
              succeed(parsed)
            })
            response.on('error', (error: Error) => {
              fail(error)
            })
          }
        )

        req.setTimeout(Math.max(1_000, opts.timeoutMs), () => {
          req.destroy()
          fail(new Error(`请求超时（${String(opts.timeoutMs)}ms）`))
        })
        req.on('error', (error: Error) => {
          fail(error)
        })
        req.end()
      })

    return once(url, PREVIEW_MAX_REDIRECTS)
  }
}

interface NpmMetadata {
  name?: string
  version?: string
  description?: string
  repository?: string
}

/** `git+https://…/x.git` → `https://…/x` */
function cleanRepository(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/^git\+/i, '')
    .replace(/\.git$/i, '')
  return trimmed.length > 0 ? trimmed : undefined
}

/** 只取我们真正会展示的四个字段；`dist-tags.latest` 决定"默认装哪个版本" */
function parseNpmMetadata(payload: unknown): NpmMetadata | undefined {
  if (!isObject(payload)) return undefined

  const distTags = payload['dist-tags']
  let version: string | undefined
  if (isObject(distTags)) version = asNonEmptyString(distTags['latest'])

  const name = asNonEmptyString(payload['name'])
  const description = asNonEmptyString(payload['description'])

  let repository: string | undefined
  const rawRepo = payload['repository']
  if (typeof rawRepo === 'string') {
    repository = cleanRepository(rawRepo)
  } else if (isObject(rawRepo)) {
    const rawUrl = rawRepo['url']
    if (typeof rawUrl === 'string') repository = cleanRepository(rawUrl)
  }

  const meta: NpmMetadata = {}
  if (name !== undefined) meta.name = name
  if (version !== undefined) meta.version = version
  if (description !== undefined) meta.description = description
  if (repository !== undefined) meta.repository = repository
  return meta
}

/* ------------------------------------------------------------------ *
 * 依赖契约
 * ------------------------------------------------------------------ */

export interface PiPackageInstallerDeps {
  locatePi(): Promise<{ command: string; version?: string } | undefined>
  launchPi(): Promise<PiLaunchSpec | undefined>
  /** 默认 `defaultSpawnPi`；单测注入 fake */
  spawnPi?: (spec: PiLaunchSpec, argv: string[]) => SpawnHandle
  /** 默认按 agentDir 读 settings.json / package.json；单测注入 */
  readTextFile?: (path: string) => Promise<string>
  /** 当前 agentDir（用于复验 settings 与落盘版本） */
  agentDir(): string
  /** 推送安装事件 */
  emit(event: PkgInstallEvent): void
  /** 与 A34 更新互斥（handler 也可判，这里再判一次防止绕过） */
  isUpdating?: () => boolean
  /** 默认 node:https 实现；单测注入 */
  requestJson?: (url: URL, opts: { timeoutMs: number; maxBytes: number }) => Promise<unknown>
  /** 默认 false；单测/测试环境放行 127.0.0.1 的 http registry */
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export type PiPackageInstallOutcome =
  | { accepted: true; result: PkgInstallResult }
  | {
      accepted: false
      reason: 'busy' | 'updating' | 'not-located' | 'invalid'
      message: string
    }

export interface PiPackageInstaller {
  preview(source: string): Promise<PkgPreview>
  install(source: string): Promise<PiPackageInstallOutcome>
  cancel(): void
  isRunning(): boolean
  activeJobId(): string | undefined
}

/* ------------------------------------------------------------------ *
 * 服务本体
 * ------------------------------------------------------------------ */

interface InstallJob {
  readonly id: string
  canceled: boolean
  settled: boolean
  child?: SpawnHandle
  /** 已脱敏的行日志尾部（最多 32KB） */
  tailBuffer: string
  timeoutTimer?: ReturnType<typeof setTimeout> | undefined
  killTimer?: ReturnType<typeof setTimeout> | undefined
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return {
    promise,
    resolve: (value: T) => {
      resolveFn(value)
    }
  }
}

export function createPiPackageInstaller(deps: PiPackageInstallerDeps): PiPackageInstaller {
  const env = deps.env ?? process.env
  const clock = deps.now ?? ((): Date => new Date())
  // 惰性调用注入物：不要把方法裸取值再调用（`unbound-method` 会判为可能丢 this）
  const readTextFile = (path: string): Promise<string> =>
    deps.readTextFile !== undefined ? deps.readTextFile(path) : readFile(path, 'utf8')
  const spawnPi = (spec: PiLaunchSpec, argv: string[]): SpawnHandle =>
    deps.spawnPi !== undefined ? deps.spawnPi(spec, argv) : defaultSpawnPi(spec, argv)
  const defaultRequest = createDefaultRequestJson(env)
  const requestJson = (
    url: URL,
    opts: { timeoutMs: number; maxBytes: number }
  ): Promise<unknown> =>
    deps.requestJson !== undefined ? deps.requestJson(url, opts) : defaultRequest(url, opts)

  /** 单飞：同一时刻只允许一个安装任务（不排队，直接拒绝） */
  let active: InstallJob | undefined
  let jobSeq = 0

  function nextJobId(): string {
    jobSeq += 1
    return `pkg-${String(jobSeq)}-${String(clock().getTime())}`
  }

  function emitSafe(event: PkgInstallEvent): void {
    try {
      deps.emit(event)
    } catch {
      /* renderer 可能已销毁：事件丢失不影响任务本身 */
    }
  }

  function agentDirSafe(): string | undefined {
    try {
      const dir = deps.agentDir()
      return dir.length > 0 ? dir : undefined
    } catch {
      return undefined
    }
  }

  /* ---------------------------------------------------------------- *
   * 日志流
   * ---------------------------------------------------------------- */

  function emitLogLine(job: InstallJob, raw: string): void {
    const cleaned = stripAnsi(raw).replace(/\r+$/, '')
    const redacted = redactLine(cleaned)
    const line = truncateText(redacted, MAX_LOG_LINE)
    // 空行不推给 renderer（npm 输出里大量空行只会把日志撑长）
    if (line.trim().length === 0) return

    job.tailBuffer += `${line}\n`
    if (job.tailBuffer.length > LOG_TAIL_LIMIT) {
      job.tailBuffer = job.tailBuffer.slice(-LOG_TAIL_LIMIT)
    }
    emitSafe({ jobId: job.id, phase: 'log', line })
  }

  /** 按行切分流式输出（chunk 边界可能落在一行中间，必须留 buffer） */
  function attachStream(
    job: InstallJob,
    subscribe: (listener: (chunk: string) => void) => void
  ): void {
    let buffer = ''
    subscribe((chunk) => {
      buffer += chunk
      const parts = buffer.split(/\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) emitLogLine(job, part)
    })
  }

  function tailOf(job: InstallJob): string | undefined {
    const tail = job.tailBuffer.trimEnd()
    return tail.length === 0 ? undefined : truncateText(tail, LOG_TAIL_LIMIT)
  }

  function clearTimers(job: InstallJob): void {
    if (job.timeoutTimer !== undefined) {
      clearTimeout(job.timeoutTimer)
      job.timeoutTimer = undefined
    }
    if (job.killTimer !== undefined) {
      clearTimeout(job.killTimer)
      job.killTimer = undefined
    }
  }

  /** 结束进程：SIGTERM/SIGKILL + Windows 上补 `taskkill /T`（杀掉 node shim 的子进程树） */
  function killJob(job: InstallJob, signal: NodeJS.Signals): void {
    const child = job.child
    if (child === undefined) return
    try {
      child.kill(signal)
    } catch {
      /* 已退出 */
    }
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      try {
        // pid 只来自 spawn 句柄的数字；参数走数组、shell:false，不拼命令行
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {
        /* taskkill 不可用：信号已经发了 */
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 成功后的复验
   * ---------------------------------------------------------------- */

  /**
   * 复验 `<agentDir>/settings.json` 里是否出现了这条声明。
   *
   * 为什么 exit 0 也要复验：`pi install` 的退出码只代表"这个命令自己跑完了"，
   * 不保证登记落到了我们看得见的 settings（可能写到了别的 agent dir、可能被并发写覆盖、
   * 也可能只 clone 了代码）。唯一可信的证据是重新读一遍文件并做身份比对。
   */
  async function isDeclared(source: string): Promise<boolean> {
    const target = sourceIdentity(source)
    if (target === undefined) return false

    const dir = agentDirSafe()
    if (dir === undefined) return false

    let text: string
    try {
      text = await readTextFile(join(dir, 'settings.json'))
    } catch {
      return false
    }
    if (text.trim().length === 0) return false

    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return false
    }
    if (!isObject(parsed)) return false

    // 显式标 unknown：`Array.isArray` 对 unknown 收窄成 any[] 会触发 no-unsafe-* 规则
    const rawPackages: unknown = parsed['packages']
    const entries: unknown[] = Array.isArray(rawPackages) ? rawPackages : []
    for (const entry of entries) {
      const entrySource = entrySourceOf(entry)
      if (entrySource === undefined) continue
      if (sourceIdentity(entrySource) === target) return true
    }
    return false
  }

  /** 读落盘包的 `package.json` 取 version（读不到就省略，不报错） */
  async function readInstalledManifest(
    source: string,
    kind: PkgKind
  ): Promise<{ installedPath: string; version?: string } | undefined> {
    const dir = agentDirSafe()
    if (dir === undefined) return undefined
    const target = managedDir(source, kind, dir)
    if (target === undefined) return undefined

    let text: string
    try {
      text = await readTextFile(join(target, 'package.json'))
    } catch {
      // 目录/清单读不到：不谎报 installedPath，只省略字段
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return { installedPath: target }
    }
    if (!isObject(parsed)) return { installedPath: target }

    const version = asNonEmptyString(parsed['version'])
    return version === undefined ? { installedPath: target } : { installedPath: target, version }
  }

  /* ---------------------------------------------------------------- *
   * preview
   * ---------------------------------------------------------------- */

  async function preview(raw: string): Promise<PkgPreview> {
    const decision = validatePackageSource(raw)
    // 非法输入在 handler 层映射成 VALIDATION；这里直接抛
    if (!decision.ok) throw new Error(decision.reason)

    const source = decision.source
    const kind = decision.kind
    const npmName = decision.npmName
    const requestedVersion = decision.npmVersion

    if (kind !== 'npm' || npmName === undefined) {
      // 防御性分支：validate 只放行 npm / git(含 https)，本地源进不来
      return {
        source,
        kind,
        origin: 'none',
        error: 'git/本地源无法预读元数据；安装会 clone 并执行其扩展代码'
      }
    }

    const fail = (reason: string): PkgPreview => ({
      source,
      kind: 'npm',
      origin: 'none',
      ...(requestedVersion === undefined ? {} : { requestedVersion }),
      error: truncate(reason, MAX_ERROR_LENGTH)
    })

    const registry = resolveRegistryBase(env)
    const url = packageMetadataUrl(registry, npmName)

    let payload: unknown
    try {
      payload = await requestJson(url, {
        timeoutMs: PREVIEW_TIMEOUT_MS,
        maxBytes: PREVIEW_MAX_BYTES
      })
    } catch (error) {
      // 预览失败**不阻断**安装：只是 UI 少一段元数据
      return fail(`查询 npm registry 失败：${describe(error)}`)
    }

    const meta = parseNpmMetadata(payload)
    if (meta === undefined) return fail('registry 响应格式不正确（不是 JSON 对象）')

    return {
      source,
      kind: 'npm',
      origin: 'npm-registry',
      name: meta.name ?? npmName,
      ...(meta.version === undefined ? {} : { version: meta.version }),
      ...(requestedVersion === undefined ? {} : { requestedVersion }),
      ...(meta.description === undefined
        ? {}
        : { description: truncate(meta.description, MAX_DESCRIPTION_LENGTH) }),
      ...(meta.repository === undefined ? {} : { repository: meta.repository })
    }
  }

  /* ---------------------------------------------------------------- *
   * install
   * ---------------------------------------------------------------- */

  async function install(raw: string): Promise<PiPackageInstallOutcome> {
    // ① 与 `pi update` 互斥：更新可能正在替换 pi 的入口，此时装插件极易装出半成品
    if (deps.isUpdating?.() === true) {
      return {
        accepted: false,
        reason: 'updating',
        message: 'pi 正在更新，请等更新结束后再安装插件'
      }
    }

    // ② 单飞（同步占位，避免"两次点击都过了 gate 再各自 spawn"）
    if (active !== undefined) {
      return { accepted: false, reason: 'busy', message: '已有插件安装任务在执行' }
    }

    // ③ 校验：失败即返回，**零 spawn**
    const decision = validatePackageSource(raw)
    if (!decision.ok) {
      return { accepted: false, reason: 'invalid', message: decision.reason }
    }
    const source = decision.source
    const kind = decision.kind

    const job: InstallJob = {
      id: nextJobId(),
      canceled: false,
      settled: false,
      tailBuffer: ''
    }
    active = job

    /** 释放 job（settled 防重入：终态只认第一次） */
    const release = (): void => {
      clearTimers(job)
      job.settled = true
      if (active === job) active = undefined
    }

    // ④/⑤ 定位 pi：locatePi 拿不到 → not-located；launchPi 拿不到 → not-located
    let spec: PiLaunchSpec | undefined
    try {
      const located = await deps.locatePi()
      if (located === undefined) {
        release()
        return {
          accepted: false,
          reason: 'not-located',
          message: '尚未定位 pi，无法安装插件（可先做一次自检，或在设置里指定可执行文件路径）'
        }
      }
      spec = await deps.launchPi()
    } catch (error) {
      release()
      return {
        accepted: false,
        reason: 'not-located',
        message: `定位 pi 失败，未执行安装：${describe(error)}`
      }
    }
    if (spec === undefined) {
      release()
      return {
        accepted: false,
        reason: 'not-located',
        message: '尚未定位 pi，无法安装插件（可先做一次自检，或在设置里指定可执行文件路径）'
      }
    }

    // 取消可能落在上面的 await 期间
    if (job.canceled) {
      release()
      const message = '已取消；安装尚未开始'
      emitSafe({ jobId: job.id, phase: 'canceled', message })
      return {
        accepted: true,
        result: { source, kind, outcome: 'canceled', message }
      }
    }

    // argv 恒为两个元素：绝不拼接、绝不追加 -l/-a/--force
    const argv = ['install', source]

    emitSafe({ jobId: job.id, phase: 'started', message: `开始执行 pi install ${source}` })

    const deferred = createDeferred<PiPackageInstallOutcome>()
    const finish = (outcome: PiPackageInstallOutcome): void => {
      if (job.settled) return
      release()
      deferred.resolve(outcome)
    }

    const baseResult = (): Pick<PkgInstallResult, 'source' | 'kind'> => ({ source, kind })

    /** 失败收尾：带日志尾部与手动命令（用户至少能自己重跑） */
    const failJob = (message: string, withManual = true): void => {
      const logTail = tailOf(job)
      emitSafe({ jobId: job.id, phase: 'failed', message })
      finish({
        accepted: true,
        result: {
          ...baseResult(),
          outcome: 'failed',
          message,
          ...(logTail === undefined ? {} : { logTail }),
          ...(withManual ? { manualCommand: `pi install ${source}` } : {})
        }
      })
    }

    let handle: SpawnHandle
    try {
      handle = spawnPi(spec, argv)
    } catch (error) {
      const message = `无法启动 pi install：${describe(error)}`
      emitSafe({ jobId: job.id, phase: 'failed', message })
      release()
      return {
        accepted: true,
        result: { ...baseResult(), outcome: 'failed', message }
      }
    }
    job.child = handle

    // ⑥ 流式日志（stdout / stderr 同格式清洗后都推给 renderer）
    attachStream(job, (listener) => {
      handle.onStdout(listener)
    })
    attachStream(job, (listener) => {
      handle.onStderr(listener)
    })

    // ⑦ 总超时
    job.timeoutTimer = setTimeout(() => {
      if (job.settled) return
      killJob(job, 'SIGKILL')
      failJob('安装超时（超过 10 分钟），已结束进程')
    }, INSTALL_TIMEOUT_MS)
    job.timeoutTimer.unref?.()

    // ⑧ spawn 层错误（可执行文件消失等）：不会再有 exit
    handle.onError((error) => {
      if (job.settled) return
      failJob(`pi install 启动失败：${describe(error)}`, false)
    })

    // ⑨ 终态
    handle.onExit((info) => {
      if (job.settled) return
      clearTimers(job)

      // 取消优先：被取消的安装可能只装了一半，不能因为目录恰好存在就报成功
      if (job.canceled) {
        const message = '已取消；可能留下未登记的半装目录，可重试'
        emitSafe({ jobId: job.id, phase: 'canceled', message })
        finish({
          accepted: true,
          result: { ...baseResult(), outcome: 'canceled', message }
        })
        return
      }

      const settle = async (): Promise<void> => {
        if (info.code !== 0) {
          failJob(`安装失败（退出码 ${String(info.code)}）`)
          return
        }

        // exit 0 → 复验登记（见 isDeclared 的注释）
        const declared = await isDeclared(source)
        if (!declared) {
          const message = 'pi 报告成功但 settings.json 未出现该声明'
          emitSafe({ jobId: job.id, phase: 'failed', message })
          finish({
            accepted: true,
            result: { ...baseResult(), outcome: 'failed', message }
          })
          return
        }

        const manifest = await readInstalledManifest(source, kind)
        const message = `已安装：${source}`
        emitSafe({ jobId: job.id, phase: 'done', message })
        finish({
          accepted: true,
          result: {
            ...baseResult(),
            outcome: 'installed',
            message,
            ...(manifest === undefined ? {} : { installedPath: manifest.installedPath }),
            ...(manifest?.version === undefined ? {} : { version: manifest.version })
          }
        })
      }

      void settle().catch((error: unknown) => {
        // 复验过程本身出错（读文件抛非预期错误等）：按失败处理，但仍把 job 释放掉
        failJob(`安装已结束，但复验失败：${describe(error)}`, false)
      })
    })

    return await deferred.promise
  }

  /* ---------------------------------------------------------------- *
   * cancel
   * ---------------------------------------------------------------- */

  function cancel(): void {
    const job = active
    // 幂等：没有任务 / 已取消 / 已结束都直接返回
    if (job === undefined || job.settled || job.canceled) return
    job.canceled = true

    // 还没 spawn 时只置标记，由 install 在 gate 之后自行收尾
    if (job.child === undefined) return

    emitSafe({
      jobId: job.id,
      phase: 'log',
      line: '收到取消请求，正在结束 pi install 进程…'
    })
    killJob(job, 'SIGTERM')
    job.killTimer = setTimeout(() => {
      if (job.settled) return
      killJob(job, 'SIGKILL')
    }, CANCEL_GRACE_MS)
    job.killTimer.unref?.()
  }

  return {
    preview,
    install,
    cancel,
    isRunning: () => active !== undefined,
    activeJobId: () => active?.id
  }
}
