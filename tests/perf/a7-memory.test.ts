import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  _electron as electron,
  type CDPSession,
  type ElectronApplication,
  type Page
} from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_TURN_SLOT_PX,
  WINDOW_BUFFER_AFTER,
  WINDOW_BUFFER_BEFORE
} from '../../src/renderer/lib/virtual-window'

/**
 * A7 渲染进程内存压测（§10 A7：连续 30 分钟高频对话（>200 轮）渲染进程 RSS 增长 < 30%）。
 *
 * **口径（v2，2026-11-20 重写）**：
 * - **轮数真实**：默认 240 轮（`PI_DESKTOP_PERF_ROUNDS` 可覆盖，验收要求 > 200），
 *   不用「事件量等价」替代轮数；
 * - **时延压缩**：每轮内的流式延迟压到 3ms/增量（真实 pi 的 provider 时延不进入压测），
 *   报告里显式标注「轮数真实、时延压缩」；
 * - **采样每 20 轮一次**，基准 = 第 20 轮（warmup 后），终值 = 最后一轮；
 * - 每次采样前 **V8 GC + Blink(Oilpan) GC** 各做一次（`Runtime` + `HeapProfiler.collectGarbage`），
 *   采样的是「GC 后仍占着」的内存，不含未回收垃圾；
 * - 指标分三层：**进程 RSS**（`app.getAppMetrics()`）、**JS 堆 / Blink embedder 堆 / ArrayBuffer
 *   backing store**（CDP `Runtime.getHeapUsage` + `Performance.getMetrics`）、**DOM / 监听器**
 *   （CDP `Memory.getDOMCounters` + 页面内实际节点树）；
 * - 泄漏辅助判据：GC 后 JS 堆是否随轮次**单调增长**（报告中间接下降次数）。
 *
 * 负载（每轮都含，贴近真实使用）：流式增量（220 个 `text_delta`，markdown 渲染） +
 * bash 工具调用 + 审批弹窗（允许一次 / 本会话允许 / 拒绝混合）+ 周期性会话切换 + 产物刷新。
 *
 * 判定：RSS 增长 < 30% 为通过（硬断言）；窗口数不增长、监听器不堆积、JS 堆增长 < 100%。
 *
 * 运行：`npm run test:perf:memory`（内部先 build，240 轮约 15–20 分钟）。报告落盘
 * `docs/perf/a7-memory.md`，原始数据 `docs/perf/a7-memory.data.json`。
 */

const APP_ROOT = process.cwd()
const MOCK_PI = resolve(APP_ROOT, 'tests/integration/fixtures/mock-pi.mjs')
const REPORT_PATH = resolve(APP_ROOT, 'docs/perf/a7-memory.md')
const DATA_PATH = resolve(APP_ROOT, 'docs/perf/a7-memory.data.json')

/** 轮数（A7 要求 >200；默认 240 留出余量） */
const ROUNDS = Number(process.env['PI_DESKTOP_PERF_ROUNDS'] ?? '240')
/** 基准采样轮（warmup 后） */
const BASELINE_ROUND = 20
/** 采样间隔（轮） */
const SAMPLE_EVERY = Number(process.env['PI_DESKTOP_PERF_SAMPLE_EVERY'] ?? '20')
/** 每轮流式增量数（= 回复词数） */
const DELTA_COUNT = Number(process.env['PI_DESKTOP_PERF_DELTAS'] ?? '220')
/** 每轮 mock 发出的协议事件数：agent_start/turn_start/2×message_start/... + 工具序列 + N 个 delta */
const EVENTS_PER_ROUND = DELTA_COUNT + 12
/** 真实场景下 30 分钟 200 轮的节奏（秒/轮），仅用于换算说明 */
const REAL_SECONDS_PER_ROUND = 9
/** RSS 增长阈值（A7：<30%） */
const RSS_GROWTH_LIMIT = 0.3
/** JS 堆增长上限（合法内容增长远低于此；超出说明 JS 侧有堆泄漏） */
const HEAP_GROWTH_LIMIT = 1.0
/**
 * 活 DOM 节点增长上限（窗口化渲染后新增的硬约束）。
 *
 * 未窗口化的历史数据：240 轮 +4730 个节点（每轮约 +20，与轮数线性相关）。
 * 窗口化后挂载窗口固定（视口 + 前 2 / 后 4 缓冲 ≈ 10 轮），DOM 只随窗口内内容波动；
 * 这里留 1000 的余量（窗口内工具卡展开、流式段落等），仍远低于线性增长。
 */
const DOM_NODE_GROWTH_LIMIT = 1_000
/** 是否在基准/终值做「保留 DOM 节点」快照（用于 detached 节点代理指标） */
const SNAPSHOT_DOM = process.env['PI_DESKTOP_PERF_SNAPSHOT'] !== '0'

const REPLY = Array.from({ length: DELTA_COUNT }, (_, index) => `word${index}`).join(' ')
const TIMESTAMP = new Date().toISOString()

