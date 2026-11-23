import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_BACKUPS,
  createModelConfigStore,
  maskApiKey,
  toModelEntryView
} from '../../src/main/services/model-config-store'

/**
 * 模型配置服务（A14）：直接读写 pi 的 `models.json` / `settings.json#defaultModel`。
 *
 * 这里守的四条硬约束：
 * 1. **apiKey 只进不出** —— 视图里只有 `hasApiKey` / `apiKeyHint`，明文不出主进程；
 * 2. **不动用户没建模的字段** —— `compat` / `headers` / `modelOverrides` 等原样保留；
 * 3. **写入可回退** —— 原子替换 + 备份，坏 JSON 直接拒绝而不是静默覆盖；
 * 4. **校验从严** —— 非法 id / baseUrl / api 在写盘前就被拒。
 */
let dir: string
let agentDir: string
let modelsPath: string
let settingsPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-model-config-'))
  agentDir = join(dir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  modelsPath = join(agentDir, 'models.json')
  settingsPath = join(agentDir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function store(): ReturnType<typeof createModelConfigStore> {
  return createModelConfigStore({ agentDir })
}

function writeModels(value: unknown): void {
  writeFileSync(modelsPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readModels(): Record<string, unknown> {
  return JSON.parse(readFileSync(modelsPath, 'utf8')) as Record<string, unknown>
}

describe('maskApiKey', () => {
  it('字面量 key 只留首 3 + 末 4', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-…cdef')
  })

  it('过短的 key 一律全遮', () => {
    expect(maskApiKey('short')).toBe('••••')
  })

  it('`$ENV` / `!command` 只提示形式，不泄漏内容', () => {
    expect(maskApiKey('$OPENAI_API_KEY')).toBe('$OPENAI_API_KEY')
    expect(maskApiKey('!pass show openai')).toBe('!<command>')
  })
})

describe('read', () => {
  it('文件不存在时给出空视图（不报错）', () => {
    const view = store().read()
    expect(view.configExists).toBe(false)
    expect(view.providers).toEqual([])
    expect(view.defaultModel).toBeUndefined()
    expect(view.configPath).toBe(modelsPath)
  })

  it('apiKey 明文不出现在视图里（JSON 序列化后也搜不到）', () => {
    const secret = 'sk-super-secret-value-9f8e7d6c'
    writeModels({
      providers: {
        acme: {
          name: 'Acme',
          baseUrl: 'https://api.acme.test/v1',
          api: 'openai-completions',
          apiKey: secret,
          models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 128000 }]
        }
      }
    })

    const view = store().read()
    expect(view.providers).toHaveLength(1)
    const provider = view.providers[0]
    expect(provider?.hasApiKey).toBe(true)
    expect(provider?.apiKeyHint).toBe('sk-…d6c'.replace('d6c', secret.slice(-4)))
    expect(JSON.stringify(view)).not.toContain(secret)
    expect(provider?.models[0]).toMatchObject({ id: 'acme-large', contextWindow: 128000 })
  })

  it('读 settings.json 的 defaultModel', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'acme-large', other: 1 }), 'utf8')
    expect(store().read().defaultModel).toBe('acme-large')
  })

  it('坏 JSON 时拒绝操作（不静默覆盖用户文件）', () => {
    writeFileSync(modelsPath, '{ not json', 'utf8')
    expect(() => store().read()).toThrowError(/不是合法 JSON/)
    // 原文件必须原样保留
    expect(readFileSync(modelsPath, 'utf8')).toBe('{ not json')
  })
})

