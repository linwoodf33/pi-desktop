import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_RECORDS,
  createSessionHistory,
  parseEntries,
  resolveRealSessionPath,
  resolveSessionPath,
  toReplayRecords
} from '../../src/main/services/session-history'
import { IpcFailure } from '../../src/shared/contracts/result'

/**
 * `session:history`（M3 补充通道）单测：
 * 只读回放 + 路径收敛（§7 约束 8）+ 超限显式截断（§7 约束 14）。
 */
let root: string
let sessionFile: string

const header = (cwd = 'C:/work') =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd
  })

const userEntry = (text: string) =>
  JSON.stringify({
    type: 'message',
    id: 'u1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1735689601000 }
  })

const assistantEntry = (text: string, toolCallId?: string) =>
  JSON.stringify({
    type: 'message',
    id: 'a1',
    parentId: 'u1',
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...(toolCallId === undefined
          ? []
          : [{ type: 'toolCall', id: toolCallId, name: 'bash', arguments: { command: 'ls' } }])
      ],
      timestamp: 1735689602000
    }
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-history-'))
  await mkdir(join(root, '--group--'), { recursive: true })
  sessionFile = join(root, '--group--', 'sess-1.jsonl')
  await writeFile(
    sessionFile,
    [header(), userEntry('列出目录'), assistantEntry('好的', 'call_1'), ''].join('\n'),
    'utf8'
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('路径收敛（§7 约束 8）', () => {
  it('会话根目录内的 .jsonl 放行', () => {
    expect(resolveSessionPath(root, sessionFile)).toBe(sessionFile)
  })

  it('../ 逃逸被拒绝（PATH_DENIED）', () => {
    expect(() =>
      resolveSessionPath(join(root, '--group--'), '../--group--/sess-1.jsonl')
    ).not.toThrow()
    expect(() => resolveSessionPath(root, '../outside.jsonl')).toThrow(IpcFailure)
  })

  it('非 .jsonl 文件被拒绝', () => {
    expect(() => resolveSessionPath(root, join(root, '--group--', 'notes.txt'))).toThrow(
      /只允许回放 .jsonl/
    )
  })
})

/**
 * M4 前置修复：`resolveSessionPath` 只做字符串收敛，junection / 符号链接仍可指向站外。
 * 这里用真实的 fs 验证「词法通过 → realpath 拦截」。
 */
describe('真实路径校验（junction / 符号链接逃逸）', () => {
  it('会话目录内的普通文件放行（realpath 归一后仍在根内）', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    const result = await history.read({ sessionFile })
    expect(result.messageCount).toBe(2)
  })

  it('文件级符号链接指向目录外时拒绝（PATH_DENIED）', async () => {
    // Windows 创建文件级 symlink 需要开发者模式/管理员权限，因此这里注入 realpath
    // 模拟「词法在内、真实路径在外」的情况（junction 变体由下一个用例用真实 fs 验证）
    const realPath = (value: string): Promise<string> =>
      Promise.resolve(value === sessionFile ? 'C:/outside/secret.jsonl' : value)
    await expect(
      createSessionHistory({ sessionRoot: () => root, realPath }).read({ sessionFile })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('目录 junction / 目录符号链接指向会话根外时拒绝', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pi-history-outside-dir-'))
    const outsideFile = join(outsideDir, 'redirected.jsonl')
    await writeFile(outsideFile, [header(), userEntry('站外目录')].join('\n'), 'utf8')

    // 整个分组目录被链接到站外（Windows 下 junction 不需管理员权限）
    const linkedDir = join(root, '--linked-group--')
    await symlink(outsideDir, linkedDir, 'junction')

    const linkedFile = join(linkedDir, 'redirected.jsonl')
    // 词法层面完全在会话根内（这就是 M3 的漏洞）
    expect(() => resolveSessionPath(root, linkedFile)).not.toThrow()

    await expect(
      createSessionHistory({ sessionRoot: () => root }).read({ sessionFile: linkedFile })
    ).rejects.toThrow(/符号链接|真实路径/)

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('文件不存在时 fail-closed（PATH_DENIED，不放行未确认路径）', async () => {
    await expect(
      createSessionHistory({ sessionRoot: () => root }).read({
        sessionFile: join(root, '--group--', 'missing.jsonl')
      })
    ).rejects.toThrow(IpcFailure)
  })

  it('resolveRealSessionPath 可单独测试（注入 realpath）', async () => {
    const calls: string[] = []
    const realPath = (value: string): Promise<string> => {
      calls.push(value)
      // 根目录归一后仍是自身；目标归一后跑到站外
      return Promise.resolve(value === sessionFile ? '/elsewhere/x.jsonl' : value)
    }
    await expect(resolveRealSessionPath(realPath, root, sessionFile)).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    expect(calls).toHaveLength(2)
  })
})

describe('回放转换', () => {
  it('message 条目归一成 message_end 记录（与 evt:record 同形）', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    const result = await history.read({ sessionFile })

    expect(result.truncated).toBe(false)
    expect(result.messageCount).toBe(2)
    expect(result.totalRecords).toBe(2)
    expect(result.records.map((record) => record.type)).toEqual(['message_end', 'message_end'])
    const first = result.records[0]
    expect((first?.['message'] as { role?: string } | undefined)?.role).toBe('user')
  })

  it('失败消息的 stopReason / errorMessage 原样透传到 message_end（§决策 7 边界）', () => {
    // 回放与实时共用同一套归约，因此透传边界必须锁住：main 侧不得裁剪、不得重写字段。
    const message = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Request timed out.: Connect Timeout Error (mock)',
      timestamp: 1735689602000
    }
    const records = toReplayRecords([{ type: 'message', message }])

    expect(records).toEqual([{ type: 'message_end', message }])
  })

  it('非 message 条目被忽略，损坏行不拖垮整个回放', async () => {
    await writeFile(
      sessionFile,
      [
        header(),
        'not json',
        JSON.stringify({ type: 'model_change', provider: 'x' }),
        userEntry('hi')
      ].join('\n'),
      'utf8'
    )
    const history = createSessionHistory({ sessionRoot: () => root })
    const result = await history.read({ sessionFile })
    expect(result.messageCount).toBe(1)
  })

  it('maxRecords 只保留最后 N 条，并标记 truncated', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    const result = await history.read({ sessionFile, maxRecords: 1 })
    expect(result.messageCount).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.totalRecords).toBe(2)
    expect((result.records[0]?.['message'] as { role?: string } | undefined)?.role).toBe(
      'assistant'
    )
  })

  it('不传 maxRecords 时按默认 2000 条截断（M4：避免 O(n²) 回放）', async () => {
    const lines: string[] = [header()]
    for (let index = 0; index < DEFAULT_MAX_RECORDS + 50; index += 1) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `u${index}`,
          parentId: null,
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: `第 ${index} 条`, timestamp: 1735689601000 + index }
        })
      )
    }
    await writeFile(sessionFile, lines.join('\n'), 'utf8')

    const result = await createSessionHistory({ sessionRoot: () => root }).read({ sessionFile })
    expect(result.records).toHaveLength(DEFAULT_MAX_RECORDS)
    expect(result.totalRecords).toBe(DEFAULT_MAX_RECORDS + 50)
    expect(result.truncated).toBe(true)
    // 保留的是**尾部**（最近的），不是开头
    const last = result.records.at(-1)?.['message'] as { content?: string } | undefined
    expect(last?.content).toBe(`第 ${DEFAULT_MAX_RECORDS + 49} 条`)
  })

  it('默认上限可由设置覆盖（defaultMaxRecords）', async () => {
    const result = await createSessionHistory({
      sessionRoot: () => root,
      defaultMaxRecords: () => 1
    }).read({ sessionFile })
    expect(result.records).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('超过回放上限时只读尾部并显式 truncated（丢弃被切半的首行）', async () => {
    // 尾部 400 字节：能覆盖最后一条消息，但会切到上一条的半行
    const history = createSessionHistory({ sessionRoot: () => root, maxBytes: 400 })
    const result = await history.read({ sessionFile })
    expect(result.truncated).toBe(true)
    // 尾部至少能拿到最后一条消息
    expect(result.messageCount).toBeGreaterThanOrEqual(1)
    const last = result.records.at(-1)
    expect((last?.['message'] as { role?: string } | undefined)?.role).toBe('assistant')
  })
})

