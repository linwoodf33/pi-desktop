import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { realpathNative } from '../../src/main/services/realpath-native'

/**
 * Electron E2E（§9.3 E1/E2/E4）——Playwright + 真实打包产物（`out/`）。
 *
 * 前置：
 * - 先 `npm run build`（本用例启动的是 `out/main/index.js`）；
 * - pi 用 `tests/integration/fixtures/mock-pi.mjs` 顶替（`PI_DESKTOP_PI_COMMAND` 指向 .cmd 包装），
 *   并开启 `MOCK_PI_TOOL=1` 让一轮里产生 bash 工具调用（E2 的工具卡片）；
 * - 会话目录用 `PI_CODING_AGENT_SESSION_DIR` 指向临时空目录，避免读到开发机真实会话；
 * - 目录选择是原生对话框，用 `app.evaluate` 在主进程内替换 `dialog.showOpenDialog`（不改产品代码）。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

let app: ElectronApplication
let page: Page
let tempRoot: string
let workDir: string

async function stubDirectoryPicker(target: string): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    // 原生对话框无法自动化：在主进程内替换为固定路径（不改产品代码）
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, target)
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-'))
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  // 真实路径归一：Windows 临时目录可能以 8.3 短路径（`RUNNER~1`）返回，而主进程的路径守卫
  // 用 `realpathNative` 归一成长路径（`runneradmin`）：JS 版 `fs.realpath` 不展开 8.3 短名，
  // 两侧形态不同时，比较产物绝对路径会假红。
  workDir = await realpathNative(workDir)

  // E5 用的历史会话（docs/session-format.md v3）：在 E5 用例里才写入，
  // 否则 E1「首启无历史会话」的前提就不成立。

  // .cmd 包装：走 §7 约束 11 的 cmd.exe 分支（与真实 Windows pi.cmd 同路径）
  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_DELAY_MS: '60',
      // 让一轮持续 ~2s，E4 才有稳定的「运行中」窗口可以点停止
      MOCK_PI_REPLY:
        '已经 列出 当前 目录 内容 如下 请 查看 附件 列表 一共 两个 文件 都 很 正常 没有 异常 继续 保持 已 完成 收尾 结束',
      MOCK_PI_TOOL: '1',
      // mock 的会话文件放在**会话根内**（session:history 的路径校验要求）：
      // B1 的 fork 用例需要它，且文件由 mock 惰性落盘（mock 不写盘）。
      MOCK_PI_SESSION_FILE: join(sessionDir, '--work--', 'mock-session.jsonl')
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 30_000 })
}, 120_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe('E1 首次启动（无配置 / 无历史会话）', () => {
  it('显示空态引导（定位 pi / 新建任务），没有错误条', async () => {
    await page.waitForSelector('[data-testid="empty-state"]', { timeout: 20_000 })
    expect(await page.isVisible('[data-testid="empty-state"]')).toBe(true)
    expect(await page.isVisible('[data-testid="new-task-button"]')).toBe(true)
    // E1：无报错
    expect(await page.isVisible('[data-testid="error-banner"]')).toBe(false)
  })
})

describe('E2 新建任务弹层 → 选目录 → 发消息 → 流式回复 + 工具卡片', () => {
  it('弹层里选目录后建会话、收到流式回复、出现 bash 工具卡片与输出', async () => {
    await stubDirectoryPicker(workDir)
    await page.click('[data-testid="new-task-button"]')

    // M4：新建任务走弹层（目录/模型/档位/会话名），只有目录必填
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    expect(await page.isEnabled('[data-testid="new-task-submit"]')).toBe(false)
    await page.click('[data-testid="new-task-pick-directory"]')
    await expect
      .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir)
    expect(await page.isEnabled('[data-testid="new-task-submit"]')).toBe(true)
    await page.click('[data-testid="new-task-submit"]')

    // 任务创建后输入区可用，且标题/目录来自所选目录
    await page.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })
    expect(await page.textContent('[data-testid="conversation-title"]')).toContain('新任务')

    await page.fill('.composer__input', '列出当前目录')
    await page.click('[data-testid="send-button"]')

    // 用户消息（乐观插入）+ 助手回复
    await page.waitForSelector('[data-testid="msg-user"]', { timeout: 20_000 })
    await page.waitForSelector('[data-testid="msg-assistant"]', { timeout: 30_000 })

    // 工具卡片：名称 + 状态 + 输出
    await page.waitForSelector('[data-testid="tool-card"]', { timeout: 30_000 })
    const card = page.locator('[data-testid="tool-card"]').first()
    await expect.poll(async () => card.getAttribute('data-tool-status')).toBe('success')
    expect(await card.textContent()).toContain('bash')
    expect(await card.textContent()).toContain('a.txt')
    expect(await page.isVisible('[data-testid="error-banner"]')).toBe(false)

    // 一轮结束后回到空闲（只认 agent_settled）
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')
  })
})

describe('E4 点击停止', () => {
  it('300ms 内按钮不可用并提示已中止，随后可继续发送', async () => {
    await page.fill('.composer__input', '再来一轮')
    await page.click('[data-testid="send-button"]')

    // 运行中：停止按钮可用
    await expect
      .poll(async () => page.isEnabled('[data-testid="abort-button"]'), { timeout: 20_000 })
      .toBe(true)

    const startedAt = Date.now()
    await page.click('[data-testid="abort-button"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="composer-state"]')?.textContent === '已中止',
      undefined,
      { timeout: 300 }
    )
    expect(Date.now() - startedAt).toBeLessThan(300)

    // 停止后回到可发送状态
    await expect
      .poll(async () => page.isEnabled('[data-testid="abort-button"]'), { timeout: 20_000 })
      .toBe(false)
    await page.fill('.composer__input', '继续')
    expect(await page.isEnabled('[data-testid="send-button"]')).toBe(true)

    // M4 闭环断言：真的再发一条并收到回复（不只断言按钮 isEnabled）
    const assistantBefore = await page.locator('[data-testid="msg-assistant"]').count()
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 30_000 })
      .toBeGreaterThan(assistantBefore)
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')
  })
})

/**
 * E6（M4 复核修复 B1）：从**第一条用户消息**分叉。
 *
 * pi 在此时建空会话，新会话文件要等下一条 prompt 才落盘。修复前 renderer 立即回放 →
 * `PATH_DENIED` 错误条（与「已分叉」信息条共存）。这里用真实 Electron + 真实 IPC 链路验证：
 * 无错误条、对话区为空（空会话）、能直接发首条消息。
 */