describe('upsertProvider / upsertModel / remove*', () => {
  it('新建 provider：写 models.json、补 $schema、模型可读回', () => {
    const result = store().upsertProvider({
      id: 'acme',
      name: 'Acme',
      baseUrl: 'http://10.0.0.5:6001/v1',
      api: 'openai-completions',
      apiKey: 'sk-test-1234567890',
      models: [{ id: 'acme-large', name: 'Acme Large', contextWindow: 200000, maxTokens: 8192 }]
    })

    expect(result.changed).toBe(true)
    const written = readModels()
    expect(written['$schema']).toBe('https://pi.dev/schemas/models.schema.json')
    const providers = written['providers'] as Record<string, Record<string, unknown>>
    expect(providers['acme']?.['baseUrl']).toBe('http://10.0.0.5:6001/v1')
    expect(providers['acme']?.['apiKey']).toBe('sk-test-1234567890')

    const view = store().read()
    expect(view.providers[0]?.models[0]?.id).toBe('acme-large')
  })

  it('provider 上客户端没建模的字段（compat / headers / modelOverrides）原样保留', () => {
    writeModels({
      providers: {
        acme: {
          baseUrl: 'https://api.acme.test/v1',
          api: 'openai-completions',
          headers: { 'X-Custom': 'yes' },
          compat: { supportsStore: false },
          modelOverrides: { 'acme-large': { name: 'Renamed' } },
          models: [
            {
              id: 'acme-large',
              compat: { requiresReasoningContentOnAssistantMessages: true },
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })

    store().upsertProvider({ id: 'acme', name: 'Acme 改名', baseUrl: 'https://api.acme.test/v2' })

    const providers = readModels()['providers'] as Record<string, Record<string, unknown>>
    const acme = providers['acme']
    expect(acme?.['name']).toBe('Acme 改名')
    expect(acme?.['baseUrl']).toBe('https://api.acme.test/v2')
    expect(acme?.['headers']).toEqual({ 'X-Custom': 'yes' })
    expect(acme?.['compat']).toEqual({ supportsStore: false })
    expect(acme?.['modelOverrides']).toEqual({ 'acme-large': { name: 'Renamed' } })
    // 模型的额外字段也要保留
    const models = acme?.['models'] as Record<string, unknown>[]
    expect(models[0]?.['compat']).toEqual({ requiresReasoningContentOnAssistantMessages: true })
    expect(models[0]?.['cost']).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
  })

  it('upsertModel 可以新增与修改单个模型，不动同 provider 的其它模型', () => {
    store().upsertProvider({
      id: 'acme',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai-completions',
      models: [{ id: 'small' }, { id: 'large' }]
    })

    store().upsertModel('acme', { id: 'large', name: 'Large v2', maxTokens: 4096 })
    store().upsertModel('acme', { id: 'medium', reasoning: true })

    const ids = store()
      .read()
      .providers[0]?.models.map((model) => model.id)
    expect(ids?.sort()).toEqual(['large', 'medium', 'small'])
    const large = store()
      .read()
      .providers[0]?.models.find((model) => model.id === 'large')
    expect(large).toMatchObject({ name: 'Large v2', maxTokens: 4096 })
  })

  it('upsertModel 指向不存在的 provider → NOT_FOUND', () => {
    expect(() => store().upsertModel('nope', { id: 'x' })).toThrowError(/provider 不存在/)
  })

  it('removeModel / removeProvider', () => {
    store().upsertProvider({
      id: 'acme',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai-completions',
      models: [{ id: 'a' }, { id: 'b' }]
    })
    expect(store().removeModel('acme', 'a').changed).toBe(true)
    expect(
      store()
        .read()
        .providers[0]?.models.map((model) => model.id)
    ).toEqual(['b'])
    // 再删同一个 → 无事发生
    expect(store().removeModel('acme', 'a').changed).toBe(false)

    expect(store().removeProvider('acme').changed).toBe(true)
    expect(store().read().providers).toEqual([])
    expect(store().removeProvider('acme').changed).toBe(false)
  })

  it('apiKey 传空字符串 = 清除；省略 = 保留原值', () => {
    store().upsertProvider({
      id: 'acme',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai-completions',
      apiKey: 'sk-keep-me-123456'
    })
    store().upsertProvider({ id: 'acme', name: '重命名' })
    expect(store().read().providers[0]?.hasApiKey).toBe(true)

    store().upsertProvider({ id: 'acme', apiKey: '' })
    expect(store().read().providers[0]?.hasApiKey).toBe(false)
  })
})

describe('setDefaultModel', () => {
  it('写入 settings.json 的 defaultModel，保留其它键', () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', packages: ['x'] }), 'utf8')
    const result = store().setDefaultModel('acme-large')
    expect(result.changed).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings['defaultModel']).toBe('acme-large')
    expect(settings['theme']).toBe('dark')
    expect(settings['packages']).toEqual(['x'])
  })

  it('null 表示清除（恢复 pi 自动选择）', () => {
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'x', keep: 1 }), 'utf8')
    expect(store().setDefaultModel(null).changed).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings['defaultModel']).toBeUndefined()
    expect(settings['keep']).toBe(1)
  })

  it('值没有变化时不写盘（changed=false，不产生备份噪音）', () => {
    store().setDefaultModel('acme-large')
    expect(store().setDefaultModel('acme-large').changed).toBe(false)
  })
})

