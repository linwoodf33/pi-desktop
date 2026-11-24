import { useEffect, useState } from 'react'

import type { ForkPoint } from '../../shared/contracts/types'
import { Artifacts } from '../features/artifacts/Artifacts'
import { ApprovalHost } from '../features/chat/ApprovalHost'
import { Conversation } from '../features/chat/Conversation'
import { ModelManager } from '../features/models/ModelManager'
import { SettingsPanel } from '../features/settings/SettingsPanel'
import { NewTaskDialog } from '../features/tasks/NewTaskDialog'
import { TaskList } from '../features/tasks/TaskList'
import {
  abortRun,
  pickWorkspaceFile,
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
  const aborting = useRunStore((state) => state.aborting)
  const aborted = useRunStore((state) => state.aborted)
  const switching = useRunStore((state) => state.switching)
  const forking = useRunStore((state) => state.forking)
  const locating = useRunStore((state) => state.locating)

  const artifactsCollapsed = useArtifactStore((state) => state.collapsed)

  const [dialogOpen, setDialogOpen] = useState(false)
  // A14：模型管理弹层（改 pi 的 models.json / 默认模型）
  const [modelsOpen, setModelsOpen] = useState(false)

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
        <span className="app__bar-note">本地工作台 · MVP</span>
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
        <BridgeIndicator />
      </header>

      <ErrorBanner />

      {/* M5：工具审批弹窗（只有当前任务有未决请求时才渲染） */}
      <ApprovalHost taskId={selectedId} />

      <main className={artifactsCollapsed ? 'layout layout--artifacts-collapsed' : 'layout'}>
        <TaskList
          onRename={renameTask}
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
          onPickFile={pickWorkspaceFile}
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

      {modelsOpen ? (
        <ModelManager
          onClose={() => {
            setModelsOpen(false)
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
