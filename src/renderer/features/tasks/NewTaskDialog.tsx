import { useEffect, useState } from 'react'

import {
  SESSION_TOOL_MODES,
  SESSION_TOOL_MODE_META,
  THINKING_LEVELS,
  type SessionToolMode
} from '../../../shared/contracts/types'
import type { AgentCatalogView } from '../../../shared/contracts/agents'
import { createTask, loadModels } from '../../lib/actions'
import { getApi } from '../../lib/client'
import { shortenPath } from '../../lib/format'
import { useSessionStore } from '../../stores/sessionStore'

/**
 * NewTaskDialog（§8.1 M4「新建任务弹层」，对标 §1.1 WorkBuddy 任务栏）。
 *
 * 必填：工作目录。其余给默认值：
 * - 模型：pi 的默认模型（列表来自 `model:list`，选不到时提示会用 pi 默认）；
 * - 推理档位：默认「off」，与 pi 的 `defaultThinkingLevel` 语义一致（不主动改）；
 * - 会话名：可空（空则由 pi 按首条消息命名，与只读索引的标题推导一致）；
 * - 起始模式：**pi 的工具选择**（不是 pi 的输出 `--mode`）。三档见 `SESSION_TOOL_MODE_META`：
 *   完整工具（默认）/ 只读（禁用 write·edit·bash·powershell）/ 纯对话（`--no-tools`）。
 *   「办公 / 编程」这类预设 pi 没有对应启动参数（属于 AGENTS.md / skills 范畴），不做假开关。
 *
 * 组件只管表单与交互，IPC 编排在 `lib/actions.ts`（createTask / loadModels）。
 */
export interface NewTaskDialogProps {
  /** 初始工作目录（通常是上次选中任务的 cwd） */
  defaultCwd?: string
  onCancel: () => void
  onCreated: (taskId: string) => void
  /** 原生目录对话框（由外层注入，便于测试） */
  pickDirectory: (defaultPath?: string) => Promise<string | undefined>
}

