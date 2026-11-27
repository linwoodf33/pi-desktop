#!/usr/bin/env node
/**
 * Mock pi（RPC 模式回放器）——仅用于集成测试与「最小可跑验证」。
 *
 * 严格按 pi 官方协议做出回应（docs/rpc.md、docs/rpc-commands.md、docs/json.md）：
 * - stdin 收命令（每行一条 JSON），stdout 只写协议记录（response / session event）
 * - stderr 写诊断（客户端必须单独缓冲，不能当协议解析）
 * - 关闭 stdin → 优雅退出（exit code 0）
 *
 * 支持命令（M4 起补齐保真度）：
 *   get_state / get_available_models / get_session_stats / get_fork_messages /
 *   prompt / abort / set_model / set_thinking_level / fork / compact
 *
 * A40/A41（专家切换与上下文压缩，只在这些输入出现时生效）：
 * - `prompt` 收到 `/agent <name|none>` → 按 pi-open-agents 的扩展命令回放：先回
 *   `{disposition:'handled'}`，再把 `custom/active_agent` 条目追加到会话文件并发
 *   `entry_appended`（客户端据此实时校准，不需要新通道）；
 * - `compact` → `compaction_start` → `compaction_end` → response（真实顺序），
 *   `get_state.isCompacting` 随之翻转；`MOCK_PI_COMPACT_FAIL=1` 走失败路径。
 * 其它用例的输入不含这两个触发条件，行为逐字节不变。
 * prompt 触发的流式序列：agent_start → turn_start → message_start(user) → message_end(user)
 *   → message_start(assistant) → message_update(text_delta ×N) → message_end(assistant)
 *   → turn_end → agent_end → agent_settled{aborted:false}
 *
 * 流式中再发 prompt（§7 约束 5 / §9.2 I3）：
 * - `streamingBehavior: 'followUp'` → 回 `{disposition:'queued'}`，**本轮 settled 后真正执行**；
 * - `streamingBehavior: 'steer'` → 回 `{disposition:'queued'}`，立即把这条当成新用户消息插进当前轮
 *   （回放 `message_end(user)`，与 pi 的「引导当前步」同形），本轮继续；
 * - 缺 streamingBehavior → `success:false`（真实 pi 的行为，客户端必须报 SESSION_BUSY）。
 *
 * fork（docs/rpc-commands.md#fork）：`entryId` 指向**用户消息** entry；mock 把会话切到新的
 * sessionId/sessionFile，并把用户消息列表截断到该 entry（原会话文件不动）。
 *
 * abort（docs/json.md 的「事件序列」+ docs/rpc-commands.md#abort）：
 * 中止正在进行的 run，把在流的 assistant 消息以 `stopReason: 'aborted'` 收尾，然后
 *   message_end(assistant, aborted) → turn_end → agent_end → agent_settled{aborted:true}
 * 事件先于 response 发出（真实 pi 的 abort 会等会话 idle 后才响应）。空闲时 abort 只回 response。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SESSION_ID = 'mock-session-0001'
/** A23：会话显示名（`set_session_name` 后回显到 get_state.sessionName） */
let sessionName = ''
const SESSION_FILE =
  process.env['MOCK_PI_SESSION_FILE'] ?? 'C:/mock-sessions/mock-session-0001.jsonl'
const REPLY = process.env['MOCK_PI_REPLY'] ?? 'Hello from mock pi'
const DELAY_MS = Number(process.env['MOCK_PI_DELAY_MS'] ?? '5')
/** 开启后一轮里多产生一次 bash 工具调用（E2E E2：工具卡片可见） */
const TOOL_MODE = process.env['MOCK_PI_TOOL'] === '1'

/**
 * 失败尝试模拟（`MOCK_PI_ERROR_MODE=1`）：复现 pi 重试失败时的线上形态——
 * 连续 N 次 `message_start(空 assistant) → message_end(stopReason:'error', errorMessage, content:[])`，
 * **不发** 任何 text delta、**不发** 成功回复。
 *
 * 不设该 env 时行为逐字节不变（其它用例零影响）。
 */
const ERROR_MODE = process.env['MOCK_PI_ERROR_MODE'] === '1'
const ERROR_ATTEMPTS = Number(process.env['MOCK_PI_ERROR_ATTEMPTS'] ?? '3')
const ERROR_TEXT =
  process.env['MOCK_PI_ERROR_TEXT'] ?? 'Request timed out.: Connect Timeout Error (mock)'

/**
 * M5 审批模拟（与真实 pi-desktop-permission 扩展的线上格式一致）：
 * - 启动即发一条 `setStatus` 版本握手（`MOCK_PI_PERMISSION_PROTOCOL` 可调协议版本，用来测不兼容）；
 * - 工具执行前发 `extension_ui_request{method:'select'}`，阻塞等待 `extension_ui_response`；
 * - 只有选了「允许一次 / 本会话允许」才真正执行工具；拒绝 / 取消 / 超时 → 工具被阻止。
 *
 * 这样客户端可以在**不装真实扩展**的前提下走完整审批链路（集成 + E2E）。
 */
