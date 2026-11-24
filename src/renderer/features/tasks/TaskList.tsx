import { useState } from 'react'

import { formatCost, formatTimestamp, formatTokens, shortenPath } from '../../lib/format'
import type { TaskItem } from '../../stores/sessionStore'

/**
 * TaskList（§5.5 / §4.1 左栏）：本地会话索引（`session:list`）+ 新建任务。
 *
 * 布局要求（§8.1 M3）：紧凑列表，每行显示标题 / 时间 / cwd / token / 成本；
 * 缺失字段显示为「—」（A3）。点击即选中（历史任务只回放，不起子进程）。
 */
export interface TaskListProps {
  tasks: TaskItem[]
  selectedId: string | undefined
  loading: boolean
  onSelect: (taskId: string) => void
  onNewTask: () => void
  /** A23：改名（返回是否成功） */
  onRename?: (taskId: string, name: string) => Promise<boolean>
}

export function TaskList({
  tasks,
  selectedId,
  loading,
  onSelect,
  onNewTask,
  onRename
}: TaskListProps) {
  /** 正在改名的任务 id 与草稿（A23） */
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  return (
    <aside className="pane pane--tasks" aria-label="任务列表">
      <header className="pane__header">
        <h2>任务</h2>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="new-task-button"
          onClick={onNewTask}
        >
          新建任务
        </button>
      </header>

      <div className="pane__scroll">
        {loading && tasks.length === 0 ? (
          <p className="empty__hint empty__hint--inline">正在读取本地会话索引…</p>
        ) : tasks.length === 0 ? (
          <div className="empty" data-testid="task-list-empty">
            <p className="empty__title">还没有任务</p>
            <p className="empty__hint">
              点击「新建任务」选择工作目录；会话记录以 pi 的 session JSONL 为准。
            </p>
          </div>
        ) : (
          <ul className="task-list" data-testid="task-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={task.id === selectedId ? 'task-item task-item--active' : 'task-item'}
                  data-testid="task-item"
                  data-task-id={task.id}
                  onClick={() => {
                    onSelect(task.id)
                  }}
                >
                  {renaming === task.id ? (
                    <input
                      className="task-item__rename"
                      data-testid="task-rename-input"
                      value={draft}
                      autoFocus
                      onChange={(event) => {
                        setDraft(event.target.value)
                      }}
                      onClick={(event) => {
                        // 编辑态点击不要触发外层按钮的「选中任务」
                        event.stopPropagation()
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation()
                        if (event.key === 'Escape') {
                          setRenaming(undefined)
                          return
                        }
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          const next = draft.trim()
                          if (next.length === 0) {
                            setRenaming(undefined)
                            return
                          }
                          void onRename?.(task.id, next).then((ok) => {
                            if (ok) setRenaming(undefined)
                          })
                        }
                      }}
                      // 刻意不在失焦时关闭：双击的第二下会立刻让输入框失焦，
                      // 导致「刚出现就被关掉」。结束编辑只认 Enter / Esc。
                    />
                  ) : (
                    <span
                      className="task-item__title"
                      title={onRename === undefined ? undefined : '双击改名'}
                      onDoubleClick={(event) => {
                        if (onRename === undefined) return
                        event.stopPropagation()
                        setDraft(task.title)
                        setRenaming(task.id)
                      }}
                    >
                      {task.title}
                    </span>
                  )}
                  <span className="task-item__meta">
                    <span>{formatTimestamp(task.updatedAt)}</span>
                    <span title={task.cwd}>{shortenPath(task.cwd, 28)}</span>
                  </span>
                  <span className="task-item__stats">
                    <span>{formatTokens(task.totalTokens)} tok</span>
                    <span>{formatCost(task.totalCostUsd)}</span>
                    {task.kind === 'live' ? <span className="pill">进行中</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
