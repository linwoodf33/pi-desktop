import { useEffect, useState } from 'react'

import {
  SESSION_TOOL_MODES,
  SESSION_TOOL_MODE_META,
  THINKING_LEVELS,
  type SessionToolMode
} from '../../../shared/contracts/types'
import type { AgentCatalogView } from '../../../shared/contracts/agents'
import { createTask, loadModels } from '../../lib/actions'
import { buildAgentTree } from '../../lib/agent-tree'
import { getApi } from '../../lib/client'
import { shortenPath } from '../../lib/format'
import { useAppStore } from '../../stores/appStore'
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
  /** pi 自检状态（A33：变化时重新探测 agent 能力） */
  const piState = useAppStore((state) =>
    state.bridge.phase === 'ok' ? state.bridge.boot.piStatus.state : 'unknown'
  )
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [model, setModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('off')
  const [name, setName] = useState('')
  const [toolMode, setToolMode] = useState<SessionToolMode>('full')
  /** A18：可用 agent（`null` = 还没探测完；`supportsAgentFlag=false` 时不显示选择器） */
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalogView | undefined>(undefined)
  const [agent, setAgent] = useState('')

  // A29 / A40：按目录把专家组织成树（与 Composer 的运行中切换共用 `lib/agent-tree.ts`）
  const agentTree = buildAgentTree(agentCatalog?.agents ?? [])

  /**
   * A33：不可用时**不隐藏整个控件**，而是禁用 + 说明原因。
   * 之前探测失败（例如 pi 尚未自检完成、或未装 pi-open-agents）会直接不渲染，
   * 用户看到的就是「agent 选择没了」。
   */
  const agentSupported = agentCatalog?.supportsAgentFlag === true
  const agentCount = agentCatalog?.agents.length ?? 0
  const agentDisabled = agentCatalog === undefined || !agentSupported || agentCount === 0
  const agentHint =
    agentCatalog === undefined
      ? '正在检测可用的专家…'
      : !agentSupported
        ? (agentCatalog.note ??
          '当前 pi 未注册 --agent（安装 pi-open-agents 扩展后才能选择/切换专家）')
        : agentCount === 0
          ? '未发现可用的专家（mode: primary/all）：放到 ~/.pi/agent/agents/ 或项目 .pi/agents/'
          : '只列可作会话身份的专家（与 TUI /agent 一致）；会话将以它的 system prompt / 模型 / 工具运行'
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (models.length === 0) void loadModels()
  }, [models.length])

  // A18：列 agent 目录。带上已选工作目录，才能扫到项目级 `.pi/agents`。
  // 支持与否由主进程探测 `pi --help`（`--agent` 是扩展 flag，未装扩展时传它会启动失败）。
  // A33：依赖 pi 自检状态 —— 应用刚启动时 pi 可能还没定位完，那时探测必然失败；
  // 自检状态变化后重新扫一次，避免「打开快了就永远看不到 agent 选择」。
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
  }, [cwd, piState])

  const pick = async (): Promise<void> => {
    // 已选任务 → 从该任务的工作区开始；否则交给主进程默认（用户主目录，不是进程启动目录）
    const startAt = cwd.trim().length > 0 ? cwd.trim() : defaultCwd
    const picked = await pickDirectory(startAt === undefined ? undefined : startAt)
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

          <label className="field">
            <span className="field__label">专家（会话身份）</span>
            <select
              className="field__input"
              data-testid="new-task-agent"
              value={agent}
              disabled={agentDisabled}
              onChange={(event) => {
                setAgent(event.target.value)
              }}
            >
              <option value="">默认（不指定专家）</option>
              {agentTree.root.map((item) => (
                <option key={item.name} value={item.name} title={item.description}>
                  {item.name}
                  {item.mode === 'primary' ? '（主）' : ''}
                  {item.scope === 'project' ? '（项目）' : ''}
                </option>
              ))}
              {agentTree.groups.map(([label, items]) => (
                <optgroup key={label} label={label}>
                  {items.map((item) => (
                    <option key={item.name} value={item.name} title={item.description}>
                      {'　'.repeat(item.group.length)}
                      {'└ '}
                      {item.name}
                      {item.mode === 'primary' ? '（主）' : ''}
                      {item.scope === 'project' ? '（项目）' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="field__hint" data-testid="new-task-agent-hint">
              {agentHint}
            </span>
          </label>

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
