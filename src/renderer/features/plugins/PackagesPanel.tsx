import { useCallback, useEffect, useState } from 'react'

import type {
  PkgCatalogView,
  PkgInstallResult,
  PkgPreview,
  PkgSummary
} from '../../../shared/contracts/packages'
import { getApi } from '../../lib/client'

/**
 * 插件（pi package）面板（A37）。
 *
 * 「插件」= pi package：`pi install <source>` 装的东西，登记在 `<agentDir>/settings.json`
 * 的 `packages` 数组里，装好后可能提供 extensions / skills / prompts / themes 四类资源。
 *
 * 本面板只做两件事：**只读呈现清单** + **触发一次安装**。
 * - 清单来自「settings.json 的登记 + 受管目录里的 package.json」，它是「装了什么」的事实，
 *   不代表当前会话已加载成功（加载失败只出现在 pi 启动日志里）。
 * - 资源过滤（`+`/`-`/`!` 前缀、`autoload:false`、项目 override）只做只读呈现，
 *   误写会静默改变加载集合，因此这里不提供任何写入入口。
 */

/** 日志最多保留的行数（npm 输出可能上千行，只留尾部） */
const MAX_LOG_LINES = 400

/** 终态事件缺 `message` 时的兜底摘要 */
const TERMINAL_TEXT: Record<'done' | 'failed' | 'canceled', string> = {
  done: '安装结束',
  failed: '安装失败',
  canceled: '安装已取消'
}

/** 会话引用：用于确定项目级 `.pi/settings.json` 的工作区 */
interface SessionRef {
  sessionKey?: string
  sessionFile?: string
}

export interface PackagesPanelProps {
  /** 会话引用（决定项目级清单）；没有任务时只看全局 */
  target?: SessionRef
  onClose: () => void
}

/** 只用有值的字段构造入参（exactOptionalPropertyTypes：不显式传 undefined） */
function sessionRefInput(key: string | undefined, file: string | undefined): SessionRef {
  return {
    ...(key === undefined ? {} : { sessionKey: key }),
    ...(file === undefined ? {} : { sessionFile: file })
  }
}

/** 「名称 · 版本」，缺版本时只显示名称 */
function nameLine(pkg: PkgSummary): string {
  return pkg.version === undefined ? pkg.name : `${pkg.name} · ${pkg.version}`
}

/** 追加一行并裁剪到上限（丢头部只留尾部） */
function pushLog(prev: string[], line: string): string[] {
  const next = [...prev, line]
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next
}

