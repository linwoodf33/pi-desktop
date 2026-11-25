import { create } from 'zustand'

import type { ModelInfo, SessionStats, SessionSummary } from '../../shared/contracts/types'
import {
  OPTIMISTIC_USER_KEY_PREFIX,
  initialChatState,
  reduceRecord,
  reduceRecords,
  type ChatState,
  type ChatMessage,
  type RunPhase
} from '../lib/reducer'

/**
 * sessionStore（§5.5 stores/sessionStore）：会话元数据、选中会话、消息树。
 *
 * 设计要点：
 * - **纯状态容器**：这里不做 IPC，编排放在 `lib/actions.ts`，便于单测注入假 api；
 * - 历史任务（来自 `session:list`）与内存任务（`session:create` 后尚未落盘）用同一个
 *   `TaskItem` 表达，`id` 是稳定键：历史任务用会话 id，内存任务用 `live:<sessionKey>`；
 * - 对话状态按任务 id 存在 `chats` 里，切任务不丢流式内容；
 * - 事件归约只走 `lib/reducer.ts`（纯函数），组件里不拼接状态。
 */
export interface TaskItem {
  id: string
  title: string
  cwd: string
  /** ISO 8601（历史任务来自 SessionIndex） */
  updatedAt?: string
  /** 缺失字段由 UI 显示为「—」（A3） */
  totalTokens?: number
  totalCostUsd?: number
  /** 历史任务的会话文件（`session:history` / `session:resume` 的入参） */
  filePath?: string
  /** 已建立的 pi 会话通道；内存任务创建后立即有值 */
  sessionKey?: string
  kind: 'history' | 'live'
  /** 当前模型（`provider/id`，来自 session:state / model:set） */
  model?: string
  /** 当前推理档位（docs/rpc-commands.md#set_thinking_level） */
  thinkingLevel?: string
  /**
   * A38：当前生效的 agent（会话里 `open-agents-state` 条目的名字）。
   * `undefined` = 未知/未设置（UI 显示「默认」），没有 agent 概念的历史任务也是它。
   */
  agent?: string
}

export interface SessionStoreState {
  tasks: TaskItem[]
  /** 首屏 `session:list` 是否已完成（避免组件在 effect 里 setState） */
  loaded: boolean
  /** 当前选中的任务 id；`undefined` 表示还没选（用 `string | undefined` 而非可选属性，
   * 这样测试与重置可以直接写回 `undefined`） */
  selectedId: string | undefined
  /** taskId → 对话状态 */
  chats: Record<string, ChatState>
  /** sessionKey → taskId（`evt:record` / `evt:status` 据此路由） */
  bySessionKey: Record<string, string>
  /** 历史回放被截断的任务（UI 需显式提示，§7 约束 14） */
  truncated: Record<string, true>
  /** taskId → pi 的会话统计（token/成本/上下文用量，来自 `session:stats`） */
  stats: Record<string, SessionStats>
  /** `model:list` 的结果（新建任务弹层 / 模型切换共用） */
  models: ModelInfo[]
  modelsLoaded: boolean

  setHistoryTasks: (summaries: SessionSummary[]) => void
  setLoaded: (loaded: boolean) => void
  select: (taskId: string) => void
  addLiveTask: (input: {
    sessionKey: string
    cwd: string
    title?: string
    agent?: string
  }) => string
  attachSessionKey: (taskId: string, sessionKey: string) => void
  setFilePatch: (taskId: string, filePath: string) => void
  ensureChat: (taskId: string) => void
  /** 归约一条记录，返回归约后的对话状态（调用方据此同步 runStore） */
  applyRecord: (taskId: string, record: { type: string; [key: string]: unknown }) => ChatState
  replay: (taskId: string, records: Array<{ type: string; [key: string]: unknown }>) => ChatState
  appendUserMessage: (taskId: string, text: string, images?: readonly string[]) => void
  setTaskTitle: (taskId: string, title: string) => void
  /**
   * A23：改名专用 —— **无条件**更新标题。
   * `setTaskTitle` 只在「live 任务 / 标题仍是『新任务』」时写，历史任务改名会被它忽略，
   * 表现为「改名没生效、也没有任何错误」。
   */
  renameTaskTitle: (taskId: string, title: string) => void
  markTruncated: (taskId: string) => void
  taskIdForSession: (sessionKey: string) => string | undefined
  resetChat: (taskId: string) => void
  /** 记录当前模型 / 推理档位（切换成功或 session:state 回来后同步） */
  setTaskModel: (taskId: string, model: string | undefined, thinkingLevel?: string) => void
  /**
   * A38：写入 / 清除任务当前 agent。
   *
   * 三态是刻意的：`string` 更新；`null` = 文件里明确清除（删除字段，回落到默认）；
   * `undefined` = 读不到（未知），**保持现值**——把「没读到」当成「没有」会误清掉
   * 刚刚由 `session:create` 入参填好的名字。
   */
  setTaskAgent: (taskId: string, agent: string | null | undefined) => void
  /** 写入会话统计（token/成本） */
  setStats: (taskId: string, stats: SessionStats) => void
  setModels: (models: ModelInfo[]) => void
  /**
   * 分叉后释放旧通道（只保留只读回放能力）：清 sessionKey、补 filePath、降级为 history。
   * 原会话文件字节不变（A4），只是不再有进程。
   */
  detachSession: (taskId: string, filePath?: string) => void
  /** 把某条消息标为「本轮已中止」样式所需的最终文本（无状态攻击面，只是展示用途） */
  removeTask: (taskId: string) => void
}

