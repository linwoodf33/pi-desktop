import { useRef, useState } from 'react'

import {
  THINKING_LEVELS,
  type ForkPoint,
  type ModelInfo,
  type SessionStats
} from '../../../shared/contracts/types'
import { formatCost, formatTokens, phaseLabel } from '../../lib/format'
import type { ChatState } from '../../lib/reducer'
import type { VirtualTimelineControls } from '../../lib/use-virtual-timeline'
import type { TaskItem } from '../../stores/sessionStore'
import { Composer } from './Composer'
import { Timeline } from './Timeline'

/**
 * Conversation（§5.5 / §4.1 中栏）：消息流 + 运行态 + 输入区。
 *
 * 组件本身**不含业务状态**：对话来自 reducer 归约后的 `ChatState`，
 * phase / aborting / 错误条来自 runStore，操作通过回调上抛给 `lib/actions.ts`。
 *
 * M4 增补（都在头部区，不侵入消息流）：
 * - 模型 / 推理档位切换（`model:set`，切换中禁用重复提交）；
 * - token / 成本展示（只来自 `session:stats`，缺失显示「—」）；
 * - 历史任务「继续对话」（才启动进程，§6.1 第 4 步）与「分叉」（§6.5 / A4）。
 */
export interface ConversationProps {
  task: TaskItem | undefined
  chat: ChatState
  phase: ChatState['phase']
  aborting: boolean
  aborted: boolean
  historyTruncated: boolean
  /** pi 自检状态（未通过时给出「定位 pi」引导，A12） */
  piReady: boolean
  locating: boolean
  /** 可选模型（`model:list`） */
  models: ModelInfo[]
  /** 会话级 token/成本（`session:stats`） */
  stats: SessionStats | undefined
  /** 模型切换在途 */
  switching: boolean
  /** 分叉在途 */
  forking: boolean
  onSend: (text: string) => void
  onAbort: () => void
  onNewTask: () => void
  onLocate: () => void
  /** 历史任务：启动 pi 进程继续对话 */
  onContinue: () => void
  /** 拉取可分叉点（pi `get_fork_messages`） */
  onLoadForkPoints: () => Promise<ForkPoint[]>
  onFork: (entryId: string) => void
  onSwitchModel: (input: { model: string; thinkingLevel?: string }) => void
}

export function Conversation({
  task,
  chat,
  phase,
  aborting,
  aborted,
  historyTruncated,
  piReady,
  locating,
  models,
  stats,
  switching,
  forking,
  onSend,
  onAbort,
  onNewTask,
  onLocate,
  onContinue,
  onLoadForkPoints,
  onFork,
  onSwitchModel
}: ConversationProps) {
  const empty = chat.messages.length === 0 && chat.streaming.length === 0
  const hasSession = task?.sessionKey !== undefined

  /*
   * 虚拟滚动（A7 方案 A）接线：
   * - `scrollRef` 指向真正的滚动容器 `.pane__scroll`（虚拟窗口要读它的 scrollTop / clientHeight）；
   * - `timelineControls` 让「回到底部」按钮与「跳转到某条消息」能命令式驱动 Timeline；
   * - `following` 由 Timeline 上报：用户上滚后为 false → 显示「回到底部」，但**不强制跳回**。
   */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const timelineControls = useRef<VirtualTimelineControls | null>(null)
  const [following, setFollowing] = useState(true)
  const showScrollToBottom = !following && !empty && task !== undefined

  return (
    <section className="pane pane--chat" aria-label="对话">
      <header className="pane__header">
        <div className="pane__title">
          <h2 data-testid="conversation-title">{task?.title ?? '对话'}</h2>
          {task === undefined ? null : <span className="pane__sub">{task.cwd}</span>}
        </div>
        <div className="pane__badges">
          {task === undefined ? null : (
            <>
              <span className="badge" data-testid="run-phase">
                {phaseLabel(phase)}
              </span>
              <StatsBadges stats={stats} />
              {hasSession ? (
                <ModelSwitcher
                  models={models}
                  current={task.model}
                  thinkingLevel={task.thinkingLevel}
                  switching={switching}
                  onApply={onSwitchModel}
                />
              ) : null}
              {hasSession ? null : (
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  data-testid="continue-conversation"
                  onClick={onContinue}
                >
                  继续对话
                </button>
              )}
              {hasSession ? (
                <ForkMenu forking={forking} onLoad={onLoadForkPoints} onFork={onFork} />
              ) : null}
            </>
          )}
        </div>
      </header>

      {historyTruncated ? (
        <p className="notice" data-testid="history-truncated">
          会话文件较大，仅回放了尾部（§7 约束 14 的 50MB / 2000 条上限）。
        </p>
      ) : null}

      {task !== undefined && !hasSession ? (
        <p className="notice notice--muted" data-testid="resume-hint">
          这是历史会话的只读回放，没有运行的 pi
          进程。点「继续对话」才会启动进程；「分叉」需要先继续对话。
        </p>
      ) : null}

      <div className="pane__scroll" data-testid="conversation-scroll" ref={scrollRef}>
        {task === undefined ? (
          <EmptyState
            piReady={piReady}
            locating={locating}
            onNewTask={onNewTask}
            onLocate={onLocate}
          />
        ) : empty ? (
          <div className="empty" data-testid="conversation-empty">
            <p className="empty__title">还没有消息</p>
            <p className="empty__hint">
              在下方输入第一句话开始。
              <br />
              工作目录：<code>{task.cwd}</code>
            </p>
          </div>
        ) : (
          <Timeline
            messages={chat.messages}
            streaming={chat.streaming}
            scrollRef={scrollRef}
            cacheKey={task.id}
            onFollowChange={setFollowing}
            controlsRef={timelineControls}
          />
        )}
      </div>

      {/* 用户上滚后不强制跳回底部，只给一个回底入口（§「必须保持的交互语义」） */}
      {showScrollToBottom ? (
        <button
          type="button"
          className="scroll-bottom"
          data-testid="scroll-to-bottom"
          onClick={() => {
            timelineControls.current?.scrollToBottom()
          }}
        >
          ↓ 回到底部
        </button>
      ) : null}

      <Composer
        phase={phase}
        aborting={aborting}
        aborted={aborted}
        disabled={task === undefined}
        onSend={onSend}
        onAbort={onAbort}
      />
    </section>
  )
}

