import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A38：输入框下方显示「当前 agent」。
 *
 * 为什么要单独一套 app：agent 名字来自会话文件里的 `open-agents-state` 条目
 * （`get_state` 不返回 agent），必须让 mock 真的把条目写进 `MOCK_PI_SESSION_FILE`，
 * 才能覆盖「主进程读文件 → session:state 返回 → store → Composer」这条完整链路。
 *
 * 两个独立性：
 * - `MOCK_PI_AGENT_STATE=scout`（写 scout）与 `__null__`（写 null，表示显式清除）各起一个
 *   Electron 实例 —— 条目在进程启动时写一次，不能在同一实例里中途改。
 * - `PI_CODING_AGENT_DIR` 指到临时目录并在里面放一个 `scout` agent 定义，
 *   否则新建任务弹层的 agent 选择器会因「未注册 --agent」被禁用。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

interface Launched {
  app: ElectronApplication
  page: Page
  root: string
}

async function launch(agentState?: string): Promise<Launched> {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-agent-display-'))
  const agentDir = join(root, 'agent')
  const workDir = join(root, 'workspace')
  const sessionDir = join(root, 'sessions')
  await mkdir(join(agentDir, 'agents'), { recursive: true })
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  // 一个可选的用户级 agent（pi 格式：frontmatter + 正文）
  await writeFile(
    join(agentDir, 'agents', 'scout.md'),
    '---\nname: scout\ndescription: 快速侦察代码\nmode: primary\n---\n\n你是侦察兵。\n',
    'utf8'
  )

  const wrapper = join(root, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(root, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_SESSION_FILE: join(sessionDir, 'mock-session.jsonl'),
      // 不传就完全不注入：mock 不写 marker，验证「未知 → 显示默认」这条路径
      ...(agentState === undefined ? {} : { MOCK_PI_AGENT_STATE: agentState })
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  // 目录选择由主进程弹原生对话框：直接打桩到临时工作区
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
  return { app, page, root }
}

async function createTask(page: Page, agent?: 'scout'): Promise<void> {
  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await page.click('[data-testid="new-task-pick-directory"]')

  if (agent !== undefined) {
    const select = page.locator('[data-testid="new-task-agent"]')
    // 能力探测要跑一次 `pi --help`，选择器可能在加载中被禁用
    await expect.poll(async () => select.isEnabled(), { timeout: 30_000 }).toBe(true)
    await select.selectOption(agent)
  }
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
}

const agentText = async (page: Page): Promise<string> =>
  (await page.textContent('[data-testid="composer-agent"]')) ?? ''

describe('A38：输入区显示 agent（文件 marker = scout）', () => {
  let launched: Launched | undefined

  beforeAll(async () => {
    launched = await launch('scout')
  }, 180_000)

  afterAll(async () => {
    await launched?.app.close()
    if (launched !== undefined) await rm(launched.root, { recursive: true, force: true })
  })

  it('E1 选 scout 建任务 → 输入区显示 agent：scout，且既有状态文字仍在', async () => {
    const { page } = launched as Launched
    await createTask(page, 'scout')

    await expect.poll(async () => agentText(page), { timeout: 30_000 }).toContain('scout')
    // A40：文案前缀锁定为「专家：」（旧文案「agent：」不得回归）
    expect(await agentText(page)).toMatch(/^专家：/)
    // 回归：agent 与 composer-state 是同一个分组里的两个元素，不能互相挤掉
    expect(await page.textContent('[data-testid="composer-state"]')).not.toBeNull()
    // A39：状态颜色靠 data-phase 驱动（CSS 按 phase 上色），必须真的有这个属性
    expect(await page.getAttribute('[data-testid="composer-state"]', 'data-phase')).toBeTruthy()
    // A39：顶部那份重复的状态徽标已删除，只剩输入区这一处
    expect(await page.locator('[data-testid="run-phase"]').count()).toBe(0)
  }, 90_000)
})

describe('A38：文件里显式清除（marker name=null）', () => {
  let launched: Launched | undefined

  beforeAll(async () => {
    launched = await launch('__null__')
  }, 180_000)

  afterAll(async () => {
    await launched?.app.close()
    if (launched !== undefined) await rm(launched.root, { recursive: true, force: true })
  })

  it('E3 create 传 scout，但会话文件声明 name:null → 收敛回「默认」', async () => {
    const { page } = launched as Launched
    await createTask(page, 'scout')

    // 入参先占位 scout，随后 syncTaskState 读文件得到 null → 清除
    await expect.poll(async () => agentText(page), { timeout: 30_000 }).toContain('默认')
  }, 90_000)
})

describe('A38：无 marker（未知）→ 显示「默认」', () => {
  let launched: Launched | undefined

  beforeAll(async () => {
    launched = await launch()
  }, 180_000)

  afterAll(async () => {
    await launched?.app.close()
    if (launched !== undefined) await rm(launched.root, { recursive: true, force: true })
  })

  it('E2 不选 agent 建任务、文件里也没有 marker → 显示「默认」', async () => {
    const { page } = launched as Launched
    await createTask(page)

    await expect.poll(async () => agentText(page), { timeout: 30_000 }).toContain('默认')
  }, 90_000)
})
