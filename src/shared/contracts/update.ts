import { z } from 'zod'

/**
 * pi 版本检测与更新的共享契约（A34）。
 *
 * 为什么「检测」与「更新」必须是两条通道、两类结果：
 * - `pi update` **没有 dry-run**：只要远端有新版，它就会直接开始下载安装（可能失败、可能中断），
 *   不会给出「有没有新版」的只读答案。所以「探版本」只能自己请求更新源
 *   （`https://pi.dev/api/latest-version`，见 `services/pi-update.ts`），并用
 *   `source: 'pi.dev' | 'cache'` 标注这次结论是新查的还是缓存的。
 * - 反过来，检测结果**不能**当作「新版已装好」的证据：安装是否真的落地，只能靠执行
 *   `pi update` 之后的版本复验（`afterVersion`）来判定，因此执行结果要区分
 *   `updated` / `pendingRestart` / `failed`。
 *
 * 三个必须先记住的事实（实测得出）：
 * 1. pi 不支持自更新时输出 `pi cannot self-update this installation.` 并给出
 *    `PI_SELF_UPDATE_COMMAND` 指引 → 这条路径要把 `manualCommand` 原样交回用户手动执行。
 * 2. 更新期间**不应**再创建/恢复会话（二进制可能正被替换）→ 对应 handler 侧的「更新中」gate。
 * 3. 更新完成后通常要重启才生效：本进程仍在跑旧代码，`pendingRestart` 是正常结局而非失败。
 */

/** 检测入参：无参数（更新源与超时由主进程决定，renderer 不能指定，避免 SSRF 面） */
export const piUpdateCheckSchema = z.object({}).strict()

export const piUpdateCheckResultSchema = z.object({
  /** `unknown` = 查不到（离线/超时/源不可用），此时 UI 不给「有新版」的强结论 */
  state: z.enum(['upToDate', 'available', 'unknown']),
  /** 本机 pi 的版本（定位不到 pi 时缺省） */
  currentVersion: z.string().optional(),
  /** 更新源给出的最新版本（`state: 'available'` 时必定存在） */
  latestVersion: z.string().optional(),
  /** 本次结论的来源：新查（`pi.dev`）或缓存 */
  source: z.enum(['pi.dev', 'cache']),
  /** ISO 时间戳（缓存命中时是上次成功检测的时间，UI 用它提示「多久前查的」） */
  checkedAt: z.string(),
  /** 可读说明：跳过检测的原因、缓存过期等（不承载错误，错误走 `error`） */
  note: z.string().max(4000).optional(),
  /** npm 包名（默认 `@earendil-works/pi-coding-agent`，用于提示手动升级命令） */
  packageName: z.string().optional(),
  /** 检测失败的原始错误（`state: 'unknown'` 时用于诊断，不直接展示给普通用户） */
  error: z.string().optional()
})

export type PiUpdateCheckResult = z.infer<typeof piUpdateCheckResultSchema>

/** 执行入参（A34） */
export const piUpdateApplyInputSchema = z
  .object({
    /** 即使检测结论是「已最新」也照常执行（用户手动要求重装/修复） */
    force: z.boolean().optional(),
    /** 执行前主动 dispose 现有会话（默认要求先关会话，避免二进制被占用） */
    disposeSessions: z.boolean().optional()
  })
  .strict()

export type PiUpdateApplyInput = z.infer<typeof piUpdateApplyInputSchema>

export const piUpdateApplyResultSchema = z.object({
  /** 执行前版本（复验用，可能就是 `currentVersion`） */
  beforeVersion: z.string().optional(),
  /** 意图更新到的版本（检测阶段的 `latestVersion`；手动 force 时可能缺省） */
  targetVersion: z.string().optional(),
  /** 执行后重新读到的版本：只有它变了才算真的装上了 */
  afterVersion: z.string().optional(),
  /**
   * `updated` = 版本已变化；`pendingRestart` = 进程已退出/待重启后才生效；
   * `failed` = 版本未变化或命令失败（看 `message` / `logTail`）。
   */
  outcome: z.enum(['updated', 'pendingRestart', 'failed']),
  /** 面向用户的一句话结论 */
  message: z.string(),
  /** 安装日志尾部（只保留尾部，避免把整段 npm 输出塞进 IPC） */
  logTail: z.string().optional(),
  /** 不支持自更新时必须由用户手动执行的命令（如 `npm i -g <pkg>@latest`） */
  manualCommand: z.string().optional()
})

export type PiUpdateApplyResult = z.infer<typeof piUpdateApplyResultSchema>

/** 取消入参：无参数（一次只允许一个更新任务，见主进程的 job gate） */
export const piUpdateCancelSchema = z.object({}).strict()

/**
 * 更新过程事件（`events` 通道推送，按 `jobId` 归属）。
 *
 * `log` 是流式行；`started` / `done` / `failed` / `canceled` 是状态迁移点。
 * UI 只靠这四类终态收敛，因此每条都必须带 `message` 或明确 `phase`。
 */
export const piUpdateEventSchema = z.object({
  jobId: z.string(),
  phase: z.enum(['started', 'log', 'done', 'failed', 'canceled']),
  /** `phase: 'log'` 时的一行输出（已剥掉 ANSI 控制符） */
  line: z.string().optional(),
  /** 状态迁移的可读说明（`started` / `done` / `failed` / `canceled`） */
  message: z.string().optional()
})

export type PiUpdateEvent = z.infer<typeof piUpdateEventSchema>