describe('E6 从首条用户消息分叉（B1）', () => {
  it('分叉后是空会话、无 PATH_DENIED 错误条，可直接发送首条消息', async () => {
    // mock 的新会话文件落在会话根的 `--work--` 分组下；目录必须存在（父目录真实路径闸）
    await mkdir(join(tempRoot, 'sessions', '--work--'), { recursive: true })

    // 打开分叉菜单（详情元素展开时才读取 forkPoints）
    await page.click('[data-testid="fork-menu"] summary')
    await page.waitForSelector('[data-testid="fork-point-select"]', { timeout: 20_000 })
    const count = await page.locator('[data-testid="fork-point-select"] option').count()
    expect(count).toBeGreaterThan(0)

    // 选第一条用户消息：UI 要提前说明「会得到一个空会话」
    await page.selectOption('[data-testid="fork-point-select"]', { index: 0 })
    expect(await page.isVisible('[data-testid="fork-first-point-hint"]')).toBe(true)

    await page.click('[data-testid="fork-apply"]')

    // 新任务接管（标题带「分叉」）
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-title"]'), { timeout: 30_000 })
      .toContain('分叉')

    // B1 的可见症状：不能有错误条；只能是「空会话」信息条
    expect(await page.locator('.banner--error').count()).toBe(0)
    await expect
      .poll(async () => page.textContent('.banners'), { timeout: 20_000 })
      .toContain('空会话')

    // 空会话：对话区没有任何消息
    expect(await page.locator('[data-testid="msg-user"]').count()).toBe(0)
    expect(await page.locator('[data-testid="msg-assistant"]').count()).toBe(0)

    // 直接发首条消息：不走 resume，prompt 打到新 sessionKey 并收到回复
    await page.fill('.composer__input', '分叉后的第一句')
    await page.click('[data-testid="send-button"]')
    await page.waitForSelector('[data-testid="msg-user"]', { timeout: 20_000 })
    await expect
      .poll(async () => page.locator('[data-testid="msg-assistant"]').count(), { timeout: 30_000 })
      .toBeGreaterThan(0)
    expect(await page.locator('.banner--error').count()).toBe(0)
  })
})

