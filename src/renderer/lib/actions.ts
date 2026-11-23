import type { PiApi } from '../../shared/contracts/api'
import type { IpcError } from '../../shared/contracts/result'
import type { ConfigUpdateInput } from '../../shared/contracts/schemas'
import type {
  AppConfigView,
  ForkPoint,
  ModelInfo,
  PiSelfCheckStatus
} from '../../shared/contracts/types'

import { getApi } from './client'
import { useAppStore } from '../stores/appStore'
import { useRunStore } from '../stores/runStore'
import { useSessionStore, liveTaskId, type TaskItem } from '../stores/sessionStore'

/**
 * renderer 侧编排层（IPC 调用 → store 更新）。
 *
 * 为什么单独一层：组件只负责渲染与交互，编排逻辑（新建任务、选中回放、发送、停止）
 * 需要可注入的 `api` 以便单测（tests/unit/renderer-actions.test.ts），
 * 也让「事件归约」与「命令发送」的边界保持清晰（§6.2 单轮对话）。
 */
export interface ActionDeps {
  api?: PiApi | undefined
}

function resolveApi(deps: ActionDeps): PiApi | undefined {
  return 'api' in deps ? deps.api : getApi()
}

function selectedTask(): TaskItem | undefined {
  const state = useSessionStore.getState()
  if (state.selectedId === undefined) return undefined
  return state.tasks.find((task) => task.id === state.selectedId)
}

function reportError(error: IpcError): void {
  // 用户主动取消（目录对话框）不是错误
  if (error.code === 'CANCELLED') return
  useRunStore.getState().pushBanner({
    level: 'error',
    message: `[${error.code}] ${error.message}`,
    ...(error.detail === undefined ? {} : { detail: error.detail })
  })
}

/** 标题取首条用户消息的首行（与 SessionIndex 的标题推导保持一致） */
export function titleFromMessage(text: string, maxLength = 60): string {
  const line = (text.split('\n')[0] ?? '').trim().replace(/\s+/g, ' ')
  if (line.length === 0) return '新任务'
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line
}

/** 读取本地 SessionIndex（§6.1 第 3 步），并默认选中最近一条 */
export async function loadTasks(deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const result = await api.session.list()
  if (!result.ok) {
    reportError(result.error)
    return
  }
  const store = useSessionStore.getState()
  store.setHistoryTasks(result.data.items)

  const after = useSessionStore.getState()
  const first = after.tasks[0]
  if (after.selectedId === undefined && first !== undefined) {
    await selectTask(first.id, deps)
  }
}

/**
 * 选中任务。
 *
 * 历史任务**只回放 JSONL，不启动子进程**（§6.1 第 4 步）；回放过的任务不重复读盘。
 */
export async function selectTask(taskId: string, deps: ActionDeps = {}): Promise<void> {
  const store = useSessionStore.getState()
  store.select(taskId)
  store.ensureChat(taskId)

  const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
  if (task === undefined || task.kind === 'live') return
  if (task.filePath === undefined) return

  const existing = useSessionStore.getState().chats[taskId]
  if (existing !== undefined && existing.messages.length > 0) return

  const api = resolveApi(deps)
  if (api === undefined) return

  const history = await api.session.history({ sessionFile: task.filePath })
  if (!history.ok) {
    reportError(history.error)
    return
  }
  const chat = useSessionStore.getState().replay(taskId, history.data.records)
  if (history.data.truncated) useSessionStore.getState().markTruncated(taskId)
  useRunStore.getState().setPhase(taskId, chat.phase)
}

/**
 * 新建任务（M3 旧入口）：先选目录，再交给 {@link createTask}。
 * M4 起主路径是新建任务弹层（`features/tasks/NewTaskDialog`），这里保留
 * 「只要目录」的最短路径给空态引导/快捷键使用。
 */
export async function newTask(deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return

  const current = selectedTask()
  const picked = await api.fs.pickDirectory(
    current === undefined || current.cwd.length === 0 ? {} : { defaultPath: current.cwd }
  )
  if (!picked.ok) {
    reportError(picked.error)
    return
  }
  await createTask({ cwd: picked.data.path }, deps)
}

/** 新建任务弹层的提交数据（§1.1 对标 WorkBuddy：只有目录必填，其余给默认值） */
export interface CreateTaskInput {
  cwd: string
  /** `provider/id`；省略 = 用 pi 自己的默认模型 */
  model?: string
  /** 推理档位（docs/rpc-commands.md#set_thinking_level） */
  thinkingLevel?: string
  /** 会话名（对应 pi `--name`），可空 */
  name?: string
  /**
   * 起始模式。M4 只支持对话模式；办公/Plan 模式按 Q5「MVP 不做，M4 之后评估」，
   * 因此这里不收其他值（不编造 pi 不支持的启动参数）。
   */
  mode?: 'chat'
}

