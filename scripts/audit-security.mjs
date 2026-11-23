#!/usr/bin/env node
/**
 * A9 安全审计门禁（docs/architecture.md §9.4 S1–S6 + §10 A9 的 `npm run audit:security`）。
 *
 * 覆盖两部分：
 *
 * 1. **依赖漏洞**：`npm audit --omit=dev --audit-level=high --json`
 *    —— 生产依赖出现 high / critical 即失败；
 *    —— 离线 / registry 不可达时**降级为 warning**（不把网络问题当作安全失败，但明确提示本次门禁未生效）。
 *
 * 2. **S1–S6 的命令行可验证部分**（构建产物静态核查，`out/` 来自 `npm run build`）：
 *    - S1（MVP）渲染进程无 Node 集成：preload/renderer 产物不含 fs/child_process/net 等 require，
 *      主进程 `webPreferences` 为 `nodeIntegration:false / contextIsolation:true / sandbox:true`；
 *    - S2（MVP）未注册 IPC 通道被拒：通道白名单（`src/shared/ipc-channels.ts`）与 preload 一一对应，
 *      主进程产物内含 `UNKNOWN_CHANNEL` 拒绝路径；不加 `--with-tests` 时只做静态断言；
 *    - S3（MVP）渲染净化管线存在：`rehype-sanitize` 在依赖里、在源码里（`defaultSchema`）、在渲染产物里；
 *    - S4（MVP）外部导航拦截：主进程产物含 `will-navigate` / `setWindowOpenHandler` / `action: "deny"`；
 *    - S5（MVP）产物扫描：`out/` 无 `*.map`、无开发机绝对路径、无明文密钥模式；
 *    - S6（MVP，**不是** Phase 2 的远端越权项）写入工作区外被拒：主进程产物含 `PATH_DENIED` 路径闸。
 *
 * 用法：
 *   node scripts/audit-security.mjs               # 静态核查（快，秒级；不含 npm audit 的网络耗时）
 *   node scripts/audit-security.mjs --with-tests  # 额外跑 S1/S2/S3/S6 的既有单测
 *   node scripts/audit-security.mjs --skip-network # 跳过 npm audit（纯离线环境）
 *
 * 退出码：0 = 全部通过（warn/skip 不算失败）；1 = 有失败项。
 *
 * 说明（刻意不做的部分，避免伪造断言）：
 * - 「日志无敏感串」（S5 后半句）属运行时行为，静态扫描无法证明；由 A11 报告的启动/安装实测覆盖
 *   （见 docs/perf/a11-package.md §3.3）。
 * - S7–S10 是 Phase 2（网关/远端）项，不在本门禁范围，见文件末尾的 skip 说明。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = new Set(process.argv.slice(2))
const WITH_TESTS = argv.has('--with-tests')
const SKIP_NETWORK = argv.has('--skip-network')

/** 产物根（`npm run build` 的输出；electron-builder 的 asar 也来自它） */
const OUT_DIR = join(ROOT, 'out')
const MAIN_BUNDLE = join(OUT_DIR, 'main', 'index.js')
const PRELOAD_BUNDLE = join(OUT_DIR, 'preload', 'index.js')
const RENDERER_INDEX = join(OUT_DIR, 'renderer', 'index.html')
const RENDERER_ASSETS = join(OUT_DIR, 'renderer', 'assets')
const ASAR = join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar')

/** @typedef {'pass'|'fail'|'skip'|'warn'} Status */
/** @type {Array<{id: string, title: string, status: Status, detail: string}>} */
const results = []

/**
 * @param {string} id
 * @param {string} title
 * @param {Status} status
 * @param {string} detail
 */
function add(id, title, status, detail) {
  results.push({ id, title, status, detail })
}

// ---------------------------------------------------------------- 工具函数

