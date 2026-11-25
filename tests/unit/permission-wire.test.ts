import { describe, expect, it } from 'vitest'

import {
  APPROVAL_CHOICES,
  APPROVAL_OPTIONS,
  EXTENSION_VERSION,
  buildHandshake,
  encodeApprovalTitle,
  encodeHandshake,
  parsePolicy,
  redactValue,
  summarizeToolInput,
  assessRisk
} from '../../src/extensions/permission/protocol'
import {
  PERMISSION_MARKER_PREFIX,
  PERMISSION_PROTOCOL_VERSION,
  PERMISSION_STATUS_KEY,
  classifyExtUi,
  clientApprovalTimeoutMs,
  optionForChoice,
  parseApprovalTitle,
  parseHandshake,
  toExtensionUiResponse,
  CLIENT_APPROVAL_LEAD_MS
} from '../../src/shared/contracts/permission'
import type { ExtUiEvent } from '../../src/shared/contracts/types'

/**
 * 审批线上格式的**双侧**契约测试（M5）。
 *
 * 扩展侧（`src/extensions/permission/protocol.ts`，编码）与客户端侧
 * （`src/shared/contracts/permission.ts`，解码）是两份代码，这里用同一份样例做往返，
 * 任何一侧偷改格式都会立刻红——这是「不靠文档、靠测试钉死格式」的防线。
 */

const META_BASE = {
  protocol: PERMISSION_PROTOCOL_VERSION,
  version: EXTENSION_VERSION,
  tool: 'bash',
  risk: 'high' as const,
  summary: 'npm run build',
  args: [{ k: 'command', v: 'npm run build' }],
  timeoutMs: 120_000
}

function approvalEvent(title: string, options: string[] = [...APPROVAL_OPTIONS]): ExtUiEvent {
  return {
    sessionKey: 's1-abc',
    request: {
      type: 'extension_ui_request',
      id: 'req-1',
      method: 'select',
      title,
      options,
      timeout: 120_000
    }
  }
}

describe('审批 title 的编码 → 解码往返', () => {
  it('扩展编码的 title 能被客户端完整解析（含元数据与人类文本）', () => {
    const title = encodeApprovalTitle({ ...META_BASE, sessionId: 'sess-9' }, '执行 shell 命令')
    const parsed = parseApprovalTitle(title)
    expect(parsed).toBeDefined()
    expect(parsed?.meta.tool).toBe('bash')
    expect(parsed?.meta.risk).toBe('high')
    expect(parsed?.meta.summary).toBe('npm run build')
    expect(parsed?.meta.args).toEqual([{ k: 'command', v: 'npm run build' }])
    expect(parsed?.meta.timeoutMs).toBe(120_000)
    expect(parsed?.meta.options).toEqual([...APPROVAL_OPTIONS])
    expect(parsed?.meta.choices).toEqual([...APPROVAL_CHOICES])
    expect(parsed?.meta.sessionId).toBe('sess-9')
    // 人类可读部分不含机器元数据行
    expect(parsed?.humanText).toContain('需要批准：bash')
    expect(parsed?.humanText).not.toContain(PERMISSION_MARKER_PREFIX)
  })

  it('元数据行始终是单行（值里的换行被 JSON 转义，不会破坏解析）', () => {
    const title = encodeApprovalTitle(
      { ...META_BASE, summary: 'line1\nline2', args: [{ k: 'command', v: 'a\nb' }] },
      'reason'
    )
    const lines = title.split('\n')
    const markerLine = lines.at(-1) ?? ''
    expect(markerLine.startsWith(PERMISSION_MARKER_PREFIX)).toBe(true)
    const parsed = parseApprovalTitle(title)
    // 摘要按原样保留（换行仍是换行），关键是它被 JSON 转义后没有逃出元数据行
    expect(parsed?.meta.summary).toBe('line1\nline2')
    expect(parsed?.meta.args[0]?.v).toBe('a\nb')
  })

  it('非本扩展的 title / 坏 JSON / 缺字段 一律解析失败（调用方按拒绝处理）', () => {
    expect(parseApprovalTitle('随便一个普通标题')).toBeUndefined()
    expect(parseApprovalTitle(`${PERMISSION_MARKER_PREFIX}{broken`)).toBeUndefined()
    expect(
      parseApprovalTitle(`${PERMISSION_MARKER_PREFIX}${JSON.stringify({ tool: 'bash' })}`)
    ).toBeUndefined()
  })
})