/** token / 成本 / 上下文用量（全部来自 pi，缺失显示「—」） */
function StatsBadges({ stats }: { stats: SessionStats | undefined }) {
  const total = stats?.tokens?.total
  const percent = stats?.contextUsage?.percent
  return (
    <>
      <span
        className="badge badge--muted"
        data-testid="stats-tokens"
        title="输入 / 输出 / 缓存读 / 缓存写"
      >
        {formatTokens(total)} tokens
        {stats?.tokens === undefined
          ? null
          : ` (in ${formatTokens(stats.tokens.input)} · out ${formatTokens(stats.tokens.output)} · cache ${formatTokens(stats.tokens.cacheRead)})`}
      </span>
      <span className="badge badge--muted" data-testid="stats-cost">
        {formatCost(stats?.cost)}
      </span>
      {percent === undefined || percent === null ? null : (
        <span className="badge badge--muted" data-testid="stats-context">
          上下文 {Math.round(percent)}%
        </span>
      )}
    </>
  )
}

/**
 * 模型 / 推理档位切换（`model:set`）。
 *
 * 用原生 `<details>` 做弹出层：不引入额外状态机，键盘可达；
 * 切换在途时禁用「应用」并显示进度，避免重复提交（§8.1 M4）。
 */
function ModelSwitcher({
  models,
  current,
  thinkingLevel,
  switching,
  onApply
}: {
  models: ModelInfo[]
  current: string | undefined
  thinkingLevel: string | undefined
  switching: boolean
  onApply: (input: { model: string; thinkingLevel?: string }) => void
}) {
  const [model, setModel] = useState(current ?? '')
  const [level, setLevel] = useState(thinkingLevel ?? 'off')
  const [syncedCurrent, setSyncedCurrent] = useState(current)
  if (syncedCurrent !== current) {
    // 渲染期校正：外部（session:state）回填后同步草稿
    setSyncedCurrent(current)
    setModel(current ?? '')
    if (thinkingLevel !== undefined) setLevel(thinkingLevel)
  }

  return (
    <details className="model-switch" data-testid="model-switch">
      <summary className="badge badge--button" title="切换模型 / 推理档位">
        {current ?? '未选择模型'}
        {thinkingLevel === undefined ? '' : ` · ${thinkingLevel}`}
      </summary>
      <div className="model-switch__body">
        <select
          className="field__input"
          data-testid="model-switch-model"
          value={model}
          onChange={(event) => {
            setModel(event.target.value)
          }}
        >
          <option value="">（未选择）</option>
          {models.map((item) => {
            const value = `${item.provider}/${item.id}`
            return (
              <option key={value} value={value}>
                {item.name ?? item.id} · {item.provider}
              </option>
            )
          })}
        </select>
        <select
          className="field__input"
          data-testid="model-switch-thinking"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value)
          }}
        >
          {THINKING_LEVELS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--small"
          data-testid="model-switch-apply"
          disabled={switching || model.length === 0}
          onClick={() => {
            onApply({ model, thinkingLevel: level })
          }}
        >
          {switching ? '切换中…' : '应用'}
        </button>
      </div>
    </details>
  )
}