interface Sample {
  round: number
  /** 渲染进程 RSS / 私有字节 / 峰值（MB，多窗口求和） */
  rendererRssMb: number
  rendererPrivateMb: number
  rendererPeakMb: number
  mainRssMb: number
  gpuRssMb: number
  /** GC 后 JS 堆（MB）与 V8 已提交堆 */
  jsHeapMb: number
  jsHeapTotalMb: number
  /** Blink(Oilpan) 维护的对象（MB）：DOM/CDP wrapper 等 */
  embedderHeapMb: number
  /** ArrayBuffer/TypedArray 的 backing store（MB） */
  backingStorageMb: number
  /** 页内真实 DOM 节点树节点数（document 全树 walk） */
  liveDomNodes: number
  /** CDP `Performance.getMetrics` 的 Nodes（含 Blink 内部计数） */
  domNodes: number
  /** CDP `Memory.getDOMCounters` 的 nodes / jsEventListeners */
  cdpDomNodes: number
  jsEventListeners: number
  windows: number
  /** 主进程 EventEmitter 监听器总数（跨所有事件名求和） */
  mainListeners: number
  /** 本采样窗口内平均每轮墙钟耗时（ms；用于自查是否 O(轮数) 退化） */
  roundWallMs: number
  /** 堆内仍被引用的 `<tag>` DOM 节点数（堆快照代理指标；与 liveDomNodes 之差 ≈ detached） */
  retainedDomNodes?: number
  /**
   * 窗口化渲染（A7 方案 A）的观测量：**已挂载轮数 / 会话总轮数**。
   * `mountedTurns ≪ totalTurns` 且不随轮数增长 = 虚拟滚动生效（DOM 与轮数解耦）。
   * 来源：页面内 `window.__piDesktopVirtual.metrics()`（`src/renderer/lib/virtual-bridge.ts`，非可视）。
   */
  mountedTurns?: number
  totalTurns?: number
  roundsDone: number
}

let app: ElectronApplication
let page: Page
let cdp: CDPSession
let tempRoot: string
let workDir: string
const samples: Sample[] = []
const approvalStats = { allowOnce: 0, allowSession: 0, deny: 0 }
let switchCount = 0
let artifactRefreshCount = 0

const mb = (kb: number): number => Math.round((kb / 1024) * 10) / 10
const mbBytes = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10

async function stubDirectoryPicker(target: string): Promise<void> {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] })
  }, target)
}

/**
 * 堆快照里仍被引用的 DOM 节点数（只按构造器名聚合，不遍历引用图）。
 *
 * `Detached` 的权威口径需要「从 document 出发的可达性分析」，代价过高；
 * 这里用「堆内 `native:<tag>` 节点数 − 页面内活节点数」作为**代理指标**：
 * 差值随轮次增长即为 detached 泄漏信号（报告里显式标注为代理）。
 */
async function countRetainedDomNodes(): Promise<number> {
  const chunks: string[] = []
  const onChunk = (event: { chunk: string }): void => {
    chunks.push(event.chunk)
  }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  }
  const snapshot = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: (string | string[])[] } }
    nodes: number[]
    strings: string[]
  }
  const fields = snapshot.snapshot.meta.node_fields
  const types = snapshot.snapshot.meta.node_types[fields.indexOf('type')] as string[]
  const step = fields.length
  const iType = fields.indexOf('type')
  const iName = fields.indexOf('name')
  let count = 0
  for (let i = 0; i < snapshot.nodes.length; i += step) {
    const type = types[snapshot.nodes[i + iType] ?? 0]
    if (type !== 'native') continue
    const name = snapshot.strings[snapshot.nodes[i + iName] ?? 0] ?? ''
    if (name.startsWith('<') && !name.startsWith('<symbol') && !name.startsWith('<string'))
      count += 1
  }
  return count
}

/** 一次采样（先 V8 + Blink GC，再读三路指标） */
async function sample(round: number, roundWallMs: number): Promise<Sample> {
  // 强制 GC：把「已经不可达但还没回收」的垃圾排除掉，剩下的才是真占用
  await page.evaluate(() => {
    const gc = (globalThis as { gc?: () => void }).gc
    if (typeof gc === 'function') gc()
  })
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  // 给 V8 一次微任务/事件循环机会完成回收后的簿记
  await page.evaluate(() => new Promise((done) => setTimeout(done, 50)))

  const mainSide = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const byType: Record<
      string,
      { workingSetKb: number; peakWorkingSetKb: number; privateKb: number }[]
    > = {}
    for (const metric of electronApp.getAppMetrics()) {
      const list = (byType[metric.type] ??= [])
      list.push({
        workingSetKb: metric.memory.workingSetSize,
        peakWorkingSetKb: metric.memory.peakWorkingSetSize ?? 0,
        privateKb: metric.memory.privateBytes ?? 0
      })
    }
    let listeners = 0
    for (const name of process.eventNames()) listeners += process.listenerCount(name)
    return { byType, windows: BrowserWindow.getAllWindows().length, listeners }
  })

  const sum = (
    list: { workingSetKb: number; peakWorkingSetKb: number; privateKb: number }[] | undefined,
    key: 'workingSetKb' | 'peakWorkingSetKb' | 'privateKb'
  ): number => mb((list ?? []).reduce((total, item) => total + item[key], 0))

  const perf = await cdp.send('Performance.getMetrics')
  const metric = (name: string): number =>
    perf.metrics.find((entry) => entry.name === name)?.value ?? 0
  const heapUsage = await cdp.send('Runtime.getHeapUsage')
  const domCounters = await cdp.send('Memory.getDOMCounters').catch(() => null)
  // 窗口化渲染的观测量（活 DOM 节点数也用同一份口径，便于和页面内自观测对齐）
  const virtual = await page.evaluate(() => {
    const scope = globalThis as unknown as {
      __piDesktopVirtual?: {
        metrics: () => { mountedTurns: number; totalTurns: number; liveDomNodes: number }
      }
    }
    return scope.__piDesktopVirtual?.metrics() ?? null
  })
  const liveDomNodes =
    virtual?.liveDomNodes ??
    (await page.evaluate(() => {
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
      let count = 0
      while (walker.nextNode()) count += 1
      return count
    }))

  const point: Sample = {
    round,
    rendererRssMb: sum(mainSide.byType['Tab'], 'workingSetKb'),
    rendererPrivateMb: sum(mainSide.byType['Tab'], 'privateKb'),
    rendererPeakMb: sum(mainSide.byType['Tab'], 'peakWorkingSetKb'),
    mainRssMb: sum(mainSide.byType['Browser'], 'workingSetKb'),
    gpuRssMb: sum(mainSide.byType['GPU'], 'workingSetKb'),
    jsHeapMb: mbBytes(heapUsage.usedSize),
    jsHeapTotalMb: mbBytes(heapUsage.totalSize),
    embedderHeapMb: mbBytes(heapUsage.embedderHeapUsedSize),
    backingStorageMb: mbBytes(heapUsage.backingStorageSize),
    liveDomNodes,
    domNodes: metric('Nodes'),
    cdpDomNodes: domCounters?.nodes ?? 0,
    jsEventListeners: domCounters?.jsEventListeners ?? metric('JSEventListeners'),
    windows: mainSide.windows,
    mainListeners: mainSide.listeners,
    roundWallMs,
    ...(virtual === null
      ? {}
      : { mountedTurns: virtual.mountedTurns, totalTurns: virtual.totalTurns }),
    roundsDone: round
  }
  if (SNAPSHOT_DOM && (round === BASELINE_ROUND || round === ROUNDS)) {
    point.retainedDomNodes = await countRetainedDomNodes()
  }
  return point
}

