import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CONFIG_VERSION,
  createConfigStore,
  migrateConfig,
  persistedConfigSchema
} from '../../src/main/services/config-store'

/**
 * ConfigStore（§5.2）：持久化 + schema 校验 + 迁移（§9.1 U14 的密钥字段拒绝）。
 */
let dir: string
let filePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-config-'))
  filePath = join(dir, 'config.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('默认值与启动', () => {
  it('没有配置文件时用默认值（并行 3 / 回收 30 分钟），且不创建文件', async () => {
    const store = createConfigStore({ filePath })
    expect(store.getConfigView()).toMatchObject({
      piCommand: 'pi',
      maxActiveSessions: 3,
      idleRecycleMinutes: 30,
      theme: 'system'
    })
    expect(store.getConfigView().sessionDir).toBeUndefined()
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()
  })

  it('auto 环境变量 PI_DESKTOP_PI_COMMAND 仍作为默认 pi 命令（E2E 依赖）', () => {
    const store = createConfigStore({ filePath, env: { PI_DESKTOP_PI_COMMAND: 'C:/mock/pi.cmd' } })
    expect(store.getConfigView().piCommand).toBe('C:/mock/pi.cmd')
  })
})

describe('持久化与迁移', () => {
  it('update 落盘为带版本号的结构，重启后可读回', async () => {
    const store = createConfigStore({ filePath })
    const view = await store.update({ maxActiveSessions: 5, idleRecycleMinutes: 15, theme: 'dark' })
    expect(view.maxActiveSessions).toBe(5)

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(raw['version']).toBe(CONFIG_VERSION)
    expect(raw['config']).toMatchObject({ maxActiveSessions: 5, idleRecycleMinutes: 15 })

    const reopened = createConfigStore({ filePath })
    expect(reopened.getConfigView().maxActiveSessions).toBe(5)
    expect(reopened.getConfigView().theme).toBe('dark')
  })

  it('会话目录覆盖：空字符串表示恢复 pi 默认（落盘后字段消失）', async () => {
    const store = createConfigStore({ filePath })
    await store.update({ sessionDir: 'D:/pi-sessions' })
    expect(store.getConfigView().sessionDir).toBe('D:/pi-sessions')

    await store.update({ sessionDir: '   ' })
    expect(store.getConfigView().sessionDir).toBeUndefined()
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { config: Record<string, unknown> }
    expect('sessionDir' in raw.config).toBe(false)
  })

  it('旧版裸配置对象（无 version 包裹）自动迁移到当前版本', () => {
    const migrated = migrateConfig(
      { piCommand: 'C:/old/pi.cmd', maxActiveSessions: 2 },
      {
        piCommand: 'pi',
        workspaceRoots: [],
        maxActiveSessions: 3,
        idleRecycleMinutes: 30,
        theme: 'system',
        permission: { enabled: true, tools: ['bash'], timeoutMs: 120_000 }
      }
    )
    expect(migrated.config.piCommand).toBe('C:/old/pi.cmd')
    expect(migrated.config.maxActiveSessions).toBe(2)
    expect(migrated.config.idleRecycleMinutes).toBe(30)
    expect(migrated.warnings).toEqual([])
  })

  it('未知字段被丢弃并给出警告（不向前兼容地扩散未知道内容）', () => {
    const migrated = migrateConfig(
      { theme: 'dark', futureField: 'x' },
      {
        piCommand: 'pi',
        workspaceRoots: [],
        maxActiveSessions: 3,
        idleRecycleMinutes: 30,
        theme: 'system' as const,
        permission: { enabled: true, tools: ['bash'], timeoutMs: 120_000 }
      }
    )
    expect(migrated.config.theme).toBe('dark')
    expect(migrated.warnings.join()).toContain('忽略未知配置字段')
  })

  it('单个字段非法时逐字段回退，不废掉整份配置', () => {
    const migrated = migrateConfig(
      { maxActiveSessions: 'many', theme: 'dark' },
      {
        piCommand: 'pi',
        workspaceRoots: [],
        maxActiveSessions: 3,
        idleRecycleMinutes: 30,
        theme: 'system' as const,
        permission: { enabled: true, tools: ['bash'], timeoutMs: 120_000 }
      }
    )
    expect(migrated.config.maxActiveSessions).toBe(3)
    expect(migrated.config.theme).toBe('dark')
    expect(migrated.warnings.join()).toContain('maxActiveSessions')
  })

  it('配置文件不是合法 JSON 时回退默认值并给出警告（不覆盖原文件）', async () => {
    await writeFile(filePath, '{ not json', 'utf8')
    const store = createConfigStore({ filePath })
    expect(store.getConfigView().maxActiveSessions).toBe(3)
    expect(store.lastLoadWarning()).toContain('不是合法 JSON')
    expect(await readFile(filePath, 'utf8')).toBe('{ not json')
  })
})

describe('安全：禁止落盘任何密钥（§9.1 U14 / §7 约束 9、12）', () => {
  it('store.update 拒绝疑似密钥字段并给出字段路径', async () => {
    const store = createConfigStore({ filePath })
    await expect(
      store.update({ apiToken: 'sk-secret' } as unknown as Record<string, never>)
    ).rejects.toMatchObject({ code: 'VALIDATION', detail: 'apiToken' })
  })

  it('落盘 schema 拒绝未知字段（不会把多余内容写到磁盘）', () => {
    const result = persistedConfigSchema.safeParse({
      version: CONFIG_VERSION,
      config: {
        piCommand: 'pi',
        workspaceRoots: [],
        maxActiveSessions: 3,
        idleRecycleMinutes: 30,
        theme: 'system',
        password: 'hunter2'
      }
    })
    expect(result.success).toBe(false)
  })

  it('落盘文件里不出现 provider key / token 字样', async () => {
    const store = createConfigStore({ filePath })
    await store.update({ piCommand: 'C:/tools/pi.cmd' })
    const text = await readFile(filePath, 'utf8')
    expect(text.toLowerCase()).not.toMatch(/token|password|secret|apikey/)
  })
})
