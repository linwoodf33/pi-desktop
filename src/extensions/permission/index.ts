/**
 * pi-desktop-permission —— 工具执行**前**审批扩展（M5）。
 *
 * 事实依据（pi 1.5.2，`docs/extensions.md#tool_call`）：
 * `pi.on('tool_call', ...)` 在工具真正执行**之前**触发，返回 `{block:true, reason}` 即阻止执行。
 * 这就是「执行前同步询问」，不是事后审计。
 *
 * 审批链路（架构文档 §6.3）：
 * ```
 * tool_call 前置钩子 → ctx.ui.select(...) → extension_ui_request{method:'select'}
 *   → 客户端弹窗 → extension_ui_response{value|'cancelled'}
 *   → 本扩展放行 / 阻止
 * ```
 *
 * fail-closed 语义（缺一不可）：
 * - 无 UI（`ctx.hasUI === false`，print/json 模式）→ 直接阻止，不挂起；
 *   **唯一例外**：策略显式 `noUi:'allow'`（用户在设置页主动打开）时放行，并在 stderr 留痕；
 * - 超时（pi 侧 `timeout` 到期返回 `undefined`）→ 阻止；
 * - 返回 `undefined` / 未知选项 → 阻止；
 * - 询问过程抛异常 → 阻止；
 * - 客户端从不回包 → pi 侧 timeout（120s）后按 `undefined` 处理 → 阻止。
 *
 * 「本会话允许」的记忆**只在本 pi 进程、本 sessionId 内**有效（内存 Map），
 * 不落盘、不跨进程、不跨会话（fork 后 sessionId 变化即失效）。
 */

import {
  APPROVAL_OPTIONS,
  EXTENSION_NAME,
  POLICY_ENV_KEY,
  STATUS_KEY,
  allowSessionKey,
  assessRisk,
  buildHandshake,
  encodeApprovalTitle,
  encodeHandshake,
  parsePolicy,
  summarizeToolInput,
  type PermissionPolicy
} from './protocol'
import type {
  ExtensionApiLike,
  ExtensionContextLike,
  ToolCallEventLike,
  ToolCallResultLike
} from './types'

export { parsePolicy } from './protocol'
export type { PermissionPolicy } from './protocol'

/** 阻止执行的统一结果（reason 会作为工具结果回给模型） */
export function blocked(reason: string): ToolCallResultLike {
  return { block: true, reason }
}

function sessionIdOf(ctx: ExtensionContextLike): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.()
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * 决策：把 select 的返回映射成三种结果。
 *
 * 关键：只要不是「允许一次 / 本会话允许」这两个已知选项，一律按拒绝处理
 * （`undefined` = 超时或客户端取消；未知字符串 = 客户端伪造成非预期响应）。
 */
export function decide(choice: string | undefined): 'allow_once' | 'allow_session' | 'deny' {
  if (choice === APPROVAL_OPTIONS[0]) return 'allow_once'
  if (choice === APPROVAL_OPTIONS[1]) return 'allow_session'
  return 'deny'
}

export interface PermissionExtensionOptions {
  /** 策略来源（默认读 `process.env.PI_DESKTOP_PERMISSION`，单测可注入） */
  readPolicy?: () => PermissionPolicy
}

export default function piDesktopPermission(
  pi: ExtensionApiLike,
  options: PermissionExtensionOptions = {}
): void {
  // 每次加载解析一次策略（env 在子进程生命周期内不变）
  const policy: PermissionPolicy =
    options.readPolicy?.() ?? parsePolicy(process.env[POLICY_ENV_KEY])
  /** sessionId::toolName → true（「本会话允许」，进程内内存） */
  const allowSession = new Set<string>()
  const approvalTools = new Set(policy.tools.map((tool) => tool.toLowerCase()))

  const handshake = encodeHandshake(buildHandshake(policy))

  /** 版本握手：fire-and-forget 的 setStatus（客户端据此校验协议兼容性） */
  function reportHandshake(ctx: ExtensionContextLike): void {
    try {
      ctx.ui.setStatus?.(STATUS_KEY, handshake)
    } catch {
      // 握手失败不影响 fail-closed：审批仍然会询问
    }
  }

  pi.on('session_start', (_event, ctx) => {
    reportHandshake(ctx)
  })

  pi.on('session_shutdown', () => {
    // 会话结束即清空记忆：绝不让「本会话允许」跨会话泄漏
    allowSession.clear()
  })

  pi.on('tool_call', async (event: ToolCallEventLike, ctx: ExtensionContextLike) => {
    try {
      if (!policy.enabled) return undefined
      const toolName = typeof event.toolName === 'string' ? event.toolName : ''
      if (toolName.length === 0) return blocked('无法识别的工具调用，已拒绝（fail-closed）')
      if (!approvalTools.has(toolName.toLowerCase())) return undefined

      const sessionId = sessionIdOf(ctx)
      if (allowSession.has(allowSessionKey(sessionId, toolName))) return undefined

      // 无 UI（print / json 模式，或客户端未连接）→ 不挂起
      if (ctx.hasUI === false || typeof ctx.ui.select !== 'function') {
        if (policy.noUi === 'allow') {
          // 放行必须留痕：不写 allowSession —— 那是「用户授权」的语义，
          // 而这里根本没有人授权过，写进去会让后续调用看起来像被批准过。
          // 只输出工具名 / sessionId / risk，**绝不含入参内容**（避免凭据落到日志）。
          const { risk } = assessRisk(toolName, event.input)
          const line = `[${EXTENSION_NAME}] noUi-allow tool=${toolName} session=${sessionId ?? 'unknown'} risk=${risk}`
          if (risk === 'critical') console.warn(line)
          else
            process.stderr.write(`${line}
`)
          return undefined
        }
        return blocked(`工具 ${toolName} 需要人工批准，但当前没有可用的审批界面，已拒绝`)
      }

      reportHandshake(ctx)

      const { args, summary } = summarizeToolInput(event.input)
      const { risk, reason } = assessRisk(toolName, event.input)
      const title = encodeApprovalTitle(
        {
          protocol: 1,
          version: '1.0.0',
          tool: toolName,
          risk,
          summary,
          args,
          timeoutMs: policy.timeoutMs,
          ...(sessionId === undefined ? {} : { sessionId })
        },
        reason
      )

      const choice = await ctx.ui.select(title, [...APPROVAL_OPTIONS], {
        timeout: policy.timeoutMs
      })

      switch (decide(choice)) {
        case 'allow_once':
          return undefined
        case 'allow_session':
          allowSession.add(allowSessionKey(sessionId, toolName))
          return undefined
        default:
          return blocked(
            `用户拒绝了工具 ${toolName} 的执行${choice === undefined ? '（超时或已取消，按拒绝处理）' : ''}`
          )
      }
    } catch (error) {
      // 任何异常都不得变成放行
      const message = error instanceof Error ? error.message : String(error)
      return blocked(`审批过程出错，已拒绝执行（fail-closed）：${message.slice(0, 200)}`)
    }
  })
}