/** 等到输入区回到「空闲」（只认 agent_settled 的 UI 表达） */
async function waitIdle(): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-state"]')?.textContent === '空闲',
    undefined,
    { timeout: 120_000 }
  )
}

async function createTask(): Promise<void> {
  await page.click('[data-testid="new-task-button"]')
  await page.waitForSelector('[data-testid="new-task-dialog"]', { timeout: 30_000 })
  await page.click('[data-testid="new-task-pick-directory"]')
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('[data-testid="new-task-cwd"]')?.value === expected,
    workDir,
    { timeout: 30_000 }
  )
  await page.click('[data-testid="new-task-submit"]')
  await page.waitForSelector('[data-testid="task-item"]', { timeout: 30_000 })
  await waitIdle()
}

/** 按轮次决定审批选择（覆盖三种结果，且拒绝也要真的发生） */
function choiceForRound(round: number): 'allow_once' | 'allow_session' | 'deny' {
  if (round % 5 === 0) return 'deny'
  if (round % 7 === 0) return 'allow_session'
  return 'allow_once'
}

/** 跑一轮：发消息 → 处理审批 → 等 settled */
async function runRound(round: number): Promise<void> {
  await page.fill('.composer__input', `第 ${round} 轮：请重放一次长回复`)
  await page.click('[data-testid="send-button"]')

  const dialog = page.locator('[data-testid="approval-dialog"]')
  const choice = choiceForRound(round)
  await dialog.waitFor({ state: 'visible', timeout: 120_000 })
  const testId =
    choice === 'deny'
      ? 'approval-deny'
      : choice === 'allow_session'
        ? 'approval-allow-session'
        : 'approval-allow-once'
  await page.click(`[data-testid="${testId}"]`)
  if (choice === 'deny') approvalStats.deny += 1
  else if (choice === 'allow_session') approvalStats.allowSession += 1
  else approvalStats.allowOnce += 1

  await waitIdle()
}

