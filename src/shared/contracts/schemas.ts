import { z } from 'zod'

import { IPC_INVOKE_CHANNELS, type InvokeChannel } from '../ipc-channels'
import { sessionKeySchema } from './common'
import {
  removeModelInputSchema,
  removeProviderInputSchema,
  setDefaultModelInputSchema,
  upsertModelInputSchema,
  upsertProviderInputSchema
} from './model-config'
import { permissionPolicySchema, sessionToolModeSchema } from './types'
import { THEME_IDS } from './theme'

/**
 * 各 invoke 通道的入参 schema（架构文档 §5.4 入参列）。
 *
 * 约定：
 * - 一律 `.strict()`：多余字段直接 VALIDATION，避免 renderer 误传被静默忽略；
 * - 用 `IPC_INVOKE_CHANNELS.x` 作为计算键，保证「白名单通道」与「schema 表」由类型系统强制对齐。
 */

export const emptyInputSchema = z.object({}).strict()

export const piLocateInputSchema = z
  .object({
    path: z.string().min(1).optional()
  })
  .strict()

export const sessionListInputSchema = z
  .object({
    cwd: z.string().min(1).optional(),
    cursor: z.string().min(1).optional()
  })
  .strict()

export const sessionCreateInputSchema = z
  .object({
    cwd: z.string().min(1),
    model: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    /** 起始模式 = pi 的工具选择（见 types.ts#sessionToolModeSchema 的说明） */
    toolMode: sessionToolModeSchema.optional()
  })
  .strict()

export const sessionResumeInputSchema = z
  .object({
    sessionFile: z.string().min(1)
  })
  .strict()

/**
 * `session:history` 入参（M3 补充通道）。
 *
 * `sessionFile` 必须位于当前会话目录内（主进程侧做前缀校验，见 services/session-history.ts）；
 * `maxRecords` 只是展示上限，不改变“截断要显式提示”的约束。
 * `allowMissing`（M4 复核修复 B1）只给 fork 编排用：新会话文件可能还没落盘，按空会话返回。
 */
export const sessionHistoryInputSchema = z
  .object({
    sessionFile: z.string().min(1),
    maxRecords: z.number().int().positive().max(20000).optional(),
    allowMissing: z.boolean().optional()
  })
  .strict()

export const sessionForkInputSchema = z
  .object({
    sessionKey: sessionKeySchema,
    /**
     * 分叉点：pi `fork` 的 `entryId`（docs/rpc-commands.md#fork，用户消息 entry 的 id）。
     * 省略时退化为 CLI `--fork <sessionFile>` 复制整条分支。
     */
    entryId: z.string().min(1).optional(),
    /** @deprecated M2 字段名（当时直接透传给 `fork.entryId`），新代码用 entryId */
    messageId: z.string().min(1).optional()
  })
  .strict()
  .refine((value) => !(value.entryId !== undefined && value.messageId !== undefined), {
    message: 'entryId 与 messageId 不能同时提供（二者同义）'
  })

export const sessionPromptInputSchema = z
  .object({
    sessionKey: sessionKeySchema,
    message: z.string().min(1),
    images: z.array(z.string().min(1)).optional(),
    /** busy 时必带（§7 约束 5）：steer = 打断当前步，followUp = 排队 */
    streamingBehavior: z.enum(['steer', 'followUp']).optional()
  })
  .strict()

export const sessionKeyInputSchema = z
  .object({
    sessionKey: sessionKeySchema
  })
  .strict()

/**
 * ��置持久化入参（M4 补充通道 `config:update`）。
 *
 * 只接受偏好字段，且**显式拒绝**任何疑似密钥字段（§3.2、§7 约束 9/12、§9.1 U14）。
 */
export const SECRET_FIELD_PATTERN = /(token|password|secret|apikey|api_key|credential|private)/i

