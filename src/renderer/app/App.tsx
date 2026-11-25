import { useEffect, useState } from 'react'

import type { PiUpdateCheckResult } from '../../shared/contracts/update'
import type { ForkPoint } from '../../shared/contracts/types'
import { Artifacts } from '../features/artifacts/Artifacts'
import { ApprovalHost } from '../features/chat/ApprovalHost'
import { Conversation } from '../features/chat/Conversation'
import { DiagnosticsPanel } from '../features/diagnostics/DiagnosticsPanel'
import { SkillsPanel } from '../features/skills/SkillsPanel'
import { PackagesPanel } from '../features/plugins/PackagesPanel'
import { ModelManager } from '../features/models/ModelManager'
import { SettingsPanel } from '../features/settings/SettingsPanel'
import { UpdatePanel } from '../features/update/UpdatePanel'
import { NewTaskDialog } from '../features/tasks/NewTaskDialog'
import { TaskList } from '../features/tasks/TaskList'
import {
  abortRun,
  endTask,
  renameTask,
  continueConversation,
  forkTask,
  loadForkPoints,
  loadModels,
  loadTasks,
  locatePi,
  selectTask,
  sendMessage,
  switchModel
} from '../lib/actions'
import { getApi, subscribeEvents } from '../lib/client'
import { initialChatState } from '../lib/reducer'
import { useAppliedTheme } from '../lib/theme'
import { useAppStore } from '../stores/appStore'
import { useArtifactStore } from '../stores/artifactStore'
import { useRunStore } from '../stores/runStore'
import { useSessionStore } from '../stores/sessionStore'
import { ErrorBanner } from './ErrorBanner'

/**
 * A34：挂载后延迟自动检测的毫秒数。等待 8s 是为了避开启动自检（定位 pi + 握手）
 * 的 IO 高峰，让首屏先把桥接徽标和任务列出来，再去问更新源。
 */
const AUTO_UPDATE_CHECK_DELAY = 8000

/**
 * 应用外壳（§4.1 / §5.5）：三栏布局 + 事件接线（§6.1 启动流程）。
 *
 * 职责边界：
 * - 这里**只做接线与布局**：事件订阅 → store（`lib/client.ts`），操作 → `lib/actions.ts`；
 * - 所有业务状态在 zustand store 与 `lib/reducer.ts` 纯函数里，组件不拼接状态；
 * - IPC 不可用、主进程异常、未捕获渲染异常都不会白屏（E6）。
 *
 * M4：新建任务走弹层（目录/模型/档位/会话名）；设置页可编辑并持久化。
 */
