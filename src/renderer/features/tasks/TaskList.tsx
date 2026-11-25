import { useState } from 'react'

import { formatCost, formatTimestamp, formatTokens, shortenPath } from '../../lib/format'
import type { RunPhase } from '../../lib/reducer'
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
  /** A36：结束会话（释放子进程，任务降级为历史） */
  onEndTask?: (taskId: string) => void
  /** A36：结束在途的任务（按钮显示「结束中…」并禁用） */
  ending?: Record<string, true>
  /** A36：用于判断「正在运行」的文案加强 */
  phases?: Record<string, RunPhase>
}

/**
 * A36：结束确认的说明文案。
 *
 * `undefined` 与 `idle` 等价（App 里 phase 的取法也是 `?? 'idle'`）：只有确实在跑
 * （streaming / tool_running / settling）才提示可能丢一条未落盘记录。
 */
function endConfirmNote(phase: RunPhase | undefined): string {
  return phase === undefined || phase === 'idle'
    ? '结束会中断正在运行的回合；已写入的历史保留。'
    : '该会话正在运行，结束会立刻中断本轮（未落盘的最后一条记录可能丢失）；已写入的历史保留。'
}

export function TaskList({
  tasks,
  selectedId,
  loading,
  onSelect,
  onNewTask,
  onRename,
  onEndTask,
  ending,
  phases
}: TaskListProps) {
  /** 正在改名的任务 id 与草稿（A23） */
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  /** A36：正在等哪个任务二次确认（同一时刻只允许一个） */
  const [confirmingEnd, setConfirmingEnd] = useState<string | undefined>(undefined)
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
              <li
                className="task-row"
                key={task.id}
                onKeyDown={(event) => {
                  // Esc 必须挂在整行上：点「结束」后焦点仍在外层按钮，keydown 不会
                  // 冒泡经过兄弟节点（确认框），挂在那里等于按了没反应。
                  if (event.key === 'Escape' && confirmingEnd === task.id) {
                    setConfirmingEnd(undefined)
                  }
                }}
              >
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
                {/*
                  A36：结束按钮是 `<li>` 里 `task-item` **兄弟**节点，不能塞进
                  `task-item` 内部 —— 按钮套按钮是无效 HTML，也会让「点击选中」串味。
                */}
                {task.kind === 'live' &&
                task.sessionKey !== undefined &&
                onEndTask !== undefined ? (
                  <button
                    type="button"
                    className="btn btn--small task-item__end"
                    data-testid="task-end-button"
                    data-task-id={task.id}
                    aria-label={`结束会话：${task.title}`}
                    disabled={ending?.[task.id] === true}
                    onClick={() => {
                      // 点另一行的结束按钮时直接切换成新 id，不留两个确认框
                      setConfirmingEnd(task.id)
                    }}
                  >
                    {ending?.[task.id] === true ? '结束中…' : '结束'}
                  </button>
                ) : null}
                {confirmingEnd === task.id ? (
                  <div
                    className="task-item__end-confirm"
                    data-testid="task-end-confirm"
                    role="group"
                    aria-label="确认结束会话"
                  >
                    <p className="task-item__end-note">{endConfirmNote(phases?.[task.id])}</p>
                    <div className="task-item__end-actions">
                      {/*
                        刻意**不加 autoFocus**：连续 Enter 会把「确认结束」当成默认动作，
                        而结束会话是不可撤销的破坏性操作。
                      */}
                      <button
                        type="button"
                        className="btn btn--danger btn--small"
                        data-testid="task-end-confirm-yes"
                        onClick={() => {
                          setConfirmingEnd(undefined)
                          // 确认区与「结束按钮」是并列的条件分支，TS 不会跨分支收窄
                          onEndTask?.(task.id)
                        }}
                      >
                        确认结束
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        data-testid="task-end-confirm-no"
                        onClick={() => {
                          setConfirmingEnd(undefined)
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
