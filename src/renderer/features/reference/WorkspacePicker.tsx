import { useEffect, useState } from 'react'

import type { DirListing } from '../../../shared/contracts/types'
import { getApi } from '../../lib/client'

/**
 * 工作区引用选择器（A27）。
 *
 * 一个入口同时选**文件**与**文件夹**。为什么自己画：
 * Windows 上原生对话框不能两者兼得（Electron 文档：`['openFile','openDirectory']`
 * 只会弹目录选择器），所以「统一成一个按钮」只能靠应用内列表。
 *
 * 边界由主进程 `path-guard` 保证：这里只按 `relative` 逐级下钻，且每次列举都会
 * 重新经过主进程校验（renderer 无法跳出工作区）。
 */
export interface WorkspacePickerProps {
  /** 会话引用（活跃会话用 sessionKey，历史任务用 sessionFile） */
  target: { sessionKey?: string; sessionFile?: string }
  /** 选中文件或文件夹后的回调（工作区相对路径） */
  onPick: (relative: string) => void
  onClose: () => void
}

export function WorkspacePicker({
  target,
  onPick,
  onClose
}: WorkspacePickerProps): React.JSX.Element {
  const [listing, setListing] = useState<DirListing | undefined>(undefined)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    // 不在 effect 体内同步 setState（会触发级联渲染的 lint 规则）：统一放进异步流程
    let live = true
    const load = async (): Promise<void> => {
      const api = getApi()
      if (api === undefined) {
        setError('IPC 不可用（preload 未注入）')
        return
      }
      const result = await api.fs.listWorkspaceDir({
        ...target,
        ...(path.length === 0 ? {} : { path })
      })
      if (!live) return
      if (result.ok) {
        setListing(result.data)
        setError(undefined)
      } else {
        setError(result.error.message)
      }
    }
    void load()
    return () => {
      live = false
    }
  }, [path, target])

  const breadcrumb = path.length === 0 ? '工作区根' : path

  return (
    <div className="modal-backdrop" data-testid="workspace-picker">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="引用工作区文件或文件夹"
      >
        <header className="modal__header">
          <h2>引用文件 / 文件夹</h2>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="workspace-picker-close"
            onClick={onClose}
          >
            关闭
          </button>
        </header>

        <div className="modal__body">
          <div className="picker__bar">
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="workspace-picker-up"
              disabled={listing?.parentRelative === undefined}
              onClick={() => {
                setPath(listing?.parentRelative ?? '')
              }}
            >
              上一级
            </button>
            <code className="picker__path" data-testid="workspace-picker-path">
              {breadcrumb}
            </code>
            <button
              type="button"
              className="btn btn--primary"
              data-testid="workspace-picker-use-folder"
              onClick={() => {
                onPick(path)
              }}
            >
              引用此文件夹
            </button>
          </div>

          {error === undefined ? null : (
            <p className="field__error" data-testid="workspace-picker-error">
              {error}
            </p>
          )}

          {listing === undefined ? (
            <p className="settings__note">读取中…</p>
          ) : (
            <ul className="picker__list" data-testid="workspace-picker-list">
              {listing.entries.map((entry) => {
                const child = path.length === 0 ? entry.name : `${path}/${entry.name}`
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className="picker__item"
                      data-testid={entry.kind === 'directory' ? 'picker-dir' : 'picker-file'}
                      onClick={() => {
                        if (entry.kind === 'directory') setPath(child)
                        else onPick(child)
                      }}
                    >
                      <span aria-hidden="true">{entry.kind === 'directory' ? '📁' : '📄'}</span>
                      <span>{entry.name}</span>
                    </button>
                  </li>
                )
              })}
              {listing.entries.length === 0 ? (
                <li className="settings__note">这个目录是空的</li>
              ) : null}
              {listing.truncated ? (
                <li className="settings__note" data-testid="workspace-picker-truncated">
                  目录条目过多，只显示前 500 项（可进入子目录继续找）
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}
