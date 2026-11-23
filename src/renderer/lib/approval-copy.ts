import type { ApprovalChoice } from '../../shared/contracts/permission'
import type { PendingApproval } from '../stores/permissionStore'

/**
 * 审批弹窗的**文案表**（M5 收口：把散落在组件里的中文硬编码收成一处）。
 *
 * 为什么单独一层：
 * - 文案与语义解耦：`choice`（协议语义）是稳定的，`label`（人类文案）可能随版本改；
 *   UI 一律按 `choice` 回包（见 `lib/approval.ts`），改文案不会改行为；
 * - 收录边界：这里的文案**只用于展示**。真正发给 pi 的选项文本来自扩展上报的
 *   `request.options`（扩展侧权威），二者不混用——避免「客户端文案即协议」的错误耦合。
 */
export const APPROVAL_ACTION_LABELS: Record<ApprovalChoice, string> = {
  allow_once: '允许一次',
  allow_session: '本会话允许',
  deny: '拒绝'
}

export interface ApprovalActionSpec {
  choice: ApprovalChoice
  testId: string
  /** 按钮样式修饰类（`undefined` = 默认样式） */
  variant?: 'primary' | 'danger'
}

/**
 * 三个动作的**顺序**与扩展侧 `choices` 对齐（允许一次 / 本会话允许 / 拒绝）。
 * 顺序即语义，渲染时按此数组遍历，不要在 JSX 里手写三份按钮。
 */
export const APPROVAL_ACTIONS: readonly ApprovalActionSpec[] = [
  { choice: 'allow_once', testId: 'approval-allow-once', variant: 'primary' },
  { choice: 'allow_session', testId: 'approval-allow-session' },
  { choice: 'deny', testId: 'approval-deny', variant: 'danger' }
]

/** 风险等级文案（键与扩展上报的 `meta.risk` 一一对应） */
export const RISK_LABELS: Record<PendingApproval['request']['meta']['risk'], string> = {
  critical: '极高',
  high: '高',
  medium: '中'
}
