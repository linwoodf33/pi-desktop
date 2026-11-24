import { useEffect, useState } from 'react'

import type { SkillSummary } from '../../../shared/contracts/skills'
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
  onClose: () => void
}

export function SkillsPanel({ cwd, onClose }: SkillsPanelProps): React.JSX.Element {
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
