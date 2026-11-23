import type { ExtUiEvent } from './types'

/**
 * 审批子协议的**客户端侧**（解码 + 校验 + 组装响应）。
 *
 * 编码侧在 `extensions/permission/protocol.ts`（扩展运行在 pi 进程里，只能依赖自身目录）。
 * 两侧由 `tests/unit/permission-wire.test.ts` 用同一份样例做「编码 → 解码」往返钉死，
 * 任何一侧改了线上格式都会立刻红。
 *
 * 线上字段事实来源（pi 1.5.2）：
 * - `docs/rpc-extension-ui.md`：`extension_ui_request{type,id,method,title,options?,timeout?}`；
 *   `extension_ui_response{type,id,value|confirmed|cancelled}`；`setStatus{statusKey,statusText}`；
 * - `dist/modes/rpc/rpc-types.d.ts` 的 `RpcExtensionUIRequest` / `RpcExtensionUIResponse` 联合。
 *
 * 审批语义（§6.3）：select 的 `options` 里三个选项顺序固定，`choices[i]` 是第 i 个选项的语义；
 * 客户端按**下标**取值（不按文案匹配），文案变了也不会错位。
 */

/** 必须与 `extensions/permission/protocol.ts` 的同名常量一致，否则判为不兼容 */
export const PERMISSION_PROTOCOL_VERSION = 1
export const PERMISSION_EXTENSION_NAME = 'pi-desktop-permission'
export const PERMISSION_MARKER_PREFIX = `${PERMISSION_EXTENSION_NAME}/v${PERMISSION_PROTOCOL_VERSION} `
/** 握手用的 statusKey（`extension_ui_request{method:'setStatus'}`） */
export const PERMISSION_STATUS_KEY = PERMISSION_EXTENSION_NAME
/** 审批时钟（§6.3 唯一时钟由扩展侧权威判定） */
export const PERMISSION_DEFAULT_TIMEOUT_MS = 120_000

/**
 * 高危工具默认清单（§Q4：bash / powershell / write / edit / 删除类走 shell 被前者覆盖）。
 *
 * **单一来源**：客户端侧（设置页默认值、ConfigStore）只认这一个常量。
 * 扩展侧（`src/extensions/permission/protocol.ts`）有一份同值副本——扩展装到
 * `~/.pi/agent/extensions` 后运行在 pi 进程里，只能依赖自身目录，无法 import 本模块。
 * 两份的一致性由 `tests/unit/approval-defaults.test.ts` 钉死（改一边不改另一边会红）。
 */
export const DEFAULT_APPROVAL_TOOLS: readonly string[] = ['bash', 'powershell', 'write', 'edit']
/**
 * 客户端提前量：在扩展侧 120s 到期**之前**先回 cancelled（同样是拒绝，语义不变），
 * 避免 UI 停在「等待」而扩展已经超时。不是第二套时钟——它是同一个 `timeout` 减去固定提前量。
 */
export const CLIENT_APPROVAL_LEAD_MS = 500
/** 提前量后允许的最小等待时间，防止极端小 timeout 变成立即拒绝 */
export const CLIENT_APPROVAL_MIN_WAIT_MS = 1_000

export type ApprovalChoice = 'allow_once' | 'allow_session' | 'deny'

export interface ApprovalArg {
  k: string
  v: string
}

export interface ApprovalRequestMeta {
  protocol: number
  version: string
  tool: string
  risk: 'critical' | 'high' | 'medium'
  summary: string
  args: ApprovalArg[]
  timeoutMs: number
  options: string[]
  choices: string[]
  sessionId?: string
}

/** 解析后交给 UI 的审批请求（renderer 只需这些字段） */
export interface ApprovalRequest {
  requestId: string
  /** pi 原始 title 里的**人类可读**部分（不含机器元数据行） */
  humanText: string
  meta: ApprovalRequestMeta
  /** 选项文案（顺序与 meta.choices 对齐） */
  options: string[]
  /** 扩展侧审批时钟（毫秒）；客户端按它排倒计时 */
  timeoutMs: number
}

