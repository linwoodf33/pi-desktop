/**
 * pi-desktop-permission 审批协议（**扩展侧**：编码 + 策略解析 + 参数摘要脱敏）。
 *
 * 为什么单独一个纯模块：
 * - 扩展由 pi 通过 jiti 加载，运行在 pi 进程里，**只能**依赖自身目录内的文件；
 * - 逻辑要能被 vitest 直接单测（不启动 pi），因此这里不出现任何 pi 类型或副作用；
 * - 客户端解码侧在 `src/shared/contracts/permission.ts`，两侧由
 *   `tests/unit/permission-wire.test.ts` 用同一份样例钉死线上格式（防漂移）。
 *
 * 线上格式（`extension_ui_request{method:'select'}` 只有 title/options/timeout 三个可承载
 * 信息的字段，见 docs/rpc-extension-ui.md），因此：
 * - 人类可读文本放在 title 前几行；
 * - 机器可读元数据放在**最后一行**，形如
 *   `pi-desktop-permission/v1 {"protocol":1,...}`（单行、值全部 JSON 转义，不会出现裸换行）；
 * - 选项字符串顺序与 `choices` 一一对应（下标即语义）。
 */

export const EXTENSION_NAME = 'pi-desktop-permission'
export const EXTENSION_VERSION = '1.0.0'

/** 协议版本：客户端 `src/shared/contracts/permission.ts` 必须同值，否则视为不兼容（fail-closed） */
export const PERMISSION_PROTOCOL_VERSION = 1

/** 机器可读块的行前缀（客户端用最后一行 + 该前缀识别） */
export const MARKER_PREFIX = `${EXTENSION_NAME}/v${PERMISSION_PROTOCOL_VERSION} `

/** 用于 fire-and-forget 版本握手的 statusKey（docs/rpc-extension-ui.md#setStatus） */
export const STATUS_KEY = EXTENSION_NAME

/** 审批时钟（§6.3：全系统唯一时钟 120s，由扩展侧权威判定） */
export const DEFAULT_TIMEOUT_MS = 120_000
export const MIN_TIMEOUT_MS = 5_000
export const MAX_TIMEOUT_MS = 600_000

export const OPTION_ALLOW_ONCE = '允许一次'
export const OPTION_ALLOW_SESSION = '本会话允许'
export const OPTION_DENY = '拒绝'

/** 顺序即语义，客户端按 `choices[下标]` 取选择（不要按文案匹配） */
export const APPROVAL_OPTIONS: readonly string[] = [
  OPTION_ALLOW_ONCE,
  OPTION_ALLOW_SESSION,
  OPTION_DENY
]
export const APPROVAL_CHOICES: readonly string[] = ['allow_once', 'allow_session', 'deny']

/** 高危工具默认清单（§Q4：bash / powershell / write / edit / 删除类） */
export const DEFAULT_APPROVAL_TOOLS: readonly string[] = ['bash', 'powershell', 'write', 'edit']

/**
 * 环境变量：客户端 spawn pi 时注入，扩展读取。
 *
 * 为什么用环境变量而不是扩展配置文件：配置的所有者是客户端（设置页），
 * 客户端本来就控制子进程环境（`local-connection.ts` 的 `buildChildEnv`），
 * 下发策略不需要第二个写入方，也不会把偏好落到扩展目录里。
 */
export const POLICY_ENV_KEY = 'PI_DESKTOP_PERMISSION'

export type RiskLevel = 'critical' | 'high' | 'medium'

export interface PermissionPolicy {
  /** false = 用户在设置页关掉了审批（显式值才生效） */
  enabled: boolean
  /** 需要审批的工具名（小写比较） */
  tools: readonly string[]
  timeoutMs: number
  /** 客户端声明的协议版本；与扩展不一致时仍按 fail-closed 审批，并上报 incompatible */
  clientProtocol: number
  /** 策略是否与扩展协议兼容（false 时 UI 需显式告警，且不得静默放行） */
  compatible: boolean
  /** 解析策略时遇到的问题（仅诊断用，不含敏感内容） */
  warning?: string
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  const rounded = Math.round(value)
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, rounded))
}

function normalizeTools(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_APPROVAL_TOOLS
  const tools = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0 && item.length <= 64)
  // 空数组是「用户一个都不想拦」，语义合法；但格式错（非数组）时回退默认（fail-closed）
  return [...new Set(tools)]
}