/**
 * 创建会话（M4 新建任务弹层的编排）。
 *
 * 顺序：`session:create`（带 model/name）→ 若同时选了推理档位则 `model:set`
 * → `session:state` 回填模型/文件 → `session:stats` 初始化 token/成本。
 */
export async function createTask(
  input: CreateTaskInput,
  deps: ActionDeps = {}
): Promise<string | undefined> {
  const api = resolveApi(deps)
  if (api === undefined) return undefined

  const created = await api.session.create({
    cwd: input.cwd,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.name === undefined || input.name.trim().length === 0
      ? {}
      : { name: input.name.trim() })
  })
  if (!created.ok) {
    reportError(created.error)
    return undefined
  }

  const sessionKey = created.data.sessionKey
  const title = input.name === undefined ? undefined : input.name.trim()
  const taskId = useSessionStore.getState().addLiveTask({
    sessionKey,
    cwd: input.cwd,
    ...(title === undefined || title.length === 0 ? {} : { title })
  })
  useRunStore.getState().setPhase(taskId, 'idle')
  useRunStore.getState().clearBanners()

  // 推理档位只能在会话存在之后设置（pi 没有 create 时传档位的参数）
  if (input.thinkingLevel !== undefined && input.model !== undefined) {
    const applied = await api.model.set({
      sessionKey,
      model: input.model,
      thinkingLevel: input.thinkingLevel
    })
    if (!applied.ok) reportError(applied.error)
  }

  await syncTaskState(taskId, deps)
  return taskId
}

/**
 * 把 pi 的真实状态回填到任务上（模型/档位/会话文件），并刷新 token/成本。
 * 创建、继续对话、分叉后都走这一条路径，避免每个入口各写一套。
 */
export async function syncTaskState(taskId: string, deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
  const sessionKey = task?.sessionKey
  if (sessionKey === undefined) return

  const state = await api.session.state({ sessionKey })
  if (!state.ok) {
    reportError(state.error)
    return
  }
  const model =
    state.data.model === undefined
      ? undefined
      : `${state.data.model.provider}/${state.data.model.id}`
  useSessionStore.getState().setTaskModel(taskId, model, state.data.thinkingLevel)
  if (state.data.sessionFile !== undefined) {
    useSessionStore.getState().setFilePatch(taskId, state.data.sessionFile)
  }
  await refreshStats(taskId, deps)
}

/** 读取 pi 的会话统计（token/成本）；缺失字段由 UI 显示「—」 */
export async function refreshStats(taskId: string, deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
  const sessionKey = task?.sessionKey
  if (sessionKey === undefined) return
  const result = await api.session.stats({ sessionKey })
  if (!result.ok) return // 统计是辅助信息：失败不弹错误条
  useSessionStore.getState().setStats(taskId, result.data)
}

/** 读取可选模型列表（新建任务弹层 / 会话内切换共用；失败返回空数组） */
export async function loadModels(deps: ActionDeps = {}): Promise<ModelInfo[]> {
  const api = resolveApi(deps)
  if (api === undefined) return []
  const result = await api.model.list()
  if (!result.ok) {
    reportError(result.error)
    return []
  }
  useSessionStore.getState().setModels(result.data)
  return result.data
}

/**
 * 会话内切换模型 / 推理档位（§8.1 M4）。
 *
 * - 切换中拒绝重复提交（`switching`）；
 * - 失败给**明确错误条**（含错误码），不静默回退；
 * - 成功后回填任务上的模型/档位徽标。
 */
export async function switchModel(
  input: { model: string; thinkingLevel?: string },
  deps: ActionDeps = {}
): Promise<boolean> {
  const api = resolveApi(deps)
  if (api === undefined) return false
  const task = selectedTask()
  if (task === undefined) return false
  const sessionKey = task.sessionKey
  if (sessionKey === undefined) {
    useRunStore.getState().pushBanner({
      level: 'warn',
      message: '该任务还没有运行中的 pi 会话：请先「继续对话」再切换模型'
    })
    return false
  }

  const run = useRunStore.getState()
  if (run.switching[task.id] === true) return false
  run.setSwitching(task.id, true)
  try {
    const result = await api.model.set({
      sessionKey,
      model: input.model,
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel })
    })
    if (!result.ok) {
      reportError(result.error)
      return false
    }
    useSessionStore.getState().setTaskModel(task.id, input.model, input.thinkingLevel)
    return true
  } finally {
    run.setSwitching(task.id, false)
  }
}