export interface PermissionHandshake {
  protocol: number
  version: string
  enabled: boolean
  tools: string[]
  timeoutMs: number
  compatible: boolean
}

export type ExtUiClassification =
  | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'handshake'; handshake: PermissionHandshake; compatible: boolean }
  | { kind: 'ignored'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length === value.length ? items : undefined
}

/**
 * 解析审批请求的 title：人类文本 + 末行机器元数据。
 * 元数据行不合法时返回 undefined（调用方按「无法识别的审批请求 → 拒绝」处理，fail-closed）。
 */
export function parseApprovalTitle(
  title: string
): { humanText: string; meta: ApprovalRequestMeta } | undefined {
  const trimmed = title.trimEnd()
  const breakAt = trimmed.lastIndexOf('\n')
  const markerLine = breakAt === -1 ? trimmed : trimmed.slice(breakAt + 1)
  if (!markerLine.startsWith(PERMISSION_MARKER_PREFIX)) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(markerLine.slice(PERMISSION_MARKER_PREFIX.length))
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined

  const tool = raw['tool']
  const risk = raw['risk']
  const options = readStringArray(raw['options'])
  const choices = readStringArray(raw['choices'])
  if (typeof tool !== 'string' || tool.length === 0) return undefined
  if (risk !== 'critical' && risk !== 'high' && risk !== 'medium') return undefined
  if (options === undefined || choices === undefined) return undefined
  if (options.length !== choices.length || options.length === 0) return undefined

  const args: ApprovalArg[] = []
  if (Array.isArray(raw['args'])) {
    for (const item of raw['args']) {
      if (!isRecord(item)) continue
      const k = item['k']
      const v = item['v']
      if (typeof k === 'string' && typeof v === 'string') args.push({ k, v })
    }
  }

  const timeoutMs =
    typeof raw['timeoutMs'] === 'number' &&
    Number.isFinite(raw['timeoutMs']) &&
    raw['timeoutMs'] > 0
      ? Math.round(raw['timeoutMs'])
      : PERMISSION_DEFAULT_TIMEOUT_MS
  const protocol =
    typeof raw['protocol'] === 'number' && Number.isFinite(raw['protocol'])
      ? Math.trunc(raw['protocol'])
      : 0

  return {
    humanText: breakAt === -1 ? '' : title.slice(0, breakAt).trimEnd(),
    meta: {
      protocol,
      version: typeof raw['version'] === 'string' ? raw['version'] : 'unknown',
      tool,
      risk,
      summary: typeof raw['summary'] === 'string' ? raw['summary'] : '',
      args,
      timeoutMs,
      options,
      choices,
      ...(typeof raw['sessionId'] === 'string' ? { sessionId: raw['sessionId'] } : {})
    }
  }
}

