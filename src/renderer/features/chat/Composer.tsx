import { useState } from 'react'

import { phaseLabel } from '../../lib/format'
import type { RunPhase } from '../../lib/reducer'

/**
 * Composer：输入框 + 发送 + 停止（§8.1 M3「停止按钮」）。
 *
 * 停止语义（E4）：点击后按钮**立即**置灰并显示「已中止」，
 * 不等待 `session:abort` 的响应（pi 的 abort 会等会话 idle 才回）。
 */
export interface ComposerProps {
  phase: RunPhase
  aborting: boolean
  aborted: boolean
  /** 没有选中任务时不显示输入区（由空态引导「新建任务」） */
  disabled: boolean
  onSend: (text: string) => void
  onAbort: () => void
}

export function Composer({ phase, aborting, aborted, disabled, onSend, onAbort }: ComposerProps) {
  const [input, setInput] = useState('')
  const canSend = !disabled && !aborting && input.trim().length > 0
  const canAbort = !disabled && !aborting && phase !== 'idle'

  const submit = (): void => {
    const text = input.trim()
    if (!canSend || text.length === 0) return
    setInput('')
    onSend(text)
  }

  return (
    <footer className="composer">
      <textarea
        className="composer__input"
        placeholder={
          disabled
            ? '先新建任务（选择工作目录）才能发送消息'
            : '输入消息，Enter 发送，Shift+Enter 换行'
        }
        rows={3}
        value={input}
        disabled={disabled}
        onChange={(event) => {
          setInput(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
      />

      <div className="composer__actions">
        <span className="composer__state" data-testid="composer-state">
          {/* E4：点击停止就立即提示「已中止」，不依赖 abort 响应到达 */}
          {aborted ? '已中止' : aborting ? '正在中止…' : phaseLabel(phase)}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="abort-button"
          disabled={!canAbort}
          onClick={onAbort}
        >
          {aborting ? '中止中…' : aborted ? '已中止' : '停止'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="send-button"
          disabled={!canSend}
          onClick={submit}
        >
          发送
        </button>
      </div>
    </footer>
  )
}