describe('E5 重开窗口（渲染进程重载）后任务列表仍在、历史完整', () => {
  it('重载后仍列出历史会话，选中即回放（不启动子进程）', async () => {
    // 先写一条真实的历史会话 JSONL（session:list 从这里索引），再重载 renderer
    const group = join(tempRoot, 'sessions', '--work--')
    await mkdir(group, { recursive: true })
    await writeFile(
      join(group, '2026-11-20T00-00-00_e5-session.jsonl'),
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'e5-session',
          timestamp: '2026-11-20T00:00:00.000Z',
          cwd: workDir
        }),
        JSON.stringify({
          type: 'message',
          id: 'e5-a1',
          parentId: null,
          timestamp: '2026-11-20T00:00:01.000Z',
          message: { role: 'user', content: '历史任务的问题', timestamp: 1735689601000 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'e5-a2',
          parentId: 'e5-a1',
          timestamp: '2026-11-20T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '历史回答' }],
            timestamp: 1735689602000
          }
        })
      ].join('\n') + '\n',
      'utf8'
    )

    // 重载等价于关掉窗口再打开：主进程与本地会话索引不变，renderer 重新 boot
    await page.reload()
    await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 30_000 })

    await page.waitForSelector('[data-testid="task-list"]', { timeout: 20_000 })
    const item = page.locator('[data-testid="task-item"]').filter({ hasText: '历史任务的问题' })
    await expect.poll(async () => item.count(), { timeout: 20_000 }).toBeGreaterThan(0)
    await item.first().click()

    // 历史回放：用户消息与助手回复都在，且没有运行中的 pi 进程（需先「继续对话」）
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 20_000
      })
      .toContain('历史任务的问题')
    await expect
      .poll(async () => page.textContent('[data-testid="conversation-scroll"]'), {
        timeout: 20_000
      })
      .toContain('历史回答')
    expect(await page.isVisible('[data-testid="continue-conversation"]')).toBe(true)
    expect(await page.isVisible('[data-testid="error-banner"]')).toBe(false)
  })
})

/**
 * E3 审批（M5）：真实 Electron + 真实 IPC + 真实子进程，mock pi 模拟扩展的审批协议。
 *
 * 两条链路（验收要求）：
 * 1. 「允许一次」→ 工具真的执行（工具卡片 success + 输出可见）；
 * 2. 「拒绝」→ 工具未执行（工具结果里写明被拒绝，且看不到真实输出）。
 *
 * 为什么单独起一个 Electron 实例：审批模式需要不同的子进程环境（`MOCK_PI_APPROVAL=1`），
 * 而第一个实例的 env 在 beforeAll 里已固定。单实例锁按 userData 目录隔离，所以换一个
 * `--user-data-dir` 即可并行运行。
 */
