import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A36「结束会话」E2E。
 *
 * 独立 app 实例 + 独立临时目录（`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` /
 * `--user-data-dir` 全部指到临时目录）：结束会话会**真的杀掉子进程**，不能借用别的 E2E 的
 * 会话目录/agent 目录，否则既污染开发机，也会让「历史条目」的断言互相干扰。
 *
 * 为什么要 poll 而不是 waitForSelector：
 * - `task-end-button` 是「渲染后的派生结果」，它出现≠状态已经落定（`filePath` 由
 *   `session:state` 回填、`kind` 由 store 归约）。结束流程更明显：点「确认结束」后先
 *   `ending` 置位 → dispose 杀进程 → `evt:status=exited` → detachSession → banner，
 *   中间每一帧都可能被 `waitForSelector` 抓到；只有轮询到**目标终态**才算验证了行为。
 * - 「结束按钮消失」「banner 文本变化」都是**消失型/内容型**断言，天生只能 poll。
 *
 * 为什么断言 `task-item` 内部不能有 button：
 * `task-item` 本身就是一个 `<button>`（点击选中）。把「结束」塞进去会形成
 * button 套 button —— 无效 HTML，且两套点击语义会串味（点结束顺带选中、Enter 触发表单
 * 提交）。这条断言锁住「结束按钮必须是 `task-item` 的兄弟节点」这个结构约束，
 * 只断言「按钮存在」是发现不了回归的。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 历史会话（直接写 JSONL，让 `session:list` 扫到；不必真的跑一轮再重启） */
const HISTORY_TASK_ID = 'a36-history'
const HISTORY_TITLE = 'A36 历史任务的问题'

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string
/** 内存任务的 taskId（`live:<sessionKey>`）——结束后 `task-end-button` 消失，只能靠它定位行 */
let liveTaskId = ''

/** 任务行：`<li class="task-row">` 才是「一行」；`task-item` 只是行内的选中按钮 */
const rowByTaskId = (id: string): ReturnType<Page['locator']> =>
  page.locator('li.task-row').filter({ has: page.locator(`[data-task-id="${id}"]`) })