describe('classifyExtUi：审批 / 握手 / 忽略', () => {
  it('select 审批请求被识别，options 以 pi 请求字段为准', () => {
    const title = encodeApprovalTitle(META_BASE, '执行 shell 命令')
    const result = classifyExtUi(approvalEvent(title, ['A', 'B', 'C']))
    expect(result.kind).toBe('approval')
    if (result.kind !== 'approval') throw new Error('unreachable')
    expect(result.request.options).toEqual(['A', 'B', 'C'])
    expect(result.request.timeoutMs).toBe(120_000)
    expect(result.request.requestId).toBe('req-1')
  })

  it('setStatus 握手（同协议）→ compatible', () => {
    const handshake = buildHandshake(parsePolicy(undefined))
    const event: ExtUiEvent = {
      sessionKey: 's1',
      request: {
        type: 'extension_ui_request',
        id: 'hs-1',
        method: 'setStatus',
        statusKey: PERMISSION_STATUS_KEY,
        statusText: encodeHandshake(handshake)
      }
    }
    const result = classifyExtUi(event)
    expect(result.kind).toBe('handshake')
    if (result.kind !== 'handshake') throw new Error('unreachable')
    expect(result.compatible).toBe(true)
    expect(result.handshake.protocol).toBe(PERMISSION_PROTOCOL_VERSION)
  })

  it('协议版本不一致的握手 → 明确 incompatible（不得静默放行）', () => {
    const event: ExtUiEvent = {
      sessionKey: 's1',
      request: {
        type: 'extension_ui_request',
        id: 'hs-2',
        method: 'setStatus',
        statusKey: PERMISSION_STATUS_KEY,
        statusText: JSON.stringify({
          ext: 'pi-desktop-permission',
          version: '9.9.9',
          protocol: PERMISSION_PROTOCOL_VERSION + 1,
          enabled: true,
          tools: ['bash'],
          timeoutMs: 120_000,
          compatible: true
        })
      }
    }
    const result = classifyExtUi(event)
    expect(result.kind).toBe('handshake')
    if (result.kind !== 'handshake') throw new Error('unreachable')
    expect(result.compatible).toBe(false)
  })

  it('其它扩展的 setStatus / notify / confirm 都不参与审批', () => {
    const other: ExtUiEvent = {
      sessionKey: 's1',
      request: {
        type: 'extension_ui_request',
        id: 'x',
        method: 'setStatus',
        statusKey: 'other-ext',
        statusText: '{}'
      }
    }
    expect(classifyExtUi(other).kind).toBe('ignored')
    const notify: ExtUiEvent = {
      sessionKey: 's1',
      request: { type: 'extension_ui_request', id: 'y', method: 'notify', message: 'hi' }
    }
    expect(classifyExtUi(notify).kind).toBe('ignored')
    const confirm: ExtUiEvent = {
      sessionKey: 's1',
      request: {
        type: 'extension_ui_request',
        id: 'z',
        method: 'confirm',
        title: 't',
        message: 'm'
      }
    }
    expect(classifyExtUi(confirm).kind).toBe('ignored')
  })

  it('select 但 title 不是本扩展格式 → 忽略（不弹审批窗）', () => {
    const result = classifyExtUi(approvalEvent('别的扩展的 select'))
    expect(result.kind).toBe('ignored')
  })
})

describe('响应组装与单项时钟', () => {
  it('optionForChoice 按 choices 下标取文案（不按文案匹配）', () => {
    const title = encodeApprovalTitle(META_BASE, 'r')
    const classified = classifyExtUi(approvalEvent(title, ['允许一次', '本会话允许', '拒绝']))
    if (classified.kind !== 'approval') throw new Error('unreachable')
    expect(optionForChoice(classified.request, 'allow_once')).toBe('允许一次')
    expect(optionForChoice(classified.request, 'allow_session')).toBe('本会话允许')
    expect(optionForChoice(classified.request, 'deny')).toBe('拒绝')
  })

  it('cancel → cancelled:true；select → value', () => {
    expect(toExtensionUiResponse('r1', { kind: 'cancel' })).toEqual({
      type: 'extension_ui_response',
      id: 'r1',
      cancelled: true
    })
    expect(toExtensionUiResponse('r1', { kind: 'select', value: '允许一次' })).toEqual({
      type: 'extension_ui_response',
      id: 'r1',
      value: '允许一次'
    })
  })

  it('客户端超时 = 扩展 timeout 减提前量（同一个时钟，不引入第二套语义）', () => {
    expect(clientApprovalTimeoutMs(120_000)).toBe(120_000 - CLIENT_APPROVAL_LEAD_MS)
    // 极小值有下限，避免变成立即拒绝
    expect(clientApprovalTimeoutMs(200)).toBe(1_000)
    // 非法值回退默认时钟
    expect(clientApprovalTimeoutMs(0)).toBe(120_000 - CLIENT_APPROVAL_LEAD_MS)
  })
})