/** 把 `evt:extui` 载荷分类：审批请求 / 版本握手 / 与本模块无关 */
export function classifyExtUi(event: ExtUiEvent): ExtUiClassification {
  const record = event.request
  if (record['type'] !== 'extension_ui_request') {
    return { kind: 'ignored', reason: `非 extension_ui_request：${record['type']}` }
  }
  const method = record['method']
  const requestId = record['id']

  if (method === 'setStatus') {
    if (record['statusKey'] !== PERMISSION_STATUS_KEY) {
      return { kind: 'ignored', reason: '其他扩展的状态栏更新' }
    }
    const handshake = parseHandshake(record['statusText'])
    if (handshake === undefined) return { kind: 'ignored', reason: '握手载荷无法解析' }
    return {
      kind: 'handshake',
      handshake,
      // 只认「同一协议版本且扩展自己也认为兼容」；其余一律不兼容（fail-closed）
      compatible:
        handshake.protocol === PERMISSION_PROTOCOL_VERSION &&
        handshake.compatible &&
        handshake.ext === PERMISSION_EXTENSION_NAME
    }
  }

  if (method !== 'select') {
    return { kind: 'ignored', reason: `不参与审批的 method：${String(method)}` }
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { kind: 'ignored', reason: '审批请求缺少 id' }
  }
  const title = record['title']
  if (typeof title !== 'string') return { kind: 'ignored', reason: '审批请求缺少 title' }

  const parsed = parseApprovalTitle(title)
  if (parsed === undefined)
    return { kind: 'ignored', reason: '不是 pi-desktop-permission 的审批请求' }

  // options 以 pi 的请求字段为准（客户端只能回传请求里出现过的选项）
  const wireOptions = readStringArray(record['options'])
  const options =
    wireOptions !== undefined && wireOptions.length === parsed.meta.options.length
      ? wireOptions
      : parsed.meta.options
  const timeoutField = record['timeout']
  const timeoutMs =
    typeof timeoutField === 'number' && Number.isFinite(timeoutField) && timeoutField > 0
      ? Math.round(timeoutField)
      : parsed.meta.timeoutMs

  return {
    kind: 'approval',
    request: {
      requestId,
      humanText: parsed.humanText,
      meta: parsed.meta,
      options,
      timeoutMs
    }
  }
}

export function parseHandshake(
  statusText: unknown
): (PermissionHandshake & { ext: string }) | undefined {
  if (typeof statusText !== 'string' || statusText.length === 0) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(statusText)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const ext = raw['ext']
  const version = raw['version']
  const protocol = raw['protocol']
  if (typeof ext !== 'string' || typeof version !== 'string') return undefined
  if (typeof protocol !== 'number' || !Number.isFinite(protocol)) return undefined
  return {
    ext,
    version,
    protocol: Math.trunc(protocol),
    enabled: raw['enabled'] !== false,
    tools: readStringArray(raw['tools']) ?? [],
    timeoutMs:
      typeof raw['timeoutMs'] === 'number' && Number.isFinite(raw['timeoutMs'])
        ? Math.round(raw['timeoutMs'])
        : PERMISSION_DEFAULT_TIMEOUT_MS,
    compatible: raw['compatible'] !== false
  }
}

/**
 * 客户端超时预算：扩展侧 timeout 减去提前量。
 *
 * 单一时钟语义（§6.3）：值**全部来自请求里的 timeout**，客户端只是提前一点点先手拒绝，
 * 结果与扩展侧超时完全一致（都是「拒绝」）。
 */
export function clientApprovalTimeoutMs(timeoutMs: number): number {
  const base = timeoutMs > 0 ? timeoutMs : PERMISSION_DEFAULT_TIMEOUT_MS
  return Math.max(CLIENT_APPROVAL_MIN_WAIT_MS, base - CLIENT_APPROVAL_LEAD_MS)
}

/** 选择 → 回传给 pi 的选项文案（越界即 undefined，调用方应改用 cancel） */
export function optionForChoice(
  request: ApprovalRequest,
  choice: ApprovalChoice
): string | undefined {
  const index = request.meta.choices.indexOf(choice)
  if (index < 0) return undefined
  return request.options[index]
}

export type ExtUiResponseInput = { kind: 'select'; value: string } | { kind: 'cancel' }

/**
 * `extension_ui_response` 的线上形状（docs/rpc-extension-ui.md#responses-to-pi）。
 *
 * 用 type alias（而非 interface）以便满足 `RpcCommand` 的索引签名要求。
 */
export type ExtensionUiResponseRecord =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

/** 组装 `extension_ui_response` 的线上形状（main 侧落到 transport.send） */
export function toExtensionUiResponse(
  requestId: string,
  response: ExtUiResponseInput
): ExtensionUiResponseRecord {
  if (response.kind === 'cancel') {
    return { type: 'extension_ui_response', id: requestId, cancelled: true }
  }
  return { type: 'extension_ui_response', id: requestId, value: response.value }
}
