/**
 * pi 扩展 API 的**结构子集**类型（只声明本扩展真正用到的成员）。
 *
 * 为什么不直接 `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'`：
 * - 该包是 pi 自带的运行时，不在本仓库的 `node_modules` 里，直接 import 会让
 *   `typecheck`/`lint` 必须依赖 pi 的安装路径（CI 与开发机路径各不相同）；
 * - 扩展是**结构化**入口（pi 用 jiti 加载后调用默认导出并传入真实 ExtensionAPI），
 *   只要形状相容即可，因此用结构类型既精确又零依赖。
 *
 * 对照 pi 1.5.2（`docs/extensions.md`、`dist/core/extensions/types.d.ts`）：
 * - `pi.on('tool_call', handler)`：工具执行**前**触发，返回 `{block:true, reason}` 可阻止执行；
 * - `pi.on('session_start' | 'session_shutdown', handler)`：会话生命周期；
 * - `ctx.ui.select(title, options, {timeout})`：RPC 模式下发 `extension_ui_request{method:'select'}`，
 *   超时/取消返回 `undefined`；
 * - `ctx.ui.setStatus(key, text)`：fire-and-forget，RPC 模式下发 `extension_ui_request{method:'setStatus'}`；
 * - `ctx.hasUI`：print/json 模式为 false；
 * - `ctx.sessionManager.getSessionId()`：当前会话身份（用于「本会话允许」的作用域）。
 */

export interface ToolCallEventLike {
  type: 'tool_call'
  toolName: string
  toolCallId?: string
  input: unknown
}

export interface ToolCallResultLike {
  block: true
  reason?: string
  terminate?: boolean
}

export interface SelectOptionsLike {
  timeout?: number
  signal?: AbortSignal
}

export interface UiContextLike {
  select?(
    title: string,
    options: string[],
    opts?: SelectOptionsLike
  ): Promise<string | undefined>
  /** fire-and-forget；RPC 模式下 statusText 为 undefined 时清空该 key */
  setStatus?(key: string, text: string | undefined): void
  notify?(message: string, type?: 'info' | 'warning' | 'error'): void
}

export interface SessionManagerLike {
  getSessionId?(): string
  getSessionFile?(): string | undefined
}

export interface ExtensionContextLike {
  hasUI?: boolean
  ui: UiContextLike
  sessionManager?: SessionManagerLike
  mode?: string
}

export interface SessionEventLike {
  type: string
}

export type ToolCallHandler = (
  event: ToolCallEventLike,
  ctx: ExtensionContextLike
) => Promise<ToolCallResultLike | undefined> | ToolCallResultLike | undefined

export type LifecycleHandler = (
  event: SessionEventLike,
  ctx: ExtensionContextLike
) => void | Promise<void>

export interface ExtensionApiLike {
  on(event: 'tool_call', handler: ToolCallHandler): void
  on(event: 'session_start' | 'session_shutdown', handler: LifecycleHandler): void
}