export function PackagesPanel({ target, onClose }: PackagesPanelProps): React.JSX.Element {
  const sessionKey = target?.sessionKey
  const sessionFile = target?.sessionFile

  /** 清单（undefined = 还没读到） */
  const [catalog, setCatalog] = useState<PkgCatalogView | undefined>(undefined)
  /** 面板级错误：IPC 失败 / 清单读不出来 */
  const [panelError, setPanelError] = useState<string | undefined>(undefined)

  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<PkgPreview | undefined>(undefined)
  const [previewing, setPreviewing] = useState(false)
  /** 安装前的内联二次确认区是否展开 */
  const [confirming, setConfirming] = useState(false)
  const [installing, setInstalling] = useState(false)
  /** 已发出取消请求、正在等终态：只驱动按钮禁用与文案 */
  const [canceling, setCanceling] = useState(false)
  const [installedText, setInstalledText] = useState<string | undefined>(undefined)
  const [installError, setInstallError] = useState<string | undefined>(undefined)
  const [manualCommand, setManualCommand] = useState<string | undefined>(undefined)
  const [copyState, setCopyState] = useState<string | undefined>(undefined)
  const [logLines, setLogLines] = useState<string[]>([])

  /** 读清单并返回结果（安装后需要读回来的条目来拼「已安装 …」） */
  const loadCatalog = useCallback(async (): Promise<PkgCatalogView | undefined> => {
    const api = getApi()
    if (api === undefined) {
      // 先让出一个微任务：这个分支是**同步** setState，而 loadCatalog 会在 effect 体内
      // 被直接调用，同步 setState 会被 react-hooks/set-state-in-effect 判为级联渲染风险。
      await Promise.resolve()
      setPanelError('IPC 不可用（preload 未注入）')
      return undefined
    }
    const result = await api.pkg.list(sessionRefInput(sessionKey, sessionFile))
    if (!result.ok) {
      setPanelError(result.error.message)
      return undefined
    }
    setCatalog(result.data)
    setPanelError(undefined)
    return result.data
  }, [sessionKey, sessionFile])

  // 首屏 / 任务切换时读一次清单；loadCatalog 已用 useCallback 收敛依赖
  useEffect(() => {
    // 包一层 async：与 SkillsPanel 一致 —— 不在 effect 体内同步 setState，
    // 且 `react-hooks/set-state-in-effect` 只认可「await 之后的 setState」。
    const load = async (): Promise<void> => {
      await loadCatalog()
    }
    void load()
  }, [loadCatalog])

  // 安装事件：日志流 + 终态收敛 loading。依赖数组为空 —— 处理器只用函数式 setState，
  // 不读闭包旧值，因此无需随依赖变化重订阅（与 UpdatePanel 同构）。
  useEffect(() => {
    const api = getApi()
    if (api === undefined) return undefined

    const off = api.events.onPkgInstall((event) => {
      // 终态放前面：这样 `event.phase` 在这里被收窄成 done|failed|canceled，
      // 能直接索引 TERMINAL_TEXT（反过来先判 started/log 时 TS 不会保留收窄）
      if (event.phase === 'done' || event.phase === 'failed' || event.phase === 'canceled') {
        // 先取出摘要再进 setState 回调：收窄不会跨进嵌套函数，直接写
        // `TERMINAL_TEXT[event.phase]` 在回调里会被 TS 判成「可能是 started/log」。
        const summary = event.message ?? TERMINAL_TEXT[event.phase]
        setLogLines((prev) => pushLog(prev, summary))
        setInstalling(false)
        setCanceling(false)
        return
      }
      // 流式阶段：优先用剥过 ANSI 的 `line`，没有则退回 `message`
      const text = event.line ?? event.message
      if (text !== undefined && text.length > 0) {
        setLogLines((prev) => pushLog(prev, text))
      }
    })

    return () => {
      off()
    }
  }, [])

  /**
   * 预览：只读 registry 元数据。
   *
   * 为什么预览失败**不阻断**安装：预览依赖外网访问 npm registry，而 `pi install` 自己
   * 完全可能在网络正常时成功（git 源、私有 registry、离线镜像都不走这条路径）。
   * 把预览当成安装的前置条件，会让「本来能装」的源被一个只读提示挡住；因此预览失败只
   * 内联说明原因，安装按钮照常可用。
   */
  const runPreview = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined) {
      setPanelError('IPC 不可用（preload 未注入）')
      return
    }
    const trimmed = source.trim()
    if (trimmed.length === 0) return
    setPreviewing(true)
    setPreview(undefined)
    setPanelError(undefined)
    const result = await api.pkg.preview({ source: trimmed })
    setPreviewing(false)
    if (result.ok) {
      setPreview(result.data)
      return
    }
    setPanelError(result.error.message)
  }

  /**
   * 真正执行安装。
   *
   * 为什么必须先过内联二次确认（而不是点「安装」就装）：`pi install` 会从 npm/git 拉取
   * 第三方代码，npm 包还可能执行 postinstall 脚本 —— 那是**在当前用户权限下运行任意命令**。
   * 这是不可撤销的副作用，所以按钮只负责展开确认区，由用户显式点「确认安装」再执行。
   * 不用 `window.confirm`：在 Electron / file:// 下会阻塞渲染进程，也无法在测试里断言。
   */
  const runInstall = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined) {
      setPanelError('IPC 不可用（preload 未注入）')
      return
    }
    const trimmed = source.trim()
    if (trimmed.length === 0) return

    setConfirming(false)
    setInstalling(true)
    setCanceling(false)
    setInstalledText(undefined)
    setInstallError(undefined)
    setManualCommand(undefined)
    setCopyState(undefined)
    setLogLines([])

    const result = await api.pkg.install({ source: trimmed })
    setInstalling(false)
    setCanceling(false)

    if (!result.ok) {
      // accepted:false 的 gate 拒绝（如 PKG_INSTALL_BUSY）才会走这里
      setInstallError(result.error.message)
      await loadCatalog()
      return
    }

    const data: PkgInstallResult = result.data
    // 结果自带输出尾部：可能含事件流里没送达的行，补进日志便于判断 postinstall 干了什么
    if (data.logTail !== undefined && data.logTail.length > 0) {
      setLogLines((prev) => pushLog(prev, data.logTail ?? ''))
    }
    // 成功或失败都刷新清单：成败以 settings.json 的登记事实为准，不听 exit code
    const refreshed = await loadCatalog()

    if (data.outcome === 'installed') {
      const added = refreshed?.packages.find((pkg) => pkg.source === data.source)
      const label =
        added === undefined
          ? data.version === undefined
            ? data.source
            : `${data.source} ${data.version}`
          : nameLine(added)
      setInstalledText(`已安装 ${label}`)
      return
    }

    setInstallError(data.message)
    if (data.manualCommand !== undefined) setManualCommand(data.manualCommand)
  }

  /** 取消安装：只负责「发请求 + 进入 stopping 态」，结论以终态事件为准 */
  const handleCancelClick = (): void => {
    const api = getApi()
    if (api === undefined) {
      setPanelError('IPC 不可用（preload 未注入）')
      return
    }
    setCanceling(true)
    void api.pkg.installCancel().then((result) => {
      if (result.ok) return
      // 取消请求本身失败（如任务刚好已结束）：撤掉 stopping 态并说明原因
      setCanceling(false)
      setInstallError(result.error.message)
    })
  }

  const copyManualCommand = async (): Promise<void> => {
    const api = getApi()
    if (api === undefined || manualCommand === undefined) return
    const result = await api.app.copyText({ text: manualCommand })
    setCopyState(result.ok ? '已复制' : `复制失败：${result.error.message}`)
  }

  const packages = catalog?.packages ?? []
  const globalItems = packages.filter((pkg) => pkg.scope === 'global')
  const projectItems = packages.filter((pkg) => pkg.scope === 'project')
  /** 清单级错误：IPC 失败优先，其次 settings.json 读不出来（降级为空清单，仍可安装） */
  const errorText = panelError ?? catalog?.globalSettingsError
  const canSubmit = !installing && source.trim().length > 0

  const renderGroup = (title: string, suffix: 'global' | 'project', items: PkgSummary[]) => {
    // 项目组无条目时不渲染（多数会话没有项目级 settings.json）
    if (items.length === 0) return null
    return (
      <section className="plugins__group" data-testid={`plugins-group-${suffix}`}>
        <h3>
          {title}（{items.length}）
        </h3>
        <ul>
          {items.map((pkg) => (
            <li
              key={`${pkg.scope}-${pkg.source}`}
              className="plugins__item"
              data-testid="plugin-item"
            >
              <div className="plugins__meta">
                <strong data-testid="plugin-name">{nameLine(pkg)}</strong>
                {pkg.filtered ? (
                  <span className="plugins__badge" data-testid="plugin-badge-filtered">
                    已被资源过滤
                  </span>
                ) : null}
                {pkg.installedPath === undefined ? (
                  <span className="plugins__badge" data-testid="plugin-badge-missing">
                    未找到安装目录
                  </span>
                ) : null}
              </div>
              {pkg.description === undefined ? null : (
                <p className="settings__note" data-testid="plugin-desc">
                  {pkg.description}
                </p>
              )}
              <p className="settings__note">
                source：<code data-testid="plugin-source">{pkg.source}</code>
              </p>
              {pkg.installedPath === undefined ? null : (
                <p className="settings__note">
                  位置：<code data-testid="plugin-path">{pkg.installedPath}</code>
                </p>
              )}
              {pkg.manifestError === undefined ? null : (
                <p className="settings__note">package.json：{pkg.manifestError}</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <div className="panel plugins" data-testid="plugins-panel">
      <header>
        <h2>插件（pi package）{catalog === undefined ? '' : `（${packages.length}）`}</h2>
        <button
          type="button"
          className="btn btn--ghost"
          data-testid="plugins-close"
          onClick={onClose}
        >
          关闭
        </button>
      </header>

      <p className="settings__note">
        插件就是 pi package：登记在 <code>&lt;agentDir&gt;/settings.json</code> 的{' '}
        <code>packages</code> 里，装好后可能带 extensions / skills / prompts / themes。
        <strong>清单只代表「登记了什么」，不代表本会话已加载成功</strong>
        —— 加载失败只出现在 pi 启动日志里。
      </p>

      <div className="plugins__actions">
        <button
          type="button"
          className="btn btn--ghost btn--small"
          data-testid="plugins-refresh"
          onClick={() => {
            void loadCatalog()
          }}
        >
          刷新
        </button>
      </div>

      {errorText === undefined ? null : (
        <p className="field__error" data-testid="plugins-error">
          {errorText}
        </p>
      )}

      {catalog === undefined ? (
        errorText === undefined ? (
          <p className="settings__note" data-testid="plugins-loading">
            读取中…
          </p>
        ) : null
      ) : packages.length === 0 ? (
        <p className="settings__note" data-testid="plugins-empty">
          未登记任何插件。可以安装一个试试：
          <code>pi install npm:pi-web-access</code>
        </p>
      ) : (
        <>
          {renderGroup('全局', 'global', globalItems)}
          {renderGroup('项目', 'project', projectItems)}
        </>
      )}

      <section className="plugins__group" data-testid="plugins-install-form">
        <h3>安装插件</h3>
        <div className="plugins__actions">
          <input
            className="field__input"
            data-testid="plugins-source"
            placeholder="npm:pi-web-access"
            value={source}
            onChange={(event) => {
              const next = event.target.value
              setSource(next)
              // 源变了，旧预览与已展开的确认都不再对应当前输入，清掉避免装错东西
              setPreview(undefined)
              setConfirming(false)
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="plugins-preview-button"
            disabled={previewing || !canSubmit}
            onClick={() => {
              void runPreview()
            }}
          >
            {previewing ? '预览中…' : '预览'}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="plugins-install-button"
            disabled={!canSubmit}
            onClick={() => {
              // 不直接安装：先展开内联确认（见 runInstall 注释）
              setConfirming(true)
            }}
          >
            {installing ? '安装中…' : '安装'}
          </button>
          {installing ? (
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="plugins-install-cancel"
              disabled={canceling}
              onClick={handleCancelClick}
            >
              {canceling ? '正在停止…' : '取消安装'}
            </button>
          ) : null}
        </div>

        {preview === undefined ? null : preview.origin === 'npm-registry' ? (
          <div className="plugins__item" data-testid="plugins-preview">
            <div className="plugins__meta">
              <strong data-testid="plugins-preview-name">{preview.name ?? preview.source}</strong>
              {preview.version === undefined ? null : (
                <span data-testid="plugins-preview-version">{preview.version}</span>
              )}
            </div>
            {preview.description === undefined ? null : (
              <p className="settings__note" data-testid="plugins-preview-desc">
                {preview.description}
              </p>
            )}
          </div>
        ) : (
          <p className="settings__note" data-testid="plugins-preview-note">
            预览失败：{preview.error ?? '无法从 registry 读到该源的信息'}。
            这不影响安装，可直接点「安装」。
          </p>
        )}

        {confirming ? (
          <div
            className="plugins__group"
            data-testid="plugins-install-confirm"
            role="group"
            aria-label="确认安装插件"
          >
            <p className="settings__note">
              即将安装的是<strong>第三方</strong>代码：<code>{source.trim()}</code>。 安装会从 npm /
              git 拉取该包，npm 包可能执行 postinstall 脚本（可在本机
              运行任意命令），且安装后需要重启本应用才会加载。确定继续？
            </p>
            <div className="plugins__actions">
              <button
                type="button"
                className="btn btn--danger"
                data-testid="plugins-install-confirm-yes"
                disabled={installing}
                onClick={() => {
                  void runInstall()
                }}
              >
                确认安装
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                data-testid="plugins-install-confirm-no"
                onClick={() => {
                  setConfirming(false)
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {installedText === undefined ? null : (
          <p className="settings__note" data-testid="plugins-install-result">
            {installedText}
          </p>
        )}

        {installError === undefined ? null : (
          <p className="field__error" data-testid="plugins-install-error">
            {installError}
          </p>
        )}

        {manualCommand === undefined ? null : (
          <div className="plugins__actions">
            <code>{manualCommand}</code>
            <button
              type="button"
              className="btn btn--ghost btn--small"
              data-testid="plugins-copy-command"
              onClick={() => {
                void copyManualCommand()
              }}
            >
              复制手动命令
            </button>
            {copyState === undefined ? null : <span className="settings__note">{copyState}</span>}
          </div>
        )}
      </section>

      <pre className="plugins__log" data-testid="plugins-install-log">
        {logLines.join('\n')}
      </pre>
    </div>
  )
}
