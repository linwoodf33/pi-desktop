import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { appendSessionName } from '../../src/main/services/pi-session-name'

/**
 * A23：改会话显示名（历史任务路径）。
 *
 * pi 的会话名是 JSONL 里的 `session_info` 记录（不是文件头字段），所以历史任务改名
 * = **追加一条**同形记录，绝不重写既有内容（最坏情况只多一行）。
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
        timestamp: '2026-11-24T00:00:00.000Z'
      })
      expect(typeof record['id']).toBe('string')

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

  it('自动化索引能读到新名字（name 字段来自 session_info）', async () => {
    const { dir, file } = withFile('{"type":"session","version":3,"id":"a","cwd":"/work"}\n')
    try {
      appendSessionName({ sessionFile: file, name: '新名字' })
      const { createSessionIndex } = await import('../../src/main/services/session-index')
      const index = createSessionIndex({ sessionDir: () => dir })
      const listed = await index.list({})
      expect(listed.items[0]?.title).toBe('新名字')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空名字 / 非 .jsonl / 文件不存在 → 明确报错', () => {
    const { dir, file } = withFile('x\n')
    try {
      expect(() => appendSessionName({ sessionFile: file, name: '   ' })).toThrowError(/不能为空/)
      expect(() => appendSessionName({ sessionFile: join(dir, 'a.txt'), name: 'x' })).toThrowError(
        /jsonl/
      )
      expect(() =>
        appendSessionName({ sessionFile: join(dir, 'missing.jsonl'), name: 'x' })
      ).toThrowError(/不存在/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
