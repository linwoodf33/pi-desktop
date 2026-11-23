import { beforeEach, describe, expect, it } from 'vitest'

import type { ArtifactList, ReadTextResult, UnifiedDiff } from '../../src/shared/contracts/types'
import { artifactKey, useArtifactStore } from '../../src/renderer/stores/artifactStore'

/**
 * artifactStore（M6）：状态转移，不发起任何 IPC（编排在 `lib/artifact-actions.ts`）。
 *
 * 重点覆盖三件事：
 * 1. 多任务分桶（切任务不串）；
 * 2. 列表刷新会让「该任务」的 diff/预览缓存失效（内容可能已变）；
 * 3. 选中项在列表刷新后仍然存在则保留，不存在则回落到首条。
 */
function makeList(overrides: Partial<ArtifactList> = {}): ArtifactList {
  return {
    items: [
      { path: 'a.txt', change: 'added' },
      { path: 'b/c.txt', change: 'modified' }
    ],
    mode: 'git',
    root: 'C:/work',
    truncated: false,
    totalCount: 2,
    scannedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

const EMPTY_STATE = {
  collapsed: false,
  lists: {},
  selected: {},
  diffs: {},
  previews: {},
  scanning: {},
  loading: {},
  errors: {}
}

beforeEach(() => {
  useArtifactStore.setState(EMPTY_STATE)
})

describe('产物面板折叠（M3 保留）', () => {
  it('默认展开，toggleCollapsed / setCollapsed 生效', () => {
    expect(useArtifactStore.getState().collapsed).toBe(false)
    useArtifactStore.getState().toggleCollapsed()
    expect(useArtifactStore.getState().collapsed).toBe(true)
    useArtifactStore.getState().setCollapsed(false)
    expect(useArtifactStore.getState().collapsed).toBe(false)
  })
})

describe('产物列表与选中（M6）', () => {
  it('setList 后自动选中首条', () => {
    useArtifactStore.getState().setList('t1', makeList())
    expect(useArtifactStore.getState().lists['t1']?.items).toHaveLength(2)
    expect(useArtifactStore.getState().selected['t1']).toBe('a.txt')
  })

  it('列表刷新：选中项仍存在则保留，消失则回落到首条', () => {
    useArtifactStore.getState().setList('t1', makeList())
    useArtifactStore.getState().setSelected('t1', 'b/c.txt')
    useArtifactStore.getState().setList('t1', makeList())
    expect(useArtifactStore.getState().selected['t1']).toBe('b/c.txt')

    useArtifactStore
      .getState()
      .setList('t1', makeList({ items: [{ path: 'd.txt', change: 'deleted' }], totalCount: 1 }))
    expect(useArtifactStore.getState().selected['t1']).toBe('d.txt')
  })

  it('列表刷新会失效该任务的 diff/预览缓存，但不影响其它任务', () => {
    const key1 = artifactKey('t1', 'a.txt')
    const key2 = artifactKey('t2', 'a.txt')
    useArtifactStore.getState().setDiff(key1, {
      path: 'a.txt',
      patch: 'diff --git a/a.txt b/a.txt',
      truncated: false,
      mode: 'git'
    } satisfies UnifiedDiff)
    useArtifactStore.getState().setDiff(key2, {
      path: 'a.txt',
      patch: 'diff --git a/a.txt b/a.txt',
      truncated: false,
      mode: 'git'
    })
    useArtifactStore.getState().setPreview(key1, {
      path: 'a.txt',
      text: 'hello',
      truncated: false,
      binary: false,
      sizeBytes: 5,
      offset: 0
    } satisfies ReadTextResult)

    useArtifactStore.getState().setList('t1', makeList())

    const state = useArtifactStore.getState()
    expect(state.diffs[key1]).toBeUndefined()
    expect(state.previews[key1]).toBeUndefined()
    expect(state.diffs[key2]).toBeDefined()
  })

  it('scanning / error 是显式位，setList 成功后清掉错误', () => {
    useArtifactStore.getState().setScanning('t1', true)
    expect(useArtifactStore.getState().scanning['t1']).toBe(true)
    useArtifactStore.getState().setError('t1', '[PATH_DENIED] 越权')
    useArtifactStore.getState().setList('t1', makeList())
    expect(useArtifactStore.getState().scanning['t1']).toBeUndefined()
    expect(useArtifactStore.getState().errors['t1']).toBeUndefined()
  })

  it('clearTask 清空该任务的所有分桶（含缓存与在途位）', () => {
    useArtifactStore.getState().setList('t1', makeList())
    useArtifactStore.getState().setLoading(artifactKey('t1', 'a.txt'), true)
    useArtifactStore.getState().clearTask('t1')
    const state = useArtifactStore.getState()
    expect(state.lists['t1']).toBeUndefined()
    expect(state.selected['t1']).toBeUndefined()
    expect(state.loading[artifactKey('t1', 'a.txt')]).toBeUndefined()
    expect(Object.keys(state.diffs)).toHaveLength(0)
  })
})
