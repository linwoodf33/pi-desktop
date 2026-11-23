import { create } from 'zustand'

import type { ArtifactList, ReadTextResult, UnifiedDiff } from '../../shared/contracts/types'

/**
 * artifactStore（§5.5 stores/artifactStore）：产物面板的状态容器（M6）。
 *
 * 设计要点（与 sessionStore 一致的边界）：
 * - **纯状态容器**：不做 IPC。拉列表 / diff / 预览都在 `lib/artifact-actions.ts`，
 *   便于单测注入假 api（tests/unit/artifact-store.test.ts 只测状态转移）；
 * - 状态按 `taskId` 分桶：多任务并行时右栏只显示当前选中任务的产物，切任务不串；
 * - diff / 预览按 `taskId::path` 缓存：反复点同一文件不重复请求（列表刷新时才失效）；
 * - 扫描/加载都有显式 loading 与 error 位，UI 不靠猜测。
 */
export interface ArtifactStoreState {
  collapsed: boolean
  /** taskId → 最近一次扫描结果 */
  lists: Record<string, ArtifactList>
  /** taskId → 选中产物路径（工作区相对） */
  selected: Record<string, string | undefined>
  /** `taskId::path` → diff 结果 */
  diffs: Record<string, UnifiedDiff>
  /** `taskId::path` → 文本预览结果 */
  previews: Record<string, ReadTextResult>
  /** taskId → 列表扫描在途 */
  scanning: Record<string, true>
  /** `taskId::path` → diff/预览加载在途 */
  loading: Record<string, true>
  /** taskId → 列表级错误文案（可操作提示） */
  errors: Record<string, string | undefined>

  toggleCollapsed: () => void
  setCollapsed: (collapsed: boolean) => void
  /** 写入新列表：清掉该任务的 diff/预览缓存（内容可能已变） */
  setList: (taskId: string, list: ArtifactList) => void
  setSelected: (taskId: string, path: string | undefined) => void
  setDiff: (key: string, diff: UnifiedDiff) => void
  setPreview: (key: string, preview: ReadTextResult) => void
  setScanning: (taskId: string, value: boolean) => void
  setLoading: (key: string, value: boolean) => void
  setError: (taskId: string, message: string | undefined) => void
  /** 任务被移除/分叉移交时清空该任务的分桶 */
  clearTask: (taskId: string) => void
}

/** diff/预览缓存键（导出便于测试与组件复用） */
export function artifactKey(taskId: string, path: string): string {
  return `${taskId}::${path}`
}

export const useArtifactStore = create<ArtifactStoreState>()((set) => ({
  collapsed: false,
  lists: {},
  selected: {},
  diffs: {},
  previews: {},
  scanning: {},
  loading: {},
  errors: {},

  toggleCollapsed: () => {
    set((state) => ({ collapsed: !state.collapsed }))
  },

  setCollapsed: (collapsed) => {
    set({ collapsed })
  },

  setList: (taskId, list) => {
    set((state) => {
      const prefix = `${taskId}::`
      const current = state.selected[taskId]
      const stillExists = current !== undefined && list.items.some((item) => item.path === current)
      const nextSelected = stillExists ? current : list.items[0]?.path
      const scanning = omitKey(state.scanning, taskId)
      const errors = omitKey(state.errors, taskId)
      return {
        lists: { ...state.lists, [taskId]: list },
        selected: { ...state.selected, [taskId]: nextSelected },
        // 列表刷新 = 内容可能已变：该任务的 diff/预览缓存全部失效
        diffs: omitPrefix(state.diffs, prefix),
        previews: omitPrefix(state.previews, prefix),
        loading: omitPrefix(state.loading, prefix),
        scanning,
        errors
      }
    })
  },

  setSelected: (taskId, path) => {
    set((state) => ({ selected: { ...state.selected, [taskId]: path } }))
  },

  setDiff: (key, diff) => {
    set((state) => ({ diffs: { ...state.diffs, [key]: diff } }))
  },

  setPreview: (key, preview) => {
    set((state) => ({ previews: { ...state.previews, [key]: preview } }))
  },

  setScanning: (taskId, value) => {
    set((state) => ({
      scanning: value ? { ...state.scanning, [taskId]: true } : omitKey(state.scanning, taskId)
    }))
  },

  setLoading: (key, value) => {
    set((state) => ({
      loading: value ? { ...state.loading, [key]: true } : omitKey(state.loading, key)
    }))
  },

  setError: (taskId, message) => {
    set((state) => ({ errors: { ...state.errors, [taskId]: message } }))
  },

  clearTask: (taskId) => {
    set((state) => {
      const prefix = `${taskId}::`
      return {
        lists: omitKey(state.lists, taskId),
        selected: omitKey(state.selected, taskId),
        errors: omitKey(state.errors, taskId),
        scanning: omitKey(state.scanning, taskId),
        diffs: omitPrefix(state.diffs, prefix),
        previews: omitPrefix(state.previews, prefix),
        loading: omitPrefix(state.loading, prefix)
      }
    })
  }
}))

/** 删除单个键（替代「写入 undefined」：值类型是 `true`/对象，写 undefined 需要绕过类型） */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey !== key) next[entryKey] = value
  }
  return next
}

/** 去掉指定前缀的键（用于按任务失效缓存） */
function omitPrefix<T>(record: Record<string, T>, prefix: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith(prefix)) next[key] = value
  }
  return next
}