describe('E3 工具审批（允许 / 拒绝）', () => {
  let app2: ElectronApplication
  let page2: Page
  let tempRoot2: string
  let workDir2: string

  beforeAll(async () => {
    tempRoot2 = await mkdtemp(join(tmpdir(), 'pi-desktop-e2e-approval-'))
    workDir2 = join(tempRoot2, 'workspace')
    const sessionDir2 = join(tempRoot2, 'sessions')
    await mkdir(workDir2, { recursive: true })
    await mkdir(sessionDir2, { recursive: true })

    const wrapper = join(tempRoot2, 'mock-pi.cmd')
    await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

    app2 = await electron.launch({
      // 与第一个实例不同的 userData → 单实例锁不冲突
      args: ['.', `--user-data-dir=${join(tempRoot2, 'userdata')}`],
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PI_DESKTOP_PI_COMMAND: wrapper,
        PI_CODING_AGENT_SESSION_DIR: sessionDir2,
        MOCK_PI_DELAY_MS: '20',
        MOCK_PI_REPLY: '好的 已经 完成',
        MOCK_PI_TOOL: '1',
        // 开启审批模拟：工具执行前先发 extension_ui_request 并阻塞等待
        MOCK_PI_APPROVAL: '1',
        MOCK_PI_APPROVAL_TIMEOUT_MS: '10000',
        MOCK_PI_SESSION_FILE: join(sessionDir2, '--work--', 'mock-session.jsonl')
      }
    })
    page2 = await app2.firstWindow()
    await page2.waitForSelector('[data-testid="bridge-status"]', { timeout: 30_000 })

    await app2.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
    }, workDir2)
  }, 120_000)

  afterAll(async () => {
    await app2?.close().catch(() => {})
    if (tempRoot2 !== undefined)
      await rm(tempRoot2, { recursive: true, force: true }).catch(() => {})
  })

  /** 新建任务并等到输入区可用 */
  async function createTask(): Promise<void> {
    await page2.click('[data-testid="new-task-button"]')
    await page2.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    await page2.click('[data-testid="new-task-pick-directory"]')
    await expect
      .poll(async () => page2.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir2)
    await page2.click('[data-testid="new-task-submit"]')
    await page2.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })
  }

  it('弹出审批窗 → 点「允许一次」→ 工具执行成功', async () => {
    await createTask()

    await page2.fill('.composer__input', '列出目录')
    await page2.click('[data-testid="send-button"]')

    // 审批弹窗：工具名、风险、参数摘要都在
    await page2.waitForSelector('[data-testid="approval-dialog"]', { timeout: 30_000 })
    expect(await page2.textContent('[data-testid="approval-tool"]')).toContain('bash')
    expect(await page2.textContent('[data-testid="approval-summary"]')).toContain('ls -la')

    // 参数可展开
    await page2.click('[data-testid="approval-expand"]')
    await page2.waitForSelector('[data-testid="approval-args"]', { timeout: 10_000 })

    await page2.click('[data-testid="approval-allow-once"]')
    await expect
      .poll(async () => page2.isVisible('[data-testid="approval-dialog"]'), { timeout: 15_000 })
      .toBe(false)

    // 工具真的执行了
    await page2.waitForSelector('[data-testid="tool-card"]', { timeout: 30_000 })
    const card = page2.locator('[data-testid="tool-card"]').first()
    await expect.poll(async () => card.getAttribute('data-tool-status')).toBe('success')
    expect(await card.textContent()).toContain('a.txt')
    expect(await page2.locator('.banner--error').count()).toBe(0)
  })

  it('再次审批 → 点「拒绝」→ 工具未执行', async () => {
    await page2.fill('.composer__input', '再列一次')
    await page2.click('[data-testid="send-button"]')

    await page2.waitForSelector('[data-testid="approval-dialog"]', { timeout: 30_000 })
    await page2.click('[data-testid="approval-deny"]')
    await expect
      .poll(async () => page2.isVisible('[data-testid="approval-dialog"]'), { timeout: 15_000 })
      .toBe(false)

    // 工具被阻止：最后一张工具卡片是 error，且内容里没有真实输出
    await expect
      .poll(
        async () => {
          const cards = page2.locator('[data-testid="tool-card"]')
          const count = await cards.count()
          if (count === 0) return 'none'
          return (await cards.nth(count - 1).getAttribute('data-tool-status')) ?? 'none'
        },
        { timeout: 30_000 }
      )
      .toBe('error')
    const last = page2.locator('[data-testid="tool-card"]').last()
    expect(await last.textContent()).toContain('拒绝')
    expect(await page2.locator('.banner--error').count()).toBe(0)
  })
})