/**
 * 继续对话（§6.1 第 4 步）：只有用户主动点「继续对话」才启动进程（`session:resume`）。
 * 选历史会话本身仍然只回放，不起子进程。
 */
export async function continueConversation(deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const task = selectedTask()
  if (task === undefined) return
  if (task.sessionKey !== undefined) return
  if (task.filePath === undefined) {
    useRunStore.getState().pushBanner({ level: 'error', message: '该任务缺少会话文件，无法恢复' })
    return
  }

  const resumed = await api.session.resume({ sessionFile: task.filePath })
  if (!resumed.ok) {
    reportError(resumed.error)
    return
  }
  useSessionStore.getState().attachSessionKey(task.id, resumed.data.sessionKey)
  await syncTaskState(task.id, deps)
}

/** 可分叉点（pi `get_fork_messages`：只有用户消息） */
export async function loadForkPoints(deps: ActionDeps = {}): Promise<ForkPoint[]> {
  const api = resolveApi(deps)
  if (api === undefined) return []
  const task = selectedTask()
  const sessionKey = task?.sessionKey
  if (sessionKey === undefined) return []
  const result = await api.session.forkPoints({ sessionKey })
  if (!result.ok) {
    reportError(result.error)
    return []
  }
  return result.data.points
}

/**
 * 分叉（§6.5 / A4）。
 *
 * 语义（与 pi 一致，已在 docs/rpc-commands.md#fork 核实）：
 * - `entryId` 是**用户消息** entry id（assistant 消息不能作为分叉点）；
 * - fork 后同一 pi 进程切到新会话：旧 sessionKey 释放 → 当前任务降级为「只读回放」，
 *   新 sessionKey 接管为新任务（`live:` 前缀）；
 * - 原会话文件字节不变（A4），新会话文件由 pi 另存。
 *
 * **空会话容错（M4 复核修复 B1）**：pi 从**第一条用户消息**分叉时 `targetLeafId = null`，
 * 走 `newSession({parentSession})` 得到空会话，新会话文件直到下一条 prompt 才落盘。
 * 所以这里回放必须带 `allowMissing: true`，并接受 `fileAbsent: true`（空记录）——
 * 不能因为「文件还不存在」把 fork 之后的正常流程报成 `PATH_DENIED` 错误条（主进程侧
 * 的 realpath fail-closed 语义不变，只是把「文件尚未落盘」单独区分出来）。
 */
export async function forkTask(entryId: string, deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return
  const task = selectedTask()
  if (task === undefined) return
  const sessionKey = task.sessionKey
  if (sessionKey === undefined) {
    useRunStore.getState().pushBanner({
      level: 'warn',
      message: '需要先「继续对话」启动 pi 会话才能从某条消息分叉'
    })
    return
  }

  const run = useRunStore.getState()
  if (run.forking[task.id] === true) return
  run.setForking(task.id, true)
  try {
    const result = await api.session.fork({ sessionKey, entryId })
    if (!result.ok) {
      reportError(result.error)
      return
    }

    // 原任务：通道已移交，降级为只读回放（文件字节不变）
    useSessionStore.getState().detachSession(task.id, task.filePath)

    const forkedId = useSessionStore.getState().addLiveTask({
      sessionKey: result.data.sessionKey,
      cwd: task.cwd,
      title: `${task.title}（分叉）`
    })
    run.setPhase(forkedId, 'idle')
    await syncTaskState(forkedId, deps)

    // 用新会话文件回放分叉后的上下文（选中即已回放，不需要用户再点）
    const forked = useSessionStore.getState().tasks.find((item) => item.id === forkedId)
    let fileAbsent = false
    if (forked?.filePath !== undefined) {
      const history = await api.session.history({
        sessionFile: forked.filePath,
        // 首条消息分叉 = 空会话：新会话文件还没落盘（B1）
        allowMissing: true
      })
      if (history.ok) {
        if (history.data.fileAbsent === true) {
          fileAbsent = true
          useSessionStore.getState().ensureChat(forkedId)
        } else {
          const chat = useSessionStore.getState().replay(forkedId, history.data.records)
          useRunStore.getState().setPhase(forkedId, chat.phase)
          if (history.data.truncated) useSessionStore.getState().markTruncated(forkedId)
        }
      } else {
        reportError(history.error)
      }
    }

    if (fileAbsent) {
      // 空会话不是错误：给出可操作的说明，不弹错误条
      run.pushBanner({
        level: 'info',
        message: '已从首条消息分叉：这是一个空会话（新会话文件尚未落盘），直接发送消息即可',
        detail: '原会话文件未改动（A4）'
      })
    } else {
      run.pushBanner({ level: 'info', message: '已分叉到新任务；原会话文件未改动（A4）' })
    }
  } finally {
    run.setForking(task.id, false)
  }
}