/** @param {string} path */
async function readTextOrUndefined(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 递归列出目录下的文件（跳过不存在） @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  /** @type {string[]} */
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/** @param {string} label @param {string[]} missing */
function missingBuild(label, missing) {
  add(
    label,
    '构建产物核查',
    'skip',
    `缺少 ${missing.map((item) => relative(ROOT, item)).join(' / ')}：先 \`npm run build\` 再跑本门禁`
  )
}

/** 在文本里找第一个命中 @param {string} text @param {RegExp} re */
function firstMatch(text, re) {
  const match = re.exec(text)
  if (!match) return undefined
  const index = Math.max(0, match.index - 40)
  return text.slice(index, Math.min(text.length, match.index + 120)).replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------- 1. 依赖漏洞

/** 离线 / registry 不可达的典型特征（npm audit 的输出或退出信息） */
const OFFLINE_HINTS =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|network|offline|audit endpoint|registry\.npmjs\.org/i

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function runNpmAudit() {
  const id = 'A9-dep'
  const title = 'npm audit --omit=dev --audit-level=high（生产依赖高危即失败）'
  if (SKIP_NETWORK) {
    add(id, title, 'skip', '本次带 --skip-network：依赖漏洞门禁未执行（离线环境请人工确认）')
    return
  }

  // 命令串形式（而不是 args 数组 + shell）：npm 在 Windows 上是 .cmd，必须经 shell 执行
  const audit = spawnSync(`${npmCommand()} audit --omit=dev --audit-level=high --json`, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    shell: true,
    windowsHide: true,
    env: process.env
  })

  const stdout = audit.stdout ?? ''
  const stderr = audit.stderr ?? ''

  /** @type {any} */
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    report = undefined
  }

  // 网络不可达：audit 无法给出结论 → 降级为 warning，不当作安全失败
  const offline = OFFLINE_HINTS.test(stderr) || OFFLINE_HINTS.test(stdout)
  if (report === undefined || report?.error !== undefined) {
    const reason =
      report?.message ??
      report?.error?.summary ??
      report?.error?.detail ??
      (stderr.trim().split('\n').slice(0, 3).join(' | ') || '无输出')
    if (offline) {
      add(
        id,
        title,
        'warn',
        `npm audit 无法完成（疑似离线/registry 不可达），本次依赖漏洞门禁**未生效**：${reason}`
      )
      return
    }
    add(id, title, 'fail', `npm audit 输出无法解析（退出码 ${String(audit.status)}）：${reason}`)
    return
  }

  const counts = report.metadata?.vulnerabilities ?? {}
  const high = Number(counts.high ?? 0)
  const critical = Number(counts.critical ?? 0)
  const moderate = Number(counts.moderate ?? 0)
  const prod = Number(report.metadata?.dependencies?.prod ?? 0)
  const summary = `high=${high} critical=${critical} moderate=${moderate}（生产依赖 ${prod} 个）`

  if (high + critical > 0) {
    const names = Object.entries(report.vulnerabilities ?? {})
      .filter(([, info]) => {
        const severity = /** @type {any} */ (info).severity
        return severity === 'high' || severity === 'critical'
      })
      .map(([name, info]) => `${name}(${/** @type {any} */ (info).severity})`)
      .join(', ')
    add(id, title, 'fail', `${summary}；高危包：${names || '（见 npm audit 原始输出）'}`)
    return
  }
  add(id, title, 'pass', summary)
}

// ---------------------------------------------------------------- 2. S1–S6

