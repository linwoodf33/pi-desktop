import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A18：新建任务时以某个 agent 身份开始会话（`--agent <name>`）。
 *
 * 独立文件 + 独立 `PI_CODING_AGENT_DIR`：agent 目录被指到临时目录，
 * 既不碰开发机的 `~/.pi/agent`，也不会影响别的 E2E（它们依赖真实扩展目录）。
 *
 * 这里守三件容易出错的事：
 * 1. 选择器**只在 `pi --help` 里有 `--agent` 时出现**（该 flag 来自 pi-open-agents 扩展；
 *    未装时传它 pi 会 `Error: Unknown option` 直接起不来）；
 * 2. 选中的 agent 名字真的进了子进程参数（不是只改 UI）；
 * 3. 只列扫描到的定义（pi 对未知 agent 静默忽略，不能让用户手打名字）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

let app: ElectronApplication
let page: Page
let tempRoot: string
let agentDir: string
let argvFile: string
let workDir: string

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-agent-'))
  agentDir = join(tempRoot, 'agent')
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(join(agentDir, 'agents'), { recursive: true })
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  argvFile = join(tempRoot, 'mock-argv.json')

  // 一个用户级 agent（pi 格式：frontmatter + 正文）
  await writeFile(
    join(agentDir, 'agents', 'scout.md'),
    '---\nname: scout\ndescription: 快速侦察代码\nmode: primary\n---\n\n你是侦察兵。\n',
    'utf8'
  )

  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_CODING_AGENT_DIR: agentDir,
      MOCK_PI_ARGV_FILE: argvFile
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
}, 180_000)

afterAll(async () => {
  await app.close()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('新建任务：agent 选择', () => {
  it('`--agent` 可用时出现选择器，并只列扫描到的定义', async () => {
    await page.click('[data-testid="new-task-button"]')
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })

    // 能力探测是异步的（要跑一次 `pi --help`）→ 等它出现
    const select = page.locator('[data-testid="new-task-agent"]')
    await expect.poll(async () => select.count(), { timeout: 30_000 }).toBe(1)

    const options = await select
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    expect(options).toEqual(['', 'scout'])
  })

  it('选中 scout 建会话后，子进程收到 --agent scout', async () => {
    await page.click('[data-testid="new-task-pick-directory"]')
    // 目录选择走一次 IPC 往返：必须等回填，不能立刻读值
    await expect
      .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir)

    await page.selectOption('[data-testid="new-task-agent"]', 'scout')
    await page.click('[data-testid="new-task-submit"]')
    await page.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })

    await expect
      .poll(
        async () => {
          const raw = await readFile(argvFile, 'utf8').catch(() => '[]')
          return (JSON.parse(raw) as string[]).join(' ')
        },
        { timeout: 30_000 }
      )
      .toContain('--agent scout')
  })
})
