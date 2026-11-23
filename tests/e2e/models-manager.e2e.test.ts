import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 模型管理弹层（M7）E2E。
 *
 * 用 `PI_CODING_AGENT_DIR` 把 pi 的 agent 目录指到临时目录：用例读写的全是假配置，
 * 绝不碰开发者本机的 `~/.pi/agent`。
 *
 * 守的关键点：
 * 1. 弹层能从顶栏打开，并列出 `models.json` 里的 provider；
 * 2. 「新增 provider」真的**写进文件**（不是只更新界面）；
 * 3. **apiKey 明文不出现在界面上**（只有掩码）；
 * 4. 默认模型写进 `settings.json#defaultModel`；
 * 5. 删除需要二次确认，且真的从文件里移除。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const SHOT_DIR = resolve(APP_ROOT, 'docs/screenshots')

const SECRET = 'sk-e2e-secret-value-abcdef'

let app: ElectronApplication
let page: Page
let tempRoot: string
let agentDir: string

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-models-'))
  agentDir = join(tempRoot, 'agent')
  const workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  await mkdir(SHOT_DIR, { recursive: true })

  // 预置一个 provider（含客户端未建模的字段，用于验证「编辑不清掉额外字段」）
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify(
      {
        $schema: 'https://pi.dev/schemas/models.schema.json',
        providers: {
          preset: {
            name: 'Preset',
            baseUrl: 'https://api.preset.test/v1',
            api: 'openai-completions',
            apiKey: SECRET,
            compat: { supportsStore: false },
            models: [{ id: 'preset-large', name: 'Preset Large', contextWindow: 128000 }]
          }
        }
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8')

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      // 关键：模型配置读写指向临时目录
      PI_CODING_AGENT_DIR: agentDir
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 900)
  })
}, 180_000)

afterAll(async () => {
  await app.close()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('模型管理', () => {
  it('顶栏可打开弹层，列出 models.json 里的 provider 且 apiKey 只显示掩码', async () => {
    await page.click('[data-testid="open-models-manager"]')
    await page.waitForSelector('[data-testid="models-manager"]', { timeout: 20_000 })

    await expect
      .poll(async () => page.locator('[data-testid="models-provider-row"]').count(), {
        timeout: 20_000
      })
      .toBeGreaterThan(0)

    const text = (await page.textContent('[data-testid="models-manager"]')) ?? ''
    expect(text).toContain('preset')
    expect(text).toContain('preset-large')
    // 掩码存在、明文不存在
    expect(text).toContain('key sk-…')
    expect(text).not.toContain(SECRET)
  })

  it('新增 provider 会写进 models.json（且保留其它 provider 的额外字段）', async () => {
    await page.click('[data-testid="models-add-provider"]')
    await page.waitForSelector('[data-testid="models-form"]', { timeout: 10_000 })

    await page.fill('[data-testid="models-form-id"]', 'e2e-provider')
    await page.fill('[data-testid="models-form-name"]', 'E2E Provider')
    await page.fill('[data-testid="models-form-baseurl"]', 'https://api.e2e.test/v1')
    await page.fill('[data-testid="models-form-model-id-0"]', 'e2e-model')
    await page.fill('[data-testid="models-form-model-name-0"]', 'E2E Model')
    await page.fill('[data-testid="models-form-model-ctx-0"]', '64000')
    await page.fill('[data-testid="models-form-model-max-0"]', '4096')
    await page.check('[data-testid="models-form-model-reasoning-0"]')
    await page.fill('[data-testid="models-form-apikey"]', 'sk-e2e-new-key-123456')
    await page.click('[data-testid="models-form-save"]')

    await expect
      .poll(
        async () => {
          const written = await readJson(join(agentDir, 'models.json'))
          const providers = written['providers'] as Record<string, Record<string, unknown>>
          return providers['e2e-provider'] === undefined ? 'absent' : 'present'
        },
        { timeout: 20_000 }
      )
      .toBe('present')

    const written = await readJson(join(agentDir, 'models.json'))
    const providers = written['providers'] as Record<string, Record<string, unknown>>
    expect(providers['e2e-provider']?.['baseUrl']).toBe('https://api.e2e.test/v1')
    expect(providers['e2e-provider']?.['apiKey']).toBe('sk-e2e-new-key-123456')
    const models = providers['e2e-provider']?.['models'] as Record<string, unknown>[]
    expect(models[0]).toMatchObject({
      id: 'e2e-model',
      contextWindow: 64000,
      maxTokens: 4096,
      reasoning: true
    })
    // 预置 provider 的额外字段仍在
    expect(providers['preset']?.['compat']).toEqual({ supportsStore: false })

    await page.screenshot({ path: join(SHOT_DIR, 'models-manager.png'), fullPage: false })
  })

  it('设置默认模型写进 settings.json#defaultModel，且保留其它键', async () => {
    await page.selectOption('[data-testid="models-default-select"]', 'e2e-model')

    await expect
      .poll(
        async () => {
          const settings = await readJson(join(agentDir, 'settings.json'))
          return settings['defaultModel'] ?? 'unset'
        },
        { timeout: 20_000 }
      )
      .toBe('e2e-model')

    const settings = await readJson(join(agentDir, 'settings.json'))
    expect(settings['theme']).toBe('dark')
  })

  it('删除 provider 需要二次确认，确认后从文件移除', async () => {
    const row = page
      .locator('[data-testid="models-provider-row"]')
      .filter({ hasText: 'e2e-provider' })
    await row.locator('[data-testid="models-provider-delete"]').click()
    await page.waitForSelector('[data-testid="models-provider-confirm"]', { timeout: 10_000 })
    await page.click('[data-testid="models-provider-confirm-yes"]')

    await expect
      .poll(
        async () => {
          const written = await readJson(join(agentDir, 'models.json'))
          const providers = written['providers'] as Record<string, Record<string, unknown>>
          return providers['e2e-provider'] === undefined ? 'removed' : 'present'
        },
        { timeout: 20_000 }
      )
      .toBe('removed')

    // preset 必须还在（只删目标 provider）
    const written = await readJson(join(agentDir, 'models.json'))
    const providers = written['providers'] as Record<string, Record<string, unknown>>
    expect(providers['preset']).toBeDefined()
  })

  it('关闭弹层回到主界面', async () => {
    await page.click('[data-testid="models-close"]')
    await expect.poll(async () => page.locator('[data-testid="models-manager"]').count()).toBe(0)
  })
})
