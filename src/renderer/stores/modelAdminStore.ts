import { create } from 'zustand'

import type {
  ModelConfigView,
  ModelConfigWriteResult,
  ModelEntryInput,
  UpsertProviderInput
} from '../../shared/contracts/model-config'
import { getApi } from '../lib/client'

/**
 * 模型管理 store（M7）。
 *
 * 只做三件事：拉视图、执行写操作、把错误留在本地（不污染全局 error banner —— 模型管理是
 * 用户主动打开的弹层，错误应显示在弹层里而不是页面顶部）。
 */
export interface ModelAdminState {
  view: ModelConfigView | undefined
  loading: boolean
  saving: boolean
  error: string | undefined
  load: () => Promise<void>
  setDefault: (modelId: string | null) => Promise<boolean>
  upsertProvider: (input: UpsertProviderInput) => Promise<boolean>
  removeProvider: (id: string) => Promise<boolean>
  upsertModel: (providerId: string, model: ModelEntryInput) => Promise<boolean>
  removeModel: (providerId: string, modelId: string) => Promise<boolean>
  clearError: () => void
}

/** 统一处理 `Result<T>`：成功返回数据，失败把 message 落进 store */
async function unwrap<T>(
  promise: Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>,
  set: (patch: Partial<ModelAdminState>) => void
): Promise<T | undefined> {
  const result = await promise
  if (!result.ok) {
    set({ error: result.error.message, saving: false })
    return undefined
  }
  return result.data
}

export const useModelAdminStore = create<ModelAdminState>((set, get) => ({
  view: undefined,
  loading: false,
  saving: false,
  error: undefined,

  load: async () => {
    const api = getApi()
    if (api === undefined) {
      set({ error: 'IPC 不可用（preload 未注入）' })
      return
    }
    set({ loading: true, error: undefined })
    const data = await unwrap(api.models.read(), set)
    set({ loading: false, ...(data === undefined ? {} : { view: data }) })
  },

  clearError: () => {
    set({ error: undefined })
  },

  setDefault: async (modelId) => {
    const api = getApi()
    if (api === undefined) return false
    set({ saving: true, error: undefined })
    const data = await unwrap(api.models.setDefault({ modelId }), set)
    if (data === undefined) return false
    await get().load()
    set({ saving: false })
    return true
  },

  upsertProvider: async (input) => {
    const api = getApi()
    if (api === undefined) return false
    set({ saving: true, error: undefined })
    const data: ModelConfigWriteResult | undefined = await unwrap(
      api.models.upsertProvider(input),
      set
    )
    if (data === undefined) return false
    await get().load()
    set({ saving: false })
    return true
  },

  removeProvider: async (id) => {
    const api = getApi()
    if (api === undefined) return false
    set({ saving: true, error: undefined })
    const data = await unwrap(api.models.removeProvider({ id }), set)
    if (data === undefined) return false
    await get().load()
    set({ saving: false })
    return true
  },

  upsertModel: async (providerId, model) => {
    const api = getApi()
    if (api === undefined) return false
    set({ saving: true, error: undefined })
    const data = await unwrap(api.models.upsertModel({ providerId, model }), set)
    if (data === undefined) return false
    await get().load()
    set({ saving: false })
    return true
  },

  removeModel: async (providerId, modelId) => {
    const api = getApi()
    if (api === undefined) return false
    set({ saving: true, error: undefined })
    const data = await unwrap(api.models.removeModel({ providerId, modelId }), set)
    if (data === undefined) return false
    await get().load()
    set({ saving: false })
    return true
  }
}))
