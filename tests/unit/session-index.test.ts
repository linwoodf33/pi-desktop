import { appendFile, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { realpathNative } from '../../src/main/services/realpath-native'
import { createSessionIndex, defaultSessionsRoot } from '../../src/main/services/session-index'
import { findLastRecordInTail } from '../../src/main/services/session-tail'

/** SessionIndex：§10 A3（20 会话 < 1s）+ 头部窗口 + 尾部窗口 */

type DirEntry = { name: string; isDirectory: () => boolean }

interface FakeFs {
  dirs: Record<string, string[]>
  files: Map<string, { content: string; mtimeMs: number }>
}

/** 头部读取按**字节**截断（旧实现「直接返回整文件内容」正是本 bug 长期假绿的根源） */
function truncateUtf8(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, 'utf8')
  return bytes.length <= maxBytes ? content : bytes.subarray(0, maxBytes).toString('utf8')
}

function fakeIndex(
  fs: FakeFs,
  options: { pageSize?: number } = {}
): ReturnType<typeof createSessionIndex> {
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
      return Promise.resolve({ mtimeMs: file.mtimeMs, size: Buffer.byteLength(file.content) })
    },
    readHead: (path, maxBytes) => {
      const file = fs.files.get(path)
      if (!file) return Promise.reject(new Error(`ENOENT ${path}`))
      return Promise.resolve(truncateUtf8(file.content, maxBytes))
    }
  })
}

