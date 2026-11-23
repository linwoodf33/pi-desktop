import { useState } from 'react'

import type { ApprovalChoice } from '../../../shared/contracts/permission'
import { remainingSeconds } from '../../lib/approval'
import { APPROVAL_ACTIONS, APPROVAL_ACTION_LABELS, RISK_LABELS } from '../../lib/approval-copy'
import type { PendingApproval } from '../../stores/permissionStore'

/**
 * 审批弹窗（M5，§6.3 / §8.1 A5）。
 *
 * 展示内容（全部来自扩展上报的**结构化元数据**，不是 HTML 字符串）：
 * - 工具名 + 风险等级 + 一行参数摘要；
 * - 可展开的参数明细（已由扩展侧脱敏：密钥字段打码、单值截断 160 字符）；
 * - 三个动作：允许一次 / 本会话允许 / 拒绝（顺序与扩展侧 `choices` 对齐）。
 *
 * 安全：全部走 React 文本节点渲染，`dangerouslySetInnerHTML` 零使用（§9.4 S3）；
 * 倒计时只是展示，真正的超时判定在 `lib/approval.ts`（同源于扩展侧 timeout）。
 */
export interface ApprovalDialogProps {
  pending: PendingApproval
  /** 当前已等待毫秒（由父组件定时刷新；仅用于展示剩余时间） */
  elapsedMs: number
  onRespond: (choice: ApprovalChoice) => void
}

export function ApprovalDialog({ pending, elapsedMs, onRespond }: ApprovalDialogProps) {
  const [expanded, setExpanded] = useState(false)
  const { request } = pending
  const remaining = remainingSeconds(request, pending.receivedAt, pending.receivedAt + elapsedMs)
  const args = request.meta.args

  return (
    <div className="approval" data-testid="approval-dialog" role="dialog" aria-modal="true">
      <div className="approval__card">
        <div className="approval__head">
          <span className={`approval__risk approval__risk--${request.meta.risk}`}>
            风险 {RISK_LABELS[request.meta.risk]}
          </span>
          <h3 className="approval__title" data-testid="approval-tool">
            需要批准：{request.meta.tool}
          </h3>
          <span className="approval__timer" data-testid="approval-remaining">
            {remaining}s
          </span>
        </div>

        {request.meta.summary.length > 0 ? (
          <p className="approval__summary" data-testid="approval-summary">
            {request.meta.summary}
          </p>
        ) : null}

        {/* 人类可读的风险说明由扩展写在 title 里（机器元数据行已剥离） */}
        {request.humanText.length > 0 ? (
          <p className="approval__reason" data-testid="approval-reason">
            {request.humanText}
          </p>
        ) : null}

        {args.length > 0 ? (
          <div className="approval__args">
            <button
              type="button"
              className="btn btn--small"
              data-testid="approval-expand"
              onClick={() => {
                setExpanded((value) => !value)
              }}
            >
              {expanded ? '收起参数' : '展开参数'}
            </button>
            {expanded ? (
              <dl className="approval__arglist" data-testid="approval-args">
                {args.map((arg) => (
                  <div className="approval__arg" key={arg.k}>
                    <dt>{arg.k}</dt>
                    {/* 纯文本渲染：参数已在扩展侧脱敏 + 截断，这里不解析任何标记 */}
                    <dd>
                      <code>{arg.v}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}

        <p className="approval__note">
          超时将按「拒绝」处理；扩展协议 v{request.meta.protocol} · {request.meta.version}
        </p>

        {/* 三个动作来自文案表（`lib/approval-copy.ts`），顺序与扩展侧 `choices` 对齐 */}
        <div className="approval__actions">
          {APPROVAL_ACTIONS.map((action) => (
            <button
              key={action.choice}
              type="button"
              className={action.variant === undefined ? 'btn' : `btn btn--${action.variant}`}
              data-testid={action.testId}
              onClick={() => {
                onRespond(action.choice)
              }}
            >
              {APPROVAL_ACTION_LABELS[action.choice]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