/**
 * 解析客户端下发的策略。
 *
 * fail-closed 原则：
 * - 环境变量缺失 → 用默认策略（**审批开启**，默认高危工具清单）；
 * - JSON 非法 / 形状不对 → 仍用默认策略并附 warning，绝不因为配置坏了就放行；
 * - 只有客户端显式 `enabled:false` 才关闭审批。
 */
export function parsePolicy(raw: string | undefined): PermissionPolicy {
  if (raw === undefined || raw.trim().length === 0) {
    return {
      enabled: true,
      tools: DEFAULT_APPROVAL_TOOLS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      clientProtocol: PERMISSION_PROTOCOL_VERSION,
      compatible: true
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      enabled: true,
      tools: DEFAULT_APPROVAL_TOOLS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      clientProtocol: PERMISSION_PROTOCOL_VERSION,
      compatible: true,
      warning: `${POLICY_ENV_KEY} 不是合法 JSON，已回退到默认审批策略`
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      enabled: true,
      tools: DEFAULT_APPROVAL_TOOLS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      clientProtocol: PERMISSION_PROTOCOL_VERSION,
      compatible: true,
      warning: `${POLICY_ENV_KEY} 不是对象，已回退到默认审批策略`
    }
  }

  const record = parsed as Record<string, unknown>
  const clientProtocol =
    typeof record['protocolVersion'] === 'number' && Number.isFinite(record['protocolVersion'])
      ? Math.trunc(record['protocolVersion'])
      : PERMISSION_PROTOCOL_VERSION
  const compatible = clientProtocol === PERMISSION_PROTOCOL_VERSION

  return {
    enabled: record['enabled'] !== false,
    tools: normalizeTools(record['tools']),
    timeoutMs: clampTimeout(record['timeoutMs']),
    clientProtocol,
    compatible,
    ...(compatible ? {} : { warning: `客户端协议 v${clientProtocol} 与扩展 v${PERMISSION_PROTOCOL_VERSION} 不兼容` })
  }
}

/** 版本握手载荷（`setStatus` 的 statusText，单行 JSON） */
export interface HandshakePayload {
  ext: string
  version: string
  protocol: number
  enabled: boolean
  tools: readonly string[]
  timeoutMs: number
  compatible: boolean
}

export function buildHandshake(policy: PermissionPolicy): HandshakePayload {
  return {
    ext: EXTENSION_NAME,
    version: EXTENSION_VERSION,
    protocol: PERMISSION_PROTOCOL_VERSION,
    enabled: policy.enabled,
    tools: policy.tools,
    timeoutMs: policy.timeoutMs,
    compatible: policy.compatible
  }
}

export function encodeHandshake(payload: HandshakePayload): string {
  return JSON.stringify(payload)
}

/* ------------------------------------------------------------------ *
 * 工具调用 → 人类可读风险描述 + 脱敏参数摘要
 * ------------------------------------------------------------------ */

export interface ApprovalArg {
  k: string
  v: string
}

export interface ApprovalMeta {
  protocol: number
  version: string
  tool: string
  risk: RiskLevel
  summary: string
  args: ApprovalArg[]
  timeoutMs: number
  options: readonly string[]
  choices: readonly string[]
  sessionId?: string
}

/** 破坏性命令模式（只用于「风险升级 + 文案」，不参与是否审批的判定） */
const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: '递归/强制删除' },
  { pattern: /\brmdir\s+\/s\b/i, reason: '递归删除目录' },
  { pattern: /\bdel\s+\/[a-z]*[fsq]/i, reason: '强制删除文件' },
  { pattern: /\bRemove-Item\b[^\n]*-Recurse/i, reason: '递归删除' },
  { pattern: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: '创建文件系统' },
  { pattern: /\bdd\s+if=/i, reason: '裸写块设备' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/, reason: 'fork 炸弹' },
  { pattern: /\bpowershell(\.exe)?\b[^\n]*-enc(odedcommand)?\b/i, reason: '编码后的 PowerShell 命令' },
  { pattern: /\bgit\s+push\b[^\n]*--force/i, reason: '强制推送' },
  { pattern: /\bshutdown\b|\breboot\b/i, reason: '关机/重启' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: '放开文件权限' },
  { pattern: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|powershell)/i, reason: '下载即执行' }
]

/** 密钥样式（值里出现的令牌串一律打码，避免把凭据塞进日志/UI/会话记录） */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
]

