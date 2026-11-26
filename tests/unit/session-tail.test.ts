import { mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_TAIL_MAX_SCAN_BYTES,
  DEFAULT_TAIL_WINDOW_BYTES,
  findLastRecordInTail,
  findLastRecordInTailSync
} from '../../src/main/services/session-tail'

/**
 * 会话 JSONL 的尾部反向扫描（A23 改名修复的核心原语）。
 *
 * 全部用例都用**真实临时文件**：本 bug 之所以长期没被测试抓到，正是因为旧单测把
 * `readHead` 注入成「返回整文件内容」，等于豁免了 32KB 预算。
 */
const isSessionInfo = (record: Record<string, unknown>): boolean =>
  record['type'] === 'session_info'

function infoLine(name: string): string {
  return `${JSON.stringify({
    type: 'session_info',
    id: 'abcd1234',
    parentId: null,
    timestamp: '2026-11-20T00:00:03.000Z',
    name
  })}\n`
}

function messageLine(text: string): string {
  return `${JSON.stringify({
    type: 'message',
    id: 'b1',
    parentId: null,
    timestamp: '2026-11-20T00:00:02.000Z',
    message: { role: 'user', content: text, timestamp: 1 }
  })}\n`
}

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-tail-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  await writeFile(file, content, 'utf8')
  return file
}

describe('findLastRecordInTail：基本命中与 last-wins', () => {
  it('T1：窗口内最后一行是 session_info → 返回该记录', async () => {
    const file = await tempFile(`${messageLine('你好')}${infoLine('任务甲')}`)
    const found = await findLastRecordInTail(file, isSessionInfo)
    expect(found?.['name']).toBe('任务甲')
    expect(findLastRecordInTailSync(file, isSessionInfo)?.['name']).toBe('任务甲')
  })

  it('T2：2MB 内多条 session_info，其后还有其他记录 → 只返回最后一条', async () => {
    const parts: string[] = ['{"type":"session","version":3,"id":"s","cwd":"/w"}\n']
    parts.push(infoLine('第一版'))
    for (let i = 0; i < 400; i += 1) parts.push(messageLine(`第 ${i} 条消息${'填'.repeat(200)}`))
    parts.push(infoLine('第二版'))
    for (let i = 0; i < 50; i += 1) parts.push(messageLine(`第二版之后的 ${i}`))
    parts.push(infoLine('第三版'))
    parts.push(messageLine('改名之后又聊了几句'))
    const file = await tempFile(parts.join(''))
    // 文件远小于 2MB（上限内），但明显大于 128KB 窗口 → 需要多轮反向扫描
    expect((await findLastRecordInTail(file, isSessionInfo))?.['name']).toBe('第三版')
    expect(findLastRecordInTailSync(file, isSessionInfo)?.['name']).toBe('第三版')
  })

  it('T3：末尾是半行 JSON（写盘途中被读到）→ 跳过，回落到上一条完整记录', async () => {
    const file = await tempFile(
      `${messageLine('你好')}${infoLine('完整名字')}{"type":"session_info","id":"zz","name":"半行`
    )
    expect((await findLastRecordInTail(file, isSessionInfo))?.['name']).toBe('完整名字')
    expect(findLastRecordInTailSync(file, isSessionInfo)?.['name']).toBe('完整名字')
  })

  it('T4：窗口边界切在多字节 UTF-8 字符中间 → 不崩、名字正确', async () => {
    // 全中文 + 极小窗口：几乎必然有某次窗口起点落在「填」的 3 字节中间
    const body = `${messageLine('填'.repeat(120))}${infoLine('中文名字')}`
    const file = await tempFile(body)
    const found = await findLastRecordInTail(file, isSessionInfo, { windowBytes: 7 })
    expect(found?.['name']).toBe('中文名字')
    expect(findLastRecordInTailSync(file, isSessionInfo, { windowBytes: 7 })?.['name']).toBe(
      '中文名字'
    )
  })

  it('T5：CRLF 行尾 → 正常命中', async () => {
    const content = `${messageLine('你好').trimEnd()}\r\n${infoLine('CRLF 名字').trimEnd()}\r\n`
    const file = await tempFile(content)
    expect((await findLastRecordInTail(file, isSessionInfo))?.['name']).toBe('CRLF 名字')
    expect(findLastRecordInTailSync(file, isSessionInfo)?.['name']).toBe('CRLF 名字')
  })

  it('T6：完全没有 session_info → undefined', async () => {
    const file = await tempFile(`${messageLine('只有消息')}${messageLine('第二条')}`)
    await expect(findLastRecordInTail(file, isSessionInfo)).resolves.toBeUndefined()
  })

  it('T7：文件不存在 → undefined（不抛）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-session-tail-missing-'))
    dirs.push(dir)
    const missing = join(dir, 'nope.jsonl')
    await expect(findLastRecordInTail(missing, isSessionInfo)).resolves.toBeUndefined()
    expect(findLastRecordInTailSync(missing, isSessionInfo)).toBeUndefined()
  })
})

describe('findLastRecordInTail：窗口与扫描上限', () => {
  it('T8：单行 > windowBytes 且该行就是 session_info → 分块拼接后命中', async () => {
    const file = await tempFile(infoLine(`长名${'x'.repeat(200_000)}`))
    const found = await findLastRecordInTail(file, isSessionInfo)
    expect(typeof found?.['name']).toBe('string')
    expect(String(found?.['name']).startsWith('长名')).toBe(true)
    expect(String(found?.['name']).length).toBe(200_002)
    expect(String(findLastRecordInTailSync(file, isSessionInfo)?.['name']).length).toBe(200_002)
  })

  it('T9：记录在 maxScanBytes 之外 → undefined（已知缺口显式化）', async () => {
    const parts: string[] = [infoLine('文件开头的旧名字')]
    for (let i = 0; i < 300; i += 1) parts.push(messageLine(`后续消息 ${i}${'填'.repeat(100)}`))
    const file = await tempFile(parts.join(''))
    // 只允许反扫 32KB：文件开头的 session_info 在预算之外
    const options = { windowBytes: 8 * 1024, maxScanBytes: 32 * 1024 }
    expect(await findLastRecordInTail(file, isSessionInfo, options)).toBeUndefined()
    expect(findLastRecordInTailSync(file, isSessionInfo, options)).toBeUndefined()
    // 放开到默认上限就应当找得到 —— 证明上面是「预算边界」而不是解析失败
    expect((await findLastRecordInTail(file, isSessionInfo))?.['name']).toBe('文件开头的旧名字')
  })

  it('窗口大于文件、追加行后仍取最后一条（append 场景）', async () => {
    const file = await tempFile(infoLine('旧名字'))
    await appendFile(file, infoLine('新名字'), 'utf8')
    expect((await findLastRecordInTail(file, isSessionInfo))?.['name']).toBe('新名字')
    expect(DEFAULT_TAIL_WINDOW_BYTES).toBe(128 * 1024)
    expect(DEFAULT_TAIL_MAX_SCAN_BYTES).toBe(2 * 1024 * 1024)
  })
})
