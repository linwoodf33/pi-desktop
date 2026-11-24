import { useEffect, useState } from 'react'

import type { SkillInstallPreview, SkillSummary } from '../../../shared/contracts/skills'
import { getApi } from '../../lib/client'

/**
 * 技能面板（A31）：显示当前可用的技能（只读）。
 *
 * 「可用」的口径与 pi 一致：global `<agent-dir>/skills/**` + 当前任务工作区的
 * `.pi/skills/**`、`.agents/skills/**`，同名以 project 为准。
 * 只展示 name/description（pi 也只把它们暴露给模型），**不加载正文、不执行**。
 */
export interface SkillsPanelProps {
  /** 当前任务工作目录（决定项目级技能）；没有任务时只看全局 */
  cwd?: string
  /** 会话引用（项目级安装需要主进程据此确定工作区） */
  target?: { sessionKey?: string; sessionFile?: string }
  onClose: () => void
}

export function SkillsPanel({ cwd, target, onClose }: SkillsPanelProps): React.JSX.Element {
  const [skills, setSkills] = useState<SkillSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    // 不在 effect 体内同步 setState（级联渲染）→ 放进异步流程
    const load = async (): Promise<void> => {
      const api = getApi()
      if (api === undefined) {
        setError('IPC 不可用（preload 未注入）')
        return
      }
      const result = await api.skills.list(cwd === undefined ? {} : { cwd })
      if (result.ok) setSkills(result.data.skills)
      else setError(result.error.message)
    }
    void load()
  }, [cwd])

  const [url, setUrl] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<SkillInstallPreview>()
  const [installResult, setInstallResult] = useState<string>()
  const [installError, setInstallError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const projectAvailable = target !== undefined

  const runPreview = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined) return
    setBusy(true)
    setInstallResult(undefined)
    setPreview(undefined)
    setInstallError(undefined)
    const result = await api.skills.preview({
      url,
      scope,
      ...(target === undefined ? {} : target)
    })
    setBusy(false)
    if (result.ok) setPreview(result.data)
    else setInstallError(result.error.message)
  }

  const runInstall = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined) return
    setBusy(true)
    setInstallError(undefined)
    const result = await api.skills.install({
      url,
      scope,
      ...(overwrite ? { overwrite: true } : {}),
      ...(target === undefined ? {} : target)
    })
    setBusy(false)
    if (!result.ok) {
      setInstallError(result.error.message)
      return
    }
    setInstallResult(result.data.path)
    // 装完刷新清单
    const listed = await api.skills.list(cwd === undefined ? {} : { cwd })
    if (listed.ok) setSkills(listed.data.skills)
  }

  const project = (skills ?? []).filter((skill) => skill.scope === 'project')
  const global = (skills ?? []).filter((skill) => skill.scope === 'global')

  const renderGroup = (title: string, items: SkillSummary[]): React.JSX.Element | null => {
    if (items.length === 0) return null
    return (
      <section
        className="skills__group"
        data-testid={`skills-group-${title === '项目' ? 'project' : 'global'}`}
      >
        <h3>
          {title}（{items.length}）
        </h3>
        <ul className="skills__list">
          {items.map((skill) => (
            <li
              key={`${skill.scope}-${skill.name}`}
              className="skills__item"
              data-testid="skill-item"
            >
              <div className="skills__head">
                <strong>{skill.name}</strong>
                {skill.group.length === 0 ? null : (
                  <span className="skills__meta">{skill.group.join(' / ')}</span>
                )}
              </div>
              {skill.description === undefined ? null : (
                <p className="skills__desc">{skill.description}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="modal-backdrop" data-testid="skills-panel">
      <section className="modal modal--wide" role="dialog" aria-modal="true" aria-label="可用技能">
        <header className="modal__header">
          <h2>可用技能{skills === undefined ? '' : `（${skills.length}）`}</h2>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="skills-close"
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        <div className="modal__body">
          <p className="settings__note">
            技能是「按需加载」的：pi 只把名称与描述给模型，命中后才读完整指令。这里只是清单，
            不含正文。项目级技能来自当前任务工作区的 <code>.pi/skills</code>。
          </p>
          <section className="skills__install" data-testid="skills-install-form">
            <h3>从 URL 安装公开技能</h3>
            <p className="settings__note">
              粘贴技能 <code>SKILL.md</code> 的 https 链接，先「预览」确认名称与描述，再选择装到
              全局或当前工作区。只安装单个 SKILL.md（不拉取技能自带的脚本/资料）。
            </p>
            <div className="skills__install-row">
              <input
                className="field__input"
                data-testid="skills-url"
                placeholder="https://example.com/skills/my-skill/SKILL.md"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                }}
              />
              <select
                className="field__input"
                data-testid="skills-scope"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value === 'project' ? 'project' : 'global')
                }}
              >
                <option value="global">全局（~/.pi/agent/skills）</option>
                <option value="project" disabled={!projectAvailable}>
                  项目级（当前工作区 .pi/skills）
                </option>
              </select>
              <button
                type="button"
                className="btn btn--ghost"
                data-testid="skills-preview-button"
                disabled={busy || url.trim().length === 0}
                onClick={() => {
                  void runPreview()
                }}
              >
                预览
              </button>
            </div>
            {preview === undefined ? null : (
              <div className="skills__preview" data-testid="skills-preview">
                <p>
                  <strong>{preview.name}</strong>
                  <span className="skills__meta">{preview.bytes} B</span>
                </p>
                {preview.description === undefined ? null : (
                  <p className="skills__desc">{preview.description}</p>
                )}
                <label className="skills__overwrite">
                  <input
                    type="checkbox"
                    data-testid="skills-overwrite"
                    checked={overwrite}
                    onChange={(event) => {
                      setOverwrite(event.target.checked)
                    }}
                  />
                  <span>覆盖同名技能</span>
                </label>
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="skills-install-button"
                  disabled={busy}
                  onClick={() => {
                    void runInstall()
                  }}
                >
                  安装到{scope === 'global' ? '全局' : '项目级'}
                </button>
              </div>
            )}
            {installError === undefined ? null : (
              <p className="field__error" data-testid="skills-install-error">
                {installError}
              </p>
            )}
            {installResult === undefined ? null : (
              <p className="skills__desc" data-testid="skills-install-result">
                已安装：{installResult}
              </p>
            )}
          </section>

          {error === undefined ? null : (
            <p className="field__error" data-testid="skills-error">
              {error}
            </p>
          )}
          {skills === undefined ? (
            <p className="settings__note">读取中…</p>
          ) : skills.length === 0 ? (
            <p className="settings__note" data-testid="skills-empty">
              未发现技能：放到 <code>~/.pi/agent/skills/&lt;名称&gt;/SKILL.md</code> 或项目的
              <code>.pi/skills/</code>
            </p>
          ) : (
            <>
              {renderGroup('项目', project)}
              {renderGroup('全局', global)}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
