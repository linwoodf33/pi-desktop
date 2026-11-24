import { z } from 'zod'

/**
 * Agent 目录的共享契约（A18：以某个 agent 身份开始会话）。
 *
 * 为什么这两个类型在 shared 而不是 main：`api.ts`（preload/renderer 的类型来源）要引用它，
 * 而 shared 不能反向依赖 main。主进程的扫描逻辑在 `services/agent-catalog.ts`。
 *
 * 两个必须先弄清的事实（实测得出）：
 * 1. `--agent <name>` **不是 pi core 的参数**，而是 `pi-open-agents` 扩展注册的启动 flag；
 *    扩展没装时传它会直接 `Error: Unknown option: --agent` 起不来 → 必须探测能力再决定是否传。
 * 2. **非法 agent 名会被静默忽略**（pi 照常启动、回落到默认模型，不报错）
 *    → 客户端必须用扫描出的名单自己校验。
 */

export const agentSummarySchema = z.object({
  /** 传给 `--agent` 的名字（frontmatter 的 name，缺省用文件名） */
  name: z.string(),
  description: z.string().optional(),
  /** pi-open-agents 的 `mode`：`all` / `primary` / `subagent`（仅供参考） */
  mode: z.string().optional(),
  model: z.string().optional(),
  scope: z.enum(['global', 'project']),
  /**
   * 目录分组（A29）：agent 定义所在子目录的分段，如 `['intranet']`；根目录为 `[]`。
   *
   * 为什么用它表达「父子」：pi / pi-open-agents 的 frontmatter **没有 parent 字段**，
   * 唯一的层级信息就是文件所在目录（`agents/intranet/architect.md` 属于 intranet 组）。
   * 选择器据此渲染成树。
   */
  group: z.array(z.string()),
  /** 定义文件绝对路径（诊断用；不返回正文） */
  file: z.string()
})

export type AgentSummary = z.infer<typeof agentSummarySchema>

export const agentCatalogViewSchema = z.object({
  agents: z.array(agentSummarySchema),
  /** pi 是否支持 `--agent`（`pi --help` 探测）；false 时 UI 不应显示选择器 */
  supportsAgentFlag: z.boolean(),
  /** 探测失败或未定位 pi 时的可读说明 */
  note: z.string().optional()
})

export type AgentCatalogView = z.infer<typeof agentCatalogViewSchema>
