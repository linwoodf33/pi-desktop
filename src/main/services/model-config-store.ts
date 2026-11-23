import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { IpcFailure } from '../../shared/contracts/result'
import type {
  ModelConfigView,
  ModelConfigWriteResult,
  ModelEntryInput,
  ModelEntryView,
  ProviderView,
  UpsertProviderInput
} from '../../shared/contracts/model-config'
import {
  modelApiKeySchema,
  modelApiSchema,
  modelBaseUrlSchema,
  modelConfigIdSchema,
  modelEntryInputSchema
} from '../../shared/contracts/model-config'

/**
 * 模型配置读写（pi 的 `<agent-dir>/models.json` 与 `<agent-dir>/settings.json#defaultModel`）。
 *
 * 三条硬约束：
 * 1. **不动用户没建模的内容**：`models.json` 是 pi 的配置文件，含 `compat`、`samplingParams`、
 *    `cost.tiers`、`headers`、`modelOverrides` 等本客户端不理解的键。写回时在对象级别做
 *    「就地合并」，未知键原样保留 —— 客户端不应该成为「打开一次就清空配置」的工具。
 * 2. **apiKey 只进不出**：读取时只算 `hasApiKey` 与掩码提示，明文不出主进程
 *    （不进 IPC、不进日志、不进审计）。
 * 3. **写入可回退**：先写同目录临时文件再 `rename`（同卷原子），覆盖前留一份
 *    `<文件名>.bak-<时间戳>` 备份，只保留最近 {@link MAX_BACKUPS} 份。
 *
 * 生效时机：pi 在**启动会话时**读取这些配置，所以改动对「已经跑起来的会话」不生效 ——
 * UI 必须提示这一点，不能假装即时生效。
 */

export const MAX_BACKUPS = 3

