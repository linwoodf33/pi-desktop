import { describeModelError, retryLine } from '../../lib/message-error'

/**
 * MessageError（§5.5 features/chat）：模型调用失败的展示块。
 *
 * 只是一块内容（不含 `pi` 角标与边框，那是调用方的事）：默认给可懂的中文标题、
 * 重试次数与建议；原始 `errorMessage` 折叠进 `<details>`，不干扰主阅读流。
 * 分类与文案在 `lib/message-error.ts`（纯函数，单测覆盖）。
 */
export interface MessageErrorBlockProps {
  /** pi 的 errorMessage 原文 */
  error: string
  /** 连续失败次数（默认 1；>1 时显示重试提示） */
  count?: number
}

export function MessageErrorBlock({ error, count = 1 }: MessageErrorBlockProps) {
  const info = describeModelError(error)
  const retry = retryLine(count)
  return (
    <div className="msg__error" data-testid="msg-error-block" data-error-kind={info.kind}>
      <p className="msg__error-title" data-testid="msg-error-title">
        {info.title}
      </p>
      {retry.length === 0 ? null : (
        <p className="msg__error-retry" data-testid="msg-error-retry">
          {retry}
        </p>
      )}
      {info.hint.length === 0 ? null : <p className="msg__error-hint">{info.hint}</p>}
      <details className="msg__error-detail" data-testid="msg-error-detail">
        <summary>技术详情</summary>
        <pre>{error}</pre>
      </details>
    </div>
  )
}
