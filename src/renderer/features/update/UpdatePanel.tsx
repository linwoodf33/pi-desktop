import { useEffect, useState } from 'react'

import type {
  PiUpdateApplyInput,
  PiUpdateApplyResult,
  PiUpdateCheckResult
} from '../../../shared/contracts/update'
import { getApi } from '../../lib/client'

/**
 * pi 更新面板（A34）：检测版本 + 真正执行 `pi update`。
 *
 * 为什么「检查更新」与「更新 pi」必须是两个按钮，而不是一个「一键更新」：
 * `pi update` 没有 dry-run —— 只要远端有新版它就立刻下载并替换本机安装，
 * 既不会先回答「有没有新版」，也没法回滚。所以检测走只读的 `pi:updateCheck`
 * （网络请求 + 缓存），执行走 `pi:updateApply`（会改动磁盘）。把二者拆开，
 * 用户能在「知道自己要不要更新」之后再决定是否让程序替换本机的 pi。
 *
 * 为什么「强制重装」需要内联二次确认：`force` 会跳过「已是最新」的判断直接重装，
 * 是最容易造成意外停机（二进制被替换、会话必须中断）的路径；而 `window.confirm`
 * 在 Electron / file:// 下会阻塞渲染进程、也无法在测试里断言，故用页面内确认区。
 */

/** 日志最多保留的行数（npm 输出可能上千行，超出部分丢头部只留尾部） */
const MAX_LOG_LINES = 400

/** 终态事件缺 `message` 时的兜底摘要 */
const TERMINAL_TEXT: Record<'done' | 'failed' | 'canceled', string> = {
  done: '更新结束',
  failed: '更新失败',
  canceled: '更新已取消'
}

export interface UpdatePanelProps {
  onClose: () => void
  /** 更新真的落地（`updated`）或已装好待重启（`pendingRestart`）时通知外部刷新状态 */
  onApplied?: () => void
}

/** ISO → 本地可读时间（用户关心「多久前查的」，不是 UTC） */
function formatCheckedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function stateLabel(state: PiUpdateCheckResult['state']): string {
  if (state === 'upToDate') return '已是最新'
  if (state === 'available') return '有新版'
  return '无法确认'
}

function sourceLabel(source: PiUpdateCheckResult['source']): string {
  return source === 'pi.dev' ? '刚刚查询' : '上次缓存'
}