describe('写入安全：原子替换 + 备份', () => {
  it('不留下临时文件，且备份可回退到上一版', () => {
    store().upsertProvider({
      id: 'acme',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai-completions',
      models: [{ id: 'v1' }]
    })
    store().upsertProvider({ id: 'acme', models: [{ id: 'v2' }] })

    const entries = readdirSync(agentDir)
    expect(entries.some((name) => name.includes('.tmp-'))).toBe(false)

    const backups = entries.filter((name) => name.startsWith('models.json.bak-'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    // 最近一份备份内容应是「加 v2 之前」的版本
    const restored = JSON.parse(
      readFileSync(join(agentDir, backups.sort().at(-1) ?? ''), 'utf8')
    ) as Record<string, unknown>
    const providers = restored['providers'] as Record<string, Record<string, unknown>>
    const models = providers['acme']?.['models'] as { id: string }[]
    expect(models.map((model) => model.id)).toEqual(['v1'])
  })

  it(`备份只保留最近 ${MAX_BACKUPS} 份`, () => {
    for (let index = 0; index < MAX_BACKUPS + 3; index += 1) {
      store().upsertProvider({
        id: 'acme',
        baseUrl: 'https://api.acme.test/v1',
        api: 'openai-completions',
        name: `name-${index}`
      })
    }
    const backups = readdirSync(agentDir).filter((name) => name.startsWith('models.json.bak-'))
    expect(backups.length).toBeLessThanOrEqual(MAX_BACKUPS)
  })
})

describe('入参校验（写盘前就拒绝）', () => {
  it('非法 provider id', () => {
    expect(() => store().upsertProvider({ id: '../evil' })).toThrowError(/provider id 不合法/)
  })

  it('baseUrl 不是 http(s)', () => {
    expect(() =>
      store().upsertProvider({ id: 'acme', baseUrl: 'ftp://example.test' })
    ).toThrowError(/must|http/)
  })

  it('api 不在允许集合内', () => {
    expect(() =>
      // @ts-expect-error 故意传非法 api，验证运行时校验
      store().upsertProvider({ id: 'acme', api: 'carrier-pigeon' })
    ).toThrowError(/api 不合法/)
  })

  it('非法 id 的 setDefaultModel 也被拒', () => {
    expect(() => store().setDefaultModel('bad id!')).toThrowError(/默认模型 id/)
  })
})

describe('toModelEntryView', () => {
  it('标记「有客户端未建模的字段」', () => {
    expect(toModelEntryView({ id: 'a', name: 'A' })?.hasExtraFields).toBe(false)
    expect(toModelEntryView({ id: 'a', cost: { input: 1 } })?.hasExtraFields).toBe(true)
    expect(toModelEntryView({ noId: true })).toBeUndefined()
  })
})

describe('多模态（input）', () => {
  it('multimodal=true 写成 ["text","image"]，false 写成 ["text"]', () => {
    store().upsertProvider({
      id: 'acme',
      baseUrl: 'https://api.acme.test/v1',
      api: 'openai-completions',
      models: [
        { id: 'vision', multimodal: true },
        { id: 'text-only', multimodal: false }
      ]
    })

    const providers = readModels()['providers'] as Record<string, Record<string, unknown>>
    const models = providers['acme']?.['models'] as Record<string, unknown>[]
    expect(models.find((model) => model['id'] === 'vision')?.['input']).toEqual(['text', 'image'])
    expect(models.find((model) => model['id'] === 'text-only')?.['input']).toEqual(['text'])
  })

  it('视图里 multimodal 由 input 是否含 image 得出（pi 默认 ["text"]）', () => {
    writeModels({
      providers: {
        acme: {
          baseUrl: 'https://api.acme.test/v1',
          api: 'openai-completions',
          models: [
            { id: 'vision', input: ['text', 'image'] },
            { id: 'legacy-no-input' },
            { id: 'text-only', input: ['text'] }
          ]
        }
      }
    })

    const models = store().read().providers[0]?.models ?? []
    expect(models.find((model) => model.id === 'vision')?.multimodal).toBe(true)
    expect(models.find((model) => model.id === 'legacy-no-input')?.multimodal).toBe(false)
    expect(models.find((model) => model.id === 'text-only')?.multimodal).toBe(false)
  })

  it('不传 multimodal 时保留原 input（不要把已配好的多模态清掉）', () => {
    writeModels({
      providers: {
        acme: {
          baseUrl: 'https://api.acme.test/v1',
          api: 'openai-completions',
          models: [{ id: 'vision', input: ['text', 'image'] }]
        }
      }
    })

    // 只改名字，不碰 input
    store().upsertModel('acme', { id: 'vision', name: 'Vision v2' })

    const providers = readModels()['providers'] as Record<string, Record<string, unknown>>
    const models = providers['acme']?.['models'] as Record<string, unknown>[]
    expect(models[0]?.['name']).toBe('Vision v2')
    expect(models[0]?.['input']).toEqual(['text', 'image'])
  })

  it('input 仍算「客户端已建模字段」（不该被标成额外字段）', () => {
    expect(toModelEntryView({ id: 'a', input: ['text', 'image'] })?.hasExtraFields).toBe(false)
  })
})
