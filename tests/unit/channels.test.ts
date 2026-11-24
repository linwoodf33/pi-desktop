import { describe, expect, it } from 'vitest'

import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '../../src/shared/ipc-channels'
import { getInputSchema, invokeInputSchemas } from '../../src/shared/contracts/schemas'

describe('IPC 通道白名单（§5.4）', () => {
  it('invoke 通道与 §5.4 表格一致（+ M3/M4 补充通道）', () => {
    expect([...INVOKE_CHANNELS].sort()).toEqual(
      [
        'app:getBoot',
        'pi:locate',
        'session:list',
        // M3 补充：§5.4 缺「选中历史会话只回放 JSONL」的通道（§6.1 第 4 步）
        'session:history',
        'session:create',
        'session:resume',
        'session:fork',
        'session:prompt',
        'session:abort',
        'session:dispose',
        'session:state',
        // M4 补充：pi get_session_stats / get_fork_messages / ConfigStore 持久化
        'session:stats',
        // A23 补充：改会话显示名（活跃会话 RPC / 历史任务追加 session_info）
        'session:setName',
        'session:forkPoints',
        'config:update',
        // M5 补充：审批扩展安装状态（只读）
        'permission:status',
        'model:list',
        'model:set',
        // A18 补充：agent 目录（只读）+ `--agent` 能力探测
        'agents:list',
        // A14 补充：模型管理（pi models.json / settings.json#defaultModel）
        'models:read',
        'models:setDefault',
        'models:upsertProvider',
        'models:removeProvider',
        'models:upsertModel',
        'models:removeModel',
        'extui:respond',
        'fs:pickDirectory',
        // A22 补充：引用工作区文件（返回工作区相对路径）
        'fs:pickWorkspaceFile',
        'fs:listArtifacts',
        'fs:readText',
        'fs:diff',
        'artifact:open'
      ].sort()
    )
  })

  it('每个白名单通道都有 zod 入参 schema（类型层面由 satisfies 保证，运行时再断言一次）', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(invokeInputSchemas[channel]).toBeDefined()
      expect(getInputSchema(channel)).toBe(invokeInputSchemas[channel])
    }
    // 反向：schema 表里没有多余通道
    expect(Object.keys(invokeInputSchemas).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('事件通道为 §5.4 事件表四条', () => {
    expect([...EVENT_CHANNELS].sort()).toEqual(
      ['evt:record', 'evt:extui', 'evt:status', 'evt:diagnostic'].sort()
    )
  })

  it('所有通道都带命名空间前缀，便于审计', () => {
    for (const channel of [...INVOKE_CHANNELS, ...EVENT_CHANNELS]) {
      expect(channel).toMatch(/^[a-z]+:[A-Za-z]+$/)
    }
  })

  it('isInvokeChannel / isEventChannel 只对白名单返回 true', () => {
    expect(isInvokeChannel(IPC_INVOKE_CHANNELS.sessionList)).toBe(true)
    expect(isInvokeChannel('fs:evil')).toBe(false)
    expect(isInvokeChannel('evt:record')).toBe(false)

    expect(isEventChannel(IPC_EVENT_CHANNELS.status)).toBe(true)
    expect(isEventChannel('evt:unknown')).toBe(false)
  })

  it('通道名唯一，没有重复项', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })
})

describe('入参 schema 细节', () => {
  it('fs:readText 的 maxBytes 受 64KB 预览上限约束（§7 约束 14）', () => {
    const schema = getInputSchema(IPC_INVOKE_CHANNELS.fsReadText)
    expect(schema.safeParse({ path: 'a.txt', maxBytes: 64 * 1024 }).success).toBe(true)
    expect(schema.safeParse({ path: 'a.txt', maxBytes: 64 * 1024 + 1 }).success).toBe(false)
    expect(schema.safeParse({ path: 'a.txt', maxBytes: 0 }).success).toBe(false)
  })

  it('session:prompt 的 streamingBehavior 只接受 steer / followUp（§7 约束 5）', () => {
    const schema = getInputSchema(IPC_INVOKE_CHANNELS.sessionPrompt)
    expect(
      schema.safeParse({ sessionKey: 'k1', message: 'hi', streamingBehavior: 'steer' }).success
    ).toBe(true)
    expect(
      schema.safeParse({ sessionKey: 'k1', message: 'hi', streamingBehavior: 'followUp' }).success
    ).toBe(true)
    expect(
      schema.safeParse({ sessionKey: 'k1', message: 'hi', streamingBehavior: 'queue' }).success
    ).toBe(false)
  })

  it('空 schema 通道拒绝任何多余字段', () => {
    const schema = getInputSchema(IPC_INVOKE_CHANNELS.modelList)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ what: 1 }).success).toBe(false)
  })

  it('config:update 只接受偏好字段，且拒绝疑似密钥（§7 约束 9/12、U14）', () => {
    const schema = getInputSchema(IPC_INVOKE_CHANNELS.configUpdate)
    expect(schema.safeParse({ maxActiveSessions: 4 }).success).toBe(true)
    expect(schema.safeParse({ sessionDir: '' }).success).toBe(true)
    // 未知字段
    expect(schema.safeParse({ unknownSetting: 1 }).success).toBe(false)
    // 疑似密钥字段（即使名字看起来像配置）
    expect(schema.safeParse({ piToken: 'x' }).success).toBe(false)
    // 越界值
    expect(schema.safeParse({ maxActiveSessions: 0 }).success).toBe(false)
    expect(schema.safeParse({ idleRecycleMinutes: 0 }).success).toBe(false)
  })

  it('session:fork 的 entryId 与 messageId 互斥', () => {
    const schema = getInputSchema(IPC_INVOKE_CHANNELS.sessionFork)
    expect(schema.safeParse({ sessionKey: 'k1', entryId: 'e1' }).success).toBe(true)
    expect(schema.safeParse({ sessionKey: 'k1' }).success).toBe(true)
    expect(schema.safeParse({ sessionKey: 'k1', entryId: 'e1', messageId: 'm1' }).success).toBe(
      false
    )
  })
})
