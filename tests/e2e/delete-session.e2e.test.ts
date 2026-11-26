import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { realpathNative } from '../../src/main/services/realpath-native'

/**
 * A39「删除会话」E2E。
 *
 * 独立 app 实例 + 独立临时目录（`PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR` /
 * `--user-data-dir` 全指到临时目录）：删除是**真的动文件**的操作，绝不能借用开发机的会话目录。
 *
 * 两个关键做法：
 * 1. `shell.trashItem` 在主进程内被 stub 成「记录路径 + 真删文件」。
 *    只记录路径的 stub 会让 E39-8「重启后仍然不存在」变成内存数组的同义反复 ——
 *    必须在磁盘上真的没了，那条断言才有意义。
 * 2. 一律 poll 到**目标终态**，不用 `waitForSelector`：删除是
 *    「点确认 → IPC → 回收站 → removeTask → 选中下一条 → banner」的多帧过程，
 *    任何中间帧都可能被抓到（`task-delete-confirm` 消失、行消失都是消失型断言）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 被删除的夹具（>64KB 单行记录：走真实规模，不靠小文件蒙混） */
const DELETE_TASK_ID = 'a39-delete'
const DELETE_TITLE = 'A39 待删除的历史任务'
/** 用来验证「删掉选中的任务后自动选中下一条」 */
const SELECTED_TASK_ID = 'a39-selected'
const SELECTED_TITLE = 'A39 被选中的历史任务'
/** 用来验证失败态（列表与文件都不动） */
const FAIL_TASK_ID = 'a39-fail'
const FAIL_TITLE = 'A39 删除会失败的历史任务'

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string
let sessionDir: string
let agentDir: string
let wrapper: string
let deleteFile: string
let selectedFile: string
let failFile: string
/** 夹具的真实路径（长名）：trash 收到的必须是它（8.3/大小写归一之后） */
let deleteFileReal: string
/** live 任务的 taskId（`live:<sessionKey>`） */
let liveTaskId = ''

const fileExists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false
  )

/** 任务行：`<li class="task-row">` 才是「一行」；`task-item` 只是行内的选中按钮 */
const rowByTaskId = (id: string): ReturnType<Page['locator']> =>
  page.locator('li.task-row').filter({
    has: page.locator(`[data-testid="task-item"][data-task-id="${id}"]`)
  })

/** 主进程侧收到的 trashItem 入参（stub 存在 globalThis 上，不受 IPC/renderer 影响） */
const trashedPaths = async (): Promise<string[]> =>
  await app.evaluate(() => {
    const store = globalThis as unknown as { __trashed?: string[] }
    return store.__trashed ?? []
  })

/**
 * 把 `shell.trashItem` 换成「记录 + 真删」。
 *
 * 与 `app.e2e.test.ts` 里 stub `shell.openPath` 同一范式：用 `app.evaluate`
 * 在主进程内替换，不改产品代码。这里必须**真删文件**，否则「重启后不存在」无法验证。
 */
async function stubTrash(): Promise<void> {
  await app.evaluate(({ shell }) => {
    const store = globalThis as unknown as { __trashed: string[] }
    store.__trashed = []
    // 只记录入参并成功返回：**不要**在 `app.evaluate` 里动态 `import('node:fs/promises')` ——
    // 打包后的 main 是 CJS 单文件，动态 import 在这里会 reject（实测直接变成
    // DELETE_FAILED / 详情 UNKNOWN），从而把「删除成功」的用例全部带偏。
    // 真正的落盘删除由测试进程完成（见 E39-4/E39-5 的 unlink），
    // 「重启后仍不存在」依然是对磁盘事实的断言。
    shell.trashItem = (target: string) => {
      store.__trashed.push(target)
      return Promise.resolve()
    }
  })
}