export function App() {
  const bridge = useAppStore((state) => state.bridge)
  const probeBridge = useAppStore((state) => state.probeBridge)
  const config = useAppStore((state) => state.config)

  // 主题在 config 到达后立即生效（首帧用样式表里的默认暗色兜底）
  useAppliedTheme(config?.theme)

  /**
   * A20：窗口级拖放兜底。
   *
   * Electron（Chromium）默认会在文件被拖到窗口任意位置时**导航到该文件**，
   * 那是「拖错位置就白屏」的经典事故。输入框自己处理图片拖放（preventDefault），
   * 这里兜住其余区域：只阻止默认行为，不做任何处理。
   */
  useEffect(() => {
    const prevent = (event: DragEvent): void => {
      if (event.dataTransfer === null) return
      const hasFiles = Array.from(event.dataTransfer.types).includes('Files')
      if (!hasFiles) return
      event.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const tasks = useSessionStore((state) => state.tasks)
  const loaded = useSessionStore((state) => state.loaded)
  const selectedId = useSessionStore((state) => state.selectedId)
  const chats = useSessionStore((state) => state.chats)
  const truncated = useSessionStore((state) => state.truncated)
  const stats = useSessionStore((state) => state.stats)
  const models = useSessionStore((state) => state.models)

  const phases = useRunStore((state) => state.phases)
  /** A36：结束会话在途（`session:dispose` 未返回） */
  const ending = useRunStore((state) => state.ending)
  const aborting = useRunStore((state) => state.aborting)
  const aborted = useRunStore((state) => state.aborted)
  const switching = useRunStore((state) => state.switching)
  const forking = useRunStore((state) => state.forking)
  const locating = useRunStore((state) => state.locating)

  const artifactsCollapsed = useArtifactStore((state) => state.collapsed)

  const [dialogOpen, setDialogOpen] = useState(false)
  // A14：模型管理弹层（改 pi 的 models.json / 默认模型）
  const [modelsOpen, setModelsOpen] = useState(false)
  /** A25：诊断面板 */
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  /** A31：技能面板 */
  const [skillsOpen, setSkillsOpen] = useState(false)
  /** A37：插件面板 */
  const [pluginsOpen, setPluginsOpen] = useState(false)
  /** A34：pi 更新面板 */
  const [updateOpen, setUpdateOpen] = useState(false)
  /** 后台/手动检测到的结论：只用来给顶栏按钮做「有新版」提示 */
  const [updateCheck, setUpdateCheck] = useState<PiUpdateCheckResult>()
  /** 是否正在执行 `pi update`（面板关闭时顶栏也要能显示「更新中…」） */
  const [updateRunning, setUpdateRunning] = useState(false)

  useEffect(() => {
    const api = getApi()
    if (api === undefined) {
      useSessionStore.getState().setLoaded(true)
      return
    }
    // 订阅一次，卸载时撤销（StrictMode 下会订阅/退订一次，不会重复归约）
    const unsubscribe = subscribeEvents(api)
    void probeBridge()
    void loadTasks({ api }).finally(() => {
      useSessionStore.getState().setLoaded(true)
    })
    return unsubscribe
  }, [probeBridge])

  /**
   * A34：挂载后延迟自动探一次版本（只读，不安装）。
   *
   * 依赖数组为空是刻意的：只在应用挂载后跑一次，**不随任务切换、面板开关重复探测** ——
   * 更新源是外网接口，重复请求既慢又可能被限流。
   * 检测失败、`state: 'unknown'` 一律静默：自动检测属于后台行为，不该给用户弹红条；
   * 想看到失败原因可到面板里手动点「检查更新」。
   */
  useEffect(() => {
    // 卸载后不得 setState（主进程响应回来时组件可能已经没了）
    let cancelled = false
    const timer = setTimeout(() => {
      const api = getApi()
      if (api === undefined) return
      void api.pi
        .updateCheck()
        .then((result) => {
          if (cancelled || !result.ok) return
          // unknown = 查不到（离线/超时）：不落状态，按钮保持「更新」
          if (result.data.state === 'unknown') return
          setUpdateCheck(result.data)
        })
        .catch(() => undefined)
    }, AUTO_UPDATE_CHECK_DELAY)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  /**
   * A34：在 App 级跟踪「更新中」。
   *
   * 面板自己订阅日志流，但面板关掉后事件仍在跑，顶栏按钮需要独立来源 —— 所以这里
   * 再订阅一次同一条事件通道。依赖数组为空：处理器只用 setState（不读闭包旧值），
   * 无需随依赖变化重订阅。
   */
  useEffect(() => {
    const api = getApi()
    if (api === undefined) return undefined
    return api.events.onPiUpdate((event) => {
      if (event.phase === 'started') {
        setUpdateRunning(true)
        return
      }
      if (event.phase === 'done' || event.phase === 'failed' || event.phase === 'canceled') {
        setUpdateRunning(false)
      }
    })
  }, [])

  const task = selectedId === undefined ? undefined : tasks.find((item) => item.id === selectedId)
  const chat = selectedId === undefined ? initialChatState : (chats[selectedId] ?? initialChatState)
  const phase = selectedId === undefined ? 'idle' : (phases[selectedId] ?? 'idle')
  const piStatus = bridge.phase === 'ok' ? bridge.boot.piStatus : undefined
  const piReady = piStatus?.state === 'ok'

  const openDialog = (): void => {
    setDialogOpen(true)
    // 模型列表按需拉取（pi 未就绪时返回空数组，弹层会提示使用 pi 默认模型）
    void loadModels()
  }

  return (
    <div className="app">
      <header className="app__bar">
        <span className="app__brand">pi-desktop</span>
        <button
          type="button"
          className="btn btn--ghost app__bar-action"
          data-testid="open-diagnostics"
          onClick={() => {
            setDiagnosticsOpen(true)
          }}
        >
          诊断
        </button>
        <span className="app__bar-note">
          本地工作台 · v{bridge.phase === 'ok' ? bridge.boot.appVersion : '…'}
        </span>
        <button
          type="button"
          className="btn btn--ghost app__bar-action"
          data-testid="open-skills"
          onClick={() => {
            setSkillsOpen(true)
          }}
        >
          技能
        </button>
        <button
          type="button"
          className="btn btn--ghost app__bar-action"
          data-testid="open-plugins"
          onClick={() => {
            setPluginsOpen(true)
          }}
        >
          插件
        </button>
        <button
          type="button"
          className="btn btn--ghost app__bar-action"
          data-testid="open-models-manager"
          onClick={() => {
            setModelsOpen(true)
          }}
        >
          模型
        </button>
        <button
          type="button"
          className="btn btn--ghost app__bar-action"
          data-testid="open-update"
          onClick={() => {
            setUpdateOpen(true)
          }}
        >
          {updateRunning ? '更新中…' : updateCheck?.state === 'available' ? '有新版' : '更新'}
          {updateCheck?.state === 'available' ? (
            <span className="app__bar-dot" data-testid="update-dot" />
          ) : null}
        </button>
        <BridgeIndicator />
      </header>

      <ErrorBanner />

      {/* M5：工具审批弹窗（只有当前任务有未决请求时才渲染） */}
      <ApprovalHost taskId={selectedId} />

      <main className={artifactsCollapsed ? 'layout layout--artifacts-collapsed' : 'layout'}>
        <TaskList
          onRename={renameTask}
          onEndTask={(taskId) => {
            void endTask(taskId)
          }}
          ending={ending}
          phases={phases}
          tasks={tasks}
          selectedId={selectedId}
          loading={!loaded}
          onSelect={(taskId) => {
            void selectTask(taskId)
          }}
          onNewTask={openDialog}
        />

        <Conversation
          task={task}
          chat={chat}
          phase={phase}
          aborting={selectedId !== undefined && aborting[selectedId] === true}
          aborted={selectedId !== undefined && aborted[selectedId] === true}
          historyTruncated={selectedId !== undefined && truncated[selectedId] === true}
          piReady={piReady}
          locating={locating}
          models={models}
          stats={selectedId === undefined ? undefined : stats[selectedId]}
          switching={selectedId !== undefined && switching[selectedId] === true}
          forking={selectedId !== undefined && forking[selectedId] === true}
          onSend={(text, images) => {
            void sendMessage(text, { images })
          }}
          onAbort={() => {
            void abortRun()
          }}
          {...(task === undefined
            ? {}
            : {
                referenceTarget: {
                  ...(task.sessionKey === undefined ? {} : { sessionKey: task.sessionKey }),
                  ...(task.filePath === undefined ? {} : { sessionFile: task.filePath })
                }
              })}
          onNewTask={openDialog}
          onLocate={() => {
            useRunStore.getState().setLocating(true)
            void locatePi({})
              .catch(() => undefined)
              .finally(() => {
                useRunStore.getState().setLocating(false)
              })
          }}
          onContinue={() => {
            void continueConversation()
          }}
          onLoadForkPoints={async (): Promise<ForkPoint[]> => loadForkPoints()}
          onFork={(entryId) => {
            void forkTask(entryId)
          }}
          onSwitchModel={(input) => {
            void switchModel(input)
          }}
        />

        <Artifacts />
      </main>

      <footer className="app__footer">
        {config === undefined ? null : (
          <details className="settings-toggle">
            <summary>设置</summary>
            <SettingsPanel config={config} piStatus={piStatus} />
          </details>
        )}
      </footer>

      {skillsOpen ? (
        <SkillsPanel
          {...(task?.cwd === undefined || task.cwd.length === 0 ? {} : { cwd: task.cwd })}
          {...(task === undefined
            ? {}
            : {
                target: {
                  ...(task.sessionKey === undefined ? {} : { sessionKey: task.sessionKey }),
                  ...(task.filePath === undefined ? {} : { sessionFile: task.filePath })
                }
              })}
          onClose={() => {
            setSkillsOpen(false)
          }}
        />
      ) : null}

      {pluginsOpen ? (
        <PackagesPanel
          {...(task === undefined
            ? {}
            : {
                target: {
                  ...(task.sessionKey === undefined ? {} : { sessionKey: task.sessionKey }),
                  ...(task.filePath === undefined ? {} : { sessionFile: task.filePath })
                }
              })}
          onClose={() => {
            setPluginsOpen(false)
          }}
        />
      ) : null}

      {diagnosticsOpen ? (
        <DiagnosticsPanel
          onClose={() => {
            setDiagnosticsOpen(false)
          }}
        />
      ) : null}

      {modelsOpen ? (
        <ModelManager
          onClose={() => {
            setModelsOpen(false)
          }}
        />
      ) : null}

      {updateOpen ? (
        <UpdatePanel
          onClose={() => {
            setUpdateOpen(false)
          }}
          // 更新会替换本机 pi（版本/路径可能变了）：重跑自检刷新徽标与诊断信息
          onApplied={() => {
            void probeBridge()
          }}
        />
      ) : null}

      {dialogOpen ? (
        // 只把**选中任务**的工作区带进弹层；目录对话框的默认位置由主进程兜底（用户主目录）
        <NewTaskDialog
          {...(task?.cwd === undefined || task.cwd.length === 0 ? {} : { defaultCwd: task.cwd })}
          onCancel={() => {
            setDialogOpen(false)
          }}
          onCreated={(taskId) => {
            setDialogOpen(false)
            void selectTask(taskId)
          }}
          pickDirectory={async (defaultPath) => {
            const api = getApi()
            if (api === undefined) return undefined
            const picked = await api.fs.pickDirectory(
              defaultPath === undefined ? {} : { defaultPath }
            )
            // 用户取消（CANCELLED）不是错误：保持弹层打开即可
            return picked.ok ? picked.data.path : undefined
          }}
        />
      ) : null}
    </div>
  )
}

/** 桥接状态徽标：失败时给出错误码，不白屏（E6） */
function BridgeIndicator() {
  const bridge = useAppStore((state) => state.bridge)

  if (bridge.phase === 'probing' || bridge.phase === 'idle') {
    return <span className="badge badge--pending">正在检测 IPC 桥接…</span>
  }

  if (bridge.phase === 'ok') {
    return (
      <span className="badge badge--ok" data-testid="bridge-status">
        IPC 正常 · pi {bridge.boot.piStatus.state} · {bridge.sessionCount} 个历史会话
      </span>
    )
  }

  return (
    <span className="badge badge--error" data-testid="bridge-status">
      IPC 桥接失败 [{bridge.code}] {bridge.message}
    </span>
  )
}
