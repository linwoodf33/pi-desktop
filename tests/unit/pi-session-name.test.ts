import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appendSessionName } from '../../src/main/services/pi-session-name'
import { createSessionIndex } from '../../src/main/services/session-index'

/**
 * A23：改会话显示名（历史任务路径）。
 *
 * pi 的会话名是 JSONL 里的 `session_info` 记录（不是文件头字段），所以历史任务改名
 * = **追加一条**同形记录，绝不重写既有内容（最坏情况只多一行）。
 *
 * 注意：「索引能读到新名字」必须用**真实规模的会话**验证 —— 改名记录落在文件尾，
 * 而索引的头部预算只有 32KB；用几十字节的夹具会让这条用例永远绿（历史假绿）。
 */
describe('appendSessionName', () => {
  function withFile(content: string): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pi-session-name-'))
    // pi 的会话按「会话根/<cwd-key>/xxx.jsonl」存放；索引只扫一层子目录
    const cwdKey = join(dir, '--work--')
    mkdirSync(cwdKey, { recursive: true })
    const file = join(cwdKey, 'session.jsonl')
    writeFileSync(file, content, 'utf8')
    return { dir, file }
  }

  /** 一条 60KB 的**单行**用户消息（超过索引的 32KB 头部预算，模拟真实长会话） */
  function bigMessageLine(): string {
    return `${JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-11-20T00:00:02.000Z',
      message: { role: 'user', content: `超长首条消息 ${'填'.repeat(20_000)}`, timestamp: 1 }
    })}\n`
  }

  it('追加一条与 pi 同形的 session_info，且不改动原内容', () => {
    const original = '{"type":"session","version":3,"id":"a","cwd":"/work"}\n'
    const { dir, file } = withFile(original)
    try {
      const { record } = appendSessionName({
        sessionFile: file,
        name: '  重构 认证  ',
        now: () => new Date('2026-11-24T00:00:00.000Z')
      })
      expect(record).toMatchObject({
        type: 'session_info',
        name: '重构 认证',
        timestamp: '2026-11-24T00:00:00.000Z',
        // 接上最后一条记录的 id：与 pi 的 RPC set_session_name 写出的形状完全一致
        parentId: 'a'
      })
      // pi 用 8 位十六进制 id
      expect(record['id']).toMatch(/^[0-9a-f]{8}$/)

      const after = readFileSync(file, 'utf8')
      expect(after.startsWith(original)).toBe(true)
      const lines = after.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
        type: 'session_info',
        name: '重构 认证'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('索引能读到新名字（会话 > 32KB 且含 60KB 单行记录，名字只在文件尾）', async () => {
    const { dir, file } = withFile(
      '{"type":"session","version":3,"id":"a","cwd":"/work"}\n' + bigMessageLine()
    )
    try {
      // 前提：文件确实超过索引的 32KB 头部预算（否则这条用例测不到尾部回退）
      expect(Buffer.byteLength(readFileSync(file, 'utf8'), 'utf8')).toBeGreaterThan(32 * 1024)

      appendSessionName({ sessionFile: file, name: '新名字' })

      const index = createSessionIndex({ sessionDir: () => dir })
      const listed = await index.list({})
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0]?.title).toBe('新名字')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('连续改名 3 次，索引只认最后一条（last-wins）', async () => {
    const { dir, file } = withFile(
      '{"type":"session","version":3,"id":"a","cwd":"/work"}\n' + bigMessageLine()
    )
    try {
      for (const name of ['第一版', '第二版', '第三版']) {
        appendSessionName({ sessionFile: file, name })
      }
      const index = createSessionIndex({ sessionDir: () => dir })
      const listed = await index.list({})
      expect(listed.items[0]?.title).toBe('第三版')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空名字 / 非 .jsonl / 文件不存在 → 明确报错', () => {
    const { dir, file } = withFile('x\n')
    try {
      expect(() => appendSessionName({ sessionFile: file, name: '   ' })).toThrow(/不能为空/)
      expect(() => appendSessionName({ sessionFile: join(dir, 'a.txt'), name: 'x' })).toThrow(
        /jsonl/
      )
      expect(() =>
        appendSessionName({ sessionFile: join(dir, 'missing.jsonl'), name: 'x' })
      ).toThrow(/不存在/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
