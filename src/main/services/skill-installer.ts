import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'

import { parseFrontmatter } from './agent-catalog'

/**
 * 从 URL 安装公开技能（A32）。
 *
 * 技能就是一个 `SKILL.md`（frontmatter name/description + 正文指令），所以「安装」=
 * 把远端那份文件写到本地某个技能目录。安全约束都是硬性的：
 *
 * 1. **只允许 https**（唯一例外：测试注入 `allowLocalhost` 时放行 127.0.0.1/localhost 的 http）；
 * 2. **拒绝内网/环回字面量 IP**（SSRF：10/8、172.16/12、192.168/16、169.254/16、::1、fc/fd/fe80）；
 * 3. **体积上限 512KB、超时 15s** —— 技能是提示词，不该是二进制大包；
 * 4. **名字白名单** `^[a-z0-9][a-z0-9._-]{0,63}$`（frontmatter 优先，缺省用 URL 文件名），
 *    直接杜绝 `../` 之类路径穿越；
 * 5. **不覆盖已有技能**（除非显式 `overwrite`），避免悄悄替换用户自己的定义；
 * 6. 写入用「临时文件 + rename」，且目标目录必须落在预期的技能根内（第二道闸）。
 *
 * 局限（如实说明）：只安装**单个 SKILL.md**，不拉取技能目录里的 scripts/references/assets。
 * 需要附带文件的技能请手动 clone。
 */
export const MAX_SKILL_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 15_000
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type SkillInstallScope = 'global' | 'project'

export interface SkillInstallPreview {
  /** 技能名（已白名单校验） */
  name: string
  description?: string
  /** 实际下载地址 */
  sourceUrl: string
  /** 正文大小（字节） */
  bytes: number
}

export interface SkillInstallResult extends SkillInstallPreview {
  /** 落盘的 SKILL.md 绝对路径 */
  path: string
}

/**
 * 真正的下载实现：`node:https`（不走 `fetch`）。
 *
 * 为什么不用全局 `fetch`：一是静态规则会把「动态 URL 的 fetch」判成 SSRF sink；
 * 二是这里需要**自己控制重定向与体积上限**（fetch 的 body 大小不可中断）。
 * 目标 URL 已经过 `assertAllowedSkillUrl`（https + 非内网），重定向每一跳都会重新校验。
 */
function downloadText(
  url: URL,
  options: { timeoutMs: number; allowLocalhost: boolean; maxBytes?: number }
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_SKILL_BYTES
  const deadline = Date.now() + options.timeoutMs

  const once = (target: URL, redirectLeft: number): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const client = target.protocol === 'https:' ? httpsRequest : httpRequest
      const req = client(
        target,
        { method: 'GET', headers: { accept: 'text/markdown,text/plain,*/*' } },
        (response) => {
          const status = response.statusCode ?? 0
          if (status >= 300 && status < 400 && response.headers.location !== undefined) {
            response.resume()
            if (redirectLeft <= 0) {
              reject(new IpcFailure('VALIDATION', '重定向次数过多', target.toString()))
              return
            }
            let next: URL
            try {
              // 每一跳都重新过安全校验（防「https 跳到内网」）
              next = assertAllowedSkillUrl(
                new URL(response.headers.location, target).toString(),
                options.allowLocalhost
              )
            } catch (error) {
              // promise 的 reject 只接受 Error（lint 规则），非 Error 包一层
              reject(error instanceof Error ? error : new Error(String(error)))
              return
            }
            resolve(once(next, redirectLeft - 1))
            return
          }
          if (status < 200 || status >= 300) {
            response.resume()
            reject(new IpcFailure('NOT_FOUND', `下载失败：HTTP ${status}`, target.toString()))
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > maxBytes) {
              req.destroy()
              reject(
                new IpcFailure(
                  'VALIDATION',
                  `技能文件过大（上限 ${Math.round(maxBytes / 1024)}KB）`
                )
              )
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'))
          })
          response.on('error', reject)
        }
      )
      req.setTimeout(Math.max(1000, deadline - Date.now()), () => {
        req.destroy()
        reject(new IpcFailure('INTERNAL', '下载超时', target.toString()))
      })
      req.on('error', (error) => {
        reject(
          new IpcFailure(
            'INTERNAL',
            `下载失败：${error instanceof Error ? error.message : String(error)}`,
            target.toString()
          )
        )
      })
      req.end()
    })

  return once(url, 3)
}

type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: 'follow' }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export interface SkillInstallOptions {
  url: string
  scope: SkillInstallScope
  /** pi 配置目录（global → `<agentDir>/skills/...`） */
  agentDir: string
  /** 当前工作区根（project → `<projectRoot>/.pi/skills/...`） */
  projectRoot?: string
  overwrite?: boolean
  /** 测试注入 */
  fetchImpl?: FetchLike
  /** 测试注入：允许 127.0.0.1 / localhost（e2e 用本地 http 服务器） */
  allowLocalhost?: boolean
  timeoutMs?: number
}