const liveRow = rowByTaskId
const historyRow = (): ReturnType<Page['locator']> => rowByTaskId(HISTORY_TASK_ID)

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-end-session-'))
  const agentDir = join(tempRoot, 'agent')
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  // 历史会话必须落在「会话根 / --<path>-- / <timestamp>_<id>.jsonl」里
  const groupDir = join(sessionDir, '--a36--')
  await mkdir(groupDir, { recursive: true })

  // 最小可索引的 pi 会话（docs/session-format.md v3）：header 给 id/cwd，用户消息给标题。
  // 直接落盘而不是「跑一轮再重启」：后者需要两次 launch + 竞态，收益为零。
  await writeFile(
    join(groupDir, '2026-11-24T00-00-00_a36-history.jsonl'),
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: HISTORY_TASK_ID,
        timestamp: '2026-11-24T00:00:00.000Z',
        cwd: workDir
      }),
      JSON.stringify({
        type: 'message',
        id: `${HISTORY_TASK_ID}-u1`,
        parentId: null,
        timestamp: '2026-11-24T00:00:01.000Z',
        message: { role: 'user', content: HISTORY_TITLE, timestamp: 1763942401000 }
      }),
      JSON.stringify({
        type: 'message',
        id: `${HISTORY_TASK_ID}-a1`,
        parentId: `${HISTORY_TASK_ID}-u1`,
        timestamp: '2026-11-24T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '历史回答' }],
          timestamp: 1763942402000
        }
      })
    ].join('\n') + '\n',
    'utf8'
  )

  // Windows：走 `.cmd` 包装，与真实 pi.cmd 同一条 spawn 分支（§7 约束 11）
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
      // 一轮要快（E4/E5 各有一次完整回合），但不要 0ms：留一点流式窗口
      MOCK_PI_DELAY_MS: '20',
      MOCK_PI_REPLY: '好的 已收到',
      // 会话文件放在会话根内（结束后的 filePath 就是它，E5 的 resume 也用它）
      MOCK_PI_SESSION_FILE: join(groupDir, 'live-session.jsonl')
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  // 原生目录对话框无法自动化：在主进程内替换（不改产品代码）
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)
}, 180_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('A36 结束会话', () => {
  it('E1 存在性：live 任务有可用的结束按钮，且 task-item 内部没有任何 button', async () => {
    await page.click('[data-testid="new-task-button"]')
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    await page.click('[data-testid="new-task-pick-directory"]')
    // 目录选择走一次 IPC 往返：必须等回填
    await expect
      .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir)
    await page.click('[data-testid="new-task-submit"]')

    // 新建后任务才 live；历史任务也会渲染同一个 testid（禁用态），
    // 所以这里按「可用的那个」定位，数量恰为 1 才说明 live 任务真的拿到了按钮。
    const endButton = page.locator('[data-testid="task-end-button"]:not([disabled])')
    await expect.poll(async () => endButton.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(async () => endButton.isEnabled(), { timeout: 10_000 }).toBe(true)

    liveTaskId = (await endButton.getAttribute('data-task-id')) ?? ''
    expect(liveTaskId.length).toBeGreaterThan(0)

    // 结构约束：结束按钮是 li 里的兄弟节点，绝不能钻进 task-item 内部
    const nestedButtons = await page.evaluate(
      () => document.querySelectorAll('[data-testid="task-item"] button').length
    )
    expect(nestedButtons).toBe(0)

    // 同一行里确实能看到它（兄弟关系成立，而不是被挤出可视区/根本没渲染）
    await expect
      .poll(async () => liveRow(liveTaskId).locator('[data-testid="task-end-button"]').count(), {
        timeout: 10_000
      })
      .toBe(1)
  }, 120_000)

  it('E2 历史任务既不显示结束按钮，也不显示「进行中」（有结束按钮就代表 live）', async () => {
    // 首屏历史条目来自 session:list（异步）：等两行都在，否则断言会跑在空 DOM 上
    await expect.poll(async () => page.locator('li.task-row').count(), { timeout: 20_000 }).toBe(2)

    const history = historyRow()
    await expect.poll(async () => history.count(), { timeout: 10_000 }).toBe(1)
    // 历史条目本身渲染正常（不是「行没出现所以没按钮」）
    expect(await history.locator('[data-testid="task-item"]').count()).toBe(1)
    expect(await history.locator('[data-testid="task-end-button"]').count()).toBe(0)
    expect(await history.locator('.pill').count()).toBe(0)
  }, 60_000)

  it('E3 确认流程可取消：点结束 → 出现确认区（含「中断」「历史」）→ 取消后一切照旧', async () => {
    const row = liveRow(liveTaskId)
    await row.locator('[data-testid="task-end-button"]').click()

    const confirm = row.locator('[data-testid="task-end-confirm"]')
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(1)

    const note = (await confirm.textContent()) ?? ''
    expect(note).toContain('中断')
    expect(note).toContain('历史')

    await row.locator('[data-testid="task-end-confirm-no"]').click()

    // 取消 = 回到原样：确认区消失、结束按钮仍在（它就是 live 标记，不需要 pill 佐证）
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(0)
    await expect
      .poll(async () => row.locator('[data-testid="task-end-button"]').count(), { timeout: 10_000 })
      .toBe(1)
  }, 60_000)

  it('E3b Esc 取消：焦点还在「结束」按钮上时按 Esc 也能收起确认区', async () => {
    const row = liveRow(liveTaskId)
    const end = row.locator('[data-testid="task-end-button"]')
    await end.click()

    const confirm = row.locator('[data-testid="task-end-confirm"]')
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(1)

    // 关键：点击后焦点留在「结束」按钮（不是确认区），Esc 必须仍然生效 ——
    // 这是把监听挂在 li.task-row 而不是确认 div 上的原因。
    await expect.poll(async () => end.evaluate((el) => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')

    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(0)
    // Esc 只是收起确认框，绝不能顺手把会话结束掉
    expect(await end.count()).toBe(1)
  }, 60_000)

  it('E4 结束成功：结束按钮消失、任务降级为历史、banner 说明已结束', async () => {
    const row = liveRow(liveTaskId)
    // 先选中它并发一条消息：`filePath` 要在结束前由 `session:state` 回填，
    // 否则 endTask 会按「首条消息前结束」把任务整个删掉（那是另一条合法但不同的路径）。
    await row.locator('[data-testid="task-item"]').click()
    await page.fill('.composer__input', 'A36 结束前的一轮')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
      .toBe('空闲')

    await row.locator('[data-testid="task-end-button"]').click()
    await expect
      .poll(async () => row.locator('[data-testid="task-end-confirm-yes"]').count(), {
        timeout: 10_000
      })
      .toBe(1)
    await row.locator('[data-testid="task-end-confirm-yes"]').click()

    // 终态：结束按钮消失（dispose → exited → detachSession 后才成立，
    // 降级为历史任务后按「只给 live 渲染」的规则自然不再出现）
    await expect
      .poll(async () => row.locator('[data-testid="task-end-button"]').count(), { timeout: 30_000 })
      .toBe(0)

    // 历史保留：任务行还在（不是被 removeTask 掉），且没有落成红条
    expect(await row.count()).toBe(1)
    expect(await row.locator('[data-testid="task-item"]').count()).toBe(1)

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('[data-testid="error-banner"]')?.textContent ?? ''
          ),
        { timeout: 20_000 }
      )
      .toContain('已结束')
  }, 150_000)

  it('E5 无僵尸键：结束后在同一任务再发一条消息，不出现 SESSION_NOT_FOUND', async () => {
    const before = await page.locator('[data-testid="msg-assistant"]').count()

    await page.fill('.composer__input', '结束后再来一条')
    await page.click('[data-testid="send-button"]')

    /**
     * 两种合法走向：resume 成功（出现新的助手回复并回到空闲），或者 UI 明确引导
     * 「继续对话」；**唯一不允许**的是把死 sessionKey 再拿去 prompt 换回 SESSION_NOT_FOUND。
     * 用一次 evaluate 同时取三个信号，poll 到可判定的终局（而不是「出现即完成」）。
     */
    const outcome = await expect
      .poll(
        async () =>
          page.evaluate((baseline) => {
            const banner = document.querySelector('[data-testid="error-banner"]')?.textContent ?? ''
            if (banner.includes('SESSION_NOT_FOUND')) return 'session-not-found'
            const assistants = document.querySelectorAll('[data-testid="msg-assistant"]').length
            const state = document.querySelector('[data-testid="composer-state"]')?.textContent
            if (assistants > baseline && state === '空闲') return 'resumed'
            return 'pending'
          }, before),
        { timeout: 60_000 }
      )
      .not.toBe('pending')
    void outcome

    const banner = await page.evaluate(
      () => document.querySelector('[data-testid="error-banner"]')?.textContent ?? ''
    )
    expect(banner).not.toContain('SESSION_NOT_FOUND')
  }, 120_000)

  it('E6 回归：双击标题仍进入改名输入框，点击任务行仍切换选中态', async () => {
    // 用**有真实 JSONL** 的历史条目做双击：点它会触发历史回放（文件存在，不会报错）
    const history = historyRow()
    await history.locator('.task-item__title').first().dblclick()
    await expect
      .poll(async () => page.locator('[data-testid="task-rename-input"]').count(), {
        timeout: 10_000
      })
      .toBe(1)
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => page.locator('[data-testid="task-rename-input"]').count(), {
        timeout: 10_000
      })
      .toBe(0)

    // 选中态跟随点击切换（A23 的改名入口不能吃掉行的点击语义）
    await history.locator('[data-testid="task-item"]').click()
    await expect
      .poll(async () => history.locator('[data-testid="task-item"]').getAttribute('class'), {
        timeout: 10_000
      })
      .toContain('task-item--active')
    await expect
      .poll(
        async () => liveRow(liveTaskId).locator('[data-testid="task-item"]').getAttribute('class'),
        {
          timeout: 10_000
        }
      )
      .not.toContain('task-item--active')
  }, 90_000)

  it('E7 历史任务恢复会话后，结束按钮变为可用（kind 必须从 history 升级为 live）', async () => {
    const history = historyRow()
    await expect.poll(async () => history.count(), { timeout: 10_000 }).toBe(1)

    // 恢复前：历史任务根本不渲染结束按钮
    const end = history.locator('[data-testid="task-end-button"]')
    await expect.poll(async () => end.count(), { timeout: 10_000 }).toBe(0)

    await history.locator('[data-testid="task-item"]').click()
    await page.click('[data-testid="continue-conversation"]')

    // 恢复成功后必须升级为 live：结束按钮出现且可用。
    // 只挂 sessionKey 而不改 kind 会让按钮根本不出现（v0.16.1 的真实 bug）。
    await expect.poll(async () => end.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(async () => end.isEnabled(), { timeout: 10_000 }).toBe(true)
  }, 90_000)
})