const configPatchShape = z
  .object({
    piCommand: z.string().min(1).max(1024).optional(),
    /** 空字符串 = 恢复 pi 默认会话目录 */
    sessionDir: z.string().max(1024).optional(),
    workspaceRoots: z.array(z.string().min(1).max(1024)).max(64).optional(),
    maxActiveSessions: z.number().int().min(1).max(10).optional(),
    idleRecycleMinutes: z.number().int().min(1).max(1440).optional(),
    // 接受现役主题 id + 历史值（`dark`/`light`，v0.1 遗留），写入前由 config-store 归一
    theme: z.enum([...THEME_IDS, 'dark', 'light']).optional(),
    /** M5：审批策略（整对象替换；下次 spawn 时随环境下发给扩展） */
    permission: permissionPolicySchema.optional()
  })
  .strict()

/**
 * 拒绝疑似密钥字段：zod 的 strict 已拒绝未知键，这里再对**已知键名**做一次模式校验，
 * 防止未来给 schema 加字段时不小心引入 `piToken` 这类名字。
 */
export const configUpdateInputSchema = configPatchShape.superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      ctx.addIssue({ code: 'custom', path: [key], message: '配置不得包含疑似密钥字段' })
    }
  }
})

export type ConfigUpdateInput = z.input<typeof configPatchShape>

export const modelSetInputSchema = z
  .object({
    sessionKey: sessionKeySchema,
    model: z.string().min(1),
    thinkingLevel: z.string().min(1).optional()
  })
  .strict()

/**
 * `extui:respond` 入参（M5 从 `response: unknown` 收窄为受控联合）。
 *
 * 只允许两种回包：选中某个**选项文案**（`kind:'select'`）或取消/拒绝（`kind:'cancel'`）。
 * 具体文案必须属于该请求的 `options`（主进程逐条比对，伪造成不在清单里的值会被 `VALIDATION` 拒绝），
 * 这样即使 renderer 被注入，也无法构造非预期的 `extension_ui_response`。
 */
export const extuiResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('select'), value: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('cancel') }).strict()
])
export type ExtUiResponseInputDto = z.infer<typeof extuiResponseSchema>

export const extuiRespondInputSchema = z
  .object({
    sessionKey: sessionKeySchema,
    requestId: z.string().min(1).max(256),
    response: extuiResponseSchema
  })
  .strict()

export const fsPickDirectoryInputSchema = z
  .object({
    defaultPath: z.string().min(1).optional()
  })
  .strict()

/**
 * 产物通道的「会话引用」（M6 对 §5.4 的补充）。
 *
 * §5.4 只给了 `sessionKey`，但右栏产物面板对**已回放的历史任务**同样要能扫工作区
 *（历史任务没有活着的 pi 进程，只有会话文件）。因此允许二选一：
 * - `sessionKey`：活跃会话（主进程从 SessionService 拿 cwd，可信来源）；
 * - `sessionFile`：会话 JSONL（主进程按会话根校验后读 header 里的 cwd）。
 *
 * 两者互斥；都不传时**只能**用绝对路径 + 全局工作区白名单（`fs:readText` / `artifact:open`
 * 的普通用法），且白名单里的根一律由主进程推导，renderer 无法自己新增根。
 */
const sessionRefShape = {
  sessionKey: sessionKeySchema.optional(),
  sessionFile: z.string().min(1).max(4096).optional()
} as const

function refineSessionRef<
  T extends { sessionKey?: string | undefined; sessionFile?: string | undefined }
>(value: T, ctx: z.RefinementCtx): void {
  if (value.sessionKey !== undefined && value.sessionFile !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['sessionKey'],
      message: 'sessionKey 与 sessionFile 不能同时提供'
    })
  }
}

export const fsListArtifactsInputSchema = z
  .object({ ...sessionRefShape })
  .strict()
  .superRefine(refineSessionRef)

/**
 * `fs:readText` 入参（M6）。
 *
 * - `path`：工作区相对路径（配合会话引用）或绝对路径（必须落在主进程的工作区白名单内）；
 * - `maxBytes`：默认 64KB、上限 64KB（§7 约束 14）；
 * - `offset`：字节偏移，支持分页（不能超过文件大小）。
 */