/** 保存偏好（ConfigStore）并回写当前视图 */
export async function saveSettings(
  patch: ConfigUpdateInput,
  deps: ActionDeps = {}
): Promise<AppConfigView | undefined> {
  const api = resolveApi(deps)
  if (api === undefined) return undefined
  const result = await api.config.update(patch)
  if (!result.ok) {
    reportError(result.error)
    return undefined
  }
  useAppStore.getState().setConfig(result.data)
  useRunStore.getState().pushBanner({ level: 'info', message: '设置已保存' })
  return result.data
}

/**
 * 发送消息（§6.2）。
 *
 * - 先乐观插入用户消息；
 * - 历史任务首次发送才 `session:resume`（不提前起子进程）；
 * - busy 时带 `streamingBehavior: 'followUp'`（§7 约束 5），由 UI 语义决定；
 * - `prompt` 成功只代表「已接受」，完成只认 `agent_settled`（phase 由事件归约驱动）。
 */
export async function sendMessage(text: string, deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  const message = text.trim()
  if (api === undefined || message.length === 0) return

  const store = useSessionStore.getState()
  const task = selectedTask()
  if (task === undefined) return

  const run = useRunStore.getState()
  const phase = run.phases[task.id] ?? 'idle'
  const busy = phase !== 'idle'

  store.appendUserMessage(task.id, message)
  if (task.kind === 'live') store.setTaskTitle(task.id, titleFromMessage(message))
  run.clearAborted(task.id)

  let sessionKey = task.sessionKey
  if (sessionKey === undefined) {
    if (task.filePath === undefined) {
      run.pushBanner({ level: 'error', message: '该任务缺少会话文件，无法恢复；请新建任务' })
      return
    }
    const resumed = await api.session.resume({ sessionFile: task.filePath })
    if (!resumed.ok) {
      reportError(resumed.error)
      return
    }
    sessionKey = resumed.data.sessionKey
    useSessionStore.getState().attachSessionKey(task.id, sessionKey)
  }

  const result = await api.session.prompt({
    sessionKey,
    message,
    ...(busy ? { streamingBehavior: 'followUp' as const } : {})
  })
  if (!result.ok) {
    reportError(result.error)
    return
  }
  if (result.data.disposition === 'handled') {
    // 扩展命令：本轮不会有 agent_settled，保持 idle 由用户继续
    useRunStore.getState().setPhase(task.id, 'idle')
  }
}

/**
 * 停止（E4）：点击即置灰 + 提示「已中止」，随后等 `session:abort` 收尾回 idle。
 * pi 的 abort 会等会话 idle 后才响应（docs/rpc-commands.md#abort），
 * 因此 UI 反馈不能依赖响应到达。
 */
export async function abortRun(deps: ActionDeps = {}): Promise<void> {
  const api = resolveApi(deps)
  if (api === undefined) return

  const task = selectedTask()
  if (task === undefined) return
  const sessionKey = task.sessionKey
  if (sessionKey === undefined) return

  const run = useRunStore.getState()
  run.setAborting(task.id, true)
  run.markAborted(task.id)
  try {
    const result = await api.session.abort({ sessionKey })
    if (!result.ok) reportError(result.error)
  } finally {
    run.setAborting(task.id, false)
    run.setPhase(task.id, 'idle')
  }
}

/** 定位 pi（A12 引导第一步）：自检后刷新 boot 视图；可带显式路径（设置页） */
export async function locatePi(
  input: { path?: string } = {},
  deps: ActionDeps = {}
): Promise<PiSelfCheckStatus | undefined> {
  const api = resolveApi(deps)
  if (api === undefined) return undefined
  const result = await api.pi.locate(input)
  if (!result.ok) {
    reportError(result.error)
    return undefined
  }
  // A12 收口：把自检结果回写到 boot 视图。成功时「1. 确认 pi 可用」立即变成「已就绪」、
  // 头部从 `pi unknown` 变为真实状态；失败时同样回写，配合下面的告警条说明原因。
  useAppStore.getState().setPiStatus(result.data)
  if (result.data.state !== 'ok') {
    useRunStore.getState().pushBanner({
      level: 'warn',
      message: result.data.message ?? 'pi 自检未通过',
      ...(result.data.version === undefined ? {} : { detail: `version: ${result.data.version}` })
    })
  }
  return result.data
}

/** 任务 id 与 sessionKey 的映射（测试与组件共用） */
export function taskIdForSessionKey(sessionKey: string): string | undefined {
  return useSessionStore.getState().taskIdForSession(sessionKey)
}

export { liveTaskId }
