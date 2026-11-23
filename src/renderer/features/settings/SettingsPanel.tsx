import { useEffect, useState } from 'react'

import type {
  AppConfigView,
  PermissionStatus,
  PiSelfCheckStatus,
  PiSelfCheckStep
} from '../../../shared/contracts/types'
import { locatePi, saveSettings } from '../../lib/actions'
import { APPROVAL_TOOL_CHOICES } from '../../lib/approval'
import { getApi } from '../../lib/client'

/**
 * Settings（§5.5 features/settings，M4 完整版）：
 * 并行活跃会话上限、空闲回收阈值、pi 可执行路径 + 三步自检可视化、会话目录覆盖、主题。
 *
 * 约束：
 * - 全部字段只写 ConfigStore（`config:update`），不落任何密钥（§7 约束 9/12）；
 * - pi 路径的「保存」与「自检」分开：自检只是探测，不隐式改配置；
 * - 会话目录留空 = 使用 pi 默认（`--session-dir` 不下发）。
 */
export interface SettingsPanelProps {
  config: AppConfigView
  /** pi 自检状态（启动时的 `app:getBoot` 结果；本地面板可重新自检刷新） */
  piStatus: PiSelfCheckStatus | undefined
}

/**
 * 审批扩展的安装状态（M5，`permission:status`）。
 *
 * 只读探测：装没装、装的是哪个版本、是否落后于仓库内的源。
 * 未安装时给出可复制的安装命令——不自动安装（安装是显式动作，避免静默改动用户扩展目录）。
 */
export function PermissionStatusView({ status }: { status: PermissionStatus | undefined }) {
  if (status === undefined) return null
  return (
    <div className="perm-status" data-testid="permission-status">
      <span
        className={status.installed ? 'badge badge--ok' : 'badge badge--error'}
        data-testid="permission-status-state"
      >
        {status.installed
          ? `审批扩展已安装 v${status.installedVersion ?? '?'}${status.upToDate ? '' : '（落后，建议重装）'}`
          : '审批扩展未安装'}
      </span>
      {status.installed ? (
        <code className="settings__note">{status.extensionDir}</code>
      ) : (
        <span className="settings__note">
          未安装时 pi 不会在执行高风险工具前询问。安装：<code>npm run install:permission</code>
        </span>
      )}
      <span className="settings__note">
        客户端协议 v{status.protocolVersion}；协议不兼容时所有审批请求会被自动拒绝
      </span>
    </div>
  )
}

const STEP_LABEL: Record<PiSelfCheckStep['state'], string> = {
  ok: '通过',
  failed: '失败',
  skipped: '跳过'
}