export const fsReadTextInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    /** 预览上限（§7 约束 14：预览 64KB） */
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024)
      .optional(),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024)
      .optional(),
    ...sessionRefShape
  })
  .strict()
  .superRefine(refineSessionRef)

export const fsDiffInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    /** §5.4 的必需字段；历史任务用 `sessionFile` 代替（M6 补充） */
    sessionKey: sessionKeySchema.optional(),
    sessionFile: z.string().min(1).max(4096).optional()
  })
  .strict()
  .superRefine(refineSessionRef)

export const artifactOpenInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    ...sessionRefShape
  })
  .strict()
  .superRefine(refineSessionRef)

/**
 * 通道 → 入参 schema。类型标注为 Record<InvokeChannel, ...>，
 * 少一个通道或写错通道名都会在 typecheck 阶段报错。
 */
export const invokeInputSchemas = {
  [IPC_INVOKE_CHANNELS.appGetBoot]: emptyInputSchema,
  [IPC_INVOKE_CHANNELS.piLocate]: piLocateInputSchema,
  [IPC_INVOKE_CHANNELS.sessionList]: sessionListInputSchema,
  [IPC_INVOKE_CHANNELS.sessionHistory]: sessionHistoryInputSchema,
  [IPC_INVOKE_CHANNELS.sessionCreate]: sessionCreateInputSchema,
  [IPC_INVOKE_CHANNELS.sessionResume]: sessionResumeInputSchema,
  [IPC_INVOKE_CHANNELS.sessionFork]: sessionForkInputSchema,
  [IPC_INVOKE_CHANNELS.sessionPrompt]: sessionPromptInputSchema,
  [IPC_INVOKE_CHANNELS.sessionAbort]: sessionKeyInputSchema,
  [IPC_INVOKE_CHANNELS.sessionDispose]: sessionKeyInputSchema,
  [IPC_INVOKE_CHANNELS.sessionState]: sessionKeyInputSchema,
  [IPC_INVOKE_CHANNELS.sessionStats]: sessionKeyInputSchema,
  [IPC_INVOKE_CHANNELS.sessionForkPoints]: sessionKeyInputSchema,
  [IPC_INVOKE_CHANNELS.modelList]: emptyInputSchema,
  [IPC_INVOKE_CHANNELS.modelSet]: modelSetInputSchema,
  [IPC_INVOKE_CHANNELS.modelsRead]: emptyInputSchema,
  [IPC_INVOKE_CHANNELS.modelsSetDefault]: setDefaultModelInputSchema,
  [IPC_INVOKE_CHANNELS.modelsUpsertProvider]: upsertProviderInputSchema,
  [IPC_INVOKE_CHANNELS.modelsRemoveProvider]: removeProviderInputSchema,
  [IPC_INVOKE_CHANNELS.modelsUpsertModel]: upsertModelInputSchema,
  [IPC_INVOKE_CHANNELS.modelsRemoveModel]: removeModelInputSchema,
  [IPC_INVOKE_CHANNELS.configUpdate]: configUpdateInputSchema,
  [IPC_INVOKE_CHANNELS.permissionStatus]: emptyInputSchema,
  [IPC_INVOKE_CHANNELS.extuiRespond]: extuiRespondInputSchema,
  [IPC_INVOKE_CHANNELS.fsPickDirectory]: fsPickDirectoryInputSchema,
  [IPC_INVOKE_CHANNELS.fsListArtifacts]: fsListArtifactsInputSchema,
  [IPC_INVOKE_CHANNELS.fsReadText]: fsReadTextInputSchema,
  [IPC_INVOKE_CHANNELS.fsDiff]: fsDiffInputSchema,
  [IPC_INVOKE_CHANNELS.artifactOpen]: artifactOpenInputSchema
} satisfies Record<InvokeChannel, z.ZodType>

/** 供 router 统一取 schema（避免把 satisfies 收窄成字面量键联合后失去索引能力） */
export function getInputSchema(channel: InvokeChannel): z.ZodType {
  return invokeInputSchemas[channel]
}