export const liveTaskId = (sessionKey: string): string => `live:${sessionKey}`

/** 历史摘要 → 任务项 */
export function toTaskItem(summary: SessionSummary): TaskItem {
  return {
    id: summary.id,
    title: summary.title,
    cwd: summary.cwd,
    updatedAt: summary.updatedAt,
    ...(summary.totalTokens === undefined ? {} : { totalTokens: summary.totalTokens }),
    ...(summary.totalCostUsd === undefined ? {} : { totalCostUsd: summary.totalCostUsd }),
    filePath: summary.filePath,
    kind: 'history'
  }
}

/** 合并历史任务与内存任务：内存任务排在前面，同 id 以内存任务为准 */
export function mergeTasks(history: TaskItem[], live: TaskItem[]): TaskItem[] {
  const liveIds = new Set(live.map((task) => task.id))
  return [...live, ...history.filter((task) => !liveIds.has(task.id))]
}

let messageSeq = 0

/** 乐观插入的用户消息（§6.2 第一步；key 前缀与 reducer 的替换逻辑同源） */
export function optimisticUserMessage(
  text: string,
  now = Date.now(),
  images: readonly string[] = []
): ChatMessage {
  messageSeq += 1
  return {
    key: `${OPTIMISTIC_USER_KEY_PREFIX}${now}:${messageSeq}`,
    role: 'user',
    text,
    timestamp: now,
    ...(images.length === 0 ? {} : { images: [...images] })
  }
}

