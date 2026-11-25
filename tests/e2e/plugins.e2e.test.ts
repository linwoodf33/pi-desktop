import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * A37：插件（pi package）面板 E2E。
 *
 * 三件事必须做对，否则要么污染开发机、要么断言的是假事实：
 *
 * 1. **完全隔离**：`PI_CODING_AGENT_DIR`（清单 + 安装复验的唯一目录事实）、
 *    `PI_CODING_AGENT_SESSION_DIR`、`--user-data-dir` 全部指到本文件自己的临时目录。
 *    插件清单读的就是 `<agentDir>/settings.json`，与 `~/.pi/agent` 混用会读到开发机
 *    真实安装的包，"清单里只有这两条"这种断言就彻底失去意义。
 * 2. **`MOCK_PI_AGENT_DIR` 必须与 `PI_CODING_AGENT_DIR` 同一个目录**：mock 的 install 分支
 *    会把「装上了」写成磁盘事实（改 `settings.json` + 建 `npm/node_modules/<pkg>`），而
 *    主进程安装完要**回读同一个 `settings.json` 复验**。两边不是同一目录时，exit 0 也会
 *    被复验判成「pi 报告成功但未出现该声明」——那不是被测行为，而是夹具接错。
 * 3. **registry 指向一个关闭的端口**：E6 要验证「预览失败不阻断安装」，不能真的去打
 *    公网 npm。`resolveRegistryBase` 只对 **本机 host** 的 `http` 覆盖放行，所以给
 *    `http://127.0.0.1:<已释放端口>` 就得到一个必定 ECONNREFUSED 的 registry，
 *    而且不依赖任何本地服务是否还活着（比「返回 500 的 server」少一份状态）。
 *
 * 为什么全程 `expect.poll`：清单是 IPC 异步读回来的、安装结果要等子进程退出 + 复验，
 * 面板里的 `plugins-install-result` / `plugin-item` 都是**派生渲染**。
 * `waitForSelector` 只能等到"某个瞬间存在"，抓不到"装完并刷新后的清单"这种目标终态。
 */
const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')

/** 预置的两个包：一个有 description、一个没有（验证 `plugin-desc` 的条件渲染） */
const MOCK_PKG = {
  name: 'pi-mock',
  version: '1.2.3',
  description: 'mock 插件说明'
}
const NODESC_PKG = { name: 'pi-nodesc', version: '0.0.1' }

/** 主组 app 的 registry 覆盖地址（端口在 `beforeAll` 里预留后立刻释放 → 必定连接被拒） */
let closedRegistryUrl = ''

/**
 * 读文本时必须容忍「元素还没渲染」：面板大部分区块是条件渲染的（`plugins-install-result`
 * 在安装完成前根本不存在）。直接 `textContent()` 会抛 not-found，在 `expect.poll` 里
 * 就变成一次硬失败而不是重试。
 */
async function textOf(target: Page, selector: string): Promise<string> {
  const locator = target.locator(selector).first()
  if ((await locator.count()) === 0) return ''
  return (await locator.textContent()) ?? ''
}

/** 取一个「现在空闲、之后也没人监听」的本机端口（listen 后立刻 close） */
async function reserveClosedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('没能拿到本机端口')
  }
  const { port } = address
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
  return port
}

interface LaunchedApp {
  app: ElectronApplication
  page: Page
  tempRoot: string
  agentDir: string
  settingsFile: string
  /** mock 收到的 argv 落盘位置（断言「恰好两个参数」/「零 spawn」的唯一证据） */
  argvFile: string
}

/**
 * 起一个完全隔离的实例。两组用例（有登记 / 空清单）各调用一次。
 *
 * `settings` 是本例的唯一入口差异：主组预置两条登记，空清单组给 `packages: []`。
 */
async function launchApp(tag: string, settings: unknown): Promise<LaunchedApp> {
  const tempRoot = await mkdtemp(join(tmpdir(), `pi-desktop-e2e-plugins-${tag}-`))
  const agentDir = join(tempRoot, 'agent')
  const sessionDir = join(tempRoot, 'sessions')
  const argvFile = join(tempRoot, 'install-argv.json')
  const settingsFile = join(agentDir, 'settings.json')

  await mkdir(agentDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  // 受管目录里的两个包：catalog 的 name/version/description 全部来自这里的 package.json
  const mockDir = join(agentDir, 'npm', 'node_modules', MOCK_PKG.name)
  const nodescDir = join(agentDir, 'npm', 'node_modules', NODESC_PKG.name)
  await mkdir(mockDir, { recursive: true })
  await mkdir(nodescDir, { recursive: true })
  await writeFile(join(mockDir, 'package.json'), `${JSON.stringify(MOCK_PKG, null, 2)}\n`, 'utf8')
  await writeFile(
    join(nodescDir, 'package.json'),
    `${JSON.stringify(NODESC_PKG, null, 2)}\n`,
    'utf8'
  )

  // 登记项就是「用户意图」；目录是否真的存在由上面两步决定
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')

  // Windows：走 `.cmd` 包装，与真实 pi.cmd 同一条 spawn 分支（§7 约束 11）
  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      // mock 的 install 分支把「装上了」写到这个目录（必须与 PI_CODING_AGENT_DIR 相同）
      MOCK_PI_AGENT_DIR: agentDir,
      MOCK_PI_INSTALL_MODE: 'ok',
      MOCK_PI_INSTALL_ARGV_FILE: argvFile,
      // 预览只允许本机 http 覆盖：这个端口已释放 → 必定 ECONNREFUSED（E6 要的失败）
      PI_DESKTOP_NPM_REGISTRY_URL: closedRegistryUrl
    }
  })
  const page = await app.firstWindow()
  // 启动即有一次 pi 自检；等到徽标出现，才保证 locate/launch 已就绪（安装的 gate 依赖它）
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })

  return { app, page, tempRoot, agentDir, settingsFile, argvFile }
}