describe('纯函数', () => {
  it('toReplayRecords 只映射 message 条目', () => {
    const records = toReplayRecords([
      { type: 'session' },
      { type: 'message', message: { role: 'user', content: 'x' } },
      { type: 'message' },
      { type: 'compaction' }
    ])
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ type: 'message_end', message: { role: 'user', content: 'x' } })
  })

  it('parseEntries 剥离 CR、跳过空行与标量行', () => {
    const entries = parseEntries('{"a":1}\r\n\nnull\n42\n{"b":2}')
    expect(entries).toEqual([{ a: 1 }, { b: 2 }])
  })
})

/**
 * M4 复核修复 B1：fork 后新会话文件可能**尚未落盘**。
 *
 * pi 从第一条用户消息分叉时 `targetLeafId = null` → `newSession({parentSession})` 得到**空会话**，
 * 文件要等下一条 prompt 才写；旧实现让 renderer 把这种情况报成 `PATH_DENIED`（误导性错误条）。
 *
 * 修复要点：只有显式 `allowMissing: true`（fork 编排）才把「文件不存在」当成空会话，
 * 且 realpath 的 fail-closed 语义**不变**（越界 / 权限 / 父目录不可信一律 PATH_DENIED）。
 */
describe('尚未落盘的新会话文件（B1：allowMissing 容错，安全闸不降）', () => {
  const missingFile = (): string => join(root, '--group--', 'fork-empty.jsonl')

  it('allowMissing: true + 文件不存在 → 空会话 + fileAbsent: true（不报错）', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    const result = await history.read({ sessionFile: missingFile(), allowMissing: true })

    expect(result).toEqual({
      records: [],
      truncated: false,
      messageCount: 0,
      totalRecords: 0,
      fileAbsent: true
    })
  })

  it('不传 allowMissing 时仍是 fail-closed（普通回放路径不因 B1 放宽）', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    await expect(history.read({ sessionFile: missingFile() })).rejects.toMatchObject({
      code: 'PATH_DENIED'
    })
    await expect(
      history.read({ sessionFile: missingFile(), allowMissing: false })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('词法闸照旧：allowMissing 也不能读会话根外的路径', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    await expect(
      history.read({ sessionFile: join(root, '..', 'outside.jsonl'), allowMissing: true })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
    await expect(
      history.read({ sessionFile: join(root, '--group--', 'notes.txt'), allowMissing: true })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('父目录是 junction 指向会话根外时仍拒绝（父目录真实路径闸）', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'pi-history-outside-b1-'))
    const linkedDir = join(root, '--linked-b1--')
    await symlink(outsideDir, linkedDir, 'junction')

    // 文件在 linkedDir 里**不存在**：allowMissing 也不能放行（父目录真实路径在根外）
    await expect(
      createSessionHistory({ sessionRoot: () => root }).read({
        sessionFile: join(linkedDir, 'fork-empty.jsonl'),
        allowMissing: true
      })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })

    await rm(outsideDir, { recursive: true, force: true })
  })

  it('父目录本身不存在时拒绝（连“属于本会话根”都无法确认）', async () => {
    await expect(
      createSessionHistory({ sessionRoot: () => root }).read({
        sessionFile: join(root, '--no-such-group--', 'fork-empty.jsonl'),
        allowMissing: true
      })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('非 ENOENT 的 realpath 失败仍 fail-closed（权限类错误不当作“未落盘”）', async () => {
    const realPath = (value: string): Promise<string> => {
      if (value === sessionFile) {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        error.code = 'EACCES'
        return Promise.reject(error)
      }
      return Promise.resolve(value)
    }
    await expect(
      createSessionHistory({ sessionRoot: () => root, realPath }).read({
        sessionFile,
        allowMissing: true
      })
    ).rejects.toMatchObject({ code: 'PATH_DENIED' })
  })

  it('文件存在时 allowMissing 不影响正常回放（fileAbsent 不出现）', async () => {
    const result = await createSessionHistory({ sessionRoot: () => root }).read({
      sessionFile,
      allowMissing: true
    })
    expect(result.messageCount).toBe(2)
    expect(result.fileAbsent).toBeUndefined()
  })

  it('③ 发消息后文件落盘 → 同一路径可正常回放（不依赖 allowMissing）', async () => {
    const history = createSessionHistory({ sessionRoot: () => root })
    const target = missingFile()
    expect((await history.read({ sessionFile: target, allowMissing: true })).fileAbsent).toBe(true)

    // 模拟 pi 在下一条 prompt 后懒落盘：写入这个路径
    await writeFile(
      target,
      [header(), userEntry('分叉后的第一句'), assistantEntry('好'), ''].join('\n'),
      'utf8'
    )

    const afterWrite = await history.read({ sessionFile: target })
    expect(afterWrite.fileAbsent).toBeUndefined()
    expect(afterWrite.messageCount).toBe(2)
    expect((afterWrite.records[0]?.['message'] as { content?: string } | undefined)?.content).toBe(
      '分叉后的第一句'
    )
  })

  it('realpath 与 read 之间文件消失时也按空会话处理（allowMissing）', async () => {
    // realpath 返回成功但文件其实不存在（TOCTOU 窄窗口）：readTail 报 ENOENT → 空会话
    const realPath = (value: string): Promise<string> => Promise.resolve(value)
    const result = await createSessionHistory({
      sessionRoot: () => root,
      realPath
    }).read({ sessionFile: missingFile(), allowMissing: true })
    expect(result.fileAbsent).toBe(true)
    expect(result.records).toEqual([])
  })
})
