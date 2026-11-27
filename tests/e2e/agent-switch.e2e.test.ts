import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A40：Composer 底部的「专家」下拉 + 运行中切换。
 *
 * 独立实例 + 独立临时目录（`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` /
 * `--user-data-dir`）：切换会写会话文件，不能借用别的 E2E 的会话目录。
 *
 * 这里守四件容易出错的事：
 * 1. 切换真的发出去了（mock 落 `MOCK_PI_AGENT_SWITCH_FILE`），而不是只改 UI；
 * 2. 扩展把 `active_agent` 条目写进会话文件（重进会话仍生效的事实来源）；
 * 3. 选「默认」发的是 `/agent none`，文件里是 `name:null`；
 * 4. 历史回放 / 未注册 `--agent` 时控件**常驻禁用**（A33：不静默消失）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const HISTORY_ID = 'a40-history'
const HISTORY_TITLE = 'A40 历史任务（只读回放）'

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string
let sessionFile: string
let switchFile: string

const agentText = async (target: Page): Promise<string> =>
  (await target.textContent('[data-testid="composer-agent"]')) ?? ''

/** 建任务（目录对话框已 stub 到 workDir） */
async function createTask(target: Page): Promise<void> {
  await target.click('[data-testid="new-task-button"]')
  await target.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await target.click('[data-testid="new-task-pick-directory"]')
  await expect
    .poll(async () => target.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
    .toBe(workDir)
  await target.click('[data-testid="new-task-submit"]')
  await target.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-agent-switch-'))
  const agentDir = join(tempRoot, 'agent')
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  const groupDir = join(sessionDir, '--work--')
  await mkdir(join(agentDir, 'agents', 'team'), { recursive: true })
  await mkdir(workDir, { recursive: true })
  await mkdir(groupDir, { recursive: true })
  sessionFile = join(groupDir, 'live-session.jsonl')
  switchFile = join(tempRoot, 'agent-switch.log')

  await writeFile(
    join(agentDir, 'agents', 'scout.md'),
    '---\nname: scout\ndescription: 快速侦察代码\nmode: primary\n---\n\n你是侦察兵。\n',
    'utf8'
  )
  await writeFile(
    join(agentDir, 'agents', 'team', 'child.md'),
    '---\nname: child\ndescription: 子专家\nmode: all\n---\n\n你是子专家。\n',
    'utf8'
  )

  // 历史会话（只读回放：没有活会话 → 切换控件必须禁用）
  await writeFile(
    join(groupDir, `2026-11-24T00-00-00_${HISTORY_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: HISTORY_ID,
        timestamp: '2026-11-24T00:00:00.000Z',
        cwd: workDir
      }),
      JSON.stringify({
        type: 'message',
        id: `${HISTORY_ID}-u1`,
        parentId: null,
        timestamp: '2026-11-24T00:00:01.000Z',
        message: { role: 'user', content: HISTORY_TITLE, timestamp: 1763942401000 }
      })
    ].join('\n') + '\n',
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
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_SESSION_FILE: sessionFile,
      MOCK_PI_AGENT_SWITCH_FILE: switchFile,
      // 一轮要够慢，才有一个稳定的「运行中」窗口验证 apply 禁用
      MOCK_PI_DELAY_MS: '120',
      MOCK_PI_REPLY: '第一段 第二段 第三段 第四段 第五段 第六段 第七段 第八段 第九段 收尾'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
}, 180_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('A40：运行中切换专家', () => {
  it('展开下拉 → 选 scout → 切换：Composer 变「专家：scout」，mock 收到 /agent scout 且写入会话文件', async () => {
    await createTask(page)

    await page.click('[data-testid="composer-agent"]')
    const select = page.locator('[data-testid="agent-switch-select"]')
    // 目录懒加载：首次展开才跑 agents:list（pi --help 探测有缓存）
    await expect.poll(async () => select.isEnabled(), { timeout: 30_000 }).toBe(true)
    const readOptions = async (): Promise<string[]> =>
      select
        .locator('option')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))
    await expect.poll(async () => (await readOptions()).length, { timeout: 30_000 }).toBe(3)
    expect(await readOptions()).toEqual(['', 'scout', 'child'])

    await select.selectOption('scout')
    await page.click('[data-testid="agent-switch-apply"]')

    await expect.poll(async () => agentText(page), { timeout: 30_000 }).toBe('专家：scout')
    // 真的发出去了（不是只改 UI）
    await expect
      .poll(async () => readFile(switchFile, 'utf8').catch(() => ''), { timeout: 30_000 })
      .toContain('scout')
    // 扩展把 active_agent 条目写进会话文件（重进会话仍生效的事实来源）
    await expect
      .poll(async () => readFile(sessionFile, 'utf8').catch(() => ''), { timeout: 30_000 })
      .toContain('"customType":"active_agent"')
    const jsonl = await readFile(sessionFile, 'utf8')
    expect(jsonl).toContain('"name":"scout"')
  }, 120_000)

  it('选「默认」→ 发 /agent none，会话文件出现 name:null', async () => {
    await page.click('[data-testid="composer-agent"]')
    const select = page.locator('[data-testid="agent-switch-select"]')
    await select.selectOption('')
    await page.click('[data-testid="agent-switch-apply"]')

    await expect.poll(async () => agentText(page), { timeout: 30_000 }).toBe('专家：默认')
    await expect
      .poll(async () => readFile(switchFile, 'utf8').catch(() => ''), { timeout: 30_000 })
      .toContain('none')
    await expect
      .poll(async () => readFile(sessionFile, 'utf8').catch(() => ''), { timeout: 30_000 })
      .toContain('"name":null')
  }, 120_000)

  it('发送中「切换」禁用；本轮结束后恢复', async () => {
    await page.fill('.composer__input', '跑一轮慢的')
    await page.click('[data-testid="send-button"]')

    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .not.toBe('空闲')
    expect(await page.isDisabled('[data-testid="agent-switch-apply"]')).toBe(true)

    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
      .toBe('空闲')
    await expect
      .poll(async () => page.isDisabled('[data-testid="agent-switch-apply"]'), { timeout: 30_000 })
      .toBe(false)
  }, 120_000)

  it('历史任务：控件常驻但禁用，hint 引导「继续对话」', async () => {
    const row = page
      .locator('li.task-row')
      .filter({ has: page.locator(`[data-task-id="${HISTORY_ID}"]`) })
    await expect.poll(async () => row.count(), { timeout: 20_000 }).toBe(1)
    await row.locator('[data-testid="task-item"]').click()

    await expect.poll(async () => agentText(page), { timeout: 20_000 }).toBe('专家：默认')
    expect(await page.isDisabled('[data-testid="agent-switch-apply"]')).toBe(true)
    const hint = (await page.textContent('[data-testid="agent-switch-hint"]')) ?? ''
    expect(hint).toContain('继续对话')
  }, 60_000)
})

describe('A33/A40：未注册 --agent 时控件仍常驻（不静默消失）', () => {
  it('MOCK_PI_HELP_HAS_AGENT=0 → 下拉禁用，hint 说明要装 pi-open-agents', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-agent-switch-unsupported-'))
    const agentDir2 = join(root2, 'agent')
    const workDir2 = join(root2, 'workspace')
    const sessionDir2 = join(root2, 'sessions')
    await mkdir(join(agentDir2, 'agents'), { recursive: true })
    await mkdir(workDir2, { recursive: true })
    await mkdir(sessionDir2, { recursive: true })
    await writeFile(
      join(agentDir2, 'agents', 'scout.md'),
      '---\nname: scout\nmode: primary\n---\n\n正文\n',
      'utf8'
    )
    const wrapper2 = join(root2, 'mock-pi.cmd')
    await writeFile(wrapper2, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

    const app2 = await electron.launch({
      args: ['.', `--user-data-dir=${join(root2, 'userdata')}`],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PI_DESKTOP_PI_COMMAND: wrapper2,
        PI_CODING_AGENT_DIR: agentDir2,
        PI_CODING_AGENT_SESSION_DIR: sessionDir2,
        MOCK_PI_HELP_HAS_AGENT: '0'
      }
    })
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
      await app2.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
      }, workDir2)

      await page2.click('[data-testid="new-task-button"]')
      await page2.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
      await page2.click('[data-testid="new-task-pick-directory"]')
      await expect
        .poll(async () => page2.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
        .toBe(workDir2)
      await page2.click('[data-testid="new-task-submit"]')
      await page2.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })

      await page2.click('[data-testid="composer-agent"]')
      const hintLoc = page2.locator('[data-testid="agent-switch-hint"]')
      await expect
        .poll(async () => (await hintLoc.textContent()) ?? '', { timeout: 30_000 })
        .toContain('pi-open-agents')
      expect(await page2.isDisabled('[data-testid="agent-switch-select"]')).toBe(true)
      expect(await page2.isDisabled('[data-testid="agent-switch-apply"]')).toBe(true)
    } finally {
      await app2.close().catch(() => {})
      await rm(root2, { recursive: true, force: true }).catch(() => {})
    }
  }, 180_000)
})
