import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'

import type { SkillCatalogView, SkillSummary } from '../../shared/contracts/skills'

import { parseFrontmatter } from './agent-catalog'

/**
 * 技能清单（A31，只读）。
 *
 * 规范：技能是**含 `SKILL.md` 的目录**（frontmatter `name`/`description`，正文为指令）。
 * 扫描位置与 pi 一致：
 * - global：`<agent-dir>/skills/**\/SKILL.md`
 * - project：`<workspace>/.pi/skills/**`、`<workspace>/.agents/skills/**`
 *
 * 只读、不执行、不返回正文 —— 客户端只负责「让用户看到有哪些技能可用」。
 * project 同名覆盖 global（与 pi 的优先级一致）。
 */
const MAX_FILES = 400
const MAX_DEPTH = 4

export interface SkillCatalogOptions {
  agentDir?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface SkillCatalog {
  /** `projectRoot` 由调用方给出（新建任务/当前任务的工作目录） */
  list: (projectRoot?: string) => SkillCatalogView
  /** pi 配置目录（安装「全局技能」时的根：`<agentDir>/skills`） */
  agentDir: () => string
}

/** 递归找 `SKILL.md`（只认这个名字；其他 md 是技能内部资料，不是技能定义） */
function collectSkillFiles(root: string): string[] {
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
      if (entry.isFile() && entry.name === 'SKILL.md') out.push(full)
    }
  }
  walk(root, 0)
  return out
}

function readSkill(
  file: string,
  root: string,
  scope: 'global' | 'project'
): SkillSummary | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const fields = parseFrontmatter(text)
  // 目录名是兜底 name（很多技能目录名与 name 一致）
  const name = (fields['name'] ?? basename(dirname(file))).trim()
  if (name.length === 0) return undefined

  const rel = relative(root, dirname(file)).split(sep).join('/')
  const group = rel.length === 0 ? [] : rel.split('/').filter((segment) => segment.length > 0)

  const summary: SkillSummary = { name, group, scope, file }
  const description = fields['description']
  if (description !== undefined) summary.description = description
  return summary
}

export function createSkillCatalog(options: SkillCatalogOptions = {}): SkillCatalog {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const agentDir = options.agentDir ?? env['PI_CODING_AGENT_DIR'] ?? join(home, '.pi', 'agent')

  function scan(projectRoot?: string): SkillSummary[] {
    const byName = new Map<string, SkillSummary>()
    const globalRoot = join(agentDir, 'skills')
    for (const file of collectSkillFiles(globalRoot)) {
      const skill = readSkill(file, globalRoot, 'global')
      if (skill !== undefined) byName.set(skill.name, skill)
    }
    if (projectRoot !== undefined && projectRoot.length > 0) {
      for (const root of [
        join(projectRoot, '.pi', 'skills'),
        join(projectRoot, '.agents', 'skills')
      ]) {
        for (const file of collectSkillFiles(root)) {
          const skill = readSkill(file, root, 'project')
          if (skill !== undefined) byName.set(skill.name, skill)
        }
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  return {
    list: (projectRoot?: string) => ({ skills: scan(projectRoot) }),
    agentDir: () => agentDir
  }
}
