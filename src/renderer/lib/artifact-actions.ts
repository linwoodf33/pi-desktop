import type { ArtifactRefInput, PiApi } from '../../shared/contracts/api'
import type { IpcError } from '../../shared/contracts/result'

import { getApi } from './client'
import { artifactKey, useArtifactStore } from '../stores/artifactStore'
import { useRunStore } from '../stores/runStore'
import { useSessionStore, type TaskItem } from '../stores/sessionStore'

/**
 * 产物编排层（M6）：IPC 调用 → artifactStore。
 *
 * 触发时机严格受限（§6.1 产物流 / 任务要求「不要轮询」）：
 * 1. 会话 `agent_settled`（`lib/client.ts` 订阅到事件后调 {@link refreshArtifacts}）；
 * 2. 用户点「刷新」按钮（同一个入口）；
 * 3. 用户点某个产物（按需拉 diff / 预览，不预取）。
 *
 * 会话引用：活跃任务用 `sessionKey`，已回放的历史任务只有会话文件 → 用 `sessionFile`。
 * 两者都没有时直接给可操作提示，不发起注定失败的 IPC。
 */
export interface ArtifactActionDeps {
  api?: PiApi | undefined
}

function resolveApi(deps: ArtifactActionDeps): PiApi | undefined {
  return 'api' in deps ? deps.api : getApi()
}

function taskById(taskId: string): TaskItem | undefined {
  return useSessionStore.getState().tasks.find((item) => item.id === taskId)
}

/** 任务 → 产物通道的会话引用；无法确定工作区时返回 undefined */
export function artifactRefOf(task: TaskItem | undefined): ArtifactRefInput | undefined {
  if (task === undefined) return undefined
  if (task.sessionKey !== undefined) return { sessionKey: task.sessionKey }
  if (task.filePath !== undefined) return { sessionFile: task.filePath }
  return undefined
}

function reportError(error: IpcError): void {
  useRunStore.getState().pushBanner({
    level: 'error',
    message: `[${error.code}] ${error.message}`,
    ...(error.detail === undefined ? {} : { detail: error.detail })
  })
}

/** 扫描产物列表（会话 settled / 手动刷新） */
export async function refreshArtifacts(
  taskId: string,
  deps: ArtifactActionDeps = {}
): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const store = useArtifactStore.getState()
  const ref = artifactRefOf(taskById(taskId))
  if (ref === undefined) {
    store.setError(taskId, '该任务还没有工作目录（先发送一条消息创建/恢复会话）')
    return
  }

  store.setScanning(taskId, true)
  try {
    const result = await api.fs.listArtifacts(ref)
    if (!result.ok) {
      useArtifactStore.getState().setError(taskId, `[${result.error.code}] ${result.error.message}`)
      // 会话未运行 / 目录不可访问属于可解释状态，不进错误条；其余照旧报错
      if (result.error.code !== 'SESSION_NOT_FOUND' && result.error.code !== 'NOT_FOUND') {
        reportError(result.error)
      }
      return
    }
    useArtifactStore.getState().setList(taskId, result.data)
  } finally {
    useArtifactStore.getState().setScanning(taskId, false)
  }
}

/** 按需拉 unified diff（同一 taskId+path 已缓存则跳过） */
export async function loadArtifactDiff(
  taskId: string,
  path: string,
  deps: ArtifactActionDeps & { force?: boolean } = {}
): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const key = artifactKey(taskId, path)
  const store = useArtifactStore.getState()
  if (deps.force !== true && (store.diffs[key] !== undefined || store.loading[key] === true)) return
  const ref = artifactRefOf(taskById(taskId))
  if (ref === undefined) {
    store.setError(taskId, '该任务还没有工作目录（先发送一条消息创建/恢复会话）')
    return
  }

  useArtifactStore.getState().setLoading(key, true)
  try {
    const result = await api.fs.diff({ ...ref, path })
    if (!result.ok) {
      useArtifactStore.getState().setError(taskId, `[${result.error.code}] ${result.error.message}`)
      reportError(result.error)
      return
    }
    useArtifactStore.getState().setDiff(key, result.data)
  } finally {
    useArtifactStore.getState().setLoading(key, false)
  }
}

/** 按需拉文本预览（默认前 64KB；分页由 `offset` 驱动） */
export async function loadArtifactPreview(
  taskId: string,
  path: string,
  deps: ArtifactActionDeps & { offset?: number; force?: boolean } = {}
): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const key = artifactKey(taskId, path)
  const store = useArtifactStore.getState()
  if (deps.force !== true && (store.previews[key] !== undefined || store.loading[key] === true)) {
    return
  }
  const ref = artifactRefOf(taskById(taskId))
  if (ref === undefined) {
    store.setError(taskId, '该任务还没有工作目录（先发送一条消息创建/恢复会话）')
    return
  }

  useArtifactStore.getState().setLoading(key, true)
  try {
    const result = await api.fs.readText({
      ...ref,
      path,
      ...(deps.offset === undefined ? {} : { offset: deps.offset })
    })
    if (!result.ok) {
      useArtifactStore.getState().setError(taskId, `[${result.error.code}] ${result.error.message}`)
      reportError(result.error)
      return
    }
    useArtifactStore.getState().setPreview(key, result.data)
  } finally {
    useArtifactStore.getState().setLoading(key, false)
  }
}

/**
 * 用系统默认程序打开产物（`artifact:open` → `shell.openPath`）。
 *
 * 只应在用户**明确确认后**调用（UI 侧二次确认由 `Artifacts` 组件负责）；
 * 主进程侧仍会重做路径校验，renderer 的确认只是 UX，不是安全边界。
 */
export async function openArtifactWithSystem(
  taskId: string,
  path: string,
  deps: ArtifactActionDeps = {}
): Promise<boolean> {
  const api = resolveApi(deps)
  if (api === undefined) return false
  const ref = artifactRefOf(taskById(taskId))
  if (ref === undefined) {
    useArtifactStore
      .getState()
      .setError(taskId, '该任务还没有工作目录（先发送一条消息创建/恢复会话）')
    return false
  }
  const result = await api.artifact.open({ ...ref, path })
  if (!result.ok) {
    reportError(result.error)
    return false
  }
  useRunStore.getState().pushBanner({ level: 'info', message: `已用系统程序打开 ${path}` })
  return true
}