function sessionFile(options: { id: string; cwd: string; title?: string; name?: string }): string {
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
          {
            content: sessionFile({ id: 'x', cwd: 'C:/a', title: '首条消息', name: '任务名' }),
            mtimeMs: 1
          }
        ]
      ])
    })
    const result = await index.list({})
    expect(result.items[0]?.title).toBe('任务名')
  })

  it('cwd 过滤只返回该目录的会话（Windows 大小写不敏感）', async () => {
    const files = new Map([
      [
        join('C:/sessions', '--a--', '1.jsonl'),
        { content: sessionFile({ id: 'a', cwd: 'C:/Work' }), mtimeMs: 2 }
      ],
      [
        join('C:/sessions', '--b--', '2.jsonl'),
        { content: sessionFile({ id: 'b', cwd: 'D:/other' }), mtimeMs: 1 }
      ]
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

    const second = await index.list({
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor })
    })
    expect(second.items).toHaveLength(2)
    expect(second.items[0]?.id).toBe('id-2')
  })

  it('损坏 / 无 header 的文件被跳过，不影响其他条目', async () => {
    const files = new Map([
      [join('C:/sessions', '--a--', 'bad.jsonl'), { content: 'not json\n', mtimeMs: 9 }],
      [
        join('C:/sessions', '--a--', 'ok.jsonl'),
        { content: sessionFile({ id: 'ok', cwd: 'C:/a' }), mtimeMs: 1 }
      ]
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

  it('小文件（size <= headBytes）不发起尾部读取', async () => {
    let tailCalls = 0
    const index = createSessionIndex({
      sessionDir: () => 'C:/sessions',
      listDir: (path) =>
        Promise.resolve<DirEntry[]>(
          path === 'C:/sessions'
            ? [{ name: '--a--', isDirectory: () => true }]
            : [{ name: '1.jsonl', isDirectory: () => false }]
        ),
      statFile: () => Promise.resolve({ mtimeMs: 1, size: 120 }),
      readHead: () => Promise.resolve(sessionFile({ id: 'small', cwd: 'C:/a', name: '小名' })),
      findTailRecord: () => {
        tailCalls += 1
        return Promise.resolve(undefined)
      }
    })
    const result = await index.list({})
    expect(result.items[0]?.title).toBe('小名')
    expect(tailCalls).toBe(0)
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
    const root = defaultSessionsRoot(
      { PI_CODING_AGENT_SESSION_DIR: 'C:/env/sessions' },
      'C:/Users/u'
    )
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

/**
 * S1–S8：本 bug 的回归用例（会话名写在文件尾 / 索引只读头部）。
 *
 * 全部用**真实临时文件**：任何「注入 readHead 返回整文件」的 fake 都会让这些用例失去意义。
 * 典型夹具 = 头部 + 一条 40–60KB 的**单行**用户消息（32KB 头部预算连它都装不下）。
 */
describe('SessionIndex：尾部补读与头部回退（A23 改名回归，真实文件）', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const HEADER = `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sid-1',
    timestamp: '2026-11-20T00:00:00.000Z',
    cwd: 'C:/work'
  })}\n`

  function infoRecord(name: string): string {
    return `${JSON.stringify({
      type: 'session_info',
      id: 'c1',
      parentId: 'b1',
      timestamp: '2026-11-20T00:00:03.000Z',
      name
    })}\n`
  }

  /** 一条**单行**的大用户消息（fillBytes 以字节计；中文 3 字节/字） */
  function bigUserMessage(text: string, fillBytes: number): string {
    return `${JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-11-20T00:00:02.000Z',
      message: {
        role: 'user',
        content: `${text}${'填'.repeat(Math.ceil(fillBytes / 3))}`,
        timestamp: 1
      }
    })}\n`
  }

  /** 一条**单行**的填充消息（默认 assistant 角色，用来把首条用户消息推到头部窗口之外） */
  function fillerMessage(text: string, fillBytes: number): string {
    return `${JSON.stringify({
      type: 'message',
      id: 'p1',
      parentId: null,
      timestamp: '2026-11-20T00:00:04.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${text}${'填'.repeat(Math.ceil(fillBytes / 3))}` }],
        timestamp: 1
      }
    })}
`
  }

  async function writeSession(lines: string[]): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(tmpdir(), 'pi-index-tail-'))
    dirs.push(root)
    const group = join(root, '--C--work--')
    await mkdir(group, { recursive: true })
    const file = join(group, 's.jsonl')
    await writeFile(file, lines.join(''), 'utf8')
    return { root, file }
  }

  it('S1：头部无 name、尾部有 session_info → 用尾部名字（本 bug 的回归断言）', async () => {
    const { root } = await writeSession([
      HEADER,
      bigUserMessage('首条消息', 40 * 1024),
      infoRecord('新名字')
    ])
    const index = createSessionIndex({ sessionDir: () => root })
    const listed = await index.list({})
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.title).toBe('新名字')
  })

  it('S2：头部有 name、尾部有更新的 name → 用尾部值（last-wins）', async () => {
    const { root } = await writeSession([
      HEADER,
      infoRecord('头部名'),
      bigUserMessage('中间消息', 40 * 1024),
      infoRecord('尾部名')
    ])
    const index = createSessionIndex({ sessionDir: () => root })
    expect((await index.list({})).items[0]?.title).toBe('尾部名')
  })

  it('S3：尾部没有 name、头部有（--name 建的老会话）→ 用头部值，不回归', async () => {
    const { root } = await writeSession([
      HEADER,
      infoRecord('头部名'),
      bigUserMessage('中间消息', 40 * 1024)
    ])
    const index = createSessionIndex({ sessionDir: () => root })
    expect((await index.list({})).items[0]?.title).toBe('头部名')
  })

  it('S4：无 name、头部看不到首条消息 → 前向补扫拿到首条消息（P1-2）', async () => {
    const { root } = await writeSession([HEADER, bigUserMessage('首条消息', 60 * 1024)])
    const index = createSessionIndex({ sessionDir: () => root })
    const title = (await index.list({})).items[0]?.title
    expect(title?.startsWith('首条消息')).toBe(true)
  })

  it('S5：既无 name 也无任何消息 → 仍是「(未命名会话)」', async () => {
    const { root } = await writeSession([HEADER])
    const index = createSessionIndex({ sessionDir: () => root })
    expect((await index.list({})).items[0]?.title).toBe('(未命名会话)')
  })

  it('S6：尾部读取抛错（注入 reject）→ 摘要仍返回（fail-soft），走头部/前向回退', async () => {
    const { root } = await writeSession([
      HEADER,
      // 首条用户消息被推到头部 32KB 之外（必须靠前向补扫才看得到）
      fillerMessage('预热', 40 * 1024),
      bigUserMessage('首条消息', 10),
      // 文件总长 > 前向补扫上限（512KB）：尾部那条 session_info 落在补扫范围之外，
      // 这样「尾部读失败」时既不会误读尾部名，也验证了前向补扫的兜底
      fillerMessage('长填充', 600 * 1024),
      infoRecord('尾部名')
    ])
    const index = createSessionIndex({
      sessionDir: () => root,
      findTailRecord: () => Promise.reject(new Error('尾部读失败（模拟 EPERM/删除）'))
    })
    const listed = await index.list({})
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]?.id).toBe('sid-1')
    expect(listed.items[0]?.title?.startsWith('首条消息')).toBe(true)
  })

  it('S7：size <= headBytes 的文件零尾部 IO（注入计数器断言 0 次）', async () => {
    const { root } = await writeSession([HEADER, infoRecord('小文件名字')])
    let tailCalls = 0
    const index = createSessionIndex({
      sessionDir: () => root,
      findTailRecord: (path, predicate) => {
        tailCalls += 1
        return findLastRecordInTail(path, predicate)
      }
    })
    expect((await index.list({})).items[0]?.title).toBe('小文件名字')
    expect(tailCalls).toBe(0)
  })

  it('S9：首条消息在头部窗口内（有 title）+ 尾部改名 → 仍取尾部名', async () => {
    // 最贴近用户实际场景的形态：会话不大，头部能读到首条消息（所以 title 不为空），
    // 名字只在文件尾。若把尾扫改成「仅在头部拿不到名字时触发」，这条会立刻变红。
    const { root } = await writeSession([
      HEADER,
      bigUserMessage('首条消息', 1024),
      fillerMessage('后续对话', 40 * 1024),
      infoRecord('尾部名')
    ])
    const index = createSessionIndex({ sessionDir: () => root })
    const title = (await index.list({})).items[0]?.title
    expect(title).toBe('尾部名')
  })

  it('S8：改名后 invalidate() → 再 list 读到新名（mtime 被固定，排除 mtime 驱动）', async () => {
    const { root, file } = await writeSession([HEADER, infoRecord('旧名字')])
    // 固定 mtime：摘要缓存必然命中，唯一能让新名字出现的就是 invalidate()
    const index = createSessionIndex({
      sessionDir: () => root,
      statFile: () => Promise.resolve({ mtimeMs: 1_000 })
    })
    expect((await index.list({})).items[0]?.title).toBe('旧名字')

    await appendFile(file, infoRecord('新名字'), 'utf8')
    expect((await index.list({})).items[0]?.title).toBe('旧名字') // 缓存仍在

    index.invalidate(file)
    expect((await index.list({})).items[0]?.title).toBe('新名字')

    // 无参数 = 清空全部缓存
    index.invalidate()
    expect((await index.list({})).items[0]?.title).toBe('新名字')
  })
})

/**
 * S9a–S9c：`SessionIndex.find` —— 单路径授权（A39/A23 F1）。
 *
 * 全部用真实临时文件：`find` 的价值就在于「真实路径归一 + 布局闸 + 摘要闸」，
 * 任何注入式 fake 都会退化成「再实现一遍 find」。
 */
describe('SessionIndex.find：单路径判定（A39）', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  /** 真实规模的会话（> 64KB 单行记录，确保不是靠「小文件恰好能读」通过） */
  function content(id: string): string {
    const header = JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-11-20T00:00:00.000Z',
      cwd: 'C:/work'
    })
    const big = JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-11-20T00:00:02.000Z',
      message: { role: 'user', content: `首条消息${'填'.repeat(25_000)}`, timestamp: 1 }
    })
    return `${header}
${big}
`
  }

  async function makeRoot(prefix: string): Promise<string> {
    const root = await realpathNative(await mkdtemp(join(tmpdir(), prefix)))
    dirs.push(root)
    return root
  }

  it('S9a：根内深度 2 的会话文件命中；根外 / 深度不符 / 相对路径 → undefined', async () => {
    const root = await makeRoot('pi-index-find-')
    const group = join(root, '--C--work--')
    await mkdir(group, { recursive: true })
    const file = join(group, 's.jsonl')
    await writeFile(file, content('sid-1'), 'utf8')
    const loose = join(root, 'loose.jsonl')
    await writeFile(loose, content('sid-loose'), 'utf8')

    const outsideDir = await mkdtemp(join(tmpdir(), 'pi-index-find-outside-'))
    dirs.push(outsideDir)
    const outsideFile = join(outsideDir, 'x.jsonl')
    await writeFile(outsideFile, content('sid-outside'), 'utf8')

    const index = createSessionIndex({ sessionDir: () => root })
    const found = await index.find(file)
    expect(found?.id).toBe('sid-1')
    expect(found?.filePath).toBe(await realpathNative(file))

    expect(await index.find(outsideFile)).toBeUndefined()
    expect(await index.find(loose)).toBeUndefined()
    expect(await index.find(join(group, 'missing.jsonl'))).toBeUndefined()
    expect(await index.find('relative.jsonl')).toBeUndefined()
  })

  it('S9b：25 条会话时第 25 条也能命中（不受 pageSize=20 影响）', async () => {
    const root = await makeRoot('pi-index-find-many-')
    const files: string[] = []
    for (let i = 0; i < 25; i += 1) {
      const group = join(root, `--g${i}--`)
      await mkdir(group, { recursive: true })
      const file = join(group, 's.jsonl')
      await writeFile(file, content(`sid-${i}`), 'utf8')
      // mtime 严格递增：首页固定是 sid-24..sid-5，目标（sid-0）一定不在首页
      const at = new Date(Date.UTC(2026, 10, 20, 0, 0, i))
      await utimes(file, at, at)
      files.push(file)
    }

    const index = createSessionIndex({ sessionDir: () => root })
    const firstPage = await index.list({})
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.items.some((item) => item.id === 'sid-0')).toBe(false)

    const oldest = files[0]!
    const found = await index.find(oldest)
    expect(found?.id).toBe('sid-0')
    expect(found?.filePath).toBe(await realpathNative(oldest))
  })

  it('S9c：分组目录是指向根外的 junction → undefined（真实路径闸）', async (ctx) => {
    const root = await makeRoot('pi-index-find-link-')
    const outsideDir = await mkdtemp(join(tmpdir(), 'pi-index-find-link-out-'))
    dirs.push(outsideDir)
    const outsideFile = join(outsideDir, 'redirected.jsonl')
    await writeFile(outsideFile, content('sid-redirected'), 'utf8')

    const linkedDir = join(root, '--linked--')
    try {
      await symlink(outsideDir, linkedDir, 'junction')
    } catch (error) {
      // 与 session-history.test.ts 同口径：创建失败时**显式 skip**（return 空跑会伪装成绿）
      ctx.skip(`无法创建 junction：${String(error)}`)
      return
    }

    const index = createSessionIndex({ sessionDir: () => root })
    expect(await index.find(join(linkedDir, 'redirected.jsonl'))).toBeUndefined()
  })
})
