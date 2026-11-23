import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { z } from 'zod'

import { IpcFailure } from '../../shared/contracts/result'
import { DEFAULT_APPROVAL_TOOLS } from '../../shared/contracts/permission'
import { SECRET_FIELD_PATTERN, type ConfigUpdateInput } from '../../shared/contracts/schemas'
import { appConfigViewSchema, type AppConfigView } from '../../shared/contracts/types'
import { normalizeThemeId } from '../../shared/contracts/theme'

/**
 * ConfigStore（架构文档 §5.2）：偏好持久化 `userData/config.json` + schema 校验 + 迁移。
 *
 * 硬约束（§7 约束 9/12、§9.1 U14）：
 * - `config.json` **只**存偏好与非敏感配置：pi 命令、会话目录覆盖、工作区根、并行上限、
 *   空闲回收分钟数、主题；
 * - 禁止写入会话内容、消息片段、token、provider key——写入前用 zod `.strict()` 校验，
 *   并对**任何**疑似密钥字段名（token/password/secret/apiKey/credential/private）直接报错且给出字段路径；
 * - 读取到的文件若包含未知字段，保留已知字段并丢弃未知字段（向前兼容），
 *   但**绝不**把未知字段回写（避免把不该落盘的东西扩散出去）。
 *
 * 文件形状带版本号，便于迁移：当前 `{ version: 2, config: {...} }`。
 * 迁移链：无版本/裸对象（v0/v1）→ v2。
 */

export const CONFIG_VERSION = 2

/** 默认审批时钟（§6.3：120s） */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000

/** 落盘 schema：视图 + 版本号；`strict()` 保证不会带出多余字段 */
export const persistedConfigSchema = z
  .object({
    version: z.number().int().positive(),
    config: appConfigViewSchema
      .omit({ sessionDir: true })
      .extend({ sessionDir: z.string().optional() })
      .strict()
  })
  .strict()

export interface ConfigStore {
  getConfigView(): AppConfigView
  /** 应用并持久化偏好补丁，返回新的视图；校验失败抛 `VALIDATION` */
  update(patch: ConfigUpdateInput): Promise<AppConfigView>
  /** 实际使用的配置文件路径（`undefined` = 仅内存，测试/无 userData 场景） */
  filePath(): string | undefined
  /** 读取过程中遇到的配置问题（供诊断，不向 renderer 暴露敏感内容） */
  lastLoadWarning(): string | undefined
}

export interface ConfigStoreOptions {
  /** `userData/config.json`；省略则只在内存中生效（M1 单测/无持久化场景） */
  filePath?: string
  env?: NodeJS.ProcessEnv
}

/** 默认 pi 命令的**开发/自动化覆盖**：`PI_DESKTOP_PI_COMMAND` */
export function defaultConfigView(env: NodeJS.ProcessEnv = process.env): AppConfigView {
  const override = env['PI_DESKTOP_PI_COMMAND']
  return {
    piCommand: override !== undefined && override.trim().length > 0 ? override : 'pi',
    workspaceRoots: [],
    maxActiveSessions: 3,
    idleRecycleMinutes: 30,
    theme: 'system',
    permission: {
      // §Q4：默认开启，仅高风险工具触发审批
      // 清单单一来源：`shared/contracts/permission.ts#DEFAULT_APPROVAL_TOOLS`
      enabled: true,
      tools: [...DEFAULT_APPROVAL_TOOLS],
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS
    }
  }
}

/**
 * 旧版本迁移（v0/v1 → v2）。
 *
 * v0/v1 都是「裸配置对象」（无 version 包裹），字段名与现在一致，因此迁移只是：
 * 取出已知字段 → 交给 zod 校验 → 缺的字段用默认值补。
 */
export function migrateConfig(
  raw: unknown,
  defaults: AppConfigView
): { config: AppConfigView; warnings: string[] } {
  const warnings: string[] = []
  const source = isRecord(raw) && isRecord(raw['config']) ? raw['config'] : raw
  if (!isRecord(source)) {
    return { config: { ...defaults }, warnings: ['配置文件不是对象，已回退到默认值'] }
  }

  const candidate: Record<string, unknown> = {}
  for (const key of Object.keys(defaults)) {
    if (key in source) candidate[key] = source[key]
  }
  const unknownKeys = Object.keys(source).filter((key) => !(key in defaults))
  if (unknownKeys.length > 0) {
    warnings.push(`忽略未知配置字段：${unknownKeys.join(', ')}`)
  }

  const parsed = appConfigViewSchema.safeParse(candidate)
  if (!parsed.success) {
    // 部分字段非法时逐字段回退：不让单个坏字段废掉整份配置
    const merged: Record<string, unknown> = { ...defaults }
    for (const [key, value] of Object.entries(candidate)) {
      const single = appConfigViewSchema.partial().safeParse({ [key]: value })
      if (single.success) merged[key] = value
      else warnings.push(`配置字段 ${key} 非法，已使用默认值`)
    }
    const retried = appConfigViewSchema.safeParse(merged)
    return {
      config: normalizeTheme(retried.success ? retried.data : { ...defaults }),
      warnings
    }
  }
  return { config: normalizeTheme(parsed.data), warnings }
}