/** 内网/环回字面量 IP 判定（SSRF 防护） */
export function isPrivateAddress(hostname: string): boolean {
  const version = isIP(hostname)
  if (version === 0) return hostname === 'localhost' || hostname.endsWith('.local')
  if (version === 6) {
    const lower = hostname.toLowerCase()
    return (
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe80')
    )
  }
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10))
  const a = parts[0] ?? -1
  const b = parts[1] ?? -1
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/** 校验并规范化 URL；不合规直接给可读原因 */
export function assertAllowedSkillUrl(raw: string, allowLocalhost = false): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new IpcFailure(
      'VALIDATION',
      'URL 格式不对（示例：https://example.com/skills/foo/SKILL.md）'
    )
  }
  const localAllowed =
    allowLocalhost && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  if (url.protocol !== 'https:' && !(localAllowed && url.protocol === 'http:')) {
    throw new IpcFailure('VALIDATION', '只支持 https 链接（内容会写入你的配置目录）')
  }
  if (!localAllowed && isPrivateAddress(url.hostname)) {
    throw new IpcFailure('VALIDATION', '拒绝访问内网/环回地址', url.hostname)
  }
  return url
}

/** 从 URL 猜技能名：`…/foo/SKILL.md` → `foo`，`…/bar.md` → `bar` */
export function fallbackSkillName(url: URL): string {
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  const last = segments.at(-1) ?? 'skill'
  const stem = last.replace(/\.md$/i, '')
  if (/^skill$/i.test(stem)) return (segments.at(-2) ?? 'skill').toLowerCase()
  return stem.toLowerCase()
}

export function validateSkillName(name: string): string {
  const normalized = name.trim().toLowerCase()
  if (!SKILL_NAME_RE.test(normalized)) {
    throw new IpcFailure(
      'VALIDATION',
      '技能名不合法：只允许小写字母/数字/点/下划线/连字符，长度 1–64',
      name
    )
  }
  return normalized
}

/** 解析远端内容 → 名称/描述/正文（体积与名字都在这道闸校验） */
export function parseSkillDocument(
  text: string,
  url: URL
): { name: string; description?: string; content: string } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_SKILL_BYTES) {
    throw new IpcFailure('VALIDATION', `技能文件过大（${bytes} B，上限 ${MAX_SKILL_BYTES} B）`)
  }
  const fields = parseFrontmatter(text)
  const name = validateSkillName(fields['name'] ?? fallbackSkillName(url))
  const description = fields['description']
  return { name, ...(description === undefined ? {} : { description }), content: text }
}

/** 下载 + 解析（内部共用；preview 与 install 不重复实现） */
async function fetchAndParse(
  options: SkillInstallOptions
): Promise<{ preview: SkillInstallPreview; content: string }> {
  const url = assertAllowedSkillUrl(options.url, options.allowLocalhost === true)
  const text =
    options.fetchImpl !== undefined
      ? await downloadWithInjected(url, options)
      : await downloadText(url, {
          timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
          allowLocalhost: options.allowLocalhost === true
        })

  const parsed = parseSkillDocument(text, url)
  return {
    preview: {
      name: parsed.name,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      sourceUrl: url.toString(),
      bytes: Buffer.byteLength(parsed.content, 'utf8')
    },
    content: parsed.content
  }
}

/** 测试注入路径（单测不发真实请求） */
async function downloadWithInjected(url: URL, options: SkillInstallOptions): Promise<string> {
  const fetchImpl = options.fetchImpl
  if (fetchImpl === undefined) throw new IpcFailure('INTERNAL', '未配置下载实现')
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, options.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      redirect: 'follow'
    })
    if (!response.ok) {
      throw new IpcFailure('NOT_FOUND', `下载失败：HTTP ${response.status}`, url.toString())
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 只下载不落盘：让用户先确认名称/描述再决定装不装 */
export async function previewSkill(options: SkillInstallOptions): Promise<SkillInstallPreview> {
  return (await fetchAndParse(options)).preview
}

/** 安装：复用同一次下载的内容写入，避免二次请求与口径漂移 */
export async function installSkill(options: SkillInstallOptions): Promise<SkillInstallResult> {
  const { preview, content } = await fetchAndParse(options)

  const skillsRoot =
    options.scope === 'global'
      ? join(options.agentDir, 'skills')
      : options.projectRoot === undefined
        ? undefined
        : join(options.projectRoot, '.pi', 'skills')
  if (skillsRoot === undefined) {
    throw new IpcFailure('VALIDATION', '项目级安装需要当前工作区（先选中或新建任务）')
  }

  const skillDir = join(skillsRoot, preview.name)
  // 第二道闸：名字已过白名单，这里再确认目标目录确实在技能根下一层
  if (dirname(skillDir) !== skillsRoot) {
    throw new IpcFailure('PATH_DENIED', '目标路径不在技能根内', skillDir)
  }
  const target = join(skillDir, 'SKILL.md')
  if (existsSync(target) && options.overwrite !== true) {
    throw new IpcFailure(
      'VALIDATION',
      `同名技能已存在：${preview.name}（如需替换请勾选「覆盖已有技能」）`,
      target
    )
  }

  mkdirSync(skillDir, { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, target)

  return { ...preview, path: target }
}