export function UpdatePanel({ onClose, onApplied }: UpdatePanelProps): React.JSX.Element {
  const [check, setCheck] = useState<PiUpdateCheckResult | undefined>(undefined)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  /**
   * 已发出取消请求、正在等 `canceled` 终态：只驱动按钮的禁用与文案。
   * 真正的收敛仍由终态事件 / `apply` 返回决定，避免「点了取消就当结束了」。
   */
  const [canceling, setCanceling] = useState(false)

  /** 最近一次操作失败的说明（错误码一并保留，用于决定是否给「结束会话并更新」入口） */
  const [error, setError] = useState<string | undefined>(undefined)
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined)
  /** `SESSION_BUSY` 的 detail = 占用中的会话键列表 */
  const [busySessions, setBusySessions] = useState<string | undefined>(undefined)
  /** `PI_UPDATE_UNAVAILABLE` 的 detail = 需要用户手动的命令 */
  const [manualCommand, setManualCommand] = useState<string | undefined>(undefined)

  const [logLines, setLogLines] = useState<string[]>([])
  const [force, setForce] = useState(false)
  /** 强制重装的二次确认区是否展开 */
  const [forceConfirm, setForceConfirm] = useState(false)
  const [applyResult, setApplyResult] = useState<PiUpdateApplyResult | undefined>(undefined)
  const [copyState, setCopyState] = useState<string | undefined>(undefined)

  // 更新过程事件：日志流 + 终态收敛 loading。依赖数组为空 —— 处理器内部只用函数式
  // setState（不读闭包里的旧 state），因此不需要在依赖变化时重订阅。
  useEffect(() => {
    const api = getApi()
    if (api === undefined) return undefined

    const append = (line: string): void => {
      setLogLines((prev) => {
        const next = [...prev, line]
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
      })
    }

    const off = api.events.onPiUpdate((event) => {
      if (event.phase === 'started' || event.phase === 'log') {
        // 流式阶段：优先用剥过 ANSI 的 `line`，没有则退回 `message`
        const text = event.line ?? event.message
        if (text !== undefined && text.length > 0) append(text)
        return
      }
      // 终态：先落一行摘要再收敛 loading（IPC 结果的返回可能晚于事件）
      append(event.message ?? TERMINAL_TEXT[event.phase])
      // `canceled` 也走这里：取消已受理不等于取消成功，结论以服务给的 message 为准
      setApplying(false)
      setCanceling(false)
    })

    return () => {
      off()
    }
  }, [])

  const clearFeedback = (): void => {
    setError(undefined)
    setErrorCode(undefined)
    setBusySessions(undefined)
    setManualCommand(undefined)
    setCopyState(undefined)
  }

  const runCheck = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined) {
      setError('IPC 不可用（preload 未注入）')
      return
    }
    setChecking(true)
    clearFeedback()
    // 契约保证 detection 永不进错误分支（离线/超时折成 state:'unknown'），这里仍留兜底
    const result = await api.pi.updateCheck()
    setChecking(false)
    if (result.ok) {
      setCheck(result.data)
      return
    }
    setError(result.error.message)
    setErrorCode(result.error.code)
  }

  const runApply = async (options: {
    force?: boolean
    disposeSessions?: boolean
  }): Promise<void> => {
    const api = getApi()
    if (api === undefined) {
      setError('IPC 不可用（preload 未注入）')
      return
    }
    setApplying(true)
    setCanceling(false)
    setForceConfirm(false)
    clearFeedback()
    setApplyResult(undefined)

    // exactOptionalPropertyTypes：可选字段只在有值时展开
    const input: PiUpdateApplyInput = {
      ...(options.force === true ? { force: true } : {}),
      ...(options.disposeSessions === true ? { disposeSessions: true } : {})
    }
    const result = await api.pi.updateApply(input)
    setApplying(false)
    setCanceling(false)

    if (!result.ok) {
      // accepted:false 的 gate 拒绝才会走这里；accepted:true 的 outcome:'failed' 仍是 ok
      setError(result.error.message)
      setErrorCode(result.error.code)
      if (result.error.code === 'SESSION_BUSY' && result.error.detail !== undefined) {
        setBusySessions(result.error.detail)
      }
      if (result.error.code === 'PI_UPDATE_UNAVAILABLE' && result.error.detail !== undefined) {
        setManualCommand(result.error.detail)
      }
      return
    }

    const applied = result.data
    setApplyResult(applied)
    if (applied.outcome === 'updated' || applied.outcome === 'pendingRestart') {
      // 版本已变化或已装好待重启：都算「落地」，交回外部刷新版本号
      onApplied?.()
    }
  }

  const handleApplyClick = (): void => {
    if (force) {
      // 强制重装不直接执行：先展开内联确认（禁 window.confirm，见文件头注释）
      setForceConfirm(true)
      return
    }
    void runApply({})
  }

  /**
   * 取消更新：`pi update` 没有回滚，能做的只有结束子进程。
   * 所以这里只负责「发请求 + 进入 stopping 态」，成败与「安装可能不完整」的说明由服务给。
   */
  const handleCancelClick = (): void => {
    const api = getApi()
    if (api === undefined) {
      setError('IPC 不可用（preload 未注入）')
      return
    }
    setCanceling(true)
    void api.pi.updateCancel().then((result) => {
      if (result.ok) return
      // 取消请求本身失败（如任务刚好已结束）：撤掉 stopping 态，并把原因说清楚
      setCanceling(false)
      setError(result.error.message)
      setErrorCode(result.error.code)
    })
  }

  const copyManualCommand = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined || manualCommand === undefined) return
    const result = await api.app.copyText({ text: manualCommand })
    setCopyState(result.ok ? '已复制' : `复制失败：${result.error.message}`)
  }

  const currentVersion = check?.currentVersion ?? '未知'
  const latestVersion = check === undefined ? '尚未检查' : (check.latestVersion ?? '未知')
  const checkedAt = check === undefined ? '尚未检查' : formatCheckedAt(check.checkedAt)
  const source = check === undefined ? '尚未检查' : sourceLabel(check.source)
  const state = check === undefined ? '尚未检查' : stateLabel(check.state)
  const showsDisposeEntry = errorCode === 'SESSION_BUSY'
  const showsManualCommand = manualCommand !== undefined && manualCommand.length > 0

  return (
    <div className="panel update" data-testid="update-panel">
      <header className="update__header">
        <h2>更新 pi</h2>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="update-close"
          onClick={onClose}
        >
          关闭
        </button>
      </header>

      <p className="update__warning">
        点「更新 pi」会真正执行 <code>pi update</code>，修改本机安装的 pi —— 不只是检查。
        更新期间不能新建或恢复会话；装完通常要重启本应用才生效。
      </p>

      <dl className="update__facts">
        <div className="update__fact">
          <dt className="update__fact-label">当前版本</dt>
          <dd data-testid="update-current-version">{currentVersion}</dd>
        </div>
        <div className="update__fact">
          <dt className="update__fact-label">最新版本</dt>
          <dd data-testid="update-latest-version">{latestVersion}</dd>
        </div>
        <div className="update__fact">
          <dt className="update__fact-label">检测时间</dt>
          <dd data-testid="update-checked-at">{checkedAt}</dd>
        </div>
        <div className="update__fact">
          <dt className="update__fact-label">结论来源</dt>
          <dd data-testid="update-source">{source}</dd>
        </div>
        <div className="update__fact">
          <dt className="update__fact-label">状态</dt>
          <dd data-testid="update-state">{state}</dd>
        </div>
      </dl>

      <div className="update__actions">
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="update-check-button"
          disabled={checking}
          onClick={() => {
            void runCheck()
          }}
        >
          {checking ? '检查中…' : '检查更新'}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          data-testid="update-apply-button"
          disabled={applying}
          onClick={handleApplyClick}
        >
          {applying ? '更新中…' : '更新 pi'}
        </button>
        {applying ? (
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="update-cancel-button"
            disabled={canceling}
            onClick={handleCancelClick}
          >
            {canceling ? '正在停止…' : '取消更新'}
          </button>
        ) : null}
        <label className="update__force field">
          <input
            type="checkbox"
            data-testid="update-force"
            checked={force}
            onChange={(event) => {
              const next = event.target.checked
              setForce(next)
              // 取消勾选时收起已展开的确认区，避免「确认了但没勾」的歧义
              if (!next) setForceConfirm(false)
            }}
          />
          <span>强制重装（已是最新也重装）</span>
        </label>
      </div>

      {forceConfirm ? (
        <div
          className="update__confirm"
          data-testid="update-force-confirm"
          role="group"
          aria-label="确认强制重装"
        >
          <p className="settings__note">
            强制重装会重新下载并安装最新版，即使当前已是最新；安装期间本机 pi 会被替换，
            正在运行的会话将被中断。确定继续？
          </p>
          <div className="update__confirm-actions">
            <button
              type="button"
              className="btn btn--danger"
              data-testid="update-force-confirm-yes"
              disabled={applying}
              onClick={() => {
                void runApply({ force: true })
              }}
            >
              确认强制重装
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="update-force-confirm-no"
              onClick={() => {
                setForceConfirm(false)
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {showsDisposeEntry ? (
        <div className="update__dispose">
          <p className="settings__note">
            还有会话在运行，更新会替换正在使用的 pi。先结束全部会话再更新。
          </p>
          <button
            type="button"
            className="btn"
            data-testid="update-dispose-and-apply"
            disabled={applying}
            onClick={() => {
              // disposeSessions：由主进程先结束现有会话，再执行更新
              void runApply({ disposeSessions: true, ...(force ? { force: true } : {}) })
            }}
          >
            结束所有会话并更新
          </button>
        </div>
      ) : null}

      {check === undefined || check.note === undefined ? null : (
        <p className="settings__note" data-testid="update-note">
          {check.note}
        </p>
      )}

      {error === undefined ? null : (
        <p className="field__error" data-testid="update-error">
          [{errorCode ?? 'INTERNAL'}] {error}
          {busySessions === undefined ? null : (
            <span className="update__sessions">（会话：{busySessions}）</span>
          )}
        </p>
      )}

      {showsManualCommand ? (
        <div className="update__manual">
          <p className="settings__note">当前安装不支持自动更新，请手动在终端执行：</p>
          <code data-testid="update-manual-command">{manualCommand}</code>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            data-testid="update-copy-command"
            onClick={() => {
              void copyManualCommand()
            }}
          >
            复制命令
          </button>
          {copyState === undefined ? null : <span className="update__copy-state">{copyState}</span>}
        </div>
      ) : null}

      {applyResult === undefined ? null : (
        <p
          className={applyResult.outcome === 'failed' ? 'field__error' : 'settings__note'}
          data-testid="update-result"
        >
          {applyResult.message}
        </p>
      )}

      <pre className="update__log" data-testid="update-log">
        {logLines.join('\n')}
      </pre>
    </div>
  )
}
