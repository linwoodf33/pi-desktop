import { useEffect, useState } from 'react'

import type { ArtifactEntry } from '../../../shared/contracts/types'
import {
  loadArtifactDiff,
  loadArtifactPreview,
  openArtifactWithSystem,
  refreshArtifacts
} from '../../lib/artifact-actions'
import { artifactKey, useArtifactStore } from '../../stores/artifactStore'
import { useSessionStore } from '../../stores/sessionStore'
import { Markdown } from '../chat/Markdown'
import { DiffView } from './DiffView'

/**
 * Artifacts（§5.5 / §4.1 右栏）：产物列表 + 选中预览/diff + 折叠（M6）。
 *
 * 行为约束：
 * - **不轮询**：列表只在「会话 settled」（`lib/client.ts`）与用户点刷新时请求；
 * - 选中条目后才按需拉 diff / 预览（一次一个文件）；
 * - 「用系统程序打开」需要用户在面板内二次确认（主进程仍会重做路径校验，确认只是 UX）；
 * - 文本预览走既有净化管线（`.md` 走 `Markdown`，其余作为纯文本渲染，均无 raw HTML）。
 */
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

export function Artifacts() {
  const collapsed = useArtifactStore((state) => state.collapsed)
  const toggleCollapsed = useArtifactStore((state) => state.toggleCollapsed)

  const selectedTaskId = useSessionStore((state) => state.selectedId)
  const task = useSessionStore((state) =>
    state.selectedId === undefined
      ? undefined
      : state.tasks.find((item) => item.id === state.selectedId)
  )

  const list = useArtifactStore((state) =>
    selectedTaskId === undefined ? undefined : state.lists[selectedTaskId]
  )
  const selectedPath = useArtifactStore((state) =>
    selectedTaskId === undefined ? undefined : state.selected[selectedTaskId]
  )
  const scanning = useArtifactStore((state) =>
    selectedTaskId === undefined ? undefined : state.scanning[selectedTaskId]
  )
  const error = useArtifactStore((state) =>
    selectedTaskId === undefined ? undefined : state.errors[selectedTaskId]
  )
  const entry = list?.items.find((item) => item.path === selectedPath)
  const cacheKey =
    selectedTaskId === undefined || selectedPath === undefined
      ? undefined
      : artifactKey(selectedTaskId, selectedPath)
  const diff = useArtifactStore((state) =>
    cacheKey === undefined ? undefined : state.diffs[cacheKey]
  )
  const preview = useArtifactStore((state) =>
    cacheKey === undefined ? undefined : state.previews[cacheKey]
  )
  const loading = useArtifactStore((state) =>
    cacheKey === undefined ? undefined : state.loading[cacheKey]
  )

  /**
   * 预览/diff 视图切换：默认 diff（产物面板的主诉求），可切到文本预览。
   *
   * 用「选中键（taskId::path）」绑定的 state 而不是 effect + setState：
   * 换文件时旧视图自动失效（无语义上的级联渲染）。
   */
  const selectionKey = `${selectedTaskId ?? ''}::${selectedPath ?? ''}`
  const [viewState, setViewState] = useState<{ key: string; view: 'diff' | 'text' }>({
    key: selectionKey,
    view: 'diff'
  })
  const view = viewState.key === selectionKey ? viewState.view : 'diff'
  /** 待确认的外部打开（用户二次确认，避免误触调起外部程序）；同样绑定选中键 */
  const [openState, setOpenState] = useState<{ key: string; path: string } | undefined>(undefined)
  const pendingOpen = openState?.key === selectionKey ? openState.path : undefined

  const setView = (next: 'diff' | 'text'): void => {
    setViewState({ key: selectionKey, view: next })
  }
  const setPendingOpen = (path: string | undefined): void => {
    setOpenState(path === undefined ? undefined : { key: selectionKey, path })
  }

  // 选中条目 → 按需拉数据（不预取、不轮询）
  useEffect(() => {
    if (selectedTaskId === undefined || entry === undefined) return
    if (entry.binary === true || entry.change === 'deleted' || view === 'diff') {
      void loadArtifactDiff(selectedTaskId, entry.path)
      return
    }
    void loadArtifactPreview(selectedTaskId, entry.path)
  }, [selectedTaskId, entry, view])

  if (collapsed) {
    return (
      <aside className="pane pane--artifacts pane--artifacts-collapsed" aria-label="产物">
        <button
          type="button"
          className="btn btn--ghost pane__rail"
          data-testid="artifacts-toggle"
          title="展开产物面板"
          onClick={toggleCollapsed}
        >
          产物
        </button>
      </aside>
    )
  }

  const count = list?.items.length ?? 0

  return (
    <aside className="pane pane--artifacts" aria-label="产物">
      <header className="pane__header">
        <h2>
          产物
          {count > 0 ? (
            <span className="badge badge--pending artifact-badge" data-testid="artifacts-count">
              {count}
            </span>
          ) : null}
        </h2>
        <div className="pane__badges">
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="artifacts-refresh"
            title="重新扫描工作区（只在会话结束后自动扫描，其余时候手动刷新）"
            disabled={selectedTaskId === undefined || scanning === true}
            onClick={() => {
              if (selectedTaskId !== undefined) void refreshArtifacts(selectedTaskId)
            }}
          >
            {scanning === true ? '扫描中…' : '刷新'}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="artifacts-toggle"
            title="折叠产物面板"
            onClick={toggleCollapsed}
          >
            折叠
          </button>
        </div>
      </header>

      <div className="pane__scroll">
        {error === undefined ? null : (
          <p className="artifact-note artifact-note--warn" data-testid="artifacts-error">
            {error}
          </p>
        )}

        {list === undefined ? (
          <div className="empty" data-testid="artifacts-empty">
            <p className="empty__title">暂无产物</p>
            <p className="empty__hint">会话结束后自动扫描工作区；也可以点「刷新」立即扫描。</p>
          </div>
        ) : (
          <>
            <p className="artifact-note" data-testid="artifacts-mode">
              {list.mode === 'git' ? 'git 工作区 · 已暂存 + 未暂存' : '非 git 工作区，快照比对'}
              {list.truncated ? ` · 仅显示前 ${list.items.length}/${list.totalCount} 条` : ''}
            </p>
            {list.note === undefined ? null : (
              <p className="artifact-note artifact-note--dim" data-testid="artifacts-note">
                {list.note}
              </p>
            )}

            {list.items.length === 0 ? (
              <div className="empty" data-testid="artifacts-empty">
                <p className="empty__title">工作区没有变更</p>
                <p className="empty__hint">
                  {task === undefined
                    ? '先选择一个任务。'
                    : '任务没有新增/修改/删除文件，或变更发生在会话开始之前。'}
                </p>
              </div>
            ) : (
              <ul className="artifact-list" data-testid="artifact-list">
                {list.items.map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      className={
                        item.path === selectedPath
                          ? 'artifact-item artifact-item--active'
                          : 'artifact-item'
                      }
                      data-testid="artifact-item"
                      data-change={item.change}
                      onClick={() => {
                        if (selectedTaskId === undefined) return
                        useArtifactStore.getState().setSelected(selectedTaskId, item.path)
                      }}
                    >
                      <span className={`artifact-item__pill artifact-item__pill--${item.change}`}>
                        {changeLabel(item)}
                      </span>
                      <code className="artifact-item__path">{item.path}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {entry === undefined ? null : (
          <section className="artifact-detail" data-testid="artifact-detail">
            <header className="artifact-detail__header">
              <code className="artifact-detail__path">{entry.path}</code>
              <div className="artifact-detail__actions">
                <button
                  type="button"
                  className={view === 'diff' ? 'btn btn--small btn--primary' : 'btn btn--small'}
                  data-testid="artifact-view-diff"
                  onClick={() => {
                    setView('diff')
                  }}
                >
                  差异
                </button>
                <button
                  type="button"
                  className={view === 'text' ? 'btn btn--small btn--primary' : 'btn btn--small'}
                  data-testid="artifact-view-text"
                  disabled={entry.change === 'deleted'}
                  title={entry.change === 'deleted' ? '文件已删除，没有内容可预览' : '文本预览'}
                  onClick={() => {
                    setView('text')
                  }}
                >
                  预览
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  data-testid="artifact-open"
                  disabled={entry.change === 'deleted'}
                  title={
                    entry.change === 'deleted'
                      ? '文件已删除，无法用系统程序打开'
                      : '用系统默认程序打开（会先请求确认）'
                  }
                  onClick={() => {
                    setPendingOpen(entry.path)
                  }}
                >
                  打开
                </button>
              </div>
            </header>

            {pendingOpen === undefined ? null : (
              <div className="artifact-confirm" data-testid="artifact-open-confirm">
                <p>用系统默认程序打开 {pendingOpen}？</p>
                <div className="artifact-confirm__actions">
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    data-testid="artifact-open-confirm-yes"
                    onClick={() => {
                      const target = pendingOpen
                      setPendingOpen(undefined)
                      if (selectedTaskId !== undefined) {
                        void openArtifactWithSystem(selectedTaskId, target)
                      }
                    }}
                  >
                    确认打开
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    data-testid="artifact-open-confirm-no"
                    onClick={() => {
                      setPendingOpen(undefined)
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {loading === true && diff === undefined && preview === undefined ? (
              <p className="artifact-note artifact-note--dim">加载中…</p>
            ) : null}

            {view === 'diff' ? (
              diff === undefined ? (
                <p className="artifact-note artifact-note--dim">正在读取差异…</p>
              ) : (
                <DiffView
                  patch={diff.patch}
                  truncated={diff.truncated}
                  {...(diff.note === undefined ? {} : { note: diff.note })}
                />
              )
            ) : preview === undefined ? (
              <p className="artifact-note artifact-note--dim">正在读取预览…</p>
            ) : preview.binary ? (
              <div className="empty empty__hint--inline" data-testid="artifact-binary">
                <p className="empty__title">二进制文件</p>
                <p className="empty__hint">
                  不做文本渲染（避免乱码）：请用「打开」交给系统默认程序（
                  {formatBytes(preview.sizeBytes)}）。
                </p>
              </div>
            ) : (
              <div className="artifact-preview" data-testid="artifact-preview">
                {isMarkdown(entry.path) ? (
                  <Markdown text={preview.text} />
                ) : (
                  <pre className="artifact-preview__plain">{preview.text}</pre>
                )}
                {preview.truncated ? (
                  <p className="artifact-note artifact-note--dim" data-testid="preview-truncated">
                    仅预览前 {formatBytes(preview.offset + preview.text.length)} /{' '}
                    {formatBytes(preview.sizeBytes)}（预览上限 64KB）
                  </p>
                ) : null}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}

function changeLabel(entry: ArtifactEntry): string {
  switch (entry.change) {
    case 'added':
      return entry.untracked === true ? '新增?' : '新增'
    case 'modified':
      return '修改'
    case 'deleted':
      return '删除'
    case 'renamed':
      return '重命名'
    default:
      return entry.change
  }
}

function isMarkdown(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
