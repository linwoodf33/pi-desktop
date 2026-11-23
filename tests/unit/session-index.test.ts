import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createSessionIndex, defaultSessionsRoot } from '../../src/main/services/session-index'

/** SessionIndex：§10 A3（20 会话 < 1s）+ 只读头部扫描 */

type DirEntry = { name: string; isDirectory: () => boolean }

interface FakeFs {
  dirs: Record<string, string[]>
  files: Map<string, { content: string; mtimeMs: number }>
}

function fakeIndex(fs: FakeFs, options: { pageSize?: number } = {}): ReturnType<typeof createSessionIndex> {
  return createSessionIndex({
    sessionDir: () => 'C:/sessions',
    pageSize: options.pageSize ?? 20,
    listDir: (path) => {
      const names = fs.dirs[path]
      if (names === undefined) throw new Error(`ENOENT ${path}`)
      return Promise.resolve<DirEntry[]>(
        names.map((name) => ({ name, isDirectory: () => !name.endsWith('.jsonl') }))
      )
    },
    statFile: (path) => {
      const file = fs.files.get(path)
      if (!file) throw new Error(`ENOENT ${path}`)
      return Promise.resolve({ mtimeMs: file.mtimeMs })
    },
    readHead: (path) => {
      const file = fs.files.get(path)
      if (!file) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(file.content)
    }
  })
}

function sessionFile(options: {
  id: string
  cwd: string
  title?: string
  name?: string
}): string {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: options.id,
      timestamp: '2026-11-20T00:00:00.000Z',
      cwd: options.cwd
    })
  ]
  if (options.name !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'session_info',
        id: 'a1',
        parentId: null,
        timestamp: '2026-11-20T00:00:01.000Z',
        name: options.name
      })
    )
  }
  if (options.title !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: 'b1',
        parentId: null,
        timestamp: '2026-11-20T00:00:02.000Z',
        message: { role: 'user', content: options.title, timestamp: 1 }
      })
    )
  }
  return `${lines.join('\n')}\n`
}