export interface ModelConfigStoreOptions {
  /** 覆盖 pi 的 agent 目录（默认 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`） */
  agentDir?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

interface JsonObject {
  [key: string]: unknown
}

export interface ModelConfigStore {
  /** 只读视图（apiKey 已脱敏） */
  read: () => ModelConfigView
  /** 设置 / 清除 settings.json 的 defaultModel */
  setDefaultModel: (modelId: string | null) => ModelConfigWriteResult
  upsertProvider: (input: UpsertProviderInput) => ModelConfigWriteResult
  removeProvider: (id: string) => ModelConfigWriteResult
  upsertModel: (providerId: string, model: ModelEntryInput) => ModelConfigWriteResult
  removeModel: (providerId: string, modelId: string) => ModelConfigWriteResult
  /** 供测试断言用的路径 */
  paths: () => { agentDir: string; modelsPath: string; settingsPath: string }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** apiKey 掩码：只保留「能认出是哪一个」所需的最少信息 */
export function maskApiKey(value: string): string {
  const trimmed = value.trim()
  // `$ENV_NAME` / `!command`：pi 的两种间接引用形式，原样提示引用目标即可（不泄漏值）
  if (trimmed.startsWith('$')) return trimmed
  if (trimmed.startsWith('!')) return '!<command>'
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
}

/** 已知建模字段（其余字段视为「额外字段」，写回时保留） */
const KNOWN_MODEL_FIELDS = new Set([
  'id',
  'name',
  'api',
  'baseUrl',
  'contextWindow',
  'maxTokens',
  'reasoning',
  'input'
])

export function toModelEntryView(entry: unknown): ModelEntryView | undefined {
  if (!isObject(entry)) return undefined
  const id = asString(entry['id'])
  if (id === undefined) return undefined
  const rawInput = entry['input']
  const inputModes = Array.isArray(rawInput)
    ? rawInput.filter((mode): mode is string => typeof mode === 'string')
    : []
  const view: ModelEntryView = {
    id,
    // pi 的默认是 ["text"]；只有显式含 image 才算多模态
    multimodal: inputModes.includes('image'),
    hasExtraFields: Object.keys(entry).some((key) => !KNOWN_MODEL_FIELDS.has(key))
  }
  const name = asString(entry['name'])
  if (name !== undefined) view.name = name
  const api = asString(entry['api'])
  if (api !== undefined) view.api = api
  const baseUrl = asString(entry['baseUrl'])
  if (baseUrl !== undefined) view.baseUrl = baseUrl
  const contextWindow = asNumber(entry['contextWindow'])
  if (contextWindow !== undefined) view.contextWindow = contextWindow
  const maxTokens = asNumber(entry['maxTokens'])
  if (maxTokens !== undefined) view.maxTokens = maxTokens
  if (typeof entry['reasoning'] === 'boolean') view.reasoning = entry['reasoning']
  return view
}

/** 把 models.json 的一个 provider 转成视图（apiKey 脱敏） */
export function toProviderView(id: string, provider: unknown): ProviderView {
  if (!isObject(provider)) {
    return { id, hasApiKey: false, isOverrideOnly: true, models: [] }
  }
  const rawModels = Array.isArray(provider['models']) ? provider['models'] : []
  const models = rawModels
    .map((entry) => toModelEntryView(entry))
    .filter((entry): entry is ModelEntryView => entry !== undefined)

  const apiKey = asString(provider['apiKey'])
  const view: ProviderView = {
    id,
    hasApiKey: apiKey !== undefined,
    // 只有 baseUrl / api 都没有的条目才是「仅覆盖内置 provider 的设置」
    isOverrideOnly:
      asString(provider['baseUrl']) === undefined && asString(provider['api']) === undefined,
    models
  }
  const name = asString(provider['name'])
  if (name !== undefined) view.name = name
  const baseUrl = asString(provider['baseUrl'])
  if (baseUrl !== undefined) view.baseUrl = baseUrl
  const api = asString(provider['api'])
  if (api !== undefined) view.api = api
  if (apiKey !== undefined) view.apiKeyHint = maskApiKey(apiKey)
  return view
}

export function createModelConfigStore(options: ModelConfigStoreOptions = {}): ModelConfigStore {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const agentDir = resolve(
    options.agentDir ?? asString(env['PI_CODING_AGENT_DIR']) ?? join(home, '.pi', 'agent')
  )
  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')

  function readJsonFile(path: string, label: string): JsonObject | undefined {
    if (!existsSync(path)) return undefined
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      throw new IpcFailure('INTERNAL', `无法读取 ${label}`, describe(error))
    }
    if (text.trim().length === 0) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isObject(parsed)) throw new IpcFailure('VALIDATION', `${label} 不是 JSON 对象`)
      return parsed
    } catch (error) {
      if (error instanceof IpcFailure) throw error
      // 配置坏了就明确报错，不要静默覆盖用户文件（那才是真的数据损失）
      throw new IpcFailure('VALIDATION', `${label} 不是合法 JSON，已拒绝改动`, describe(error))
    }
  }

  /** 覆盖前备份：`<name>.bak-<yyyymmddHHMMss>`，只保留最近 MAX_BACKUPS 份 */
  function backup(path: string): string | undefined {
    if (!existsSync(path)) return undefined
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..*/, '')
      .replace('T', '-')
    const target = `${path}.bak-${stamp}`
    copyFileSync(path, target) // 覆盖同秒备份是可以接受的（同一秒内改两次）
    pruneBackups(path)
    return target
  }

  function pruneBackups(path: string): void {
    const dir = dirname(path)
    const prefix = `${basename(path)}.bak-`
    const entries = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        // 清理失败不影响主流程（备份文件残留不是错误）
      }
    }
  }

  /** 原子写：同目录临时文件 + rename（同卷 rename 是原子的） */
  function writeAtomic(path: string, data: JsonObject): string | undefined {
    mkdirSync(dirname(path), { recursive: true })
    const backupPath = backup(path)
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return backupPath
  }

  function readModelsConfig(): { config: JsonObject; exists: boolean } {
    const config = readJsonFile(modelsPath, 'models.json') ?? {}
    return { config, exists: existsSync(modelsPath) }
  }

  function readSettings(): JsonObject {
    return readJsonFile(settingsPath, 'settings.json') ?? {}
  }

  function providersOf(config: JsonObject): JsonObject {
    const providers = config['providers']
    return isObject(providers) ? providers : {}
  }

  function read(): ModelConfigView {
    const { config, exists } = readModelsConfig()
    const settings = readSettings()
    const providers = providersOf(config)
    const view: ModelConfigView = {
      configPath: modelsPath,
      configExists: exists,
      settingsPath,
      providers: Object.keys(providers)
        .sort()
        .map((id) => toProviderView(id, providers[id]))
    }
    const defaultModel = asString(settings['defaultModel'])
    if (defaultModel !== undefined) view.defaultModel = defaultModel
    return view
  }

  function assertValid<T>(
    schema: {
      safeParse: (value: unknown) => { success: boolean; error?: { issues: { message: string }[] } }
    },
    value: T,
    label: string
  ): void {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      const message = parsed.error?.issues.map((issue) => issue.message).join('；') ?? '校验失败'
      throw new IpcFailure('VALIDATION', `${label} 不合法：${message}`)
    }
  }

  function setDefaultModel(modelId: string | null): ModelConfigWriteResult {
    if (modelId !== null) assertValid(modelConfigIdSchema, modelId, '默认模型 id')
    const settings = readSettings()
    const next: JsonObject = { ...settings }
    if (modelId === null) delete next['defaultModel']
    else next['defaultModel'] = modelId

    if (JSON.stringify(settings) === JSON.stringify(next)) {
      return { changed: false, configPath: settingsPath }
    }
    const backupPath = writeAtomic(settingsPath, next)
    return {
      changed: true,
      configPath: settingsPath,
      ...(backupPath === undefined ? {} : { backupPath })
    }
  }

  function upsertProvider(input: UpsertProviderInput): ModelConfigWriteResult {
    assertValid(modelConfigIdSchema, input.id, 'provider id')
    if (input.baseUrl !== undefined) assertValid(modelBaseUrlSchema, input.baseUrl, 'baseUrl')
    if (input.api !== undefined) assertValid(modelApiSchema, input.api, 'api')
    if (input.apiKey !== undefined && input.apiKey !== '') {
      assertValid(modelApiKeySchema, input.apiKey, 'apiKey')
    }
    for (const model of input.models ?? []) {
      assertValid(modelEntryInputSchema, model, `模型 ${model.id}`)
    }

    const { config } = readModelsConfig()
    const providers = { ...providersOf(config) }
    const candidate = providers[input.id]
    const existing: JsonObject = isObject(candidate) ? candidate : {}

    // 就地合并：未知键（compat/headers/modelOverrides…）原样保留
    const nextProvider: JsonObject = { ...existing }
    if (input.name !== undefined) nextProvider['name'] = input.name
    if (input.baseUrl !== undefined) nextProvider['baseUrl'] = input.baseUrl
    if (input.api !== undefined) nextProvider['api'] = input.api
    if (input.apiKey !== undefined) {
      if (input.apiKey === '') delete nextProvider['apiKey']
      else nextProvider['apiKey'] = input.apiKey
    }

    if (input.models !== undefined) {
      const rawModels: unknown = existing['models']
      const existingModels: unknown[] = Array.isArray(rawModels) ? rawModels : []
      const byId = new Map<string, unknown>()
      for (const entry of existingModels) {
        const view = toModelEntryView(entry)
        if (view !== undefined) byId.set(view.id, entry)
      }
      for (const model of input.models) {
        const previous = byId.get(model.id)
        const merged: JsonObject = isObject(previous) ? { ...previous } : {}
        merged['id'] = model.id
        if (model.name !== undefined) merged['name'] = model.name
        if (model.api !== undefined) merged['api'] = model.api
        if (model.baseUrl !== undefined) merged['baseUrl'] = model.baseUrl
        if (model.contextWindow !== undefined) merged['contextWindow'] = model.contextWindow
        if (model.maxTokens !== undefined) merged['maxTokens'] = model.maxTokens
        if (model.reasoning !== undefined) merged['reasoning'] = model.reasoning
        if (model.multimodal !== undefined) {
          merged['input'] = model.multimodal ? ['text', 'image'] : ['text']
        }
        byId.set(model.id, merged)
      }
      nextProvider['models'] = [...byId.values()]
    }

    providers[input.id] = nextProvider
    const next: JsonObject = { ...config, providers }
    if (next['$schema'] === undefined) next['$schema'] = 'https://pi.dev/schemas/models.schema.json'

    if (JSON.stringify(config) === JSON.stringify(next)) {
      return { changed: false, configPath: modelsPath }
    }
    const backupPath = writeAtomic(modelsPath, next)
    return {
      changed: true,
      configPath: modelsPath,
      ...(backupPath === undefined ? {} : { backupPath })
    }
  }

  function removeProvider(id: string): ModelConfigWriteResult {
    assertValid(modelConfigIdSchema, id, 'provider id')
    const { config } = readModelsConfig()
    const providers = { ...providersOf(config) }
    if (!(id in providers)) return { changed: false, configPath: modelsPath }
    delete providers[id]
    const next: JsonObject = { ...config, providers }
    const backupPath = writeAtomic(modelsPath, next)
    return {
      changed: true,
      configPath: modelsPath,
      ...(backupPath === undefined ? {} : { backupPath })
    }
  }

  function upsertModel(providerId: string, model: ModelEntryInput): ModelConfigWriteResult {
    assertValid(modelConfigIdSchema, providerId, 'provider id')
    assertValid(modelEntryInputSchema, model, `模型 ${model.id}`)

    const { config } = readModelsConfig()
    const providers = { ...providersOf(config) }
    const candidateProvider = providers[providerId]
    const existingProvider: JsonObject | undefined = isObject(candidateProvider)
      ? candidateProvider
      : undefined
    if (existingProvider === undefined) {
      throw new IpcFailure('NOT_FOUND', `provider 不存在：${providerId}`)
    }
    // 显式标成 unknown[]：`Array.isArray` 对 unknown 收窄成 any[] 会触发 no-unsafe-assignment
    const rawModels: unknown = existingProvider['models']
    const existingModels: unknown[] = Array.isArray(rawModels) ? rawModels : []
    const target = existingModels.find((entry) => toModelEntryView(entry)?.id === model.id)
    const merged: JsonObject = isObject(target) ? { ...target } : {}
    merged['id'] = model.id
    if (model.name !== undefined) merged['name'] = model.name
    if (model.api !== undefined) merged['api'] = model.api
    if (model.baseUrl !== undefined) merged['baseUrl'] = model.baseUrl
    if (model.contextWindow !== undefined) merged['contextWindow'] = model.contextWindow
    if (model.maxTokens !== undefined) merged['maxTokens'] = model.maxTokens
    if (model.reasoning !== undefined) merged['reasoning'] = model.reasoning
    if (model.multimodal !== undefined) {
      merged['input'] = model.multimodal ? ['text', 'image'] : ['text']
    }

    const nextModels = existingModels.filter((entry) => toModelEntryView(entry)?.id !== model.id)
    nextModels.push(merged)

    providers[providerId] = { ...existingProvider, models: nextModels }
    const next: JsonObject = { ...config, providers }
    const backupPath = writeAtomic(modelsPath, next)
    return {
      changed: true,
      configPath: modelsPath,
      ...(backupPath === undefined ? {} : { backupPath })
    }
  }

  function removeModel(providerId: string, modelId: string): ModelConfigWriteResult {
    assertValid(modelConfigIdSchema, providerId, 'provider id')
    assertValid(modelConfigIdSchema, modelId, 'model id')

    const { config } = readModelsConfig()
    const providers = { ...providersOf(config) }
    const candidateProvider = providers[providerId]
    const existingProvider: JsonObject | undefined = isObject(candidateProvider)
      ? candidateProvider
      : undefined
    if (existingProvider === undefined) {
      throw new IpcFailure('NOT_FOUND', `provider 不存在：${providerId}`)
    }
    // 显式标成 unknown[]：`Array.isArray` 对 unknown 收窄成 any[] 会触发 no-unsafe-assignment
    const rawModels: unknown = existingProvider['models']
    const existingModels: unknown[] = Array.isArray(rawModels) ? rawModels : []
    const nextModels = existingModels.filter((entry) => toModelEntryView(entry)?.id !== modelId)
    if (nextModels.length === existingModels.length) {
      return { changed: false, configPath: modelsPath }
    }
    providers[providerId] = { ...existingProvider, models: nextModels }
    const next: JsonObject = { ...config, providers }
    const backupPath = writeAtomic(modelsPath, next)
    return {
      changed: true,
      configPath: modelsPath,
      ...(backupPath === undefined ? {} : { backupPath })
    }
  }

  return {
    read,
    setDefaultModel,
    upsertProvider,
    removeProvider,
    upsertModel,
    removeModel,
    paths: () => ({ agentDir, modelsPath, settingsPath })
  }
}

function describe(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  return undefined
}
