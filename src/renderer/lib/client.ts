import type { PiApi } from '../../shared/contracts/api'
import { agentNameFromRecord } from '../../shared/contracts/agents'

import { refreshArtifacts } from './artifact-actions'
import { forgetSession, handleExtUiEvent } from './approval'
import { useRunStore } from '../stores/runStore'
import { useSessionStore } from '../stores/sessionStore'

/**
 * 会话结束后刷新 token/成本（§8.1 M4：成本与 token 展示）。
 *
 * 数据只来自 pi 的 `get_session_stats`，失败时静默（统计是辅助信息，失败不该弹错误条）。
 */
async function refreshStats(api: PiApi, taskId: string): Promise<void> {
  const task = useSessionStore.getState().tasks.find((item) => item.id === taskId)
  const sessionKey = task?.sessionKey
  if (sessionKey === undefined) return
  const result = await api.session.stats({ sessionKey })
  if (!result.ok) return
  useSessionStore.getState().setStats(taskId, result.data)
}

/**
 * renderer 侧的 preload 桥接与事件接线。
 *
 * 事件归约的唯一入口在此处：`evt:record` → `sessionStore.applyRecord`（内部走
 * `lib/reducer.ts` 纯函数）→ 把 phase 同步给 `runStore`。组件里不做状态拼接（§5.5）。
 */
export function getApi(): PiApi | undefined {
  return (globalThis as { pi?: PiApi }).pi
}

/** 订阅 main → renderer 的全部事件；返回取消订阅函数 */
export function subscribeEvents(api: PiApi): () => void {
  const offRecord = api.events.onRecord((event) => {
    const session = useSessionStore.getState()
    const taskId = session.taskIdForSession(event.sessionKey)
    if (taskId === undefined) return

    const run = useRunStore.getState()

    /*
     * A40：实时校准专家（F2）。
     * 扩展每次 `appendEntry` 都发 `entry_appended`，所以这里不需要新通道（F8 已全量转发）；
     * `undefined`（与该标记无关）必须**不动**现值，否则会把刚切换的结果抹掉。
     */
    const agentUpdate = agentNameFromRecord(event.record)
    if (agentUpdate !== undefined) session.setTaskAgent(taskId, agentUpdate)

    /*
     * A41：压缩状态机（R6）。`setCompacting` 是幂等的：
     * true→true / false→false 都只保证终态正确，事件与动作两种来源可以任意顺序到达。
     * 失败提示只给**非用户触发**的压缩：手动压缩的失败由 actions 报一次，避免双条（R9）。
     */
    if (event.record.type === 'compaction_start') {
      run.setCompacting(taskId, true)
    } else if (event.record.type === 'compaction_end') {
      run.setCompacting(taskId, false)
      const aborted = event.record['aborted'] === true
      const errorMessage = event.record['errorMessage']
      const reason = event.record['reason']
      if (!aborted && typeof errorMessage === 'string' && reason !== 'manual') {
        run.pushBanner({ level: 'warn', message: `上下文压缩失败：${errorMessage}` })
      }
    }

    const chat = session.applyRecord(taskId, event.record)
    run.setPhase(taskId, chat.phase)
  })

  const offStatus = api.events.onStatus((event) => {
    const run = useRunStore.getState()
    // §5.4：evt:status 必须按 sessionKey 关联
    run.setStatus(event.sessionKey, event.status)
    const taskId = useSessionStore.getState().taskIdForSession(event.sessionKey)
    if (taskId === undefined) return
    run.applyStatus(taskId, event.status)
    // settled = 本轮真正完成（§6.2），此时 pi 的统计才完整
    if (event.status === 'settled') {
      void refreshStats(api, taskId)
      // M6：产物扫描的**唯一自动时机**（§6.1 产物流：agent_settled → 只读 git status → 变更列表）
      void refreshArtifacts(taskId)
    }
    if (event.status === 'exited') {
      if (useRunStore.getState().ending[taskId] === true) {
        // A36：用户主动结束 —— 降级由 endTask 在 dispose 真正返回后执行；
        // 这里只把 phase 压到 settling（禁发），且不弹「子进程退出」的提示条
        run.setPhase(taskId, 'settling')
        // B1（reviewer）：压缩标志不随会话终止清理的话，恢复会话后「压缩/切换专家」永久禁用
        run.setCompacting(taskId, false)
        forgetSession(event.sessionKey)
        return
      }
      // A6：子进程意外退出后必须**立刻可操作**——释放已死的 sessionKey，把任务降级为历史回放
      // （对话与 filePath 都保留，点「继续对话」即 `session:resume`）。
      // 不这么做的话，任务会留着一个僵尸 sessionKey：再发消息只会得到 SESSION_NOT_FOUND。
      useSessionStore.getState().detachSession(taskId)
      run.pushBanner({
        level: 'warn',
        message: 'pi 会话已结束（子进程退出）：历史已保留，点「继续对话」可重新启动'
      })
    }
    if (event.status === 'recycled') {
      // A8：空闲回收同理——保留可读历史，重新进入时给「继续对话」而不是僵尸会话
      useSessionStore.getState().detachSession(taskId)
    }
    // M5：会话结束/回收 → 清空该会话的未决审批与「本会话允许」记忆（不跨会话泄漏）
    if (event.status === 'exited' || event.status === 'recycled') forgetSession(event.sessionKey)
    // B1（reviewer）：压缩中会话被终止（dispose/崩溃/空闲回收）时 compaction_end 永不到达，
    // 键必须在此复位，否则恢复会话后「压缩上下文」「切换专家」永久禁用且无事件能解
    if (event.status === 'exited' || event.status === 'recycled') run.setCompacting(taskId, false)
  })

  // M5：审批子协议（extension_ui_request：select = 审批弹窗；setStatus = 版本握手）
  const offExtUi = api.events.onExtUi((event) => {
    handleExtUiEvent(api, event)
  })

  const offDiagnostic = api.events.onDiagnostic((event) => {
    useRunStore.getState().pushBanner({
      level: event.level,
      message: event.message,
      ...(event.stderrTail === undefined ? {} : { detail: event.stderrTail })
    })
  })

  return () => {
    offRecord()
    offStatus()
    offExtUi()
    offDiagnostic()
  }
}