const APPROVAL_MODE = process.env['MOCK_PI_APPROVAL'] === '1'
const APPROVAL_TIMEOUT_MS = Number(process.env['MOCK_PI_APPROVAL_TIMEOUT_MS'] ?? '5000')
const HANDSHAKE_PROTOCOL = Number(process.env['MOCK_PI_PERMISSION_PROTOCOL'] ?? '1')
const EXTENSION_VERSION = '1.0.0'
const PERMISSION_MARKER = 'pi-desktop-permission/v1 '
const APPROVAL_OPTIONS = ['允许一次', '本会话允许', '拒绝']
const APPROVAL_CHOICES = ['allow_once', 'allow_session', 'deny']

const argv = process.argv.slice(2)

/**
 * 把收到的启动参数落盘（`MOCK_PI_ARGV_FILE`）。
 * 用途：断言客户端真的把「起始模式」翻译成了 pi 的工具选择参数
 * （`--exclude-tools write,edit,bash,powershell` / `--no-tools`）。
 */
if (process.env['MOCK_PI_ARGV_FILE'] !== undefined) {
  try {
    writeFileSync(process.env['MOCK_PI_ARGV_FILE'], JSON.stringify(argv), 'utf8')
  } catch {
    /* 夹具落盘失败不影响协议行为 */
  }
}

/**
 * A34：pi 的「当前版本」来源。
 *
 * `MOCK_PI_VERSION_FILE` 存在时**优先读文件**，否则回落到 `MOCK_PI_VERSION`（默认 1.5.2）。
 * 为什么要这个文件：`pi update` 只有真的把新版本装上，后续 `pi --version` 才会变；
 * 用文件承载版本，才能让「更新后版本变了」成为真实可观测的事实（而不是测试自己假装）。
 */
const CURRENT_VERSION_FILE = process.env['MOCK_PI_VERSION_FILE']

function currentVersion() {
  if (CURRENT_VERSION_FILE !== undefined) {
    try {
      const fromFile = readFileSync(CURRENT_VERSION_FILE, 'utf8').trim()
      if (fromFile.length > 0) return fromFile
    } catch {
      /* 文件还没落盘：回落到 env */
    }
  }
  return process.env['MOCK_PI_VERSION'] ?? '1.5.2'
}

/**
 * A6（强杀子进程）测试夹具：把自身 pid 落盘，测试据此 `process.kill(pid,'SIGKILL')`。
 * 为什么不用「按命令行匹配 pid」：测试进程/排查工具自身的命令行也会命中标记，容易误杀。
 * 只在 `--mode rpc` 的**长驻**进程里写：`pi --version` 自检的短命进程不能覆盖它。
 */
function recordPidFile() {
  const file = process.env['MOCK_PI_PID_FILE']
  if (file === undefined || file.length === 0) return
  try {
    writeFileSync(file, String(process.pid), 'utf8')
  } catch {
    /* 夹具落盘失败不影响协议行为 */
  }
}
/**
 * A18：`--help` 也要能应答 —— 客户端用它探测 `--agent` 是否可用
 * （该 flag 由 pi-open-agents 扩展注册；未装时传它 pi 会直接 `Error: Unknown option`）。
 * `MOCK_PI_HELP_HAS_AGENT=0` 可模拟「扩展没装」的情形。
 */
if (argv.includes('--help') || argv.includes('-h')) {
  const withAgent = process.env['MOCK_PI_HELP_HAS_AGENT'] !== '0'
  process.stdout.write(
    [
      'Usage: pi [options]',
      '  --mode <mode>                  Output mode: text (default), json, or rpc',
      withAgent ? '  --agent <value>             Default agent to use at startup' : '',
      ''
    ].join(String.fromCharCode(10))
  )
  process.exit(0)
}

// E2E：pi 自检第一步是 `pi --version`（docs/cli.md），mock 也要能应答
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${currentVersion()}
`)
  process.exit(0)
}

/**
 * A34：`pi update` 子命令回放（仅测试用；**不进入 RPC 主循环**）。
 *
 * 真实 `pi update` 没有 dry-run（见 src/main/services/pi-update.ts 头注释），所以这里
 * 只按 `MOCK_PI_UPDATE_MODE` 回放四种真实输出形态：
 * - `in-sync`（默认）：`pi is already up to date (v<当前版本>)`，exit 0，不动任何文件；
 * - `available`：两行 Updating/Updated，并把目标版本写进 `MOCK_PI_VERSION_FILE`，exit 0；
 * - `fail`：stderr 一条 npm EACCES，exit 1；
 * - `no-self`：不支持自更新的两行输出（含 `PI_SELF_UPDATE_COMMAND` 指引），exit 1。
 * `--force`（即 `pi update --force`）：`in-sync` 下先打 `Forcing reinstall of pi`，再按
 * `available` 处理（对应真实 pi 的「强制重装」语义）。
 */
const UPDATE_TO = process.env['MOCK_PI_UPDATE_TO'] ?? '1.6.0'

/** 装「新版本」：唯一能被后续 `pi --version` 观测到的证据就是版本文件 */
function installUpdateVersion(fromVersion) {
  process.stdout.write(`Updating pi from ${fromVersion} to ${UPDATE_TO}
