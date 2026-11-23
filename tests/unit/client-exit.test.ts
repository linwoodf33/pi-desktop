import { afterEach, describe, expect, it } from 'vitest'

import type { PiApi } from '../../src/shared/contracts/api'
import { subscribeEvents } from '../../src/renderer/lib/client'
import { useRunStore } from '../../src/renderer/stores/runStore'
import { useSessionStore } from '../../src/renderer/stores/sessionStore'

/**
 * A6 的 renderer 侧机制：`evt:status=exited/recycled` 必须把任务降级成「可 continue 的历史任务」。
 *
 * 为什么单独钉死这一条：子进程被强杀后，如果 renderer 还留着已死的 sessionKey，任务就是个
 * 僵尸——「继续对话」按钮不出现（A6 要求的可操作入口缺失），再发消息只会得到 SESSION_NOT_FOUND。
 * 这里用假 api 直接驱动 `subscribeEvents` 的 status 处理器，不启动 Electron。
 */

type StatusEvent = { sessionKey: string; status: string }

interface FakeApi {
  api: PiApi
  emitStatus: (event: StatusEvent) => void
}

function createFakeApi(): FakeApi {
  let statusHandler: ((event: StatusEvent) => void) | undefined
  const noop = (): void => undefined
  const unsubscribe = (): void => undefined

  const api = {
    events: {
      onRecord: () => unsubscribe,
      onStatus: (handler: (event: StatusEvent) => void) => {
        statusHandler = handler
        return unsubscribe
      },
      onExtUi: () => unsubscribe,
      onDiagnostic: () => unsubscribe
    },
    session: { stats: noop }
  } as unknown as PiApi

  return {
    api,
    emitStatus: (event) => {
      if (statusHandler === undefined) throw new Error('status 处理器未注册')
      statusHandler(event)
    }
  }
}

const pristineSession = useSessionStore.getState()
const pristineRun = useRunStore.getState()

afterEach(() => {
  useSessionStore.setState(pristineSession, true)
  useRunStore.setState(pristineRun, true)
})

/** 造一个「活着的」任务：有 sessionKey、有 filePath */
function seedLiveTask(sessionKey: string): string {
  const store = useSessionStore.getState()
  const taskId = store.addLiveTask({ sessionKey, cwd: 'C:/work' })
  useSessionStore.getState().setFilePatch(taskId, 'C:/sessions/live.jsonl')
  return taskId
}

describe('client: evt:status=exited（A6 可操作入口）', () => {
  it('清掉已死的 sessionKey、保留 filePath 与对话，并提示「继续对话」', () => {
    const { api, emitStatus } = createFakeApi()
    const unsubscribe = subscribeEvents(api)
    const taskId = seedLiveTask('live-key-a6')

    emitStatus({ sessionKey: 'live-key-a6', status: 'exited' })

    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.sessionKey).toBeUndefined()
    expect(task?.filePath).toBe('C:/sessions/live.jsonl')
    // 降级为历史任务 = UI 渲染「继续对话」+ 只读回放提示
    expect(task?.kind).toBe('history')
    expect(useSessionStore.getState().taskIdForSession('live-key-a6')).toBeUndefined()
    expect(
      useRunStore
        .getState()
        .banners.some((banner) => banner.message.includes('继续对话') && banner.level === 'warn')
    ).toBe(true)

    unsubscribe()
  })

  it('recycled（空闲回收）同样降级，不留僵尸会话', () => {
    const { api, emitStatus } = createFakeApi()
    const unsubscribe = subscribeEvents(api)
    const taskId = seedLiveTask('live-key-recycled')

    emitStatus({ sessionKey: 'live-key-recycled', status: 'recycled' })

    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.sessionKey).toBeUndefined()
    expect(task?.kind).toBe('history')
    unsubscribe()
  })

  it('running 等中间状态不动 sessionKey（避免过度降级）', () => {
    const { api, emitStatus } = createFakeApi()
    const unsubscribe = subscribeEvents(api)
    const taskId = seedLiveTask('live-key-running')

    emitStatus({ sessionKey: 'live-key-running', status: 'running' })

    const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
    expect(task?.sessionKey).toBe('live-key-running')
    expect(task?.kind).toBe('live')
    unsubscribe()
  })
})
