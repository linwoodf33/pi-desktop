import { contextBridge, ipcRenderer } from 'electron'

import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from '../shared/ipc-channels'
import type { PiApi, Unsubscribe } from '../shared/contracts/api'

/**
 * preload：通过 contextBridge 暴露 `window.pi`（架构文档 §4.1、§5.4）。
 *
 * 安全约束：
 * - **只**暴露 §5.4 白名单方法，每个方法绑定固定通道；
 * - 不暴露 ipcRenderer / ipcRenderer.invoke 本身，也不接受 channel 字符串参数，
 *   因此 renderer 无法构造任意通道调用（§9.4 S2）；
 * - 本文件不 import zod（preload 运行在沙箱里，不应拉业务依赖）。
 */
function invoke<TOut>(channel: InvokeChannel, payload: unknown): Promise<TOut> {
  return ipcRenderer.invoke(channel, payload) as Promise<TOut>
}

function on<T>(channel: EventChannel, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: PiApi = {
  app: {
    getBoot: () => invoke(IPC_INVOKE_CHANNELS.appGetBoot, {})
  },
  pi: {
    locate: (input) => invoke(IPC_INVOKE_CHANNELS.piLocate, input ?? {})
  },
  session: {
    list: (input) => invoke(IPC_INVOKE_CHANNELS.sessionList, input ?? {}),
    history: (input) => invoke(IPC_INVOKE_CHANNELS.sessionHistory, input),
    create: (input) => invoke(IPC_INVOKE_CHANNELS.sessionCreate, input),
    resume: (input) => invoke(IPC_INVOKE_CHANNELS.sessionResume, input),
    fork: (input) => invoke(IPC_INVOKE_CHANNELS.sessionFork, input),
    forkPoints: (input) => invoke(IPC_INVOKE_CHANNELS.sessionForkPoints, input),
    prompt: (input) => invoke(IPC_INVOKE_CHANNELS.sessionPrompt, input),
    abort: (input) => invoke(IPC_INVOKE_CHANNELS.sessionAbort, input),
    dispose: (input) => invoke(IPC_INVOKE_CHANNELS.sessionDispose, input),
    state: (input) => invoke(IPC_INVOKE_CHANNELS.sessionState, input),
    stats: (input) => invoke(IPC_INVOKE_CHANNELS.sessionStats, input)
  },
  model: {
    list: () => invoke(IPC_INVOKE_CHANNELS.modelList, {}),
    set: (input) => invoke(IPC_INVOKE_CHANNELS.modelSet, input)
  },
  config: {
    update: (input) => invoke(IPC_INVOKE_CHANNELS.configUpdate, input)
  },
  extui: {
    respond: (input) => invoke(IPC_INVOKE_CHANNELS.extuiRespond, input)
  },
  permission: {
    status: () => invoke(IPC_INVOKE_CHANNELS.permissionStatus, {})
  },
  fs: {
    pickDirectory: (input) => invoke(IPC_INVOKE_CHANNELS.fsPickDirectory, input ?? {}),
    listArtifacts: (input) => invoke(IPC_INVOKE_CHANNELS.fsListArtifacts, input),
    readText: (input) => invoke(IPC_INVOKE_CHANNELS.fsReadText, input),
    diff: (input) => invoke(IPC_INVOKE_CHANNELS.fsDiff, input)
  },
  artifact: {
    open: (input) => invoke(IPC_INVOKE_CHANNELS.artifactOpen, input)
  },
  events: {
    onRecord: (cb) => on(IPC_EVENT_CHANNELS.record, cb),
    onExtUi: (cb) => on(IPC_EVENT_CHANNELS.extui, cb),
    onStatus: (cb) => on(IPC_EVENT_CHANNELS.status, cb),
    onDiagnostic: (cb) => on(IPC_EVENT_CHANNELS.diagnostic, cb)
  }
}

contextBridge.exposeInMainWorld('pi', api)