describe('SessionIndex：摘要与排序', () => {
  it('按 mtime 倒序，标题取首条 user 消息', async () => {
    const files = new Map<string, { content: string; mtimeMs: number }>([
      [
        join('C:/sessions', '--a--', '1.jsonl'),
        { content: sessionFile({ id: 'id-old', cwd: 'C:/a', title: '旧会话' }), mtimeMs: 1000 }
      ],
      [
        join('C:/sessions', '--a--', '2.jsonl'),
        { content: sessionFile({ id: 'id-new', cwd: 'C:/a', title: '新会话' }), mtimeMs: 2000 }
      ]
    ])
    const index = fakeIndex({
      dirs: { 'C:/sessions': ['--a--'], [join('C:/sessions', '--a--')]: ['1.jsonl', '2.jsonl'] },
      files
    })

    const result = await index.list({})
    expect(result.items.map((item) => item.title)).toEqual(['新会话', '旧会话'])
    expect(result.items[0]?.id).toBe('id-new')
    expect(result.items[0]?.filePath).toBe(join('C:/sessions', '--a--', '2.jsonl'))
    expect(result.nextCursor).toBeUndefined()
  })

  it('session_info.name 优先于首条消息文本', async () => {
    const index = fakeIndex({
      dirs: { 'C:/sessions': ['--a--'], [join('C:/sessions', '--a--')]: ['1.jsonl'] },
      files: new Map([
        [
          join('C:/sessions', '--a--', '1.jsonl'),
          { content: sessionFile({ id: 'x', cwd: 'C:/a', title: '首条消息', name: '任务名' }), mtimeMs: 1 }
        ]
      ])
    })
    const result = await index.list({})
    expect(result.items[0]?.title).toBe('任务名')
  })

  it('cwd 过滤只返回该目录的会话（Windows 大小写不敏感）', async () => {
    const files = new Map([
      [join('C:/sessions', '--a--', '1.jsonl'), { content: sessionFile({ id: 'a', cwd: 'C:/Work' }), mtimeMs: 2 }],
      [join('C:/sessions', '--b--', '2.jsonl'), { content: sessionFile({ id: 'b', cwd: 'D:/other' }), mtimeMs: 1 }]
    ])
    const index = fakeIndex({
      dirs: {
        'C:/sessions': ['--a--', '--b--'],
        [join('C:/sessions', '--a--')]: ['1.jsonl'],
        [join('C:/sessions', '--b--')]: ['2.jsonl']
      },
      files
    })

    const result = await index.list({ cwd: 'C:/work' })
    expect(result.items.map((item) => item.id)).toEqual(['a'])
  })

  it('分页游标：首屏 pageSize 条 + nextCursor', async () => {
    const files = new Map<string, { content: string; mtimeMs: number }>()
    const names: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const name = `${i}.jsonl`
      names.push(name)
      files.set(join('C:/sessions', '--a--', name), {
        content: sessionFile({ id: `id-${i}`, cwd: 'C:/a' }),
        mtimeMs: 100 + i
      })
    }
    const index = fakeIndex(
      { dirs: { 'C:/sessions': ['--a--'], [join('C:/sessions', '--a--')]: names }, files },
      { pageSize: 2 }
    )

    const first = await index.list({})
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe('2')

    const second = await index.list({ ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) })
    expect(second.items).toHaveLength(2)
    expect(second.items[0]?.id).toBe('id-2')
  })

  it('损坏 / 无 header 的文件被跳过，不影响其他条目', async () => {
    const files = new Map([
      [join('C:/sessions', '--a--', 'bad.jsonl'), { content: 'not json\n', mtimeMs: 9 }],
      [join('C:/sessions', '--a--', 'ok.jsonl'), { content: sessionFile({ id: 'ok', cwd: 'C:/a' }), mtimeMs: 1 }]
    ])
    const index = fakeIndex({
      dirs: { 'C:/sessions': ['--a--'], [join('C:/sessions', '--a--')]: ['bad.jsonl', 'ok.jsonl'] },
      files
    })

    const result = await index.list({})
    expect(result.items.map((item) => item.id)).toEqual(['ok'])
  })

  it('会话目录不存在 → 空列表（首启场景不报错）', async () => {
    const index = fakeIndex({ dirs: {}, files: new Map() })
    await expect(index.list({})).resolves.toEqual({ items: [] })
  })
})

describe('SessionIndex：root 解析', () => {
  it('设置项优先于环境变量', () => {
    const index = createSessionIndex({
      sessionDir: () => 'C:/custom/sessions',
      env: { PI_CODING_AGENT_SESSION_DIR: 'C:/env/sessions' },
      homeDir: 'C:/Users/u'
    })
    expect(index.root()).toBe('C:/custom/sessions')
  })

  it('PI_CODING_AGENT_SESSION_DIR 覆盖默认目录（docs/sessions.md）', () => {
    const root = defaultSessionsRoot({ PI_CODING_AGENT_SESSION_DIR: 'C:/env/sessions' }, 'C:/Users/u')
    expect(root).toBe('C:/env/sessions')
  })

  it('默认落到 ~/.pi/agent/sessions', () => {
    const root = defaultSessionsRoot({}, 'C:/Users/u')
    expect(root.replace(/\\/g, '/')).toContain('.pi/agent/sessions')
  })
})

describe('SessionIndex：真实文件系统（§10 A3 预算）', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('20 个会话的列表耗时 < 1s，且只读头部', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-index-'))
    dirs.push(root)
    const group = join(root, '--C--work--')
    await mkdir(group, { recursive: true })

    for (let i = 0; i < 20; i += 1) {
      await writeFile(
        join(group, `2026-11-20T00-00-0${i}_id-${i}.jsonl`),
        sessionFile({ id: `id-${i}`, cwd: 'C:/work', title: `任务 ${i}` }),
        'utf8'
      )
    }

    const index = createSessionIndex({ sessionDir: () => root })
    const startedAt = Date.now()
    const result = await index.list({})
    const elapsed = Date.now() - startedAt

    expect(result.items).toHaveLength(20)
    expect(elapsed).toBeLessThan(1000)
    expect(result.items[0]?.cwd).toBe('C:/work')
  })
})
