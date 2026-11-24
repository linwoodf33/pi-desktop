import { useEffect, useState } from 'react'

import type { Diagnostics } from '../../../shared/contracts/types'
import { getApi } from '../../lib/client'

/**
 * 诊断面板（A25）。
 *
 * 目的很具体：用户反馈问题时常需要确认「跑的是哪一版 / pi 什么版本 / 配置目录在哪」。
 * 之前每次都要来回问，现在一眼能看到，还能一键复制。
 *
 * 边界：**只读、脱敏** —— 不含 apiKey / token，也不读会话内容。
 */
export interface DiagnosticsPanelProps {
  onClose: () => void
}

/** 展示顺序固定，便于用户按固定位置找信息 */
const ROWS: Array<{ key: keyof Diagnostics; label: string }> = [
  { key: 'appVersion', label: '客户端版本' },
  { key: 'piVersion', label: 'pi 版本' },
  { key: 'piState', label: 'pi 状态' },
  { key: 'piPath', label: 'pi 可执行文件' },
  { key: 'piMessage', label: 'pi 自检信息' },
  { key: 'agentDir', label: 'pi 配置目录' },
  { key: 'sessionDir', label: '会话目录' },
  { key: 'modelsPath', label: 'models.json' },
  { key: 'settingsPath', label: 'settings.json' },
  { key: 'lastCwd', label: '默认工作目录' },
  { key: 'theme', label: '主题' },
  { key: 'sessionCount', label: '已索引会话数' },
  { key: 'electron', label: 'Electron' },
  { key: 'chrome', label: 'Chromium' },
  { key: 'node', label: 'Node' },
  { key: 'platform', label: '平台' },
  { key: 'arch', label: '架构' }
]

export function DiagnosticsPanel({ onClose }: DiagnosticsPanelProps): React.JSX.Element {
  const [data, setData] = useState<Diagnostics | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // 不在 effect 体内同步 setState（会触发级联渲染的 lint 规则）：
    // 统一放进异步流程，首帧先渲染「读取中…」。
    const load = async (): Promise<void> => {
      const api = getApi()
      if (api === undefined) {
        setError('IPC 不可用（preload 未注入）')
        return
      }
      const result = await api.app.diagnostics()
      if (result.ok) setData(result.data)
      else setError(result.error.message)
    }
    void load()
  }, [])

  const asText = (value: Diagnostics): string =>
    ROWS.filter((row) => value[row.key] !== undefined)
      .map((row) => `${row.label}: ${String(value[row.key])}`)
      .join('\n')

  return (
    <div className="modal-backdrop" data-testid="diagnostics-panel">
      <section className="modal" role="dialog" aria-modal="true" aria-label="诊断信息">
        <header className="modal__header">
          <h2>诊断信息</h2>
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="diagnostics-close"
            onClick={onClose}
          >
            关闭
          </button>
        </header>
        <div className="modal__body">
          {error === undefined ? null : (
            <p className="field__error" data-testid="diagnostics-error">
              {error}
            </p>
          )}
          {data === undefined ? (
            error === undefined ? (
              <p className="settings__note">读取中…</p>
            ) : null
          ) : (
            <>
              <p className="settings__note">
                反馈问题时把下面内容贴给我即可（不包含任何密钥或对话内容）。
              </p>
              <dl className="settings__list" data-testid="diagnostics-rows">
                {ROWS.filter((row) => data[row.key] !== undefined).map((row) => (
                  <div className="settings__row" key={row.key}>
                    <dt>{row.label}</dt>
                    <dd>
                      <code data-testid={`diagnostics-${row.key}`}>{String(data[row.key])}</code>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="settings__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="diagnostics-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(asText(data)).then(() => {
                      setCopied(true)
                      window.setTimeout(() => setCopied(false), 1500)
                    })
                  }}
                >
                  {copied ? '已复制' : '复制全部'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