`)
  if (CURRENT_VERSION_FILE !== undefined) {
    try {
      writeFileSync(CURRENT_VERSION_FILE, UPDATE_TO, 'utf8')
    } catch {
      /* 夹具落盘失败不影响输出形态 */
    }
  }
  process.stdout.write(`Updated pi from ${fromVersion} to ${UPDATE_TO}
`)
  process.exit(0)
}

if (argv[0] === 'update') {
  const mode = process.env['MOCK_PI_UPDATE_MODE'] ?? 'in-sync'
  const beforeVersion = currentVersion()
  const forced = argv.includes('--force')

  if (mode === 'fail') {
    process.stderr.write(`npm ERR! code EACCES: permission denied, open '/usr/lib/node_modules/pi'
`)
    process.exit(1)
  }
  if (mode === 'no-self') {
    process.stdout.write(`pi cannot self-update this installation.
Set PI_SELF_UPDATE_COMMAND to customize how pi is updated.
`)
    process.exit(1)
  }
  if (mode === 'in-sync' && forced) {
    process.stdout.write(`Forcing reinstall of pi
`)
    installUpdateVersion(beforeVersion)
  }
  if (mode === 'available') {
    installUpdateVersion(beforeVersion)
  }
  if (mode !== 'in-sync') {
    process.stderr.write(`mock-pi: 未知的 MOCK_PI_UPDATE_MODE=${mode}
`)
    process.exit(2)
  }
  process.stdout.write(`pi is already up to date (v${beforeVersion})
`)
  process.exit(0)
}

/** A37：`pi install <source>` 子命令回放（仅测试用；**不进入 RPC 主循环**）。
 *
 * `MOCK_PI_INSTALL_MODE`：
 * - `ok`（默认）：两行输出，并把「装上了」写成磁盘事实：
 *   ① `<MOCK_PI_AGENT_DIR>/settings.json#packages` 追加该 source；
 *   ② npm 源再写 `<agentDir>/npm/node_modules/<pkg>/package.json`（版本 9.9.9）；
 * - `fail`：stderr 一条 npm EACCES，exit 1；
 * - `slow`：打 `Installing` 后等 `MOCK_PI_INSTALL_DELAY_MS`（默认 3000）再按 ok 收尾（测取消）；
 * - `noop`：两行输出但 exit 0 **不写** settings（测「exit 0 但登记没出现」）。
 * 收到的 argv 落 `MOCK_PI_INSTALL_ARGV_FILE`，用于断言恰好是 `['install', source]`。
 */
if (argv[0] === 'install') {
  const source = argv[1] ?? ''
  const agentDir = process.env['MOCK_PI_AGENT_DIR']
  const mode = process.env['MOCK_PI_INSTALL_MODE'] ?? 'ok'

  if (process.env['MOCK_PI_INSTALL_ARGV_FILE'] !== undefined) {
    try {
      writeFileSync(process.env['MOCK_PI_INSTALL_ARGV_FILE'], JSON.stringify(argv), 'utf8')
    } catch {
      /* 夹具落盘失败不影响输出形态 */
    }
  }

  /** 把「真的装上了」写成磁盘事实（settings 登记 + npm 包清单） */
  function writeInstalledEvidence() {
    if (agentDir === undefined || agentDir.length === 0) return

    const settingsPath = join(agentDir, 'settings.json')
    let settings = {}
    try {
      const text = readFileSync(settingsPath, 'utf8')
      if (text.trim().length > 0) settings = JSON.parse(text)
    } catch {
      /* 不存在 / 损坏：重建一个最小 settings */
    }
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {}
    const packages = Array.isArray(settings.packages) ? settings.packages : []
    if (!packages.includes(source)) packages.push(source)
    settings.packages = packages
    try {
      mkdirSync(agentDir, { recursive: true })
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    } catch {
      /* 夹具落盘失败不影响输出形态 */
    }

    if (!source.startsWith('npm:')) return
    const spec = source.slice('npm:'.length)
    const at = spec.lastIndexOf('@')
    const name = at > 0 ? spec.slice(0, at) : spec
    const segments = name.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) return
    try {
      const pkgDir = join(agentDir, 'npm', 'node_modules', ...segments)
      mkdirSync(pkgDir, { recursive: true })
      const manifest = { name, version: '9.9.9', description: 'mock package' }
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
    } catch {
      /* 同上 */
    }
  }

  if (mode === 'fail') {
    process.stderr.write(`npm ERR! code EACCES: permission denied, open '${source}'\n`)
    process.exit(1)
  }
  if (mode === 'noop') {
    process.stdout.write(`Installing ${source}\n`)
    process.stdout.write(`Installed ${source}\n`)
    process.exit(0)
  }
  if (mode === 'slow') {
    process.stdout.write(`Installing ${source}
`)
    const rawDelay = Number(process.env['MOCK_PI_INSTALL_DELAY_MS'] ?? '3000')
    const delayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 3000
    // 必须真的等：只 setTimeout 不 await 会继续往下走，落到 RPC 校验分支直接 exit(2)，
    // 客户端就会立刻看到进程退出（取消用例永远测不到「进行中」）。
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    })
    process.stdout.write(`Installed ${source}\n`)
    process.exit(0)
  }
  if (mode === 'ok') {
    process.stdout.write(`Installing ${source}\n`)
    writeInstalledEvidence()
    process.stdout.write(`Installed ${source}\n`)
    process.exit(0)
  } else {
    process.stderr.write(`mock-pi: 未知的 MOCK_PI_INSTALL_MODE=${mode}\n`)
    process.exit(2)
  }
}