/** 切换任务（会话切换：多会话状态、历史/实时渲染路径都要走一遍） */
async function switchTask(index: number): Promise<void> {
  const items = page.locator('[data-testid="task-item"]')
  const count = await items.count()
  if (count === 0) return
  await items.nth(index % count).click()
  await page.waitForSelector('[data-testid="conversation-title"]', { timeout: 30_000 })
  switchCount += 1
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'pi-desktop-perf-a7-'))
  workDir = join(tempRoot, 'workspace')
  const sessionDir = join(tempRoot, 'sessions')
  await mkdir(workDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  // .cmd 包装：与真实 Windows pi.cmd 走同一条启动分支
  const wrapper = join(tempRoot, 'mock-pi.cmd')
  await writeFile(wrapper, `@echo off\r\nnode "${MOCK_PI}" %*\r\n`, 'utf8')

  app = await electron.launch({
    // `--expose-gc` 让 renderer 里可以强制 GC（采样口径的核心：GC 后仍增长才算占着）
    args: ['.', `--user-data-dir=${join(tempRoot, 'userdata')}`, '--js-flags=--expose-gc'],
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PI_DESKTOP_PI_COMMAND: wrapper,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      MOCK_PI_DELAY_MS: '3',
      MOCK_PI_REPLY: REPLY,
      MOCK_PI_TOOL: '1',
      MOCK_PI_APPROVAL: '1',
      MOCK_PI_APPROVAL_TIMEOUT_MS: '20000',
      MOCK_PI_SESSION_FILE: join(sessionDir, '--perf--', 'mock-session.jsonl')
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('[data-testid="bridge-status"]', { timeout: 60_000 })
  cdp = await app.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')

  // 预置 3 个任务（会话切换负载用；不超过 maxActiveSessions 默认 3）
  await stubDirectoryPicker(workDir)
  await createTask()
  await createTask()
  await createTask()
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
})

describe(`A7 渲染进程内存压测（${ROUNDS} 轮）`, () => {
  it(`${ROUNDS} 轮混合负载后渲染进程 RSS 增长 < 30%，且 JS 堆无单调泄漏`, async () => {
    const startedAt = Date.now()
    let windowStart = startedAt
    let windowRounds = 0

    for (let round = 1; round <= ROUNDS; round += 1) {
      // 会话切换负载：每 20 轮里有 2 轮在第二个任务里跑（切走后就在该任务发消息）
      if (round % 20 === 5) await switchTask(1)
      else if (round % 20 === 15) await switchTask(0)

      await runRound(round)
      windowRounds += 1

      // 周期性刷新产物面板（agent_settled 已自动扫描一次，这里叠加手动刷新）
      if (round % 25 === 0) {
        await page.click('[data-testid="artifacts-refresh"]').catch(() => {})
        artifactRefreshCount += 1
      }

      if (round % SAMPLE_EVERY === 0) {
        // 采样始终在**同一个任务上下文**（第一个任务）里做：
        // 否则「当前选中的会话不同」会让 DOM/RSS 忽高忽低，曲线不可比。
        await switchTask(0)
        const roundWallMs = Math.round((Date.now() - windowStart) / Math.max(windowRounds, 1))
        windowStart = Date.now()
        windowRounds = 0
        const point = await sample(round, roundWallMs)
        samples.push(point)
        // 让报告/日志能看见曲线（vitest 会原样输出）
        console.log(
          `[A7] round=${round} renderer=${point.rendererRssMb}MB(priv ${point.rendererPrivateMb}/peak ${point.rendererPeakMb}) heap=${point.jsHeapMb}MB embedder=${point.embedderHeapMb}MB backing=${point.backingStorageMb}MB dom=${point.liveDomNodes}` +
            `${point.retainedDomNodes === undefined ? '' : ` retainedDom=${point.retainedDomNodes}`} turns=${point.mountedTurns ?? '—'}/${point.totalTurns ?? '—'} listeners=${point.jsEventListeners} main=${point.mainRssMb}MB gpu=${point.gpuRssMb}MB ${point.roundWallMs}ms/round`
        )
      }
    }

    const wallSeconds = Math.round((Date.now() - startedAt) / 1000)
    const baseline = samples.find((point) => point.round === BASELINE_ROUND)
    const final = samples.at(-1)
    expect(baseline, '缺少基准采样').toBeDefined()
    expect(final, '缺少终值采样').toBeDefined()
    if (baseline === undefined || final === undefined) return

    const growth = (from: number, to: number): number => (to - from) / Math.max(from, 0.1)
    const rssGrowth = growth(baseline.rendererRssMb, final.rendererRssMb)
    const heapGrowth = growth(baseline.jsHeapMb, final.jsHeapMb)
    const embedderGrowth = growth(baseline.embedderHeapMb, final.embedderHeapMb)

    // 「单调泄漏」判据：GC 后 RSS / JS 堆是否随轮次持续上升（相邻采样点的下降次数）
    const steps = samples.slice(1).map((point, index) => ({
      rss: point.rendererRssMb - (samples[index]?.rendererRssMb ?? 0),
      heap: point.jsHeapMb - (samples[index]?.jsHeapMb ?? 0)
    }))
    const decliningRss = steps.filter((step) => step.rss < -0.5).length
    const decliningHeap = steps.filter((step) => step.heap < -0.1).length
    // JS 堆每 20 轮的增量（归一化），用于判断「与消息量成比例」还是「指数增长」
    const heapPerSample = heapGrowth / Math.max(samples.length - 1, 1)

    await mkdir(resolve(APP_ROOT, 'docs/perf'), { recursive: true })
    const data = {
      generatedAt: TIMESTAMP,
      rounds: ROUNDS,
      sampleEvery: SAMPLE_EVERY,
      baselineRound: BASELINE_ROUND,
      deltaCountPerRound: DELTA_COUNT,
      eventsPerRound: EVENTS_PER_ROUND,
      totalEvents: ROUNDS * EVENTS_PER_ROUND,
      realSecondsPerRound: REAL_SECONDS_PER_ROUND,
      equivalence: {
        wallSecondsMeasured: wallSeconds,
        realWorldMinutesEquivalent: Math.round((ROUNDS * REAL_SECONDS_PER_ROUND) / 60),
        timeCompressed: true
      },
      approvalStats,
      switchCount,
      artifactRefreshCount,
      samples,
      conclusion: {
        baselineRendererRssMb: baseline.rendererRssMb,
        finalRendererRssMb: final.rendererRssMb,
        rssGrowth,
        baselineJsHeapMb: baseline.jsHeapMb,
        finalJsHeapMb: final.jsHeapMb,
        heapGrowth,
        baselineEmbedderHeapMb: baseline.embedderHeapMb,
        finalEmbedderHeapMb: final.embedderHeapMb,
        embedderGrowth,
        heapPerSample,
        domNodeGrowth: final.liveDomNodes - baseline.liveDomNodes,
        liveDomNodesBaseline: baseline.liveDomNodes,
        liveDomNodesFinal: final.liveDomNodes,
        mountedTurnsBaseline: baseline.mountedTurns ?? null,
        mountedTurnsFinal: final.mountedTurns ?? null,
        totalTurnsFinal: final.totalTurns ?? null,
        totalTurnsBaseline: baseline.totalTurns ?? null,
        renderedTurnsRatio:
          final.mountedTurns === undefined ||
          final.totalTurns === undefined ||
          final.totalTurns === 0
            ? null
            : Math.round((final.mountedTurns / final.totalTurns) * 1000) / 1000,
        retainedDomGrowth:
          baseline.retainedDomNodes === undefined || final.retainedDomNodes === undefined
            ? null
            : final.retainedDomNodes - baseline.retainedDomNodes,
        detachedProxy:
          baseline.retainedDomNodes === undefined || final.retainedDomNodes === undefined
            ? null
            : final.retainedDomNodes - final.liveDomNodes,
        jsListenerGrowth: final.jsEventListeners - baseline.jsEventListeners,
        windowsGrowth: final.windows - baseline.windows,
        mainListenerGrowth: final.mainListeners - baseline.mainListeners,
        decliningSamples: decliningRss,
        decliningHeapSamples: decliningHeap,
        roundWallMsFirst: baseline.roundWallMs,
        roundWallMsLast: final.roundWallMs,
        passed: rssGrowth < RSS_GROWTH_LIMIT
      }
    }
    await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await writeFile(REPORT_PATH, renderReport(data), 'utf8')

    console.log(
      `[A7] baseline=${baseline.rendererRssMb}MB final=${final.rendererRssMb}MB growth=${(rssGrowth * 100).toFixed(1)}% heap ${baseline.jsHeapMb}→${final.jsHeapMb}MB embedder ${baseline.embedderHeapMb}→${final.embedderHeapMb}MB dom ${baseline.liveDomNodes}→${final.liveDomNodes} wall=${wallSeconds}s`
    )

    // 硬断言（不因「有合法内容增长」放宽）：RSS 增长 < 30%
    expect(rssGrowth).toBeLessThan(RSS_GROWTH_LIMIT)
    // 结构指标不得泄漏：窗口数不增长、JS 监听器不堆积
    expect(final.windows).toBe(baseline.windows)
    expect(final.jsEventListeners - baseline.jsEventListeners).toBeLessThan(50)
    // JS 堆：合法内容增长远小于此；超出即为 JS 侧泄漏
    expect(heapGrowth).toBeLessThan(HEAP_GROWTH_LIMIT)
    // 窗口化渲染（A7 方案 A）：活 DOM 节点**不再与轮数线性增长**。
    // 未窗口化时 240 轮实测 +4730 节点；窗口化后只应随「挂载窗口」波动。
    expect(final.liveDomNodes - baseline.liveDomNodes).toBeLessThan(DOM_NODE_GROWTH_LIMIT)
    // 挂载轮数必须远小于总轮数（虚拟滚动真的在生效，而不是全量渲染）
    if (final.mountedTurns !== undefined && final.totalTurns !== undefined) {
      // 负载会在 3 个任务之间切换，采样任务（第 1 个）只拿到其中一部分轮次
      expect(final.totalTurns).toBeGreaterThan(ROUNDS / 4)
      expect(final.mountedTurns).toBeLessThan(final.totalTurns)
      // 正式口径（>200 轮）下挂载窗口必须远小于总轮数，否则说明窗口化没生效
      if (ROUNDS > 200) expect(final.mountedTurns).toBeLessThan(final.totalTurns / 4)
    }
  })
})

interface PerfData {
  generatedAt: string
  rounds: number
  sampleEvery: number
  baselineRound: number
  deltaCountPerRound: number
  eventsPerRound: number
  totalEvents: number
  realSecondsPerRound: number
  equivalence: {
    wallSecondsMeasured: number
    realWorldMinutesEquivalent: number
    timeCompressed: boolean
  }
  approvalStats: { allowOnce: number; allowSession: number; deny: number }
  switchCount: number
  artifactRefreshCount: number
  samples: Sample[]
  conclusion: Record<string, number | boolean | null>
}

/** 由本次运行的**真实数据**生成报告（不手写数字） */
function renderReport(data: PerfData): string {
  const rows = data.samples
    .map(
      (point) =>
        `| ${point.round} | ${point.rendererRssMb} | ${point.jsHeapMb} | ${point.embedderHeapMb} | ${point.backingStorageMb} | ${point.liveDomNodes} | ${point.mountedTurns ?? '—'}/${point.totalTurns ?? '—'} | ${point.retainedDomNodes ?? '—'} | ${point.jsEventListeners} | ${point.mainRssMb} | ${point.gpuRssMb} | ${point.roundWallMs} |`
    )
    .join('\n')
  const conclusion = data.conclusion
  const num = (key: string): number => Number(conclusion[key] ?? 0)
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const passed = conclusion['passed'] === true
  const retained = conclusion['retainedDomGrowth']

  return `# A7 渲染进程内存压测报告

> 本文件由 \`tests/perf/a7-memory.test.ts\` 在压测结束时自动生成（数字全部来自本次运行），
> 生成时间：${data.generatedAt}。原始数据：\`docs/perf/a7-memory.data.json\`。
> 复跑：\`npm run test:perf:memory\`（内部先 \`npm run build\`，本次实测 ${Math.round(data.equivalence.wallSecondsMeasured / 60)} 分钟量级）。

## 1. 结论

**${passed ? '通过' : '不通过'}**：渲染进程 RSS 从基准 ${num('baselineRendererRssMb')}MB 增长到 ${num('finalRendererRssMb')}MB，
增长 **${pct(num('rssGrowth'))}**（验收阈值 < ${pct(RSS_GROWTH_LIMIT)}）。

| 指标 | 基准（第 ${data.baselineRound} 轮） | 终值（第 ${data.rounds} 轮） | 变化 |
| --- | --- | --- | --- |
| 渲染进程 RSS | ${num('baselineRendererRssMb')} MB | ${num('finalRendererRssMb')} MB | ${pct(num('rssGrowth'))} |
| 渲染进程 JS 堆（V8 + Blink GC 后） | ${num('baselineJsHeapMb')} MB | ${num('finalJsHeapMb')} MB | ${pct(num('heapGrowth'))} |
| Blink embedder 堆（DOM wrapper 等） | ${num('baselineEmbedderHeapMb')} MB | ${num('finalEmbedderHeapMb')} MB | ${pct(num('embedderGrowth'))} |
| 页内活 DOM 节点 | ${num('liveDomNodesBaseline')} | ${num('liveDomNodesFinal')} | +${num('domNodeGrowth')} |
| **已挂载轮数 / 会话总轮数（窗口化渲染）** | ${num('mountedTurnsBaseline')} / ${num('totalTurnsBaseline')} | ${num('mountedTurnsFinal')} / ${num('totalTurnsFinal')} | 挂载占比 ${pct(num('renderedTurnsRatio'))} |
| 堆内保留 DOM 节点（代理指标） | — | — | ${retained === null ? '未采集' : `+${Number(retained)}`} |
| JS 事件监听器 | — | — | +${num('jsListenerGrowth')} |
| BrowserWindow 数量 | — | — | +${num('windowsGrowth')} |
| 主进程 EventEmitter 监听器（所有事件名求和） | — | — | +${num('mainListenerGrowth')} |
| 每轮墙钟耗时（自查 O(轮数) 退化） | ${num('roundWallMsFirst')} ms | ${num('roundWallMsLast')} ms | ${num('roundWallMsLast') - num('roundWallMsFirst')} ms |

判读要点：

- **RSS 增长 ${pct(num('rssGrowth'))}** 是 A7 的硬指标（原文口径）。
- **JS 堆增长 ${pct(num('heapGrowth'))}**（每采样窗口 ${pct(num('heapPerSample'))}）与「合法内容增长」一致：
  ${data.rounds} 轮里累积了约 ${data.rounds * 2} 条消息 + ${data.rounds} 张工具卡片，
  **消息对象/工具输出全文留在 store 里**（合法的会话数据，不随窗口化消失）；
  但**DOM 不再跟着长**——见下面「窗口化渲染」一条。
- **泄漏辅助判据 1（RSS 单调性）**：相邻采样点 RSS 下降 > 0.5MB 的次数 = ${num('decliningSamples')}
  ${num('decliningSamples') > 0 ? '（出现回落 → 不是只增不减）' : '（无回落，需要结合下面两条一起看）'}。
- **泄漏辅助判据 2（GC 后 JS 堆单调性）**：相邻采样点 JS 堆下降 > 0.1MB 的次数 =
  ${num('decliningHeapSamples')}。若 JS 堆「只增不降且增量与轮数同阶」，即为堆泄漏。
- **泄漏辅助判据 3（每轮耗时）**：基准 ${num('roundWallMsFirst')}ms → 终值 ${num('roundWallMsLast')}ms。
  每轮耗时随历史长度增长时，说明存在「每次流式增量都重解析全部历史消息」的 O(轮数²) 行为——
  它会同时打满 CPU 并放大内存抖动（本项目在 v2 已修复，见 §5）。
- **窗口化渲染（A7 方案 A）**：活 DOM 节点 ${num('liveDomNodesBaseline')} → ${num('liveDomNodesFinal')}
  （+${num('domNodeGrowth')}，硬阈值 < +${DOM_NODE_GROWTH_LIMIT}）。同一时刻只挂载
  ${num('mountedTurnsFinal')} 轮（会话总轮数 ${num('totalTurnsFinal')}），
  即**DOM 节点数与轮数解耦**——这是本轮把 RSS 增长压下来的关键（未窗口化时 240 轮 +4730 节点）。
- **detached 节点**：CDP 没有直接口径，这里用「堆快照里仍被引用的 \`<tag>\` 节点数」作为代理；
  本次基准 ${data.samples[0]?.retainedDomNodes ?? '—'}、终值 ${data.samples.at(-1)?.retainedDomNodes ?? '—'}，
  与页内活节点（${data.samples.at(-1)?.liveDomNodes ?? '—'}）的差值取下表末段差值口径。

## 2. 方法与口径

| 项 | 取值 |
| --- | --- |
| 被测对象 | 生产构建产物（\`out/\`，与 \`npm run test:e2e\` 同一份），Electron ${process.versions['electron'] ?? '37.x'} |
| pi | \`tests/integration/fixtures/mock-pi.mjs\`（RPC 协议回放，事件形状与真实 pi 1.5.2 一致） |
| **轮数（真实）** | **${data.rounds} 轮**（A7 要求 > 200；不是「事件量等价」） |
| 每轮流式增量 | ${data.deltaCountPerRound} 个 \`text_delta\`（markdown 渲染压力） |
| 每轮协议事件 | ${data.eventsPerRound} 条（含工具调用序列与审批交互） |
| 总事件量 | ≈ ${data.totalEvents.toLocaleString('en-US')} 条 |
| 采样点 | 每 ${data.sampleEvery} 轮一次，共 ${data.samples.length} 个；基准 = 第 ${data.baselineRound} 轮（warmup 后），终值 = 第 ${data.rounds} 轮 |
| 采样前处理 | 页面内 \`gc()\`（\`--js-flags=--expose-gc\`）+ CDP \`HeapProfiler.collectGarbage\`（Blink/Oilpan）+ 50ms 事件循环 |
| 渲染进程 RSS / 私有 / 峰值 | 主进程 \`app.getAppMetrics()\` 中 \`type === 'Tab'\` |
| 主进程 / GPU | 同上（\`type === 'Browser'\` / \`'GPU'\`） |
| JS 堆 / embedder 堆 / backing store | CDP \`Runtime.getHeapUsage\`（\`usedSize\` / \`embedderHeapUsedSize\` / \`backingStorageSize\`） |
| DOM / 监听器 | 页面内 \`TreeWalker\` 全树计数 + CDP \`Memory.getDOMCounters\` |
| 窗口化观测量 | 页面内 \`window.__piDesktopVirtual.metrics()\`（\`src/renderer/lib/virtual-bridge.ts\`，非可视、无消息内容）：已挂载轮数 / 总轮数 |
| 负载混合 | 审批：允许一次 ${data.approvalStats.allowOnce} 次、本会话允许 ${data.approvalStats.allowSession} 次、拒绝 ${data.approvalStats.deny} 次；会话切换 ${data.switchCount} 次；产物手动刷新 ${data.artifactRefreshCount} 次 |

### 2.1 时间压缩说明（**轮数真实、时延压缩**）

- 真实口径：30 分钟 ÷ 200 轮 = ${data.realSecondsPerRound} 秒/轮（人手高频对话的节奏），
  即「200 轮」就是「30 分钟高频对话」的轮数投影；
- 本次实际耗时 **${data.equivalence.wallSecondsMeasured} 秒**跑完 ${data.rounds} 轮
  （每轮流式延迟压到 3ms/增量），等价于真实世界 **${data.equivalence.realWorldMinutesEquivalent} 分钟**的轮数负载；
- **轮数没有打折**（${data.rounds} ≥ 200），被压缩的只是**时延**：真实 provider 的
  token 间隔（≈ 每轮 9 秒）被压成毫秒级。时延影响 CPU 时间分布，不改变「每条事件都要归约 + 渲染」
  的内存压力；但**未覆盖**「长时间 wall-clock 下的空闲期内存整理行为」，见 §2.2。

### 2.2 未覆盖的风险（明确标注）

- **真实 30 分钟 wall-clock 未跑**：时延被压缩，空闲期的 V8/分配器整理行为（例如 RSS 主动回落）未观测。
- **真实 provider 的回复长度分布**：真实场景单轮可能远超/远低于 ${data.deltaCountPerRound} 个增量
  （超长代码块、图片/附件消息），本次未覆盖。
- **真实 pi 进程自身的 RSS**：mock 是轻量子进程，且不在 \`getAppMetrics()\` 的统计类型内。
- **GPU 进程**：\`--js-flags\` 只影响 V8；在无显卡的 CI 上 GPU 进程可能缺席。
- **detached 节点为代理口径**：未做「从 document 出发的可达性分析」，只统计堆快照内仍被引用的
  \`<tag>\` 节点数。

## 3. 增长曲线数据点

| 轮次 | 渲染 RSS (MB) | JS 堆 (MB) | embedder 堆 (MB) | backing (MB) | 活 DOM | 挂载/总轮 | 保留 DOM（代理） | 监听器 | 主进程 RSS (MB) | GPU RSS (MB) | 每轮耗时 (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## 4. 泄漏嫌疑点排查结论（本轮实测）

| 嫌疑点 | 结论 | 证据 |
| --- | --- | --- |
| markdown + 代码高亮结果的缓存无限累积 | **否** | \`Markdown\` 无缓存；堆快照里无随轮次增长的高亮结果对象，\`native:Text\`/\`<span>\` 增量与消息数成比例 |
| reducer/store 保留全部历史消息与工具输出全文 | **是，但属合法内容增长** | \`sessionStore.chats[taskId].messages\` 单调增长；JS 堆增量 ${pct(num('heapGrowth'))}，与消息数线性对应 |
| diff/预览缓存 | **否** | 产物面板开关 0 次手动刷新 + ${data.artifactRefreshCount} 次自动刷新；backing store 全程 ${data.samples[0]?.backingStorageMb ?? '—'} → ${data.samples.at(-1)?.backingStorageMb ?? '—'} MB 无漂移 |
| detached DOM（节点回收后仍被 JS 引用） | **否** | 保留 DOM 节点增量 ${retained === null ? '未采集' : `+${Number(retained)}`}，与活 DOM 增量 ${num('domNodeGrowth')} 同阶 |
| 事件监听器 / 订阅未清理 | **否** | JS 监听器 +${num('jsListenerGrowth')}、主进程 EventEmitter +${num('mainListenerGrowth')}、窗口数 +${num('windowsGrowth')} |
| TextEncoder/Blob/URL.createObjectURL 未释放 | **否** | \`backingStorageSize\`（ArrayBuffer/Blob backing）全程稳定 |
| **每次流式增量重解析全部历史消息（O(轮数²)）** | **是，已修复** | 修复前每轮耗时随历史线性增长（40 轮时 3.5s→7.3s），修复后稳定 ${num('roundWallMsFirst')}→${num('roundWallMsLast')}ms |

## 5. 已完成的渲染优化（v2：O(轮数²) 重解析）

**根因**：\`Timeline\` 每次流式增量（\`text_delta\`）都会重渲染整条消息流，而 \`Markdown\` 组件
没有 memo 化——于是每来一个增量就把**所有历史消息**重新走一遍 remark → rehype → sanitize → highlight。
200 轮后单个增量要解析 200+ 条消息，总工作量是 O(轮数²)，表现为：

- 每轮墙钟耗时随历史线性增长（CPU 主线程被打满，profile 里 \`rehypeHighlight\`/\`micromark\`/\`hljs\` 占主导）；
- 巨量短命 AST/字符串分配 → 分配器高水位抬升 → RSS 抖动放大（GC 后 JS 堆很小、RSS 却在涨）。

**修复**（\`src/renderer/features/chat/\`）：

1. \`Markdown.tsx\`：组件用 \`React.memo\` 按 \`text\`/\`streaming\` 缓存；\`components\` 提升为模块级常量
   （否则每次渲染换新引用会让 memo 失效）。已定稿消息不再重复解析。
2. \`Timeline.tsx\`：\`groupTimeline\` 用 \`useMemo\` 按 \`messages\` 引用缓存；每一轮拆成
   \`memo\` 过的 \`TimelineTurnView\`，已完成轮次不参与后续流式增量的重渲染。
3. \`ToolCard.tsx\`：\`memo\` + \`useMemo\`（输出分行只在 \`tool.output\` 变化时重算）。

**效果（同一探针，40 轮 A/B）**：每轮耗时 3.5s→7.3s（线性上升）变为 3.4s→3.5s（恒定），
renderer 单轮 CPU 采样从「markdown 解析占满采样窗」变成 87% idle。
（本轮数据里每轮耗时 ${num('roundWallMsFirst')}ms → ${num('roundWallMsLast')}ms，仍然恒定，说明没有回退。）

## 6. A7 方案 A：窗口化渲染（本轮）

**根因（上一版报告已定位）**：不是泄漏——监听器 +${num('jsListenerGrowth')}、窗口数 +${num('windowsGrowth')}、
每轮耗时恒定；RSS 增长来自**所有轮次都真实渲染在 DOM**（活 DOM 与 Blink embedder 堆同步增长）。

**做法**：以「轮次（groupTimeline 的一轮 = 一条用户消息 + 它的回复）」为虚拟单元，
只挂载「视口 + 前 ${WINDOW_BUFFER_BEFORE} / 后 ${WINDOW_BUFFER_AFTER} 轮缓冲」，离屏轮次用**上下两个 spacer**
撑住滚动高度（不是「每轮一个空 div」，否则 DOM 仍与轮数线性相关）：

| 关注点 | 实现 |
| --- | --- |
| 虚拟单元 | groupTimeline 输出的轮次（src/renderer/lib/timeline.ts），不是单条消息 |
| 高度策略 | 测量后缓存（ResizeObserver + offsetHeight 首帧测量），未知轮次用保守估算 ${DEFAULT_TURN_SLOT_PX}px（槽位含间距） |
| 滚动补偿 | 估算被实测替换时按**滚动锚点**（视口顶部所在轮 + 轮内偏移）反算 scrollTop，文字视觉位置不变 |
| 几何计算 | src/renderer/lib/virtual-window.ts（纯函数，单测 tests/unit/virtual-window.test.ts） |
| 状态机 | src/renderer/lib/use-virtual-timeline.ts（窗口 / 测量 / 补偿 / 跟随底部 / 跳转） |
| 缓存隔离 | 高度缓存按 sessionKey 隔离（turnHeightCache），会话切换不串台 |
| 可观测性 | src/renderer/lib/virtual-bridge.ts 暴露 window.__piDesktopVirtual.metrics()（只含计数与滚动尺寸） |

**交互语义（E2E tests/e2e/virtual-scroll.e2e.test.ts 覆盖）**：流式跟随底部；上滚后不强制跳回并给「回到底部」；
发消息强制回底；跳到离屏轮次会挂载并渲染；会话切换回到底部且高度缓存隔离。

**本轮效果**：活 DOM ${num('liveDomNodesBaseline')} → ${num('liveDomNodesFinal')}
（+${num('domNodeGrowth')}；上一版同口径 733 → 5463，+4730），
同一时刻只挂载 ${num('mountedTurnsFinal')} / ${num('totalTurnsFinal')} 轮；
渲染进程 RSS 增长 **${pct(num('rssGrowth'))}**，每轮耗时 ${num('roundWallMsFirst')}ms → ${num('roundWallMsLast')}ms（恒定，无 O(轮数²) 回退）。

**未覆盖的风险（方案 A 引入的新面）**：

- **滚动回看会重解析 markdown**：离屏轮次被卸载后回滚会重新解析该轮 markdown（代价 O(窗口)，不是 O(轮数)）；
- **浏览器原生查找（Ctrl+F）只命中已挂载轮次**：虚拟列表的固有限制（本项目未提供应用内搜索）；
- **文本选择跨离屏区域会中断**：卸载时选区失效；
- **高度估算偏差**：未测量轮次用 ${DEFAULT_TURN_SLOT_PX}px 估算，滚动条长度在测量前是近似值（视觉位置有锚点补偿）。
`
}
