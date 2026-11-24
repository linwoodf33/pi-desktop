import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createSkillCatalog } from '../../src/main/services/skill-catalog'

/**
 * 技能清单（A31）。
 *
 * 规范：技能 = **含 `SKILL.md` 的目录**（frontmatter name/description）。
 * 只认这个名字 —— 技能目录里的其他 md 是内部资料，不是技能定义。
 */
const NL = String.fromCharCode(10)

function skillFile(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---${NL}name: ${name}${NL}description: ${description}${NL}---${NL}${NL}正文${NL}`,
    'utf8'
  )
}

describe('createSkillCatalog', () => {
  it('扫描全局技能目录，读 name/description', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-'))
    try {
      const agentDir = join(root, 'agent')
      skillFile(join(agentDir, 'skills', 'pdf-tools'), 'pdf-tools', '提取 PDF 文本与表格')
      const view = createSkillCatalog({ agentDir }).list()
      expect(view.skills).toHaveLength(1)
      expect(view.skills[0]).toMatchObject({
        name: 'pdf-tools',
        description: '提取 PDF 文本与表格',
        scope: 'global',
        group: ['pdf-tools']
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只认 SKILL.md：目录里的其他 md 不算技能', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-'))
    try {
      const agentDir = join(root, 'agent')
      mkdirSync(join(agentDir, 'skills', 'x'), { recursive: true })
      writeFileSync(join(agentDir, 'skills', 'x', 'notes.md'), '不是技能', 'utf8')
      expect(createSkillCatalog({ agentDir }).list().skills).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('项目级同名覆盖全局（与 pi 优先级一致）', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-'))
    try {
      const agentDir = join(root, 'agent')
      const project = join(root, 'workspace')
      skillFile(join(agentDir, 'skills', 'shared'), 'shared', '全局版')
      skillFile(join(project, '.pi', 'skills', 'shared'), 'shared', '项目版')

      const catalog = createSkillCatalog({ agentDir })
      expect(catalog.list(project).skills).toEqual([
        expect.objectContaining({ name: 'shared', description: '项目版', scope: 'project' })
      ])
      // 不带工作区时只有全局
      expect(catalog.list().skills[0]).toMatchObject({ description: '全局版', scope: 'global' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺 frontmatter name 时用目录名兜底', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skills-'))
    try {
      const agentDir = join(root, 'agent')
      mkdirSync(join(agentDir, 'skills', 'fallback-name'), { recursive: true })
      writeFileSync(
        join(agentDir, 'skills', 'fallback-name', 'SKILL.md'),
        `---${NL}description: 无 name${NL}---${NL}`,
        'utf8'
      )
      expect(createSkillCatalog({ agentDir }).list().skills[0]?.name).toBe('fallback-name')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