if (!argv.includes('--mode') || !argv.includes('rpc')) {
  process.stderr.write(`mock-pi: 需要以 --mode rpc 启动，收到 ${JSON.stringify(argv)}\n`)
  process.exit(2)
}

recordPidFile()

/**
 * A38：把「当前 agent」写进会话文件的扩展条目（与 pi-open-agents 同形）。
 *
 * 真实 pi 的 `get_state` 不返回 agent，客户端只能读文件里的
 * `custom/open-agents-state` 条目；这个开关让 e2e 能端到端验证那条读路径。
 * 不设 `MOCK_PI_AGENT_STATE` 时行为完全不变（其它用例零影响）。
 */
function recordAgentState() {
  const raw = process.env['MOCK_PI_AGENT_STATE']
  if (raw === undefined) return
  const name = raw === '__null__' ? null : raw
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    appendFileSync(
      SESSION_FILE,
      `${JSON.stringify({
        type: 'custom',
        customType: 'open-agents-state',
        data: { name },
        id: 'agent-1',
        parentId: null,
        timestamp: new Date().toISOString()
      })}\n`,
      'utf8'
    )
  } catch {
    /* 夹具落盘失败不影响协议行为 */
  }
}

recordAgentState()

/**
 * A40：把 `/agent` 的结果写成扩展条目（与 pi-open-agents 的 `active_agent` 同形）。
 *
 * 只在显式指定会话文件时落盘（与 `appendSessionMessage` 同风格）：其它用例不产生磁盘副作用。
 */