export const useSessionStore = create<SessionStoreState>()((set, get) => ({
  tasks: [],
  loaded: false,
  selectedId: undefined,
  chats: {},
  bySessionKey: {},
  truncated: {},
  stats: {},
  models: [],
  modelsLoaded: false,

  setLoaded: (loaded) => {
    set({ loaded })
  },

  setHistoryTasks: (summaries) => {
    const live = get().tasks.filter((task) => task.kind === 'live')
    set({ tasks: mergeTasks(summaries.map(toTaskItem), live) })
  },

  select: (taskId) => {
    set({ selectedId: taskId })
  },

  addLiveTask: ({ sessionKey, cwd, title, agent }) => {
    const id = liveTaskId(sessionKey)
    const task: TaskItem = {
      id,
      title: title ?? '新任务',
      cwd,
      sessionKey,
      kind: 'live',
      ...(agent === undefined || agent.length === 0 ? {} : { agent })
    }
    set((state) => ({
      tasks: mergeTasks(
        state.tasks.filter((existing) => existing.kind === 'history'),
        [task, ...state.tasks.filter((existing) => existing.kind === 'live' && existing.id !== id)]
      ),
      selectedId: id,
      chats: { ...state.chats, [id]: state.chats[id] ?? initialChatState },
      bySessionKey: { ...state.bySessionKey, [sessionKey]: id }
    }))
    return id
  },

  attachSessionKey: (taskId, sessionKey) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, sessionKey } : task)),
      bySessionKey: { ...state.bySessionKey, [sessionKey]: taskId }
    }))
  },

  setFilePatch: (taskId, filePath) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, filePath } : task))
    }))
  },

  ensureChat: (taskId) => {
    set((state) =>
      state.chats[taskId] === undefined
        ? { chats: { ...state.chats, [taskId]: initialChatState } }
        : state
    )
  },

  applyRecord: (taskId, record) => {
    const current = get().chats[taskId] ?? initialChatState
    const next = reduceRecord(current, record)
    if (next !== current) {
      set((state) => ({ chats: { ...state.chats, [taskId]: next } }))
    }
    return next
  },

  /**
   * 历史回放（§6.1 第 4 步）。
   *
   * **必须走批量归约**（M4 复核修复 B2）：逐条 `reduceRecord` 等价于每条记录都新建一次
   * 游标，`message_end` 会重建 keyIndex，20k 条实测 8.3s（O(n²)）；`reduceRecords` 用
   * 「写前拷贝 + 懒建索引」的一次性游标，同一批记录实测 15.5ms。两者结果等价
   * （tests/unit/reducer-perf.test.ts 有等价性回归）。
   */
  replay: (taskId, records) => {
    const next = reduceRecords(initialChatState, records)
    set((state) => ({ chats: { ...state.chats, [taskId]: next } }))
    return next
  },

  appendUserMessage: (taskId, text, images) => {
    set((state) => {
      const current = state.chats[taskId] ?? initialChatState
      return {
        chats: {
          ...state.chats,
          [taskId]: {
            ...current,
            messages: [...current.messages, optimisticUserMessage(text, Date.now(), images)]
          }
        }
      }
    })
  },

  renameTaskTitle: (taskId, title) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, title } : task))
    }))
  },

  setTaskTitle: (taskId, title) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId && (task.kind === 'live' || task.title === '新任务')
          ? { ...task, title }
          : task
      )
    }))
  },

  markTruncated: (taskId) => {
    set((state) => ({ truncated: { ...state.truncated, [taskId]: true } }))
  },

  taskIdForSession: (sessionKey) => get().bySessionKey[sessionKey],

  resetChat: (taskId) => {
    set((state) => ({ chats: { ...state.chats, [taskId]: initialChatState } }))
  },

  setTaskAgent: (taskId, agent) => {
    // 未知（undefined）不动：读不到文件时保持现值，避免把已有名字抹掉
    if (agent === undefined) return
    set((state) => ({
      tasks: state.tasks.map((item) => {
        if (item.id !== taskId) return item
        if (agent === null) {
          const next = { ...item }
          delete next.agent
          return next
        }
        return { ...item, agent }
      })
    }))
  },
  setTaskModel: (taskId, model, thinkingLevel) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...(model === undefined ? {} : { model }),
              ...(thinkingLevel === undefined ? {} : { thinkingLevel })
            }
          : task
      )
    }))
  },

  setStats: (taskId, stats) => {
    set((state) => ({ stats: { ...state.stats, [taskId]: stats } }))
  },

  setModels: (models) => {
    set({ models, modelsLoaded: true })
  },

  detachSession: (taskId, filePath) => {
    set((state) => {
      const bySessionKey = { ...state.bySessionKey }
      const tasks = state.tasks.map((item) => {
        if (item.id !== taskId) return item
        if (item.sessionKey !== undefined) delete bySessionKey[item.sessionKey]
        const next: TaskItem = { ...item, kind: 'history' }
        delete next.sessionKey
        if (next.filePath === undefined && filePath !== undefined) next.filePath = filePath
        return next
      })
      return { bySessionKey, tasks }
    })
  },

  removeTask: (taskId) => {
    set((state) => {
      const task = state.tasks.find((item) => item.id === taskId)
      const bySessionKey = { ...state.bySessionKey }
      if (task?.sessionKey !== undefined) delete bySessionKey[task.sessionKey]
      const chats = { ...state.chats }
      delete chats[taskId]
      // 任务没了，按 taskId 存的统计/截断标记也必须一起清：否则并行开关任务
      // 久了会留下一堆永远读不到的孤儿键。
      const stats = { ...state.stats }
      delete stats[taskId]
      const truncated = { ...state.truncated }
      delete truncated[taskId]
      return {
        tasks: state.tasks.filter((item) => item.id !== taskId),
        bySessionKey,
        chats,
        stats,
        truncated,
        ...(state.selectedId === taskId ? { selectedId: undefined } : {})
      }
    })
  }
}))

/** 便于测试与选择器使用：取某任务的对话状态 */
export function chatOf(state: SessionStoreState, taskId: string | undefined): ChatState {
  if (taskId === undefined) return initialChatState
  return state.chats[taskId] ?? initialChatState
}

/** 运行态（phase）归属 runStore；这里只提供纯映射便于单测 */
export function phaseOfChat(chat: ChatState): RunPhase {
  return chat.phase
}