beforeAll(async () => {
  closedRegistryUrl = `http://127.0.0.1:${String(await reserveClosedPort())}`
}, 60_000)

describe('A37 插件面板 —— 已登记两个插件', () => {
  let launched: LaunchedApp

  beforeAll(async () => {
    launched = await launchApp('listed', { packages: ['npm:pi-mock', 'npm:pi-nodesc'] })
  }, 180_000)

  afterAll(async () => {
    await launched?.app.close().catch(() => {})
    if (launched !== undefined) {
      await rm(launched.tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('E1 顶栏位置：插件按钮在「技能」之后、「模型」之前', async () => {
    await expect
      .poll(async () => launched.page.locator('[data-testid="open-plugins"]').count(), {
        timeout: 30_000
      })
      .toBe(1)

    // 用 DOM 里的 data-testid 顺序直接比较索引：比"视觉上靠右"可靠，也比 class 顺序稳
    const order = await launched.page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll('[data-testid]')).map(
        (element) => (element as HTMLElement).dataset.testid ?? ''
      )
      return {
        skills: ids.indexOf('open-skills'),
        plugins: ids.indexOf('open-plugins'),
        models: ids.indexOf('open-models-manager')
      }
    })

    expect(order.skills).toBeGreaterThanOrEqual(0)
    expect(order.plugins).toBeGreaterThan(order.skills)
    expect(order.plugins).toBeLessThan(order.models)
  }, 60_000)

  it('E2 清单：两条登记都出现，name 带版本，有 description 才渲染 plugin-desc', async () => {
    const { page } = launched
    await page.click('[data-testid="open-plugins"]')
    await page.waitForSelector('[data-testid="plugins-panel"]', { timeout: 20_000 })

    // 清单是 IPC 读回来的：先 poll 条目数，再断言内容（否则读的是空清单）
    const items = page.locator('[data-testid="plugin-item"]')
    await expect.poll(async () => items.count(), { timeout: 20_000 }).toBe(2)

    // 按 source 定位条目：`npm:pi-mock` 不会误命中 `npm:pi-nodesc`
    const mockItem = items.filter({ hasText: 'npm:pi-mock' })
    const nodescItem = items.filter({ hasText: 'npm:pi-nodesc' })
    await expect.poll(async () => mockItem.count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => nodescItem.count(), { timeout: 10_000 }).toBe(1)

    // nameLine 的真实形态是 `名称 · 版本`
    const mockName = (await mockItem.locator('[data-testid="plugin-name"]').textContent()) ?? ''
    expect(mockName).toContain(MOCK_PKG.name)
    expect(mockName).toContain(MOCK_PKG.version)

    expect((await mockItem.locator('[data-testid="plugin-desc"]').textContent()) ?? '').toContain(
      MOCK_PKG.description
    )
    // 没有 description 的包必须**整块不渲染**（不是渲染空 <p>）
    expect(await nodescItem.locator('[data-testid="plugin-desc"]').count()).toBe(0)
  }, 60_000)

  it('E4 安装成功：确认区提到第三方与 postinstall，装完刷新清单并落盘登记', async () => {
    const { page, settingsFile, argvFile } = launched

    await page.fill('[data-testid="plugins-source"]', 'npm:pi-fresh')
    await page.click('[data-testid="plugins-install-button"]')

    // 点「安装」只展开确认区，绝不直接 spawn
    const confirm = page.locator('[data-testid="plugins-install-confirm"]')
    await expect.poll(async () => confirm.count(), { timeout: 10_000 }).toBe(1)
    const confirmText = (await confirm.textContent()) ?? ''
    expect(confirmText).toContain('第三方')
    expect(confirmText).toContain('postinstall')
    // 尚未确认 → 还没有任何 argv 落盘
    expect((await readFile(argvFile, 'utf8').catch(() => '')).length).toBe(0)

    await page.click('[data-testid="plugins-install-confirm-yes"]')

    // 终态：done 事件 + 清单刷新都完成才出现「已安装 …」
    await expect
      .poll(
        async () => {
          const text = await textOf(page, '[data-testid="plugins-install-result"]')
          return text
        },
        { timeout: 90_000 }
      )
      .toContain('已安装')

    // 清单里多出第三项（catalog 复读 settings.json 的结果）
    await expect
      .poll(async () => page.locator('[data-testid="plugin-item"]').count(), { timeout: 30_000 })
      .toBe(3)
    await expect
      .poll(
        async () =>
          page.locator('[data-testid="plugin-item"]').filter({ hasText: 'npm:pi-fresh' }).count(),
        { timeout: 10_000 }
      )
      .toBe(1)

    // 日志流：mock 打印的 `Installed …` 必须到达日志区（事件通道而不是返回值）
    await expect
      .poll(async () => textOf(page, '[data-testid="plugins-install-log"]'), { timeout: 20_000 })
      .toContain('Installed npm:pi-fresh')

    // 磁盘事实 ①：settings.json 的 packages 里确实有这条登记
    const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as {
      packages?: string[]
    }
    expect(settings.packages).toContain('npm:pi-fresh')

    // 磁盘事实 ②：argv **严格只有两个元素**，没有任何附加开关
    const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[]
    expect(argv).toEqual(['install', 'npm:pi-fresh'])
  }, 120_000)

  it('E5 注入被拒：非法 source 在 spawn 之前就被拦下（argv 文件必须不存在）', async () => {
    const { page, argvFile } = launched

    // 上一条用例已经留下 argv 文件，先清掉 —— 本用例要证明的是"这一次没有任何 spawn"
    await rm(argvFile, { force: true })

    await page.fill('[data-testid="plugins-source"]', 'npm:pi-x; rm -rf /')
    await page.click('[data-testid="plugins-install-button"]')
    await expect
      .poll(async () => page.locator('[data-testid="plugins-install-confirm"]').count(), {
        timeout: 10_000
      })
      .toBe(1)
    await page.click('[data-testid="plugins-install-confirm-yes"]')

    // VALIDATION 走 Result.ok === false → 面板红字（不是插件安装失败的 install-error 分支）
    await expect
      .poll(async () => textOf(page, '[data-testid="plugins-install-error"]'), { timeout: 20_000 })
      .toContain('不允许的字符')

    /**
     * 为什么这里必须断言 argv 文件**不存在**，而不是只断言「UI 报错」：
     * `MOCK_PI_INSTALL_ARGV_FILE` 是 mock 收到 `pi install` 时**第一件事**就写的落盘痕迹，
     * 也是"到底有没有 spawn"的唯一客观证据。只断言红字，无法区分下面两种实现：
     *   ⓐ 校验在 spawn 之前 → 零 spawn（正确）；
     *   ⓑ 校验放在子进程退出后 → 已经带着 `; rm -rf /` 起了一个进程，只是最后报了错。
     * 两者在 UI 上长得一模一样，但 ⓑ 意味着注入串真的进过命令行。文件不存在 = 零 spawn。
     */
    const argvAfter = await readFile(argvFile, 'utf8').catch(() => '')
    expect(argvAfter).toBe('')
  }, 60_000)

  it('E6 预览失败不阻断：说明原因，安装按钮仍可用', async () => {
    const { page } = launched

    await page.fill('[data-testid="plugins-source"]', 'npm:pi-mock')
    await page.click('[data-testid="plugins-preview-button"]')

    // registry 指向已释放端口 → ECONNREFUSED → origin !== 'npm-registry' → 走 preview-note
    const note = page.locator('[data-testid="plugins-preview-note"]')
    await expect.poll(async () => note.count(), { timeout: 30_000 }).toBe(1)
    const noteText = (await note.textContent()) ?? ''
    expect(noteText).toContain('预览失败')
    expect(noteText).toContain('不影响安装')

    // 关键：预览只是只读提示，绝不能把安装挡掉
    await expect
      .poll(async () => page.locator('[data-testid="plugins-install-button"]').isEnabled(), {
        timeout: 10_000
      })
      .toBe(true)
  }, 60_000)
})

describe('A37 插件面板 —— 空清单', () => {
  let launched: LaunchedApp

  beforeAll(async () => {
    // 独立实例：空清单与「有两条登记」互斥，不能共用同一个 agentDir
    launched = await launchApp('empty', { packages: [] })
  }, 180_000)

  afterAll(async () => {
    await launched?.app.close().catch(() => {})
    if (launched !== undefined) {
      await rm(launched.tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('E3 空清单提示：没有登记时给出引导文案（不是空白面板）', async () => {
    const { page } = launched
    await page.click('[data-testid="open-plugins"]')
    await page.waitForSelector('[data-testid="plugins-panel"]', { timeout: 20_000 })

    // catalog 读完后才从 loading 切到 empty：poll 到提示出现
    await expect
      .poll(async () => page.locator('[data-testid="plugins-empty"]').count(), { timeout: 20_000 })
      .toBe(1)
    const emptyText = await textOf(page, '[data-testid="plugins-empty"]')
    expect(emptyText).toContain('pi install')
    // 空清单不能同时报错（降级为空 vs 读取失败是两件事）
    expect(await page.locator('[data-testid="plugins-error"]').count()).toBe(0)
    expect(await page.locator('[data-testid="plugin-item"]').count()).toBe(0)
  }, 60_000)
})
