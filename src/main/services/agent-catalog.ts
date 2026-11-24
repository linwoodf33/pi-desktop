import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'

import type { AgentCatalogView, AgentSummary } from '../../shared/contracts/agents'

import type { PiLaunchSpec } from '../transport/types'

/**
 * Agent 目录（A18）——「以某个 agent 身份开始会话」所需的只读目录。
 *
 * 两个必须搞清的事实（都是实测得来的，不是猜的）：
 *
 * 1. **`--agent <name>` 不是 pi core 的参数**，而是 `pi-open-agents` 扩展注册的启动 flag。
 *    扩展没装时传它 → pi 直接 `Error: Unknown option: --agent` 起不来。
 *    所以这里必须先探测能力（`pi --help` 里有没有 `--agent`），UI 再决定是否显示选择器。
 * 2. **非法 agent 名会被静默忽略**：`pi --agent nosuchagent` 照常启动、回落到默认模型，
 *    不报错。所以客户端必须**自己**用扫描出的名单校验名字，不能指望 pi 兜底。
 *
 * 扫描路径（与 pi / pi-open-agents 的文档一致，project 覆盖 global）：
 * - global：`<agent-dir>/agents/**\/*.md`（agent-dir = `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）
 * - project：`<workspace>/.pi/agents/**\/*.md`、`<workspace>/.agents/agents/**\/*.md`
 *
 * 只读：不写任何文件，也不执行 agent 正文。
 */

interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface AgentCatalogOptions {
  /** 覆盖 pi 的 agent 目录（默认 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`） */
  agentDir?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** 当前工作区（用于扫描项目级 agent） */
  projectRoot?: () => string | undefined
  /** pi 的启动规格（由 pi-locator 提供；undefined = 还没定位到 pi） */
  launch?: () => PiLaunchSpec | undefined
  runCapture?: (spec: PiLaunchSpec, args: string[], timeoutMs: number) => Promise<CaptureResult>
  /** 能力探测缓存时长（`pi --help` 是一次子进程，别每次开弹层都跑） */
  probeTtlMs?: number
  probeTimeoutMs?: number
}

export interface AgentCatalog {
  /** `projectRoot` 由调用方给出（新建任务弹层里选的工作目录），用于扫描项目级 agent */
  list: (projectRoot?: string) => Promise<AgentCatalogView>
  /** 名字是否在扫描结果里（供 session:create 校验，避免 pi 静默忽略） */
  has: (view: AgentCatalogView, name: string) => boolean
}

/** 扫描文件数量上限（防御性：agent 目录被塞进一堆 md 时不至于卡死） */
const MAX_FILES = 500
const MAX_DEPTH = 4

/** frontmatter 只解析「一层 key: value」，够用且不引 yaml 依赖 */
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const body = text.slice(3, end)
  const fields: Record<string, string> = {}
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) fields[match[1]] = value
  }
  return fields
}

/** 递归收集某个根下的 `*.md`（跳过 `.chain.md`：那是 workflow 链，不是 agent） */
function collectMarkdown(root: string): string[] {
  const out: string[] = []
  if (!existsSync(root)) return out

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      if (entry.name.endsWith('.chain.md')) continue
      out.push(full)
    }
  }

  walk(root, 0)
  return out
}

/**
 * 计算目录分组：`relative(scanRoot, file)` 去掉文件名后的分段。
 * 例：`agents/intranet/architect.md`（root=`agents`）→ `['intranet']`。
 */
function groupOf(root: string, file: string): string[] {
  const rel = relative(root, file).split(sep).join('/')
  const segments = rel.split('/')
  segments.pop() // 去掉文件名
  return segments.filter((segment) => segment.length > 0)
}

function readAgent(
  file: string,
  scope: 'global' | 'project',
  root: string
): AgentSummary | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const fields = parseFrontmatter(text)
  const name = fields['name'] ?? basename(file, '.md')
  if (name.trim().length === 0) return undefined
  const summary: AgentSummary = { name, scope, file, group: groupOf(root, file) }
  const description = fields['description']
  if (description !== undefined) summary.description = description
  const mode = fields['mode']
  if (mode !== undefined) summary.mode = mode
  const model = fields['model']
  if (model !== undefined) summary.model = model
  return summary
}

export function createAgentCatalog(options: AgentCatalogOptions = {}): AgentCatalog {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const agentDir = options.agentDir ?? env['PI_CODING_AGENT_DIR'] ?? join(home, '.pi', 'agent')
  const runCapture = options.runCapture
  const probeTtlMs = options.probeTtlMs ?? 60_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000

  let probeCache: { key: string; at: number; supported: boolean; note?: string } | undefined

  async function detectAgentFlag(): Promise<{ supported: boolean; note?: string }> {
    const spec = options.launch?.()
    if (spec === undefined || runCapture === undefined) {
      return { supported: false, note: '尚未定位 pi，无法确认是否支持 --agent' }
    }
    const key = `${spec.command}|${spec.displayPath ?? ''}`
    const now = Date.now()
    if (probeCache !== undefined && probeCache.key === key && now - probeCache.at < probeTtlMs) {
      return {
        supported: probeCache.supported,
        ...(probeCache.note === undefined ? {} : { note: probeCache.note })
      }
    }

    let supported = false
    let note: string | undefined
    try {
      const result = await runCapture(spec, ['--help'], probeTimeoutMs)
      const text = `${result.stdout}\n${result.stderr}`
      supported = /(^|[\s,])--agent\b/.test(text)
      if (!supported) {
        note = 'pi 未注册 --agent（需要安装 pi-open-agents 扩展才能以 agent 身份启动）'
      }
    } catch (error) {
      note = `探测 --agent 失败：${error instanceof Error ? error.message : String(error)}`
    }
    probeCache = { key, at: now, supported, ...(note === undefined ? {} : { note }) }
    return { supported, ...(note === undefined ? {} : { note }) }
  }

  function scan(explicitProjectRoot?: string): AgentSummary[] {
    const byName = new Map<string, AgentSummary>()
    // global 先入，project 同名覆盖
    const globalRoot = join(agentDir, 'agents')
    for (const file of collectMarkdown(globalRoot)) {
      const agent = readAgent(file, 'global', globalRoot)
      if (agent !== undefined) byName.set(agent.name, agent)
    }
    const projectRoot = explicitProjectRoot ?? options.projectRoot?.()
    if (projectRoot !== undefined && projectRoot.length > 0) {
      for (const root of [
        join(projectRoot, '.pi', 'agents'),
        join(projectRoot, '.agents', 'agents')
      ]) {
        for (const file of collectMarkdown(root)) {
          const agent = readAgent(file, 'project', root)
          if (agent !== undefined) byName.set(agent.name, agent)
        }
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    list: async (explicitProjectRoot?: string) => {
      const agents = scan(explicitProjectRoot)
      const { supported, note } = await detectAgentFlag()
      return {
        agents,
        supportsAgentFlag: supported,
        ...(note === undefined ? {} : { note })
      }
    },
    has: (view, name) => view.agents.some((agent) => agent.name === name)
  }
}
