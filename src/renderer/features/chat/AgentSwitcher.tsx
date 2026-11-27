import { useMemo, useRef, useState } from 'react'

import type { AgentCatalogView } from '../../../shared/contracts/agents'
import { isAgentNameSwitchable } from '../../../shared/contracts/agents'
import { buildAgentTree } from '../../lib/agent-tree'
import { getApi } from '../../lib/client'

/**
 * AgentSwitcher（A40）：Composer 底部的「专家」下拉 + 运行中切换。
 *
 * 关键决策（方案 ② D）：
 * - **就地升级** A38 的展示位：`<summary>` 沿用 `data-testid="composer-agent"`，
 *   既有 e2e 的 `toContain` 断言继续成立，减少回归面；
 * - 目录**懒加载**：首次展开才 `agents:list`（主进程 `pi --help` 探测有 60s 缓存）；
 * - 不可用时**不隐藏控件**（A33 教训）：summary 常驻，body 里给原因、按钮禁用，
 *   否则用户看到的是「控件凭空消失」；
 * - 六种禁用原因同时写进 `<summary title>` 与 hint（F1 静默失败 / F4 单 token / F6 仅 idle /
 *   历史回放没有活进程）。
 */
export interface AgentSwitcherProps {
  /** 当前生效的专家（undefined = 默认/未知） */
  current: string | undefined
  /** 活跃会话；undefined = 历史回放（禁用切换） */
  sessionKey: string | undefined
  cwd: string
  /** 本轮运行中（phase !== 'idle'） */
  busy: boolean
  compacting: boolean
  switching: boolean
  onSwitch: (name: string | null) => void
}

export function AgentSwitcher({
  current,
  sessionKey,
  cwd,
  busy,
  compacting,
  switching,
  onSwitch
}: AgentSwitcherProps) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  /** `undefined` = 还没探测（懒加载）；探测完成后才有内容 */
  const [catalog, setCatalog] = useState<AgentCatalogView | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(current ?? '')
  const [syncedCurrent, setSyncedCurrent] = useState(current)
  if (syncedCurrent !== current) {
    // 渲染期校正（与 ModelSwitcher 同一手法）：外部回填（session:state / entry_appended）后草稿跟随
    setSyncedCurrent(current)
    setSelected(current ?? '')
  }

  const tree = useMemo(() => buildAgentTree(catalog?.agents ?? []), [catalog])

  const load = async (): Promise<void> => {
    if (catalog !== undefined || loading) return
    const api = getApi()
    if (api === undefined) return
    setLoading(true)
    try {
      const result = await api.agents.list({ cwd })
      if (result.ok) setCatalog(result.data)
    } finally {
      setLoading(false)
    }
  }

  /** 硬性不可提交（与选中哪一项无关） */
  const blocked =
    sessionKey === undefined ||
    compacting ||
    busy ||
    catalog === undefined ||
    !catalog.supportsAgentFlag ||
    catalog.agents.length === 0
  /** F4：含空白/控制字符的名字不能走 `/agent`（新建任务时仍可用 `--agent` 指定） */
  const nameUnsupported = !blocked && selected.length > 0 && !isAgentNameSwitchable(selected)

  const reason =
    sessionKey === undefined
      ? '这是历史会话的只读回放：点「继续对话」后才能切换专家'
      : compacting
        ? '正在压缩上下文：稍后可切换专家'
        : busy
          ? '本轮正在运行：结束后可切换专家'
          : catalog === undefined
            ? '正在检测可用的专家…'
            : !catalog.supportsAgentFlag
              ? (catalog.note ?? '当前 pi 未注册 --agent（需要安装 pi-open-agents 扩展）')
              : catalog.agents.length === 0
                ? '未发现可用的专家：放到 ~/.pi/agent/agents/ 或项目 .pi/agents/'
                : undefined

  const hint =
    reason ??
    (nameUnsupported
      ? `「${selected}」含空白字符，暂不支持运行中切换；新建任务时可指定它`
      : '切换后会按该专家定义应用模型 / 推理档位 / 工具集；会写入会话记录，重进会话仍生效')
  const canApply = !blocked && !nameUnsupported && !switching

  return (
    <details
      className="agent-switch"
      data-testid="agent-switch"
      ref={detailsRef}
      onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open) void load()
      }}
    >
      <summary className="composer__agent" data-testid="composer-agent" title={hint}>
        专家：{current ?? '默认'}
      </summary>
      <div className="agent-switch__body">
        <select
          className="field__input"
          data-testid="agent-switch-select"
          value={selected}
          disabled={blocked || switching}
          onChange={(event) => {
            setSelected(event.target.value)
          }}
        >
          <option value="">默认（不指定专家）</option>
          {tree.root.map((item) => (
            <option
              key={item.name}
              value={item.name}
              title={item.description}
              disabled={!isAgentNameSwitchable(item.name)}
            >
              {item.name}
              {isAgentNameSwitchable(item.name) ? '' : '（不支持运行中切换）'}
            </option>
          ))}
          {tree.groups.map(([label, items]) => (
            <optgroup key={label} label={label}>
              {items.map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  title={item.description}
                  disabled={!isAgentNameSwitchable(item.name)}
                >
                  {'　'.repeat(item.group.length)}
                  {'└ '}
                  {item.name}
                  {isAgentNameSwitchable(item.name) ? '' : '（不支持运行中切换）'}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--small"
          data-testid="agent-switch-apply"
          disabled={!canApply}
          onClick={() => {
            if (!canApply) return
            onSwitch(selected.length === 0 ? null : selected)
            // 提交后收起弹层：留在展开态会让用户以为「没生效」
            if (detailsRef.current !== null) detailsRef.current.open = false
          }}
        >
          {switching ? '切换中…' : '切换'}
        </button>
        <span className="field__hint" data-testid="agent-switch-hint">
          {hint}
        </span>
      </div>
    </details>
  )
}