/**
 * 分叉入口。
 *
 * **pi 语义**：`fork` 只能从**用户消息** entry 分叉（docs/rpc-commands.md#fork），
 * 所以这里列出的是 `get_fork_messages` 返回的用户消息，而不是任意 assistant 消息。
 */
function ForkMenu({
  forking,
  onLoad,
  onFork
}: {
  forking: boolean
  onLoad: () => Promise<ForkPoint[]>
  onFork: (entryId: string) => void
}) {
  const [points, setPoints] = useState<ForkPoint[] | undefined>(undefined)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const loaded = await onLoad()
      setPoints(loaded)
      setSelected(loaded.at(-1)?.entryId ?? '')
    } finally {
      setLoading(false)
    }
  }

  return (
    <details
      className="fork-menu"
      data-testid="fork-menu"
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open && points === undefined) void load()
      }}
    >
      <summary className="badge badge--button" title="从某条用户消息分叉（原会话文件不变）">
        分叉
      </summary>
      <div className="model-switch__body">
        {loading || points === undefined ? (
          <span className="field__hint">正在读取可分叉点…</span>
        ) : points.length === 0 ? (
          <span className="field__hint" data-testid="fork-points-empty">
            还没有可分叉的用户消息
          </span>
        ) : (
          <>
            <select
              className="field__input"
              data-testid="fork-point-select"
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value)
              }}
            >
              {points.map((point, index) => (
                <option key={point.entryId} value={point.entryId}>
                  {index + 1}. {point.text.slice(0, 60)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--primary btn--small"
              data-testid="fork-apply"
              disabled={forking || selected.length === 0}
              onClick={() => {
                onFork(selected)
              }}
            >
              {forking ? '分叉中…' : '从这里分叉'}
            </button>
            {selected === points[0]?.entryId ? (
              // pi 从第一条用户消息 fork 时 targetLeafId = null → 得到空会话（新会话文件
              // 要等下一条 prompt 才落盘）。提前说明，避免用户以为分叉失败（M4 复核 B1）。
              <span className="field__hint" data-testid="fork-first-point-hint">
                从首条消息分叉会得到一个空会话（该消息之前没有上下文）；发送第一条消息后新会话文件才落盘
              </span>
            ) : null}
          </>
        )}
      </div>
    </details>
  )
}

/** E1 / A12：无任务时的空态与引导（定位 pi → 新建任务 → 发消息） */
function EmptyState(props: {
  piReady: boolean
  locating: boolean
  onNewTask: () => void
  onLocate: () => void
}) {
  return (
    <div className="empty empty--onboarding" data-testid="empty-state">
      <h3 className="empty__title">开始一个任务</h3>
      <ol className="onboarding">
        <li
          className={props.piReady ? 'onboarding__step onboarding__step--done' : 'onboarding__step'}
        >
          <span>1. 确认 pi 可用</span>
          {props.piReady ? (
            <span className="badge badge--ok">已就绪</span>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={props.locating}
              onClick={props.onLocate}
            >
              {props.locating ? '检测中…' : '定位 pi'}
            </button>
          )}
        </li>
        <li className="onboarding__step">
          <span>2. 新建任务并选择工作目录</span>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="empty-new-task"
            onClick={props.onNewTask}
          >
            新建任务
          </button>
        </li>
        <li className="onboarding__step">
          <span>3. 输入消息，Enter 发送（Shift+Enter 换行）</span>
        </li>
      </ol>
      <p className="empty__hint">
        会话记录以 pi 的 session JSONL 为准：左侧列表来自本地会话索引，选中即回放，不会启动子进程。
      </p>
    </div>
  )
}