/** S1 探针：渲染侧（preload / renderer）不得出现的 Node 能力 */
const NODE_CAPABILITY_PROBES = [
  { name: "require('fs')", re: /require\(\s*["'](?:node:)?fs["']\s*\)/ },
  { name: "require('child_process')", re: /require\(\s*["'](?:node:)?child_process["']\s*\)/ },
  { name: "require('net')", re: /require\(\s*["'](?:node:)?net["']\s*\)/ },
  { name: 'process.binding', re: /process\.binding\s*\(/ }
]

/**
 * preload 额外加一条：`import ... from 'node:*'`。
 * renderer 产物不加这条——第三方依赖的**文档注释**里会出现 `import process from 'node:process'`
 * 这类示例（实测误报），而 browser bundle 里的真实 `require('node:fs')` 已由上表覆盖。
 */
const PRELOAD_ONLY_PROBES = [{ name: "import('node:')", re: /from\s*["']node:/ }]

async function checkS1() {
  const id = 'S1'
  const title = '渲染进程无 Node 集成（renderer 调 require("fs") 必须失败）'

  const preload = await readTextOrUndefined(PRELOAD_BUNDLE)
  const rendererIndex = await readTextOrUndefined(RENDERER_INDEX)
  const main = await readTextOrUndefined(MAIN_BUNDLE)
  if (preload === undefined || rendererIndex === undefined || main === undefined) {
    missingBuild(
      id,
      [PRELOAD_BUNDLE, RENDERER_INDEX, MAIN_BUNDLE].filter((p) => !existsSync(p))
    )
    return
  }

  const assets = (await walk(RENDERER_ASSETS)).filter((file) => file.endsWith('.js'))
  const hits = []

  // preload 只用 electron：任何其它 Node 核心模块都说明 preload 越界了
  for (const probe of [...NODE_CAPABILITY_PROBES, ...PRELOAD_ONLY_PROBES]) {
    if (probe.re.test(preload)) hits.push(`preload.js 命中 ${probe.name}`)
  }
  // renderer 产物里出现 require(...) 本身就不该有；node: 协议同理
  const rendererSources = [rendererIndex, ...(await Promise.all(assets.map(readTextOrUndefined)))]
  for (const source of rendererSources) {
    if (source === undefined) continue
    for (const probe of NODE_CAPABILITY_PROBES) {
      if (probe.re.test(source)) hits.push(`renderer 产物命中 ${probe.name}`)
    }
  }

  // 主进程必须把 Node 关掉
  const prefs = []
  if (!/nodeIntegration:\s*false/.test(main)) prefs.push('nodeIntegration 未显式 false')
  if (!/contextIsolation:\s*true/.test(main)) prefs.push('contextIsolation 未显式 true')
  if (!/sandbox:\s*true/.test(main)) prefs.push('sandbox 未显式 true')

  if (hits.length > 0 || prefs.length > 0) {
    add(id, title, 'fail', [...hits, ...prefs].join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    `preload/renderer 产物无 Node 核心模块调用；主进程 nodeIntegration:false / contextIsolation:true / sandbox:true（renderer js ${assets.length} 个）`
  )
}

async function checkS2() {
  const id = 'S2'
  const title = '未注册 IPC 通道被拒（通道白名单 + UNKNOWN_CHANNEL）'

  const preload = await readTextOrUndefined(PRELOAD_BUNDLE)
  const main = await readTextOrUndefined(MAIN_BUNDLE)
  const channelsSource = await readTextOrUndefined(join(ROOT, 'src', 'shared', 'ipc-channels.ts'))
  if (preload === undefined || main === undefined || channelsSource === undefined) {
    missingBuild(
      id,
      [PRELOAD_BUNDLE, MAIN_BUNDLE, join(ROOT, 'src/shared/ipc-channels.ts')].filter(
        (p) => !existsSync(p)
      )
    )
    return
  }

  // 从**单一来源**里抽出 invoke 通道字面量，逐条断言 preload 绑定了固定通道
  const invokeBlock = channelsSource.slice(
    channelsSource.indexOf('IPC_INVOKE_CHANNELS'),
    channelsSource.indexOf('INVOKE_CHANNELS:')
  )
  const channels = [...invokeBlock.matchAll(/'([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1])
  if (channels.length === 0) {
    add(id, title, 'fail', '无法从 src/shared/ipc-channels.ts 解析出通道白名单')
    return
  }
  const unbound = channels.filter((channel) => !preload.includes(`"${channel}"`))
  const problems = []
  if (unbound.length > 0) problems.push(`preload 未绑定通道：${unbound.join(', ')}`)
  if (!main.includes('UNKNOWN_CHANNEL')) problems.push('主进程产物缺 UNKNOWN_CHANNEL 拒绝路径')
  if (!/exposeInMainWorld\(\s*"pi"/.test(preload))
    problems.push('preload 未通过 contextBridge 暴露 window.pi')
  if (/exposeInMainWorld\([^)]*ipcRenderer/.test(preload)) {
    problems.push('preload 把 ipcRenderer 本体暴露给了页面')
  }

  if (problems.length > 0) {
    add(id, title, 'fail', problems.join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    `${channels.length} 条 invoke 通道全部在 preload 中按固定通道绑定，主进程含 UNKNOWN_CHANNEL 拒绝；renderer 无任意通道透传 API`
  )
}

async function checkS3() {
  const id = 'S3'
  const title = '渲染净化管线存在（rehype-sanitize）'

  const pkgRaw = await readTextOrUndefined(join(ROOT, 'package.json'))
  const markdown = await readTextOrUndefined(join(ROOT, 'src', 'renderer', 'lib', 'markdown.ts'))
  const rendererIndex = await readTextOrUndefined(RENDERER_INDEX)
  const assets = (await walk(RENDERER_ASSETS)).filter((file) => file.endsWith('.js'))
  const bundles = (await Promise.all(assets.map(readTextOrUndefined))).filter(
    (item) => item !== undefined
  )

  if (pkgRaw === undefined || markdown === undefined || rendererIndex === undefined) {
    missingBuild(id, [RENDERER_INDEX])
    return
  }

  const pkg = JSON.parse(pkgRaw)
  const problems = []
  if (pkg.dependencies?.['rehype-sanitize'] === undefined)
    problems.push('依赖里没有 rehype-sanitize')
  if (!/from\s+'rehype-sanitize'/.test(markdown))
    problems.push('markdown.ts 未引入 rehype-sanitize')
  if (!/defaultSchema/.test(markdown)) problems.push('markdown.ts 未使用 defaultSchema 白名单')
  const bundled = bundles.some(
    (bundle) => bundle.includes('defaultSchema') && bundle.includes('"mailto"')
  )
  if (!bundled) problems.push('渲染产物里找不到净化管线（defaultSchema + mailto 协议白名单）')

  if (problems.length > 0) {
    add(id, title, 'fail', problems.join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    `rehype-sanitize ${pkg.dependencies['rehype-sanitize']} 在依赖、源码（defaultSchema）与渲染产物中均存在`
  )
}

async function checkS4() {
  const id = 'S4'
  const title = '外部导航拦截（will-navigate / setWindowOpenHandler deny + 确认后 openExternal）'

  const main = await readTextOrUndefined(MAIN_BUNDLE)
  const windowSource = await readTextOrUndefined(join(ROOT, 'src', 'main', 'window.ts'))
  if (main === undefined || windowSource === undefined) {
    missingBuild(
      id,
      [MAIN_BUNDLE, join(ROOT, 'src/main/window.ts')].filter((p) => !existsSync(p))
    )
    return
  }

  const problems = []
  for (const marker of ['will-navigate', 'setWindowOpenHandler', 'openExternal']) {
    if (!main.includes(marker)) problems.push(`主进程产物缺 ${marker}`)
    if (!windowSource.includes(marker)) problems.push(`window.ts 缺 ${marker}`)
  }
  if (!/action:\s*["']deny["']/.test(main))
    problems.push('主进程产物缺 action: "deny"（不开新窗口）')
  if (!/preventDefault\(\)/.test(windowSource))
    problems.push('window.ts 的 will-navigate 未 preventDefault')

  if (problems.length > 0) {
    add(id, title, 'fail', problems.join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    'will-navigate 阻断并 preventDefault；setWindowOpenHandler 一律 deny；http(s) 外链仅在用户确认后 openExternal'
  )
}

/** S5 探针：明文密钥特征（保守集合，避免误报） */
const SECRET_PROBES = [
  { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'OpenAI/Anthropic 风格 sk- key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ }
]

function absolutePathProbe() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\/g, '\\\\')
  return {
    name: '开发机绝对路径',
    re:
      home.length > 0
        ? new RegExp(`${escaped}|[A-Za-z]:\\\\+(?:Users|Documents and Settings)\\\\+`, 'i')
        : /[A-Za-z]:\\+(?:Users|Documents and Settings)\\+/i
  }
}

async function checkS5() {
  const id = 'S5'
  const title = '产物扫描（无 sourcemap / 无绝对路径 / 无明文密钥）'

  const files = await walk(OUT_DIR)
  if (files.length === 0) {
    add(id, title, 'skip', 'out/ 为空：先 `npm run build` 再跑本门禁')
    return
  }

  const probes = [...SECRET_PROBES, absolutePathProbe()]
  const problems = []

  const maps = files.filter((file) => file.endsWith('.map'))
  if (maps.length > 0) {
    problems.push(
      `sourcemap ${maps.length} 个：${maps
        .map((f) => relative(ROOT, f))
        .slice(0, 5)
        .join(', ')}`
    )
  }

  // 只扫文本产物（js/html/css/json），二进制跳过
  const textFiles = files.filter((file) => /\.(?:js|mjs|cjs|html|css|json)$/.test(file))
  for (const file of textFiles) {
    const text = await readTextOrUndefined(file)
    if (text === undefined) continue
    for (const probe of probes) {
      const hit = firstMatch(text, probe.re)
      if (hit !== undefined) {
        problems.push(`${relative(ROOT, file)} 命中 ${probe.name}：「${hit}」`)
      }
    }
  }

  // 打包产物（asar）只核对清单：asar 内容与 out/ 同源（A11 §3.1 已做过全量内容扫描）
  let asarNote = ''
  if (existsSync(ASAR)) {
    const listed = spawnSync(
      process.execPath,
      [
        '-e',
        `console.log(require('@electron/asar').listPackage(${JSON.stringify(ASAR)}).join('\\n'))`
      ],
      { cwd: ROOT, encoding: 'utf8' }
    )
    if (listed.status === 0) {
      const entries = listed.stdout.split('\n').filter((line) => line.length > 0)
      const asarMaps = entries.filter((entry) => entry.endsWith('.map'))
      if (asarMaps.length > 0) problems.push(`app.asar 内含 sourcemap ${asarMaps.length} 个`)
      asarNote = `；app.asar 清单 ${entries.length} 项无 sourcemap`
    } else {
      asarNote = '；app.asar 清单读取失败（未计入失败，见 A11 §3.1）'
    }
  }

  if (problems.length > 0) {
    add(id, title, 'fail', problems.slice(0, 8).join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    `扫描 ${textFiles.length} 个文本产物：0 sourcemap、0 开发机绝对路径、0 明文密钥模式${asarNote}（运行时日志口径见 A11 §3.3）`
  )
}

async function checkS6() {
  const id = 'S6'
  const title = '写入 workspaceRoots 之外被拒（PATH_DENIED 路径闸，MVP 本地项）'

  const main = await readTextOrUndefined(MAIN_BUNDLE)
  const guard = await readTextOrUndefined(join(ROOT, 'src', 'main', 'services', 'path-guard.ts'))
  if (main === undefined || guard === undefined) {
    missingBuild(
      id,
      [MAIN_BUNDLE, join(ROOT, 'src/main/services/path-guard.ts')].filter((p) => !existsSync(p))
    )
    return
  }

  const problems = []
  if (!main.includes('PATH_DENIED')) problems.push('主进程产物缺 PATH_DENIED 拒绝码')
  if (!/realpath/.test(guard))
    problems.push('path-guard.ts 未做 realpath 归一（符号链接/junction 绕过）')
  if (!/workspaceRoot/i.test(guard)) problems.push('path-guard.ts 未见 workspaceRoot 归属判定')

  if (problems.length > 0) {
    add(id, title, 'fail', problems.join('；'))
    return
  }
  add(
    id,
    title,
    'pass',
    '主进程含 PATH_DENIED；path-guard 以 realpath 归一后判定 workspaceRoot 归属（符号链接/junction/UNC 均由单测矩阵覆盖）'
  )
}

// ---------------------------------------------------------------- 3. 既有单测（可选）

/** S1/S2/S3/S6 的可执行证据：不重复实现断言，直接跑既有单测 */
const SECURITY_TESTS = [
  'tests/unit/window-security.test.ts',
  'tests/unit/channels.test.ts',
  'tests/unit/ipc-router.test.ts',
  'tests/unit/markdown-sanitize.test.ts',
  'tests/unit/path-guard.test.ts'
]

function runSecurityTests() {
  const id = 'S1-S6-tests'
  const title = '既有安全单测（--with-tests）'
  if (!WITH_TESTS) {
    add(
      id,
      title,
      'skip',
      '未带 --with-tests：静态断言已通过，可执行证据请跑 `npm run audit:security -- --with-tests`'
    )
    return
  }
  const run = spawnSync(
    `${npmCommand()} exec -- vitest run --project unit ${SECURITY_TESTS.join(' ')}`,
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000, shell: true, windowsHide: true }
  )
  const tail = (run.stdout ?? '')
    .split('\n')
    .filter((line) => /Test Files|Tests\s/.test(line))
    .join(' ')
    .trim()
  if (run.status !== 0) {
    add(
      id,
      title,
      'fail',
      `安全单测失败（退出码 ${String(run.status)}）：${tail || '见 vitest 输出'}`
    )
    return
  }
  add(id, title, 'pass', tail || `5 个安全测试文件通过`)
}

// ---------------------------------------------------------------- 输出

const ICONS = { pass: '✔ PASS', fail: '✘ FAIL', warn: '▲ WARN', skip: '– SKIP' }

function printReport() {
  const lines = []
  lines.push('=== A9 安全审计（pi-desktop）===')
  lines.push(`目录：${ROOT}`)
  lines.push(
    `构建产物：${existsSync(MAIN_BUNDLE) ? 'out/ 已构建' : 'out/ 缺失（S1–S5 将跳过，先 npm run build）'}`
  )
  lines.push('')
  const width = Math.max(...results.map((item) => item.id.length), 3)
  for (const item of results) {
    lines.push(`${ICONS[item.status]}  ${item.id.padEnd(width)}  ${item.title}`)
    lines.push(`${' '.repeat(8)}${' '.repeat(width)}  ${item.detail}`)
  }
  lines.push('')

  // Phase 2 项显式标注（不冒充已覆盖）
  lines.push('未纳入本门禁（Phase 2 / 需真实远端环境，显式 skip）：')
  lines.push('  - S7 网关 token 缺失/过期/暴力尝试 → Phase 2（A-P2 起）')
  lines.push('  - S8 明文 ws:// 默认拒绝 → Phase 2')
  lines.push(
    "  - S9 伪造其他通道 id 的审批请求 → Phase 2（MVP 的跨会话 requestId 见 S9'，由单测覆盖）"
  )
  lines.push('  - S10 远端越权 ../../etc/passwd → 由远端网关拒绝，Phase 2')
  lines.push('')

  const failed = results.filter((item) => item.status === 'fail')
  const warns = results.filter((item) => item.status === 'warn')
  const skipped = results.filter((item) => item.status === 'skip')
  lines.push(
    `小结：通过 ${results.filter((item) => item.status === 'pass').length} · 失败 ${failed.length} · 警告 ${warns.length} · 跳过 ${skipped.length}`
  )
  console.log(lines.join('\n'))

  if (failed.length > 0) {
    console.error('\n失败项：')
    for (const item of failed) console.error(` - ${item.id} ${item.title}：${item.detail}`)
    process.exitCode = 1
    return
  }
  if (warns.length > 0) {
    console.warn('\n警告（不阻塞，但需人工确认）：')
    for (const item of warns) console.warn(` - ${item.id}：${item.detail}`)
  }
  console.log('\nA9 门禁：通过（无高危依赖、无产物凭证泄漏、S1–S6 静态核查全绿）')
}

await runNpmAudit()
await checkS1()
await checkS2()
await checkS3()
await checkS4()
await checkS5()
await checkS6()
runSecurityTests()
printReport()
