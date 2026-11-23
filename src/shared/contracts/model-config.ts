import { z } from 'zod'

/**
 * 模型管理（pi `models.json` + `settings.json#defaultModel`）的共享契约。
 *
 * 设计要点：
 * - **apiKey 永不回传**：出参只有 `hasApiKey` 与掩码提示 `apiKeyHint`（如 `sk-…1a2b`），
 *   renderer 拿不到明文，也就不会被误写进日志/截图（§9.4 S5 的同一条思路）。
 * - **只管理结构化字段**：provider / model 里本客户端没建模的键（`compat`、`samplingParams`、
 *   `cost.tiers`、`headers`…）在写回时**原样保留**，不因为「客户端不认识」而丢失用户配置。
 * - **校验从严**：id / baseUrl / api / 数值范围都在 IPC 边界 zod 化；写入走原子替换 + 备份。
 */

/** provider id 与 model id 允许的字符（真实配置里出现 `google/gemma-3-12b-it`、`deepseek-v4.1-flash`） */
const idPattern = /^[A-Za-z0-9._:/-]{1,128}$/

export const modelConfigIdSchema = z
  .string()
  .regex(idPattern, '只能包含字母、数字与 . _ : / -')
  .refine((value) => !value.includes('..'), '不允许包含「..」')
  .refine((value) => !value.startsWith('/') && !value.endsWith('/'), '不能以「/」开头或结尾')

/** pi 支持的 api 类型（见 pi docs/models-configuration.md） */
export const MODEL_API_VALUES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'azure-openai-responses'
] as const

export const modelApiSchema = z.enum(MODEL_API_VALUES)

/**
 * baseUrl 校验：只接受 http(s)。
 *
 * 刻意**允许 http**：内网自建 endpoint（`http://10.x.x.x:6001/v1`）是真实用法，
 * 一刀切要求 https 会让这类用户无法在客户端里配置。UI 上对 http 给出明文提示。
 */
export const modelBaseUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, '必须是 http(s) URL')

/** pi 的输入模态（见 models.json 的 `input`） */
export const MODEL_INPUT_MODES = ['text', 'image'] as const

export const modelInputSchema = z.array(z.enum(MODEL_INPUT_MODES)).min(1).max(2)

/**
 * 单个模型条目（客户端建模的字段；其余字段写回时保留）。
 *
 * `input` 就是「是否多模态」：pi 的取值是 `["text"]` 或 `["text","image"]`。
 * 客户端用布尔开关表达（不支持纯图片模型：pi 的对话至少要有文本），
 * 落盘时再展开成数组。
 */
export const modelEntryInputSchema = z
  .object({
    id: modelConfigIdSchema,
    name: z.string().min(1).max(200).optional(),
    contextWindow: z.number().int().min(1).max(100_000_000).optional(),
    maxTokens: z.number().int().min(1).max(10_000_000).optional(),
    reasoning: z.boolean().optional(),
    /** `true` = 支持图片输入（写 `["text","image"]`）；`false` = 仅文本（写 `["text"]`） */
    multimodal: z.boolean().optional(),
    api: modelApiSchema.optional(),
    baseUrl: modelBaseUrlSchema.optional()
  })
  .strict()

export type ModelEntryInput = z.infer<typeof modelEntryInputSchema>

/**
 * apiKey 形式（pi 支持三种）：字面量、`$ENV_NAME` 环境变量、`!command` 命令输出。
 * 只做长度与空白校验，不猜内容；`!` 开头的命令**不在客户端执行**，仅原样写入配置。
 */
export const modelApiKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, 'apiKey 不能为空白')

export const upsertProviderInputSchema = z
  .object({
    id: modelConfigIdSchema,
    name: z.string().min(1).max(200).optional(),
    baseUrl: modelBaseUrlSchema.optional(),
    api: modelApiSchema.optional(),
    /** 省略 = 保留现有 key；空字符串 = 显式清除；否则写入新 key */
    apiKey: z.union([modelApiKeySchema, z.literal('')]).optional(),
    /** 省略 = 不动其模型列表（新增 provider 时可一并给出初始模型） */
    models: z.array(modelEntryInputSchema).max(200).optional()
  })
  .strict()

export type UpsertProviderInput = z.infer<typeof upsertProviderInputSchema>

export const removeProviderInputSchema = z.object({ id: modelConfigIdSchema }).strict()

export const upsertModelInputSchema = z
  .object({
    providerId: modelConfigIdSchema,
    model: modelEntryInputSchema
  })
  .strict()

export const removeModelInputSchema = z
  .object({
    providerId: modelConfigIdSchema,
    modelId: modelConfigIdSchema
  })
  .strict()

export const setDefaultModelInputSchema = z
  .object({
    /** `null` = 清除默认模型（恢复 pi 的自动选择） */
    modelId: z.union([modelConfigIdSchema, z.null()])
  })
  .strict()

/** 出参：单个模型（只读视图） */
export const modelEntryViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  api: z.string().optional(),
  baseUrl: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  reasoning: z.boolean().optional(),
  /** 是否支持图片输入（由 `input` 里是否含 `image` 得出） */
  multimodal: z.boolean(),
  /** 该条目在 models.json 里还有客户端没建模的字段（提示「编辑不会清掉它们」） */
  hasExtraFields: z.boolean()
})

export type ModelEntryView = z.infer<typeof modelEntryViewSchema>

/** 出参：单个 provider（只读视图，apiKey 已脱敏） */
export const providerViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  api: z.string().optional(),
  /** 是否配置了 apiKey（**不返回** key 本身） */
  hasApiKey: z.boolean(),
  /** 掩码提示，仅够用来分辨「是不是我配的那个 key」 */
  apiKeyHint: z.string().optional(),
  /** 内置 provider（没有 baseUrl/api 的自定义条目，或 pi 自带 provider 的覆盖） */
  isOverrideOnly: z.boolean(),
  models: z.array(modelEntryViewSchema)
})

export type ProviderView = z.infer<typeof providerViewSchema>

export const modelConfigViewSchema = z.object({
  /** `<agent-dir>/models.json` 的绝对路径（展示用；不返回文件内容） */
  configPath: z.string(),
  configExists: z.boolean(),
  /** `<agent-dir>/settings.json` 的绝对路径 */
  settingsPath: z.string(),
  /** pi settings.json 里的启动模型；undefined = 自动 */
  defaultModel: z.string().optional(),
  providers: z.array(providerViewSchema)
})

export type ModelConfigView = z.infer<typeof modelConfigViewSchema>

/** 写入结果：后端会原子替换并留备份，返回值告诉前端「改了哪个文件」 */
export const modelConfigWriteResultSchema = z.object({
  changed: z.boolean(),
  configPath: z.string(),
  /** 备份文件路径（无变更时为 undefined） */
  backupPath: z.string().optional()
})

export type ModelConfigWriteResult = z.infer<typeof modelConfigWriteResultSchema>
