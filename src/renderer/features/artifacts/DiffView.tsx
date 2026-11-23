import { useMemo, useState } from 'react'

import {
  diffFileLabel,
  diffFileStats,
  diffTotals,
  parseUnifiedDiff,
  type DiffFile
} from '../../lib/diff'

/**
 * DiffView（§5.5 features/artifacts/DiffView）：unified diff 着色 + 按文件折叠。
 *
 * 安全：所有补丁内容只作为 React 文本节点渲染（`{line.text}`），
 * 没有 `dangerouslySetInnerHTML`，也不会被当作 markdown/HTML 解释（§9.4 S3）。
 */
export interface DiffViewProps {
  patch: string
  /** 补丁被截断（超过 2MB 上限）：必须显式提示，不静默 */
  truncated?: boolean
  /** 主进程给的补充说明（快照未保留原始内容、二进制文件等） */
  note?: string
}

export function DiffView({ patch, truncated = false, note }: DiffViewProps) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch])
  const totals = useMemo(() => diffTotals(files), [files])

  if (patch.trim().length === 0) {
    return (
      <div className="empty empty__hint--inline" data-testid="diff-empty">
        <p className="empty__title">没有可显示的 diff</p>
        {note === undefined ? null : <p className="empty__hint">{note}</p>}
      </div>
    )
  }

  return (
    <div className="diff" data-testid="diff-view">
      <div className="diff__summary">
        <span className="diff__count diff__count--add">+{totals.additions}</span>
        <span className="diff__count diff__count--del">−{totals.deletions}</span>
        <span className="diff__files">{files.length} 个文件块</span>
      </div>

      {note === undefined ? null : (
        <p className="diff__note" data-testid="diff-note">
          {note}
        </p>
      )}

      {files.map((file, index) => (
        <DiffFileBlock key={`${index}:${diffFileLabel(file)}`} file={file} />
      ))}

      {truncated ? (
        <p className="diff__truncated" data-testid="diff-truncated">
          补丁超过 2MB 上限，已截断（仅显示前半部分）
        </p>
      ) : null}
    </div>
  )
}

function DiffFileBlock({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true)
  const stats = diffFileStats(file)
  const label = diffFileLabel(file)

  return (
    <section className="diff__file" data-testid="diff-file">
      <button
        type="button"
        className="diff__file-header"
        aria-expanded={open}
        data-testid="diff-file-toggle"
        onClick={() => {
          setOpen((value) => !value)
        }}
      >
        <span className="diff__caret">{open ? '▾' : '▸'}</span>
        <code className="diff__path">{label}</code>
        <span className="diff__count diff__count--add">+{stats.additions}</span>
        <span className="diff__count diff__count--del">−{stats.deletions}</span>
      </button>

      {open ? (
        <div className="diff__body">
          {file.meta.length > 0 ? (
            <div className="diff__meta">
              {file.meta.map((line, index) => (
                <div key={index} className="diff__line diff__line--meta">
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {file.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className="diff__hunk">
              <div className="diff__line diff__line--hunk">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  className={`diff__line diff__line--${line.kind}`}
                  data-kind={line.kind}
                >
                  {line.kind === 'add'
                    ? '+'
                    : line.kind === 'del'
                      ? '−'
                      : line.kind === 'ctx'
                        ? ' '
                        : ''}
                  {line.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