function appendAgentEntry(name) {
  if (process.env['MOCK_PI_SESSION_FILE'] === undefined) return
  agentEntrySeq += 1
  try {
    mkdirSync(dirname(sessionFile), { recursive: true })
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'custom',
        customType: 'active_agent',
        data: { name },
        id: `agent-switch-${agentEntrySeq}`,
        parentId: null,
        timestamp: new Date().toISOString()
      })}\n`,
      'utf8'
    )
  } catch {
    /* 夹具落盘失败不影响协议行为 */
  }
}

function writeRecord(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function respond(id, command, data) {
  writeRecord(
    data === undefined
      ? { type: 'response', id, command, success: true }
      : { type: 'response', id, command, success: true, data }
  )
}

const MODEL = {
  id: 'mock-model',
  name: 'Mock Model',
  provider: 'mock',
  api: 'mock-messages',
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

let messageCount = 0
let streaming = false
/** A41：压缩中（`get_state.isCompacting` 的事实来源） */
let compacting = false
/** A40：`/agent` 写的 active_agent 条目序号 */
let agentEntrySeq = 0
/** 未决 extension_ui_request：id → resolve(value | undefined) */
const pendingUi = new Map()
let uiSeq = 0
/** 当前在跑的 run：{ timer, text() }，abort 时用它收尾 */
let activeRun = null
/** 已收到的用户消息 entry 列表（get_fork_messages / fork 用，模拟 JSONL 的 tree entry） */
const userEntries = []
/** followUp 排队（本轮 settled 后执行；与 pi 的 pendingMessage 同义） */
const queuedPrompts = []
let sessionId = SESSION_ID
let sessionFile = SESSION_FILE
/** 工具调用序号（每次调用唯一，模拟真实 pi 的 toolCallId） */
let toolSeq = 0

function assistantMessage(text, stopReason, errorMessage) {
  return {
    role: 'assistant',
    content: text.length > 0 ? [{ type: 'text', text }] : [],
    api: 'mock-messages',
    provider: 'mock',
    model: 'mock-model',
    stopReason,
    // 只有真的失败时才出现（与真实 pi 同形：正常回复不带 errorMessage 字段）
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now()
  }
}

/** 失败消息同步落盘（仅 `MOCK_PI_SESSION_FILE` 显式设置时，与 recordAgentState 同风格） */
let sessionEntrySeq = 0
function appendSessionMessage(message) {
  if (process.env['MOCK_PI_SESSION_FILE'] === undefined) return
  sessionEntrySeq += 1
  try {
    mkdirSync(dirname(sessionFile), { recursive: true })
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'message',
        id: `err-${sessionEntrySeq}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message
      })}\n`,
      'utf8'
    )
  } catch {
    /* 夹具落盘失败不影响协议行为 */
  }
}

/**
 * 连续失败尝试序列（`MOCK_PI_ERROR_MODE=1`）。
 *
 * 间隔用 `DELAY_MS * 4`：reducer 的去重键含 timestamp，同毫秒内的多条失败会被幂等吞成一条
 * （产品的已知降级），夹具必须让每条失败的时间戳不同，才能测出「连续 N 次」。
 * 运行态仍挂在 `activeRun` 上，`abort` 的收尾语义保持不变（timer 由 setTimeout 创建，
 * 中止时用 clearTimeout 清理）。
 */
function startFailedAttempts() {
  let remaining =
    Number.isFinite(ERROR_ATTEMPTS) && ERROR_ATTEMPTS >= 1 ? Math.floor(ERROR_ATTEMPTS) : 1
  const run = { timer: null, text: () => '' }

  const step = () => {
    if (activeRun !== run) return
    if (remaining > 0) {
      remaining -= 1
      writeRecord({
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: Date.now() }
      })
      const message = assistantMessage('', 'error', ERROR_TEXT)
      writeRecord({ type: 'message_end', message })
      appendSessionMessage(message)
      run.timer = setTimeout(step, DELAY_MS * 4)
      run.timer.unref?.()
      return
    }
    writeRecord({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'error' },
      toolResults: []
    })
    writeRecord({ type: 'agent_end', messages: [], willRetry: false })
    messageCount += 2
    streaming = false
    activeRun = null
    writeRecord({ type: 'agent_settled', aborted: false })
    drainQueue()
  }

  activeRun = run
  step()
}

/** 工具调用序列（docs/json.md#tool-execution-events）：start → end → toolResult 消息 */
function emitToolSequence(toolCallId, toolName, args, output) {
  writeRecord({ type: 'tool_execution_start', toolCallId, toolName, args })
  writeRecord({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text: output }], details: {} },
    isError: false,
    durationMs: 12
  })
  writeRecord({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text: output }],
      isError: false,
      timestamp: Date.now()
    }
  })
}

/**
 * 发一条审批请求并等待响应（模拟 pi-desktop-permission 的 tool_call 前置钩子）。
 * 超时 / cancelled / 未知选项一律返回 undefined（客户端与扩展都按「拒绝」处理）。
 */
function requestApproval(toolName, input) {
  return new Promise((resolve) => {
    uiSeq += 1
    const id = `ui-${uiSeq}`
    const meta = {
      protocol: HANDSHAKE_PROTOCOL,
      version: EXTENSION_VERSION,
      tool: toolName,
      risk: 'high',
      summary: String(input.command ?? ''),
      args: Object.entries(input).map(([k, v]) => ({ k, v: String(v) })),
      timeoutMs: APPROVAL_TIMEOUT_MS,
      options: APPROVAL_OPTIONS,
      choices: APPROVAL_CHOICES,
      sessionId
    }
    const title = `需要批准：${toolName}\n${meta.summary}\n风险：在本地执行 shell 命令\n\n${PERMISSION_MARKER}${JSON.stringify(meta)}`
    const timer = setTimeout(() => {
      if (!pendingUi.has(id)) return
      pendingUi.delete(id)
      resolve(undefined)
    }, APPROVAL_TIMEOUT_MS)
    timer.unref?.()
    pendingUi.set(id, (value) => {
      clearTimeout(timer)
      resolve(value === APPROVAL_OPTIONS[0] || value === APPROVAL_OPTIONS[1] ? value : undefined)
    })
    writeRecord({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title,
      options: APPROVAL_OPTIONS,
      timeout: APPROVAL_TIMEOUT_MS
    })
  })
}

/** 版本握手（fire-and-forget setStatus，与扩展实现同形） */
function writeHandshake() {
  writeRecord({
    type: 'extension_ui_request',
    id: `hs-${sessionId}`,
    method: 'setStatus',
    statusKey: 'pi-desktop-permission',
    statusText: JSON.stringify({
      ext: 'pi-desktop-permission',
      version: EXTENSION_VERSION,
      protocol: HANDSHAKE_PROTOCOL,
      enabled: true,
      tools: ['bash', 'powershell', 'write', 'edit'],
      timeoutMs: APPROVAL_TIMEOUT_MS,
      compatible: HANDSHAKE_PROTOCOL === 1
    })
  })
}

/**
 * 工具调用序列 —— 审批模式下先问用户：
 * - 允许 → 正常执行（tool_execution_start/end + toolResult 消息）；
 * - 拒绝 / 超时 → 工具**未执行**，只留一条 isError 的 toolResult（与 pi 阻止调用同形）。
 */
async function emitToolSequenceWithApproval() {
  // 与真实 pi 一致：每次工具调用都用**唯一** toolCallId（renderer 按 id 关联卡片，
  // 复用同一个 id 会让后一轮的卡片覆盖前一轮的，压测时低估了 DOM 增长）
  toolSeq += 1
  const toolCallId = `call_mock_${toolSeq}`
  const toolName = 'bash'
  const args = { command: 'ls -la' }

  let allowed = true
  if (APPROVAL_MODE) {
    const choice = await requestApproval(toolName, args)
    allowed = choice !== undefined
  }

  if (!allowed) {
    writeRecord({ type: 'tool_execution_start', toolCallId, toolName, args })
    writeRecord({
      type: 'tool_execution_end',
      toolCallId,
      toolName,
      result: { content: [{ type: 'text', text: '用户拒绝了工具 bash 的执行' }], details: {} },
      isError: true,
      durationMs: 3
    })
    writeRecord({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text: '用户拒绝了工具 bash 的执行' }],
        isError: true,
        timestamp: Date.now()
      }
    })
    return
  }

  emitToolSequence(toolCallId, toolName, args, 'a.txt\nb.txt')
}

/** 一轮正常结束：message_end → turn_end → agent_end → agent_settled */
async function completeRun(text) {
  if (TOOL_MODE) {
    writeRecord({ type: 'message_end', message: assistantMessage(text, 'stop') })
    await emitToolSequenceWithApproval()
    writeRecord({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })
    writeRecord({ type: 'agent_end', messages: [], willRetry: false })
    messageCount += 2
    streaming = false
    activeRun = null
    writeRecord({ type: 'agent_settled', aborted: false })
    drainQueue()
    return
  }
  writeRecord({ type: 'message_end', message: assistantMessage(text, 'stop') })
  writeRecord({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })
  writeRecord({ type: 'agent_end', messages: [], willRetry: false })
  messageCount += 2
  streaming = false
  activeRun = null
  writeRecord({ type: 'agent_settled', aborted: false })
  drainQueue()
}

/**
 * followUp 队列：本轮 settled 之后真正执行（M4 保真度）。
 * 真实 pi 会把排队的消息作为下一轮的开头，这里用同样的消息形状重放一遍。
 */
function drainQueue() {
  const next = queuedPrompts.shift()
  if (next === undefined) return
  agentRun(next.text, next.images)
}

/** 中止当前 run：与真实 pi 一致，先补 message_end(aborted) 再收尾到 agent_settled */
function abortRun() {
  // 中止时把所有未决审批按「取消」释放（等价于客户端一直不回包的超时路径）
  for (const [pendingId, resolve] of pendingUi) {
    pendingUi.delete(pendingId)
    resolve(undefined)
  }
  const run = activeRun
  if (run === null) return false
  activeRun = null
  clearTimeout(run.timer)
  streaming = false

  const text = run.text()
  writeRecord({ type: 'message_end', message: assistantMessage(text, 'aborted') })
  writeRecord({
    type: 'turn_end',
    message: { role: 'assistant', stopReason: 'aborted' },
    toolResults: []
  })
  writeRecord({ type: 'agent_end', messages: [], willRetry: false })
  messageCount += 2
  writeRecord({ type: 'agent_settled', aborted: true })
  return true
}

/**
 * 组装 user 消息的 content。
 *
 * 真实 pi 把用户消息（含图片）原样存进会话记录，所以 mock 也要回显图片块 ——
 * 否则「发了截图 → 回显只有文字」，客户端的缩略图就会依赖本地兜底而不是上游事实。
 */
function userContent(promptText, images) {
  // 无图片时保持字符串形状：既有集成用例（I3 followUp/steer）按字符串断言 content
  if (images.length === 0) return promptText
  const blocks = []
  if (promptText.length > 0) blocks.push({ type: 'text', text: promptText })
  for (const image of images) {
    blocks.push({
      type: 'image',
      data: String(image?.data ?? ''),
      mimeType: String(image?.mimeType ?? '')
    })
  }
  return blocks.length > 0 ? blocks : promptText
}

function agentRun(promptText, images = []) {
  streaming = true
  const userTimestamp = Date.now()
  userEntries.push({ entryId: `entry-${userEntries.length + 1}`, text: promptText })
  writeRecord({ type: 'agent_start' })
  writeRecord({ type: 'turn_start' })
  const userPayload = userContent(promptText, images)
  writeRecord({
    type: 'message_start',
    message: { role: 'user', content: userPayload, timestamp: userTimestamp }
  })
  writeRecord({
    type: 'message_end',
    message: { role: 'user', content: userPayload, timestamp: userTimestamp }
  })
  // 失败模式：只发失败尝试，**不发** 文本 delta / 成功回复
  if (ERROR_MODE) {
    startFailedAttempts()
    return
  }
  writeRecord({
    type: 'message_start',
    message: { role: 'assistant', content: [], timestamp: Date.now() }
  })

  const chunks = REPLY.split(/(?<= )/)
  let emitted = ''
  let index = 0
  const timer = setInterval(() => {
    if (activeRun === null) return
    if (index < chunks.length) {
      const delta = chunks[index]
      index += 1
      emitted += delta
      writeRecord({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta }
      })
      return
    }
    clearInterval(timer)
    void completeRun(REPLY)
  }, DELAY_MS)
  timer.unref?.()

  activeRun = { timer, text: () => emitted }
}

function handleCommand(command) {
  const { id, type } = command

  // 审批响应不是普通命令：用请求 id 关联（docs/rpc.md：不产生 command response）
  if (type === 'extension_ui_response') {
    const resolve = pendingUi.get(String(id))
    if (resolve !== undefined) {
      pendingUi.delete(String(id))
      resolve(command.cancelled === true ? undefined : command.value)
    }
    return
  }

  switch (type) {
    case 'get_state':
      respond(id, 'get_state', {
        model: MODEL,
        thinkingLevel: 'medium',
        isStreaming: streaming,
        isCompacting: compacting,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        sessionFile: sessionFile,
        sessionId: sessionId,
        // A23：改名后 get_state 回显（真实 pi 同形）
        ...(sessionName.length === 0 ? {} : { sessionName }),
        messageCount,
        pendingMessageCount: 0
      })
      return
    case 'get_available_models':
      respond(id, 'get_available_models', { models: [MODEL] })
      return
    case 'prompt': {
      const text = String(command.message ?? '')
      /**
       * A40：扩展命令（pi-open-agents 的 `/agent`）。
       * 必须在 streaming / 排队判定**之前**处理：真实 pi 对扩展命令立即执行并回 handled，
       * 不管当前是否在流式中（这里仍按只回 handled 处理，不推进 busy）。
       */
      if (text.startsWith('/agent')) {
        const arg = text.slice('/agent'.length).trim()
        if (process.env['MOCK_PI_AGENT_SWITCH_FILE'] !== undefined) {
          try {
            appendFileSync(process.env['MOCK_PI_AGENT_SWITCH_FILE'], `${arg}\n`, 'utf8')
          } catch {
            /* 夹具落盘失败不影响协议行为 */
          }
        }
        respond(id, 'prompt', { disposition: 'handled' })
        const name = arg.length === 0 || arg === 'none' || arg === 'clear' ? null : arg
        appendAgentEntry(name)
        writeRecord({
          type: 'entry_appended',
          entry: {
            type: 'custom',
            customType: 'active_agent',
            data: { name },
            id: `agent-switch-${agentEntrySeq + 1}`,
            parentId: null,
            timestamp: new Date().toISOString()
          }
        })
        return
      }
      /**
       * A19：记录收到的 prompt 载荷（含图片），供 E2E 断言「粘贴的截图真的发出去了」。
       * 只记数量与 MIME，不落图片内容（夹具不处理真实像素）。
       */
      const promptImages = Array.isArray(command.images) ? command.images : []
      if (process.env['MOCK_PI_PROMPT_FILE'] !== undefined) {
        try {
          const images = Array.isArray(command.images) ? command.images : []
          appendFileSync(
            process.env['MOCK_PI_PROMPT_FILE'],
            JSON.stringify({
              text,
              imageCount: images.length,
              mimeTypes: images.map((image) => String(image?.mimeType ?? '')),
              dataPrefixes: images.map((image) => String(image?.data ?? '').slice(0, 8))
            }) + String.fromCharCode(10),
            'utf8'
          )
        } catch {
          /* 夹具落盘失败不影响协议行为 */
        }
      }
      if (streaming && command.streamingBehavior === undefined) {
        writeRecord({
          type: 'response',
          id,
          command: 'prompt',
          success: false,
          error: 'Agent is streaming; streamingBehavior is required'
        })
        return
      }
      if (streaming) {
        // 两种排队语义都先回 queued（与 pi 一致），差别在「什么时候生效」
        respond(id, 'prompt', { disposition: 'queued' })
        if (command.streamingBehavior === 'steer') {
          // steer：立即插进当前轮（用户消息立刻可见），本轮继续
          userEntries.push({ entryId: `entry-${userEntries.length + 1}`, text })
          writeRecord({
            type: 'message_end',
            message: {
              role: 'user',
              content: userContent(text, promptImages),
              timestamp: Date.now()
            }
          })
        } else {
          // followUp：本轮 settled 之后执行（drainQueue）
          queuedPrompts.push({ text, images: promptImages })
        }
        return
      }
      respond(id, 'prompt', { disposition: 'started' })
      agentRun(text, promptImages)
      return
    }
    case 'compact': {
      /**
       * A41：手动压缩。
       *
       * 顺序与真实 pi 一致：`compaction_start` → `compaction_end` → response。
       * 客户端必须在「事件先到 / 响应先到」两种顺序下都不残留「压缩中」状态。
       */
      compacting = true
      writeRecord({ type: 'compaction_start', reason: 'manual' })
      if (process.env['MOCK_PI_COMPACT_FAIL'] === '1') {
        compacting = false
        writeRecord({
          type: 'compaction_end',
          reason: 'manual',
          aborted: false,
          errorMessage: 'mock compact failed'
        })
        writeRecord({
          type: 'response',
          id,
          command: 'compact',
          success: false,
          error: 'mock compact failed'
        })
        return
      }
      const compactResult = {
        summary: '（mock 压缩摘要）',
        firstKeptEntryId: 'entry-1',
        tokensBefore: 120000,
        estimatedTokensAfter: 20000
      }
      writeRecord({
        type: 'compaction_end',
        reason: 'manual',
        aborted: false,
        result: compactResult
      })
      compacting = false
      respond(id, 'compact', {
        ...compactResult,
        usage: { inputTokens: 1000, outputTokens: 200 },
        details: {}
      })
      return
    }
    case 'abort':
      // 事件先于响应（真实 pi 会等会话 idle 后才回 response）
      abortRun()
      respond(id, 'abort')
      return
    case 'set_session_name':
      // A23：改名（活跃会话）→ pi 侧只回成功；真实 pi 会把 session_info 写进 JSONL
      sessionName = String(command.name ?? '')
      respond(id, 'set_session_name')
      return
    case 'set_model':
    case 'set_thinking_level':
      respond(id, type)
      return
    case 'get_session_stats':
      // 形状对齐 docs/rpc-commands.md#get_session_stats（含 tokens/cost/contextUsage）
      respond(id, 'get_session_stats', {
        sessionFile: sessionFile,
        sessionId: sessionId,
        userMessages: userEntries.length,
        assistantMessages: messageCount,
        toolCalls: TOOL_MODE ? 1 : 0,
        toolResults: TOOL_MODE ? 1 : 0,
        totalMessages: userEntries.length + messageCount,
        tokens: {
          input: 1000 * userEntries.length,
          output: 500 * messageCount,
          cacheRead: 200 * userEntries.length,
          cacheWrite: 0,
          total: 1200 * userEntries.length + 500 * messageCount
        },
        cost: 0.001 * userEntries.length,
        contextUsage: { tokens: 1000 * userEntries.length, contextWindow: 128000, percent: 1 }
      })
      return
    case 'get_fork_messages':
      respond(id, 'get_fork_messages', { messages: userEntries.slice() })
      return
    case 'fork': {
      const entryId = String(command.entryId ?? '')
      const index = userEntries.findIndex((entry) => entry.entryId === entryId)
      if (index < 0) {
        writeRecord({
          type: 'response',
          id,
          command: 'fork',
          success: false,
          error: `Unknown entryId: ${entryId}`
        })
        return
      }
      // 截断到该用户消息之前（分叉从这条消息重新开始），并切到新的 session 身份
      const forkedText = userEntries[index].text
      userEntries.length = index
      sessionId = `mock-session-fork-${index + 1}`
      sessionFile = sessionFile.replace(/\.jsonl$/, `-fork-${index + 1}.jsonl`)
      respond(id, 'fork', { text: forkedText, cancelled: false })
      return
    }
    default:
      writeRecord({
        type: 'response',
        id,
        command: type,
        success: false,
        error: `mock-pi 不支持命令 ${String(type)}`
      })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let lf = buffer.indexOf('\n')
  while (lf !== -1) {
    const line = buffer.slice(0, lf).replace(/\r$/, '')
    buffer = buffer.slice(lf + 1)
    if (line.trim().length > 0) {
      try {
        handleCommand(JSON.parse(line))
      } catch (error) {
        writeRecord({
          type: 'response',
          command: 'parse',
          success: false,
          error: `Failed to parse command: ${String(error)}`
        })
      }
    }
    lf = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => {
  process.stderr.write('mock-pi: stdin closed, shutting down\n')
  process.exit(0)
})

if (APPROVAL_MODE) writeHandshake()

// 启动横幅只进 stderr（stdout 必须纯净）
process.stderr.write(`mock-pi rpc ready (pid ${process.pid})\n`)
// 注：Node 全局（process / setInterval 等）由 eslint.config.mjs 的 tests/**/*.mjs 块提供。