export function NewTaskDialog({
  defaultCwd,
  onCancel,
  onCreated,
  pickDirectory
}: NewTaskDialogProps) {
  const models = useSessionStore((state) => state.models)
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [model, setModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('off')
  const [name, setName] = useState('')
  const [toolMode, setToolMode] = useState<SessionToolMode>('full')
  /** A18：可用 agent（`null` = 还没探测完；`supportsAgentFlag=false` 时不显示选择器） */
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalogView | undefined>(undefined)
  const [agent, setAgent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (models.length === 0) void loadModels()
  }, [models.length])

  // A18：列 agent 目录。带上已选工作目录，才能扫到项目级 `.pi/agents`。
  // 支持与否由主进程探测 `pi --help`（`--agent` 是扩展 flag，未装扩展时传它会启动失败）。
  useEffect(() => {
    const api = getApi()
    if (api === undefined) return
    let live = true
    void api.agents.list(cwd.trim().length === 0 ? {} : { cwd: cwd.trim() }).then((result) => {
      if (!live || !result.ok) return
      setAgentCatalog(result.data)
    })
    return () => {
      live = false
    }
  }, [cwd])

  const pick = async (): Promise<void> => {
    const picked = await pickDirectory(cwd.length > 0 ? cwd : undefined)
    if (picked !== undefined) setCwd(picked)
  }

  const submit = async (): Promise<void> => {
    if (cwd.trim().length === 0 || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      const taskId = await createTask({
        cwd: cwd.trim(),
        ...(model.length === 0 ? {} : { model }),
        ...(model.length === 0 ? {} : { thinkingLevel }),
        ...(name.trim().length === 0 ? {} : { name: name.trim() }),
        toolMode,
        ...(agent.length === 0 ? {} : { agent })
      })
      if (taskId === undefined) {
        // 具体错误已由 actions 推进错误条；这里给出就近提示
        setError('创建会话失败，请查看顶部错误条')
        return
      }
      onCreated(taskId)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="new-task-dialog">
      <section className="modal" role="dialog" aria-modal="true" aria-label="新建任务">
        <header className="modal__header">
          <h2>新建任务</h2>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="new-task-cancel"
            onClick={onCancel}
          >
            取消
          </button>
        </header>

        <div className="modal__body">
          <label className="field">
            <span className="field__label">
              工作目录 <span className="field__required">必填</span>
            </span>
            <div className="field__row">
              <input
                className="field__input"
                data-testid="new-task-cwd"
                type="text"
                placeholder="选择或输入工作目录"
                value={cwd}
                onChange={(event) => {
                  setCwd(event.target.value)
                }}
              />
              <button
                type="button"
                className="btn"
                data-testid="new-task-pick-directory"
                onClick={() => {
                  void pick()
                }}
              >
                选择目录
              </button>
            </div>
            {cwd.length === 0 ? null : (
              <span className="field__hint" title={cwd}>
                {shortenPath(cwd, 64)}
              </span>
            )}
          </label>

          <label className="field">
            <span className="field__label">模型</span>
            <select
              className="field__input"
              data-testid="new-task-model"
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
              }}
            >
              <option value="">pi 默认模型</option>
              {models.map((item) => (
                <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>
                  {item.name ?? item.id} · {item.provider}
                </option>
              ))}
            </select>
            {models.length === 0 ? (
              <span className="field__hint">pi 未就绪或没有可用模型：将使用 pi 的默认模型</span>
            ) : null}
          </label>

          <label className="field">
            <span className="field__label">推理档位</span>
            <select
              className="field__input"
              data-testid="new-task-thinking"
              value={thinkingLevel}
              disabled={model.length === 0}
              onChange={(event) => {
                setThinkingLevel(event.target.value)
              }}
            >
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <span className="field__hint">
              只在选定模型后生效（pi 会 clamp 不支持档位）；默认不改变 pi 的档位
            </span>
          </label>

          <label className="field">
            <span className="field__label">会话名</span>
            <input
              className="field__input"
              data-testid="new-task-name"
              type="text"
              placeholder="可留空（由 pi 按首条消息命名）"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          </label>

          {agentCatalog?.supportsAgentFlag === true ? (
            <label className="field">
              <span className="field__label">Agent（会话身份）</span>
              <select
                className="field__input"
                data-testid="new-task-agent"
                value={agent}
                disabled={agentCatalog.agents.length === 0}
                onChange={(event) => {
                  setAgent(event.target.value)
                }}
              >
                <option value="">默认（不加 --agent）</option>
                {agentCatalog.agents.map((item) => (
                  <option key={item.name} value={item.name} title={item.description}>
                    {item.name}
                    {item.scope === 'project' ? '（项目）' : ''}
                  </option>
                ))}
              </select>
              <span className="field__hint">
                {agentCatalog.agents.length === 0
                  ? '未发现 agent 定义：放到 ~/.pi/agent/agents/ 或项目 .pi/agents/'
                  : '以该 agent 的 system prompt / 模型 / 工具开始这个会话；pi 对未知名字会静默忽略，所以这里只列扫描到的定义'}
              </span>
            </label>
          ) : null}

          <label className="field">
            <span className="field__label">起始模式</span>
            <select
              className="field__input"
              data-testid="new-task-mode"
              value={toolMode}
              onChange={(event) => {
                setToolMode(event.target.value as SessionToolMode)
              }}
            >
              {SESSION_TOOL_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {SESSION_TOOL_MODE_META[mode].label}
                </option>
              ))}
            </select>
            <span className="field__hint">{SESSION_TOOL_MODE_META[toolMode].hint}</span>
          </label>

          {error === undefined ? null : (
            <p className="field__error" data-testid="new-task-error">
              {error}
            </p>
          )}
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="new-task-submit"
            disabled={cwd.trim().length === 0 || submitting}
            onClick={() => {
              void submit()
            }}
          >
            {submitting ? '创建中…' : '创建任务'}
          </button>
        </footer>
      </section>
    </div>
  )
}