/**
 * E10 产物面板（M6）：会话结束后自动扫描 → 选中显示 diff → 「用系统程序打开」经过确认 →
 * 文件清理后再刷新列表回到空态。
 *
 * 为什么 stub `shell.openPath`：E2E 不应真的调起记事本/Excel；
 * 用 `app.evaluate` 在主进程内替换（不改产品代码），断言**传给 openPath 的路径**
 * 正好是被校验过的工作区文件（这同时证明「本地校验是唯一防线」时它确实生效）。
 */
describe('E10 产物 diff 与系统程序打开（M6）', () => {
  it('settled 后自动扫描出变更 → diff 可见 → 确认后调起系统程序 → 清理后回到空态', async () => {
    // 主进程侧记录 openPath 的入参（不真开窗口）
    await app.evaluate(({ shell }) => {
      const store = globalThis as unknown as { __openedPaths: string[] }
      store.__openedPaths = []
      shell.openPath = (target: string) => {
        store.__openedPaths.push(target)
        return Promise.resolve('')
      }
    })

    // 新建任务（目录对话框已被 stub 到 workDir）
    await stubDirectoryPicker(workDir)
    await page.click('[data-testid="new-task-button"]')
    await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 20_000 })
    await page.click('[data-testid="new-task-pick-directory"]')
    await expect
      .poll(async () => page.inputValue('[data-testid="new-task-cwd"]'), { timeout: 10_000 })
      .toBe(workDir)
    await page.click('[data-testid="new-task-submit"]')
    await page.waitForSelector('[data-testid="task-item"]', { timeout: 20_000 })

    // 会话开始快照已建立（evt:status=starting）；此后写入的文件应被识别为「新增」
    const artifactFile = join(workDir, 'artifact-e10.txt')
    await writeFile(artifactFile, 'hello artifact\n', 'utf8')

    // 发一条消息 → agent_settled → 产物自动扫描（不轮询）
    await page.fill('.composer__input', '完成')
    await page.click('[data-testid="send-button"]')
    await expect
      .poll(async () => page.textContent('[data-testid="composer-state"]'), { timeout: 30_000 })
      .toBe('空闲')

    // 列表出现该文件，并标注「非 git 工作区，快照比对」
    const item = page
      .locator('[data-testid="artifact-item"]')
      .filter({ hasText: 'artifact-e10.txt' })
    await expect.poll(async () => item.count(), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect
      .poll(async () => page.textContent('[data-testid="artifacts-mode"]'), { timeout: 20_000 })
      .toContain('非 git 工作区')

    // 选中 → diff 可见（新增文件 = 全是 + 行）
    await item.first().click()
    await expect
      .poll(async () => page.textContent('[data-testid="diff-view"]'), { timeout: 20_000 })
      .toContain('hello artifact')
    expect(await page.locator('[data-testid="diff-truncated"]').count()).toBe(0)

    // 「打开」→ 二次确认 → 主进程收到 openPath
    await page.click('[data-testid="artifact-open"]')
    await page.waitForSelector('[data-testid="artifact-open-confirm"]', { timeout: 10_000 })
    await page.click('[data-testid="artifact-open-confirm-yes"]')

    await expect
      .poll(
        async () =>
          app.evaluate(() => {
            const store = globalThis as unknown as { __openedPaths?: string[] }
            return store.__openedPaths ?? []
          }),
        { timeout: 20_000 }
      )
      .toEqual([artifactFile])

    // 清理临时文件 → 手动刷新 → 条目消失，回到空态。
    //
    // 语义说明（与 git 一致）：产物列表是「相对**会话开始**的变更」。
    // 这个文件在会话开始快照之后才出现、随即被删除，两个时点都没有它 → 不该再列出。
    await rm(artifactFile, { force: true })
    await page.click('[data-testid="artifacts-refresh"]')
    await expect.poll(async () => item.count(), { timeout: 20_000 }).toBe(0)
    await expect
      .poll(async () => page.isVisible('[data-testid="artifacts-empty"]'), { timeout: 20_000 })
      .toBe(true)

    expect(await page.locator('.banner--error').count()).toBe(0)
  })
})