describe('参数摘要脱敏（不得把密钥/长文本整段塞进 UI 或日志）', () => {
  it('疑似密钥字段整段打码', () => {
    const { args } = summarizeToolInput({ command: 'curl x', apiKey: 'abcd1234', password: 'p@ss' })
    expect(args.find((arg) => arg.k === 'apiKey')?.v).toBe('[已隐藏]')
    expect(args.find((arg) => arg.k === 'password')?.v).toBe('[已隐藏]')
  })

  it('值里的令牌样式被打码', () => {
    expect(redactValue('token=sk-abcdefghijklmnopqrstuvwxyz')).toContain('[已隐藏]')
    expect(redactValue('ghp_abcdefghijklmnopqrstuvwxyz01')).toBe('[已隐藏]')
  })

  it('长值截断到 160 字符，最多 8 个字段', () => {
    const long = 'x'.repeat(500)
    const { args } = summarizeToolInput({ command: long })
    expect(args[0]?.v.length).toBeLessThanOrEqual(161)
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v']))
    expect(summarizeToolInput(many).args.length).toBe(8)
  })

  it('破坏性命令被识别为 critical 风险', () => {
    expect(assessRisk('bash', { command: 'rm -rf /tmp/x' }).risk).toBe('critical')
    expect(assessRisk('bash', { command: 'ls -la' }).risk).toBe('high')
    expect(assessRisk('write', { path: 'a.txt' }).risk).toBe('medium')
  })
})

describe('策略解析 fail-closed', () => {
  it('环境变量缺失 → 默认开启审批 + 默认工具清单', () => {
    const policy = parsePolicy(undefined)
    expect(policy.enabled).toBe(true)
    expect(policy.tools).toEqual(['bash', 'powershell', 'write', 'edit'])
    expect(policy.compatible).toBe(true)
  })

  it('非法 JSON / 非对象 → 仍默认开启并给出 warning（绝不因配置坏了就放行）', () => {
    for (const raw of ['{broken', '"string"', '[1,2,3]']) {
      const policy = parsePolicy(raw)
      expect(policy.enabled).toBe(true)
      expect(policy.warning).toBeDefined()
    }
  })

  it('显式 enabled:false 才关闭；timeout 被 clamp', () => {
    const policy = parsePolicy(JSON.stringify({ enabled: false, timeoutMs: 1 }))
    expect(policy.enabled).toBe(false)
    expect(policy.timeoutMs).toBe(5_000)
  })

  it('客户端协议版本不一致 → compatible=false', () => {
    const policy = parsePolicy(JSON.stringify({ protocolVersion: 7 }))
    expect(policy.compatible).toBe(false)
    expect(policy.warning).toContain('不兼容')
  })

  it('工具名统一小写去重', () => {
    const policy = parsePolicy(JSON.stringify({ tools: ['Bash', 'bash', ' Write '] }))
    expect(policy.tools).toEqual(['bash', 'write'])
  })
})

describe('握手里的无 UI 策略（noUi，A35）', () => {
  function handshakeEvent(statusText: string): ExtUiEvent {
    return {
      sessionKey: 's1',
      request: {
        type: 'extension_ui_request',
        id: 'hs-no-ui',
        method: 'setStatus',
        statusKey: PERMISSION_STATUS_KEY,
        statusText
      }
    }
  }

  it('新扩展握手带 noUi:allow → 解析仍是 allow，且不影响兼容性', () => {
    const statusText = encodeHandshake(
      buildHandshake(parsePolicy(JSON.stringify({ noUi: 'allow' })))
    )
    expect(parseHandshake(statusText)?.noUi).toBe('allow')

    const result = classifyExtUi(handshakeEvent(statusText))
    expect(result.kind).toBe('handshake')
    if (result.kind !== 'handshake') throw new Error('unreachable')
    expect(result.handshake.noUi).toBe('allow')
    expect(result.compatible).toBe(true)
  })

  it('老扩展握手不含 noUi → 按 deny 解读，且不因此判为不兼容', () => {
    const statusText = JSON.stringify({
      ext: 'pi-desktop-permission',
      version: '1.0.0',
      protocol: PERMISSION_PROTOCOL_VERSION,
      enabled: true,
      tools: ['bash'],
      timeoutMs: 120_000,
      compatible: true
    })
    expect(parseHandshake(statusText)?.noUi).toBe('deny')

    const result = classifyExtUi(handshakeEvent(statusText))
    expect(result.kind).toBe('handshake')
    if (result.kind !== 'handshake') throw new Error('unreachable')
    expect(result.compatible).toBe(true)
  })

  it('noUi 取值非法 → 归 deny，但握手本身仍可解析（不返回 undefined）', () => {
    const statusText = JSON.stringify({
      ext: 'pi-desktop-permission',
      version: '1.0.0',
      protocol: PERMISSION_PROTOCOL_VERSION,
      enabled: true,
      tools: ['bash'],
      timeoutMs: 120_000,
      compatible: true,
      noUi: 'garbage'
    })
    const parsed = parseHandshake(statusText)
    expect(parsed).toBeDefined()
    expect(parsed?.noUi).toBe('deny')
  })
})
