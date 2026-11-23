import { memo, useMemo, useState } from 'react'

import {
  TOOL_PREVIEW_LINES,
  TOOL_STATUS_CLASS,
  TOOL_STATUS_LABEL,
  formatDuration
} from '../../lib/format'
import type { ToolItem } from '../../lib/reducer'

/**
 * ToolCard（§5.5 features/chat/ToolCard）：
 * 工具名、参数摘要（可展开全文）、状态、耗时、输出前 N 行 + 可展开。
 *
 * 大输出不读文件：只显示 `fullOutputPath` 提示（M3 边界，§7 约束 14）。
 * 状态→标签/样式映射在 `lib/format.ts`，便于纯函数单测。
 *
 * 性能（A7）：工具卡片在完整会话里数量与轮数同阶，用 `memo` + `useMemo`
 * 避免流式增量引发的重新分割输出与重渲染。
 */
export interface ToolCardProps {
  tool: ToolItem
}

export const ToolCard = memo(function ToolCard({ tool }: ToolCardProps) {
  const [outputExpanded, setOutputExpanded] = useState(false)
  const [argsExpanded, setArgsExpanded] = useState(false)

  const { preview, hiddenLines, lineCount } = useMemo(() => {
    if (tool.output.length === 0) return { preview: '', hiddenLines: 0, lineCount: 0 }
    const lines = tool.output.split('\n')
    return {
      preview: lines.slice(0, TOOL_PREVIEW_LINES).join('\n'),
      hiddenLines: lines.length - TOOL_PREVIEW_LINES,
      lineCount: lines.length
    }
  }, [tool.output])

  return (
    <div
      className={`tool-card ${TOOL_STATUS_CLASS[tool.status]}`}
      data-testid="tool-card"
      data-tool-status={tool.status}
    >
      <div className="tool-card__head">
        <span className="tool-card__name">{tool.toolName}</span>
        <span className="tool-card__status">{TOOL_STATUS_LABEL[tool.status]}</span>
        {tool.durationMs === undefined ? null : (
          <span className="tool-card__duration">{formatDuration(tool.durationMs)}</span>
        )}
      </div>

      {tool.argsSummary.length === 0 ? null : (
        <button
          type="button"
          className="tool-card__args"
          onClick={() => {
            setArgsExpanded((value) => !value)
          }}
          title={argsExpanded ? '收起参数' : '展开参数全文'}
        >
          {argsExpanded ? tool.argsText : tool.argsSummary}
        </button>
      )}

      {lineCount === 0 ? (
        <p className="tool-card__empty">（无输出）</p>
      ) : (
        <div className="tool-card__output">
          <pre>{outputExpanded ? (tool.output.length > 0 ? tool.output : preview) : preview}</pre>
          {hiddenLines > 0 || outputExpanded ? (
            <button
              type="button"
              className="tool-card__toggle"
              onClick={() => {
                setOutputExpanded((value) => !value)
              }}
            >
              {outputExpanded ? '收起输出' : `展开全部（还有 ${hiddenLines} 行）`}
            </button>
          ) : null}
        </div>
      )}

      {tool.fullOutputPath === undefined ? null : (
        <p className="tool-card__hint">
          输出已截断，完整内容：<code>{tool.fullOutputPath}</code>（M3 不读取文件）
        </p>
      )}
    </div>
  )
})
