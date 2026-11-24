import { z } from 'zod'

/**
 * 技能目录契约（A31）。
 *
 * pi 的技能遵循 Agent Skills 规范：**一个目录 + 其中的 `SKILL.md`**（frontmatter
 * `name` / `description`，正文是该技能的完整指令）。pi 只把 name/description 暴露给模型，
 * 真正加载正文是在需要时 —— 客户端这里做的是「只读清单」，不执行、不读取正文。
 */
export const skillSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** 定义所在目录的分段（相对扫描根），供树状分组 */
  group: z.array(z.string()),
  scope: z.enum(['global', 'project']),
  /** SKILL.md 绝对路径（诊断用；不返回正文） */
  file: z.string()
})

export type SkillSummary = z.infer<typeof skillSummarySchema>

export const skillCatalogViewSchema = z.object({
  skills: z.array(skillSummarySchema)
})

export type SkillCatalogView = z.infer<typeof skillCatalogViewSchema>
