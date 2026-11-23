/**
 * 展示层格式化（纯函数，无 DOM 依赖，便于单测）。
 *
 * 约定：**缺失字段显示为「—」**（A3：任务列表 token/成本可能缺失）。
 */
import type { RunPhase, ToolStatus } from './reducer'

export const EMPTY_DISPLAY = '—'

/** 工具卡片状态 → 中文标签（running/success/error，§8.1 M3） */
export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  pending: '等待执行',
  running: '执行中',
  success: '已完成',
  error: '失败'
}

/** 工具卡片状态 → CSS 类（左侧状态色条） */
export const TOOL_STATUS_CLASS: Record<ToolStatus, string> = {
  pending: 'tool-card--pending',
  running: 'tool-card--running',
  success: 'tool-card--success',
  error: 'tool-card--error'
}

/** 工具输出折叠态显示的行数 */
export const TOOL_PREVIEW_LINES = 12

/** 运行态中文标签（idle / streaming / tool_running / settling，§8.1 M3） */
export function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case 'streaming':
      return '生成中'
    case 'tool_running':
      return '工具执行中'
    case 'settling':
      return '收尾中'
    case 'idle':
    default:
      return '空闲'
  }
}

/** 毫秒 → `1.2s` / `350ms` */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return EMPTY_DISPLAY
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** token 数 → `1.2k` / `3.4M` */
export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens)) return EMPTY_DISPLAY
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/** 美元成本 → `$0.0123`（低于 1 分保留 4 位，避免显示成 `$0.00`） */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return EMPTY_DISPLAY
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

/** ISO 时间 → `MM-DD HH:mm`（本地时区；无法解析时返回原串） */
export function formatTimestamp(iso: string | undefined): string {
  if (iso === undefined || iso.length === 0) return EMPTY_DISPLAY
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`
}

/** 路径过长时保留尾部（工作目录通常后面的部分更有信息量） */
export function shortenPath(path: string, maxLength = 42): string {
  if (path.length <= maxLength) return path
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  let result = ''
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part === undefined) continue
    const candidate = result.length === 0 ? part : `${part}/${result}`
    if (candidate.length + 2 > maxLength) break
    result = candidate
  }
  return result.length === 0 ? `…${path.slice(-maxLength)}` : `…/${result}`
}
