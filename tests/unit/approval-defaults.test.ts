import { describe, expect, it } from 'vitest'

import {
  APPROVAL_CHOICES,
  DEFAULT_APPROVAL_TOOLS as EXTENSION_DEFAULT_APPROVAL_TOOLS
} from '../../src/extensions/permission/protocol'
import { defaultConfigView } from '../../src/main/services/config-store'
import { APPROVAL_ACTIONS, APPROVAL_ACTION_LABELS } from '../../src/renderer/lib/approval-copy'
import { DEFAULT_APPROVAL_TOOLS as SHARED_DEFAULT_APPROVAL_TOOLS } from '../../src/shared/contracts/permission'

/**
 * 收口债 #2 / #1：审批默认清单与文案表的「单一来源」钉子。
 *
 * 背景：`DEFAULT_APPROVAL_TOOLS` 原来在 `config-store.ts` 与扩展 `protocol.ts` 各写一份，
 * 谁都不是权威；`ApprovalDialog.tsx` 里三个按钮的文案也是硬编码。现在：
 * - 客户端侧唯一来源 = `shared/contracts/permission.ts`（ConfigStore 从这里取）；
 * - 扩展侧必须保留一份副本（扩展装到 `~/.pi/agent/extensions` 后只能依赖自身目录），
 *   所以用本测试把两份钉成「同值同序」——改一边不改另一边立刻红；
 * - 弹窗文案进 `lib/approval-copy.ts`，动作顺序必须与扩展侧 `choices` 对齐。
 */
describe('审批默认工具清单（单一来源）', () => {
  it('ConfigStore 默认值取自 shared 常量（不复制字面量）', () => {
    const view = defaultConfigView({})
    expect(view.permission.tools).toEqual([...SHARED_DEFAULT_APPROVAL_TOOLS])
    expect(view.permission.enabled).toBe(true)
  })

  it('扩展侧副本与 shared 同值同序（扩展无法 import shared，只能靠本断言保持一致）', () => {
    expect([...EXTENSION_DEFAULT_APPROVAL_TOOLS]).toEqual([...SHARED_DEFAULT_APPROVAL_TOOLS])
  })

  it('默认清单就是 §Q4 的高风险四项', () => {
    expect([...SHARED_DEFAULT_APPROVAL_TOOLS]).toEqual(['bash', 'powershell', 'write', 'edit'])
  })
})

describe('审批弹窗文案表', () => {
  it('三个动作齐全、顺序与扩展 choices 对齐', () => {
    expect(APPROVAL_ACTIONS.map((action) => action.choice)).toEqual([...APPROVAL_CHOICES])
  })

  it('每个动作都有非空文案，且拒绝的文案是「拒绝」', () => {
    for (const action of APPROVAL_ACTIONS) {
      expect(APPROVAL_ACTION_LABELS[action.choice].length).toBeGreaterThan(0)
    }
    expect(APPROVAL_ACTION_LABELS.deny).toBe('拒绝')
  })

  it('testId 稳定（E2E 依赖它们点击按钮）', () => {
    expect(APPROVAL_ACTIONS.map((action) => action.testId)).toEqual([
      'approval-allow-once',
      'approval-allow-session',
      'approval-deny'
    ])
  })
})