describe('E13 浅色主题下的工具卡片与代码块（v0.3.1 回归）', () => {
  /**
   * 真实缺陷：`.tool-card__output pre` 的底色曾写死成近黑色，主题切浅色后
   * 文字是深色 → 黑底黑字，工具调用输出完全不可读。
   *
   * 这里用**浏览器算出来的颜色**复验：浅色主题下代码块 / 工具输出的
   * 底色必须是浅色，且与文字对比度 ≥ 4.5。
   */
  interface SurfaceReading {
    background: string
    color: string
    contrast: number
    backgroundLuminance: number
  }

  async function readSurface(selector: string): Promise<SurfaceReading | undefined> {
    return page.evaluate((target) => {
      const element = document.querySelector(target)
      if (element === null) return undefined
      const parse = (value: string): [number, number, number] => {
        const match = /rgba?\(([^)]+)\)/.exec(value)
        const parts = (match?.[1] ?? '0,0,0').split(',').map((item) => Number(item.trim()))
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
      }
      const luminance = (rgb: [number, number, number]): number => {
        const [r, g, b] = rgb.map((channel) => {
          const value = channel / 255
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        }) as [number, number, number]
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      // 背景可能是透明的（继承自父级）→ 向上找到第一个不透明的祖先
      let node: Element | null = element
      let background = 'rgba(0, 0, 0, 0)'
      while (node !== null) {
        const value = getComputedStyle(node).backgroundColor
        if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') {
          background = value
          break
        }
        node = node.parentElement
      }
      const color = getComputedStyle(element).color
      const bgLum = luminance(parse(background))
      const textLum = luminance(parse(color))
      const [high, low] = [bgLum, textLum].sort((a, b) => b - a) as [number, number]
      return {
        background,
        color,
        contrast: (high + 0.05) / (low + 0.05),
        backgroundLuminance: bgLum
      }
    }, selector)
  }

  async function setTheme(id: string): Promise<void> {
    const toggle = page.locator('.settings-toggle')
    const open = await toggle.evaluate((element) => (element as HTMLDetailsElement).open)
    if (!open) await page.click('.settings-toggle > summary')
    await page.waitForSelector('[data-testid="settings-theme"]', { timeout: 20_000 })
    await page.selectOption('[data-testid="settings-theme"]', id)
    await page.click('[data-testid="settings-save"]')
    await page.waitForFunction((want) => document.documentElement.dataset['theme'] === want, id, {
      timeout: 20_000
    })
    if (open) await page.click('.settings-toggle > summary')
  }

  it('切到 pi-light 后工具输出与代码块不出现黑底黑字', async () => {
    // 确保当前有工具卡片可测：上一轮 mock 会产出一条工具调用
    await page.fill('.composer__input', '再跑一次工具调用')
    await page.click('[data-testid="send-button"]')
    await page.waitForSelector('[data-testid="tool-card__output"], .tool-card__output', {
      timeout: 60_000
    })
    await page.waitForFunction(
      () => document.querySelector('[data-testid="composer-state"]')?.textContent === '空闲',
      undefined,
      { timeout: 60_000 }
    )

    await setTheme('pi-light')

    const output = await readSurface('.tool-card__output pre')
    expect(output, '未找到工具输出的代码块').toBeDefined()
    if (output === undefined) return
    // 浅色主题的代码块底色必须亮（原缺陷是近黑 #0b0e12，亮度 ≈0.006）
    expect(output.backgroundLuminance).toBeGreaterThan(0.5)
    expect(
      output.contrast,
      `工具输出 contrast=${output.contrast}（${output.background} / ${output.color}）`
    ).toBeGreaterThanOrEqual(4.5)

    const code = await readSurface('.md pre')
    if (code !== undefined) {
      expect(code.backgroundLuminance).toBeGreaterThan(0.5)
      expect(code.contrast).toBeGreaterThanOrEqual(4.5)
    }

    // 还原主题，避免影响后续用例
    await setTheme('pi-dark')
  })
})