export function SettingsPanel({ config, piStatus }: SettingsPanelProps) {
  const [piCommand, setPiCommand] = useState(config.piCommand)
  const [sessionDir, setSessionDir] = useState(config.sessionDir ?? '')
  const [maxActiveSessions, setMaxActiveSessions] = useState(String(config.maxActiveSessions))
  const [idleRecycleMinutes, setIdleRecycleMinutes] = useState(String(config.idleRecycleMinutes))
  const [theme, setTheme] = useState<AppConfigView['theme']>(config.theme)
  const [permEnabled, setPermEnabled] = useState(config.permission.enabled)
  const [permTools, setPermTools] = useState<string[]>(config.permission.tools)
  const [permStatus, setPermStatus] = useState<PermissionStatus | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<PiSelfCheckStatus | undefined>(piStatus)

  // 外部配置变化（保存成功后回写）时同步草稿：
  // 用 React 推荐的「渲染期校正」而不是 effect（避免级联渲染，符合 react-hooks 规则）
  const [syncedConfig, setSyncedConfig] = useState(config)
  if (syncedConfig !== config) {
    setSyncedConfig(config)
    setPiCommand(config.piCommand)
    setSessionDir(config.sessionDir ?? '')
    setMaxActiveSessions(String(config.maxActiveSessions))
    setIdleRecycleMinutes(String(config.idleRecycleMinutes))
    setTheme(config.theme)
    setPermEnabled(config.permission.enabled)
    setPermTools(config.permission.tools)
  }

  // 安装状态是只读探测：只在挂载时拉一次（失败不打扰用户，状态位留空）
  useEffect(() => {
    const api = getApi()
    if (api === undefined) return
    void api.permission.status().then((result) => {
      if (result.ok) setPermStatus(result.data)
    })
  }, [])

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      const status = await locatePi(piCommand.trim().length === 0 ? {} : { path: piCommand.trim() })
      if (status !== undefined) setCheck(status)
    } finally {
      setChecking(false)
    }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      await saveSettings({
        piCommand: piCommand.trim().length === 0 ? 'pi' : piCommand.trim(),
        // 空字符串的语义是「恢复 pi 默认会话目录」
        sessionDir: sessionDir.trim(),
        maxActiveSessions: Number.parseInt(maxActiveSessions, 10),
        idleRecycleMinutes: Number.parseInt(idleRecycleMinutes, 10),
        theme,
        permission: {
          enabled: permEnabled,
          tools: permTools,
          timeoutMs: config.permission.timeoutMs
        }
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings" aria-label="设置">
      <h3>设置</h3>
      <dl className="settings__list">
        <div className="settings__row">
          <dt>
            <label htmlFor="pi-command">pi 可执行文件</label>
          </dt>
          <dd>
            <div className="field__row">
              <input
                id="pi-command"
                className="field__input"
                data-testid="settings-pi-command"
                type="text"
                value={piCommand}
                onChange={(event) => {
                  setPiCommand(event.target.value)
                }}
              />
              <button
                type="button"
                className="btn"
                data-testid="settings-pi-check"
                disabled={checking}
                onClick={() => {
                  void runCheck()
                }}
              >
                {checking ? '自检中…' : '定位 / 自检'}
              </button>
            </div>
            <SelfCheckView status={check} />
          </dd>
        </div>

        <div className="settings__row">
          <dt>
            <label htmlFor="session-dir">会话目录</label>
          </dt>
          <dd>
            <input
              id="session-dir"
              className="field__input"
              data-testid="settings-session-dir"
              type="text"
              placeholder="留空 = pi 默认（~/.pi/agent/sessions）"
              value={sessionDir}
              onChange={(event) => {
                setSessionDir(event.target.value)
              }}
            />
            <span className="settings__note">
              对应当前 pi 进程的 `--session-dir`；留空表示使用 pi 自己的默认位置
            </span>
          </dd>
        </div>

        <div className="settings__row">
          <dt>
            <label htmlFor="max-active">并行活跃会话上限</label>
          </dt>
          <dd>
            <input
              id="max-active"
              className="field__input field__input--number"
              data-testid="settings-max-active"
              type="number"
              min={1}
              max={10}
              value={maxActiveSessions}
              onChange={(event) => {
                setMaxActiveSessions(event.target.value)
              }}
            />
            <span className="settings__note">默认 3；超限时最久未活动的空闲会话会被回收</span>
          </dd>
        </div>

        <div className="settings__row">
          <dt>
            <label htmlFor="idle-recycle">空闲回收阈值（分钟）</label>
          </dt>
          <dd>
            <input
              id="idle-recycle"
              className="field__input field__input--number"
              data-testid="settings-idle-recycle"
              type="number"
              min={1}
              max={1440}
              value={idleRecycleMinutes}
              onChange={(event) => {
                setIdleRecycleMinutes(event.target.value)
              }}
            />
            <span className="settings__note">默认 30；只回收已 settled 的会话</span>
          </dd>
        </div>

        <div className="settings__row">
          <dt>
            <label htmlFor="theme">主题</label>
          </dt>
          <dd>
            <select
              id="theme"
              className="field__input"
              data-testid="settings-theme"
              value={theme}
              onChange={(event) => {
                setTheme(event.target.value as AppConfigView['theme'])
              }}
            >
              <option value="system">跟随系统</option>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
            <span className="settings__note">视觉沿用 pi（Q6）；M4 只持久化选择</span>
          </dd>
        </div>
        <div className="settings__row">
          <dt>
            <label htmlFor="permission-enabled">工具审批</label>
          </dt>
          <dd>
            <label className="field__row" htmlFor="permission-enabled">
              <input
                id="permission-enabled"
                data-testid="settings-permission-enabled"
                type="checkbox"
                checked={permEnabled}
                onChange={(event) => {
                  setPermEnabled(event.target.checked)
                }}
              />
              <span>高风险工具执行前必须人工批准（默认开启，§Q4）</span>
            </label>
            <div className="field__row" data-testid="settings-permission-tools">
              {APPROVAL_TOOL_CHOICES.map((tool) => (
                <label key={tool.value} className="field__check">
                  <input
                    type="checkbox"
                    data-testid={`settings-permission-tool-${tool.value}`}
                    checked={permTools.includes(tool.value)}
                    onChange={(event) => {
                      setPermTools((current) =>
                        event.target.checked
                          ? [...new Set([...current, tool.value])]
                          : current.filter((item) => item !== tool.value)
                      )
                    }}
                  />
                  <span>{tool.label}</span>
                </label>
              ))}
            </div>
            <span className="settings__note">
              审批策略在下次启动会话时随环境下发给扩展；已运行的会话保持原策略
            </span>
            <PermissionStatusView status={permStatus} />
          </dd>
        </div>
      </dl>

      <div className="settings__actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="settings-save"
          disabled={saving}
          onClick={() => {
            void save()
          }}
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </section>
  )
}

/** 三步自检的可视化（定位 → 版本 → RPC 连通性，§3.3 / A12） */
function SelfCheckView({ status }: { status: PiSelfCheckStatus | undefined }) {
  if (status === undefined) return null
  const steps = status.steps ?? []
  return (
    <div className="selfcheck" data-testid="self-check">
      <span
        className={
          status.state === 'ok'
            ? 'badge badge--ok'
            : status.state === 'unknown'
              ? 'badge'
              : 'badge badge--error'
        }
        data-testid="self-check-state"
      >
        {status.state === 'ok'
          ? `pi ${status.version ?? ''} 就绪`
          : status.state === 'missing'
            ? '未找到 pi'
            : status.state === 'unknown'
              ? '尚未自检'
              : '自检失败'}
      </span>
      {steps.length === 0 ? null : (
        <ol className="selfcheck__steps" data-testid="self-check-steps">
          {steps.map((step) => (
            <li key={step.id} className={`selfcheck__step selfcheck__step--${step.state}`}>
              <span className="selfcheck__label">
                {step.label}：{STEP_LABEL[step.state]}
              </span>
              {step.detail === undefined ? null : (
                <code className="selfcheck__detail">{step.detail}</code>
              )}
            </li>
          ))}
        </ol>
      )}
      {status.message === undefined ? null : <p className="settings__note">{status.message}</p>}
    </div>
  )
}
