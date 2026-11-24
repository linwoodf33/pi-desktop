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

/** A32：从 URL 安装公开技能 */
export const skillInstallInputSchema = z
  .object({
    url: z.string().min(1).max(2048),
    scope: z.enum(['global', 'project']),
    /** 覆盖同名技能（默认拒绝，避免悄悄替换用户自己的定义） */
    overwrite: z.boolean().optional(),
    /** 项目级安装需要会话引用（主进程据此确定工作区） */
    sessionKey: z.string().min(1).max(128).optional(),
    sessionFile: z.string().min(1).max(2048).optional()
  })
  .strict()

export type SkillInstallInput = z.infer<typeof skillInstallInputSchema>

export const skillInstallPreviewSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  sourceUrl: z.string(),
  bytes: z.number()
})

export type SkillInstallPreview = z.infer<typeof skillInstallPreviewSchema>

export const skillInstallResultSchema = skillInstallPreviewSchema.extend({
  /** 落盘的 SKILL.md 绝对路径 */
  path: z.string()
})

export type SkillInstallResult = z.infer<typeof skillInstallResultSchema>