/** 字段名疑似密钥 → 整段打码 */
const SECRET_KEY_PATTERN = /(token|password|passwd|secret|api[-_]?key|apikey|credential|private)/i

const MAX_ARG_VALUE_CHARS = 160
const MAX_ARGS = 8
const MAX_SUMMARY_CHARS = 200

export function redactValue(value: string): string {
  let masked = value
  for (const pattern of SECRET_VALUE_PATTERNS) {
    masked = masked.replace(pattern, '[已隐藏]')
  }
  return masked.length > MAX_ARG_VALUE_CHARS ? `${masked.slice(0, MAX_ARG_VALUE_CHARS)}…` : masked
}

function stringifyArgValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[不可序列化]'
  }
}

/**
 * 工具入参 → 脱敏摘要。
 *
 * 约束（§7 约束 9/12、§9.4 S5）：不把密钥、也不把整段长文本塞进 UI/日志；
 * 每个值截断 160 字符、最多 8 个字段，疑似密钥字段名直接打码。
 */
export function summarizeToolInput(input: unknown): { args: ApprovalArg[]; summary: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { args: [], summary: '' }
  }
  const entries = Object.entries(input as Record<string, unknown>)
  const args: ApprovalArg[] = []
  for (const [key, rawValue] of entries.slice(0, MAX_ARGS)) {
    const text = stringifyArgValue(rawValue).replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    const value = SECRET_KEY_PATTERN.test(key) ? '[已隐藏]' : redactValue(text)
    args.push({ k: key, v: value })
  }

  // 摘要优先取最有信息量的字段（命令 / 路径），并限制总长度
  const preferred = ['command', 'script', 'path', 'file_path', 'filePath', 'pattern']
  const ordered = [
    ...args.filter((arg) => preferred.includes(arg.k)),
    ...args.filter((arg) => !preferred.includes(arg.k))
  ]
  const summary = ordered
    .map((arg) => arg.v)
    .filter((value) => value.length > 0)
    .join(' · ')
  return {
    args,
    summary: summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary
  }
}

/** 工具名 + 入参 → 风险级别与风险说明 */
export function assessRisk(
  toolName: string,
  input: unknown
): { risk: RiskLevel; reason: string } {
  const tool = toolName.toLowerCase()
  const text = stringifyArgValue(
    (input as Record<string, unknown> | undefined)?.['command'] ??
      (input as Record<string, unknown> | undefined)?.['script']
  )

  if (tool === 'bash' || tool === 'powershell') {
    for (const item of DESTRUCTIVE_PATTERNS) {
      if (item.pattern.test(text)) {
        return { risk: 'critical', reason: `命令包含高风险操作：${item.reason}` }
      }
    }
    return { risk: 'high', reason: '在本地执行 shell 命令，可读写任意文件、访问网络' }
  }
  if (tool === 'write' || tool === 'edit') {
    return { risk: 'medium', reason: '修改工作区文件内容' }
  }
  return { risk: 'medium', reason: '该工具会改变本机状态' }
}

/** 人类可读的 title 前缀（TUI 里也能读） */
function humanText(meta: Pick<ApprovalMeta, 'tool' | 'risk' | 'summary'>, reason: string): string {
  const lines = [`需要批准：${meta.tool}`]
  if (meta.summary.length > 0) lines.push(meta.summary)
  lines.push(`风险：${reason}`)
  return lines.join('\n')
}

/**
 * 组装 `extension_ui_request.title`：人类文本 + 末行机器可读元数据。
 *
 * 元数据行必须是**单行**：所有值经 JSON.stringify 转义，换行不会泄漏到行外。
 */
export function encodeApprovalTitle(
  meta: Omit<ApprovalMeta, 'options' | 'choices'>,
  reason: string
): string {
  const payload: ApprovalMeta = {
    ...meta,
    options: APPROVAL_OPTIONS,
    choices: APPROVAL_CHOICES
  }
  return `${humanText(meta, reason)}\n\n${MARKER_PREFIX}${JSON.stringify(payload)}`
}

/** 本会话允许的记忆键（会话身份 + 工具名；只在本 pi 进程内、本会话内有效） */
export function allowSessionKey(sessionId: string | undefined, toolName: string): string {
  return `${sessionId ?? '(unknown-session)'}::${toolName.toLowerCase()}`
}