export function createConfigStore(options: ConfigStoreOptions = {}): ConfigStore {
  const env = options.env ?? process.env
  const defaults = defaultConfigView(env)
  const path = options.filePath

  let warnings: string[] = []
  let current: AppConfigView = loadFromDisk(path, defaults, (list) => {
    warnings = list
  })

  return {
    getConfigView: () => cloneView(current),
    filePath: () => path,
    lastLoadWarning: () => (warnings.length === 0 ? undefined : warnings.join('; ')),
    update(patch) {
      try {
        assertNoSecretFields(patch)
        const next = mergePatch(current, patch)
        // 写盘失败必须让调用方知道（否则设置看起来生效、重启后丢失）
        persistSync(path, next)
        current = next
        return Promise.resolve(cloneView(current))
      } catch (error) {
        // 保持「永远返回 Promise」的契约（调用方不必区分同步/异步失败）
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 内部实现
 * ------------------------------------------------------------------ */

function loadFromDisk(
  path: string | undefined,
  defaults: AppConfigView,
  reportWarnings: (warnings: string[]) => void
): AppConfigView {
  if (path === undefined) return { ...defaults }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // 首次启动没有配置文件是正常的
    return { ...defaults }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    reportWarnings(['配置文件不是合法 JSON，已回退到默认值（原文件未被覆盖）'])
    return { ...defaults }
  }
  const migrated = migrateConfig(raw, defaults)
  reportWarnings(migrated.warnings)
  return migrated.config
}

function persistSync(path: string | undefined, config: AppConfigView): void {
  if (path === undefined) return
  const payload = persistedConfigSchema.parse({
    version: CONFIG_VERSION,
    config: {
      ...config,
      ...(config.sessionDir === undefined ? {} : { sessionDir: config.sessionDir })
    }
  })
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new IpcFailure(
      'INTERNAL',
      `保存设置失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * 合并补丁。
 *
 * `sessionDir` 传空字符串的语义是「恢复 pi 默认会话目录」，因此这里把它转成 `undefined`
 * 并从对象上删掉（而不是留一个空串，让下游 `length > 0` 判断继续依赖魔法值）。
 */
function mergePatch(current: AppConfigView, patch: ConfigUpdateInput): AppConfigView {
  const next: AppConfigView = {
    ...current,
    workspaceRoots: [...current.workspaceRoots]
  }
  if (patch.piCommand !== undefined) next.piCommand = patch.piCommand
  if (patch.workspaceRoots !== undefined) next.workspaceRoots = [...patch.workspaceRoots]
  if (patch.maxActiveSessions !== undefined) next.maxActiveSessions = patch.maxActiveSessions
  if (patch.idleRecycleMinutes !== undefined) next.idleRecycleMinutes = patch.idleRecycleMinutes
  if (patch.theme !== undefined) next.theme = normalizeThemeId(patch.theme)
  if (patch.sessionDir !== undefined) {
    const trimmed = patch.sessionDir.trim()
    if (trimmed.length === 0) delete next.sessionDir
    else next.sessionDir = trimmed
  }
  if (patch.permission !== undefined) {
    // 工具名归一（小写/去重/去空），避免设置页传入的写法差异导致「明明勾了却不生效」
    const tools = [
      ...new Set(patch.permission.tools.map((tool) => tool.trim().toLowerCase()))
    ].filter((tool) => tool.length > 0)
    next.permission = {
      enabled: patch.permission.enabled,
      tools,
      timeoutMs: patch.permission.timeoutMs
    }
  }
  return next
}

/** 疑似密钥字段一律拒绝，并给出字段路径（§9.1 U14） */
function assertNoSecretFields(patch: ConfigUpdateInput): void {
  for (const key of Object.keys(patch)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new IpcFailure('VALIDATION', `配置不得包含疑似密钥字段：${key}`, key)
    }
  }
}

function cloneView(view: AppConfigView): AppConfigView {
  return {
    ...view,
    workspaceRoots: [...view.workspaceRoots],
    permission: { ...view.permission, tools: [...view.permission.tools] }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一主题字段（读盘/写盘两侧都走这里）。
 *
 * 历史配置里 `theme` 只有 `dark` / `light`（v0.1 只持久化、未应用）；
 * 映射到同族主题而不是回退 `system`，避免升级后用户「主题被悄悄重置」。
 */
function normalizeTheme(config: AppConfigView): AppConfigView {
  return { ...config, theme: normalizeThemeId(config.theme) }
}
