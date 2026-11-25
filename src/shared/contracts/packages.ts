import { z } from 'zod'

/**
 * 插件（pi package）契约 —— A37 阶段 1（仅契约，不含服务与 UI）。
 *
 * 概念对齐：这里的「插件」= **pi package**（`pi install <source>` 安装的东西，
 * 可来自 npm、git、本地路径），在 `settings.json#packages` 里登记，安装后可能提供
 * extensions / skills / prompts / themes 四类资源。
 *
 * 两条必须说清的边界：
 * 1. 清单（`PkgCatalogView`）来自 **settings.json 的登记** + 受管目录里的 `package.json`，
 *    它是「装了什么」的事实，**不代表当前会话已加载成功**（加载失败只在 pi 启动日志里）。
 * 2. `resources` / `filtered` / `autoload` 只做**只读呈现**：启用/禁用是资源过滤模式
 *    （`+`/`-`/`!` 前缀、`autoload:false`、项目 override），误写会静默改变加载集合，
 *    因此契约里不提供任何写入字段。
 */

export const pkgKindSchema = z.enum(['npm', 'git', 'local', 'unknown'])

export type PkgKind = z.infer<typeof pkgKindSchema>

/** 单条已登记插件（只读视图；`installedPath` 缺失表示未在 pi 受管位置找到） */
export const pkgSummarySchema = z.object({
  /** settings.json 里登记的原始 source 字符串（如 `npm:foo@1.2.3`、git URL、相对路径） */
  source: z.string(),
  scope: z.enum(['global', 'project']),
  kind: pkgKindSchema,
  name: z.string(),
  version: z.string().optional(),
  description: z.string().max(512).optional(),
  /** 受管位置里的包目录绝对路径（诊断用；找不到时省略，而不是谎报「未安装」） */
  installedPath: z.string().optional(),
  /** package.json 缺失/损坏时的可读说明（条目仍保留，降级展示） */
  manifestError: z.string().optional(),
  /** 该包是否被资源过滤规则裁剪（只读呈现） */
  filtered: z.boolean(),
  autoload: z.boolean().optional(),
  resources: z.array(z.enum(['extensions', 'skills', 'prompts', 'themes']))
})

export type PkgSummary = z.infer<typeof pkgSummarySchema>

export const pkgCatalogViewSchema = z.object({
  packages: z.array(pkgSummarySchema),
  /** pi agent 目录（`PI_CODING_AGENT_DIR` 或默认），UI 展示受管位置用 */
  agentDir: z.string(),
  /** 全局 settings.json 读不出来（损坏/权限）时的可读说明；清单降级为空但仍可安装 */
  globalSettingsError: z.string().optional(),
  projectSettingsError: z.string().optional(),
  /** 项目级清单所属工作区根（无项目上下文时省略） */
  projectRoot: z.string().optional()
})

export type PkgCatalogView = z.infer<typeof pkgCatalogViewSchema>

/** npm 源预览：只读 registry 元数据；预览失败**不阻断**安装（`error` 内联反馈） */
export const pkgPreviewSchema = z.object({
  source: z.string(),
  kind: pkgKindSchema,
  origin: z.enum(['npm-registry', 'none']),
  name: z.string().optional(),
  version: z.string().optional(),
  requestedVersion: z.string().optional(),
  description: z.string().max(1024).optional(),
  repository: z.string().optional(),
  error: z.string().optional()
})

export type PkgPreview = z.infer<typeof pkgPreviewSchema>

export const pkgInstallResultSchema = z.object({
  source: z.string(),
  kind: pkgKindSchema,
  outcome: z.enum(['installed', 'failed', 'canceled']),
  message: z.string(),
  installedPath: z.string().optional(),
  version: z.string().optional(),
  /** 输出尾部（已去 ANSI / 脱敏），供用户判断 npm postinstall 到底做了什么 */
  logTail: z.string().optional(),
  /** 需要用户手动执行时给出的等价命令（原样展示，不由客户端拼 shell） */
  manualCommand: z.string().optional()
})

export type PkgInstallResult = z.infer<typeof pkgInstallResultSchema>

/** 安装过程事件（`evt:pkgInstall`）：与 A34 更新事件同构，便于复用日志组件 */
export const pkgInstallEventSchema = z.object({
  jobId: z.string(),
  phase: z.enum(['started', 'log', 'done', 'failed', 'canceled']),
  line: z.string().optional(),
  message: z.string().optional()
})

export type PkgInstallEvent = z.infer<typeof pkgInstallEventSchema>

/**
 * `pkg:list` 入参：可选会话引用（用于确定项目级 `.pi/settings.json` 的工作区）。
 * 两者互斥；都不传时只读全局清单。
 */
export const pkgListInputSchema = z
  .object({
    sessionKey: z.string().min(1).max(128).optional(),
    sessionFile: z.string().min(1).max(2048).optional()
  })
  .strict()
  .refine((value) => !(value.sessionKey !== undefined && value.sessionFile !== undefined), {
    message: 'sessionKey 与 sessionFile 只能传一个'
  })

export type PkgListInput = z.infer<typeof pkgListInputSchema>

/** `pkg:preview` 入参（source 只作数据，不经 shell 拼接） */
export const pkgPreviewInputSchema = z
  .object({
    source: z.string().min(1).max(512)
  })
  .strict()

export type PkgPreviewInput = z.infer<typeof pkgPreviewInputSchema>

/** `pkg:install` 入参：与预览同形（安装会执行第三方代码，二次确认在 UI 侧） */
export const pkgInstallInputSchema = pkgPreviewInputSchema

export type PkgInstallInput = z.infer<typeof pkgInstallInputSchema>