/** 会话 JSONL（docs/session-format.md v3）：header 给 id/cwd，首条用户消息给标题 */
function sessionLines(id: string, title: string, padding = 0): string {
  const content = padding === 0 ? title : `${title} ${'x'.repeat(padding)}`
  return `${[
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-11-26T00:00:00.000Z',
      cwd: workDir
    }),
    JSON.stringify({
      type: 'message',
      id: `${id}-u1`,
      parentId: null,
      timestamp: '2026-11-26T00:00:01.000Z',
      message: { role: 'user', content, timestamp: 1795651201000 }
    }),
    JSON.stringify({
      type: 'message',
      id: `${id}-a1`,
      parentId: `${id}-u1`,
      timestamp: '2026-11-26T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `对 ${id} 的回答` }],
        timestamp: 1795651202000
      }
    })
  ].join('\n')}\n`
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_CODING_AGENT_DIR: agentDir,
      MOCK_PI_DELAY_MS: '20',
      MOCK_PI_REPLY: '好的 已收到',
      // 会话文件放在会话根内：live 任务「结束」后才能降级成可删除的历史任务
      MOCK_PI_SESSION_FILE: join(sessionDir, '--a39--', 'live-session.jsonl')
    }
  })
  const first = await launched.firstWindow()
  await first.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  return { app: launched, page: first }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-delete-session-'))
  agentDir = join(tempRoot, 'agent')
  workDir = join(tempRoot, 'workspace')
  sessionDir = join(tempRoot, 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  // 历史会话必须落在「会话根 / --<path>-- / <name>.jsonl」里
  const groupDir = join(sessionDir, '--a39--')
  await mkdir(groupDir, { recursive: true })

  deleteFile = join(groupDir, 'a39-delete.jsonl')
  selectedFile = join(groupDir, 'a39-selected.jsonl')
  failFile = join(groupDir, 'a39-fail.jsonl')
  // 目标夹具故意 >64KB：索引的头部窗口只有 32KB（v0.16.4 的教训），小文件会绕过真实路径
  await writeFile(deleteFile, sessionLines(DELETE_TASK_ID, DELETE_TITLE, 70 * 1024), 'utf8')
  await writeFile(selectedFile, sessionLines(SELECTED_TASK_ID, SELECTED_TITLE), 'utf8')
  await writeFile(failFile, sessionLines(FAIL_TASK_ID, FAIL_TITLE), 'utf8')
  // Windows 临时目录可能以 8.3 短路径返回，而主进程用 realpathNative 归成长名：比较前先归一
  deleteFileReal = await realpathNative(deleteFile)

  // Windows：走 `.cmd` 包装，与真实 pi.cmd 同一条 spawn 分支（§7 约束 11）
  wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  const started = await launch()
  app = started.app
  page = started.page

  await stubTrash()

  // 原生目录对话框无法自动化：在主进程内替换（不改产品代码）
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, workDir)

  // 造一个 live 任务：E39-1 的「live 行没有删除按钮」与 E39-7 的「结束后变成可删除」都靠它
  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
  await page.click('[data-testid="new-task-pick-directory"]')
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[data-testid="new-task-cwd"]')?.value === expected,
    workDir,
    { timeout: 20_000 }
  )
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="task-end-button"]').length === 1,
    undefined,
    { timeout: 30_000 }
  )
  liveTaskId = await page.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-testid="task-end-button"]')?.dataset['taskId'] ??
      ''
  )
  expect(liveTaskId.length).toBeGreaterThan(0)
}, 180_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('A39 删除会话', () => {
  it('E39-1 结构：历史行有删除按钮、live 行没有；task-item 内部没有任何 button', async () => {
    // 3 条历史夹具 + 1 个 live 任务
    await expect.poll(async () => page.locator('li.task-row').count(), { timeout: 20_000 }).toBe(4)

    const history = rowByTaskId(DELETE_TASK_ID)
    await expect
      .poll(async () => history.locator('[data-testid="task-delete-button"]').count(), {
        timeout: 10_000
      })
      .toBe(1)

    // live 行只有「结束」：两个动作永不同行（结构上排除「把结束当删除」）
    const liveRow = rowByTaskId(liveTaskId)
    expect(await liveRow.locator('[data-testid="task-delete-button"]').count()).toBe(0)
    expect(await liveRow.locator('[data-testid="task-end-button"]').count()).toBe(1)

    // 删除按钮必须是 task-item 的兄弟节点
    expect(
      await page.evaluate(
        () => document.querySelectorAll('[data-testid="task-item"] button').length
      )
    ).toBe(0)
  }, 90_000)

  it('E39-2 确认可取消：点删除 → 确认区出现（含「回收站」）→ 取消后一切照旧', async () => {
    const row = rowByTaskId(DELETE_TASK_ID)
    await row.locator('[data-testid="task-delete-button"]').click()

    const confirm = row.locator('[data-testid="task-delete-confirm"]')
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(1)
    const note = (await confirm.textContent()) ?? ''
    expect(note).toContain('回收站')
    expect(note).toContain('不会影响其他会话')

    await row.locator('[data-testid="task-delete-confirm-no"]').click()

    // 取消 = 零 IPC、零回收站调用、文件原样
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(0)
    expect(await row.count()).toBe(1)
    expect(await trashedPaths()).toEqual([])
    expect(await fileExists(deleteFile)).toBe(true)
  }, 90_000)

  it('E39-3 Esc 取消：焦点仍在「删除」按钮上时按 Esc 也能收起确认区', async () => {
    const row = rowByTaskId(DELETE_TASK_ID)
    const del = row.locator('[data-testid="task-delete-button"]')
    await del.click()

    const confirm = row.locator('[data-testid="task-delete-confirm"]')
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(1)

    // 关键：点击后焦点留在「删除」按钮（不是确认区），Esc 必须仍然生效 ——
    // 这是把监听挂在 li.task-row 而不是确认 div 上的原因。
    await expect.poll(async () => del.evaluate((el) => el === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')

    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(0)
    // Esc 只是收起确认框，绝不能顺手删掉会话
    expect(await trashedPaths()).toEqual([])
    expect(await fileExists(deleteFile)).toBe(true)
  }, 90_000)

  it('E39-4 确认删除：行消失、info 条说明可恢复、trash 收到夹具真实路径', async () => {
    const row = rowByTaskId(DELETE_TASK_ID)
    await row.locator('[data-testid="task-delete-button"]').click()
    await expect
      .poll(async () => row.locator('[data-testid="task-delete-confirm-yes"]').count(), {
        timeout: 10_000
      })
      .toBe(1)
    await row.locator('[data-testid="task-delete-confirm-yes"]').click()

    await expect.poll(async () => row.count(), { timeout: 30_000 }).toBe(0)
    // 主进程只记录了路径；这里由测试进程把文件真删掉，
    // 让「重启后不存在」是对磁盘事实的断言，而不是内存数组的同义反复
    expect(await trashedPaths()).toEqual([deleteFileReal])
    await unlink(deleteFile)
    expect(await fileExists(deleteFile)).toBe(false)

    // 成功不是错误：红条的 message 一定带 `[CODE]` 前缀，这里必须一个都没有
    const bannerText = await page.evaluate(
      () => document.querySelector('[data-testid="error-banner"]')?.textContent ?? ''
    )
    expect(bannerText).toContain('回收站')
    expect(bannerText).not.toContain('[')
    expect(await page.locator('.banner--error').count()).toBe(0)

    // trash 收到的是 realpath 长名（8.3/大小写已归一）
    expect(await trashedPaths()).toEqual([deleteFileReal])
  }, 120_000)

  it('E39-5 删除选中的任务：自动选中另一条，对话区不残留旧任务的消息', async () => {
    const row = rowByTaskId(SELECTED_TASK_ID)
    await row.locator('[data-testid="task-item"]').click()
    await expect
      .poll(async () => row.locator('[data-testid="task-item"]').getAttribute('class'), {
        timeout: 10_000
      })
      .toContain('task-item--active')
    // 先确认回放落到对话区，否则「不残留」这条断言毫无意义
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('[data-testid="msg-user"]')?.textContent ?? ''
          ),
        { timeout: 20_000 }
      )
      .toContain(SELECTED_TITLE)

    await row.locator('[data-testid="task-delete-button"]').click()
    await row.locator('[data-testid="task-delete-confirm-yes"]').click()

    await expect.poll(async () => row.count(), { timeout: 30_000 }).toBe(0)
    await unlink(selectedFile)
    // 恰好一个选中项，且不是被删掉的那个
    await expect
      .poll(async () => page.locator('.task-item--active').count(), { timeout: 20_000 })
      .toBe(1)
    const activeId = await page.evaluate(
      () => document.querySelector<HTMLElement>('.task-item--active')?.dataset['taskId'] ?? ''
    )
    expect(activeId).not.toBe(SELECTED_TASK_ID)
    // 换了一份 chat 状态：被删任务的用户消息不得留在对话区
    await expect
      .poll(
        async () =>
          page.evaluate(
            (title) => document.body.textContent?.includes(title) ?? false,
            SELECTED_TITLE
          ),
        { timeout: 20_000 }
      )
      .toBe(false)
  }, 120_000)

  it('E39-6 失败态：回收站失败 → 红条带 DELETE_FAILED，行与文件都不动', async () => {
    await app.evaluate(({ shell }) => {
      shell.trashItem = () => Promise.reject(new Error('EPERM: operation not permitted'))
    })

    const row = rowByTaskId(FAIL_TASK_ID)
    await row.locator('[data-testid="task-delete-button"]').click()
    await row.locator('[data-testid="task-delete-confirm-yes"]').click()

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('[data-testid="error-banner"]')?.textContent ?? ''
          ),
        { timeout: 20_000 }
      )
      .toContain('DELETE_FAILED')
    // 失败时列表与文件都不变（绝不降级为永久删除）
    expect(await row.count()).toBe(1)
    expect(await fileExists(failFile)).toBe(true)

    // 复位：后续用例与 afterAll 的清理需要「记录 + 真删」的 stub
    await stubTrash()
  }, 120_000)

  it('E39-7 与「结束」互斥：先发一条消息 → 结束 → 同一行出现删除、结束按钮消失', async () => {
    const row = rowByTaskId(liveTaskId)
    await row.locator('[data-testid="task-item"]').click()
    // 先跑一轮：`filePath` 要在结束前由 `session:state` 回填，否则 endTask 会按
    // 「首条消息前结束」把任务整个删掉（另一条合法但不同的路径）
    await page.fill('.composer__input', 'A39 结束前的一轮')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 60_000 })
      .toBe('空闲')

    await row.locator('[data-testid="task-end-button"]').click()
    await row.locator('[data-testid="task-end-confirm-yes"]').click()

    await expect
      .poll(async () => row.locator('[data-testid="task-end-button"]').count(), { timeout: 30_000 })
      .toBe(0)
    await expect
      .poll(async () => row.locator('[data-testid="task-delete-button"]').count(), {
        timeout: 20_000
      })
      .toBe(1)
  }, 150_000)

  it('E39-8 重启后仍不存在：关闭 app，用同一临时目录重新 launch', async () => {
    await app.close()

    const started = await launch()
    app = started.app
    page = started.page

    await expect
      .poll(async () => page.locator('li.task-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
    // 删掉的两条：内存里没了、磁盘上也没了 → 重启后依然不在
    expect(await rowByTaskId(DELETE_TASK_ID).count()).toBe(0)
    expect(await rowByTaskId(SELECTED_TASK_ID).count()).toBe(0)
    // 删失败的那条文件还在 → 重启后必须在列表里（证明确实只删了该删的）
    await expect.poll(async () => rowByTaskId(FAIL_TASK_ID).count(), { timeout: 20_000 }).toBe(1)
  }, 180_000)
})
