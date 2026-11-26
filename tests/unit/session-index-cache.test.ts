import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createSessionIndex } from '../../src/main/services/session-index'

/**
 * SessionIndex 的 mtime 缓存（§10 A3：万级会话不退化）。
 *
 * 会话 JSONL 只追加不重写 ⇒ mtime 不变即可复用上次的摘要，不必重读 32KB 头部。
 * 另外给出 20 / 100 / 1000 会话的实测 list 耗时（报告用）。
 */

type DirEntry = { name: string; isDirectory: () => boolean }

interface FakeFs {
  dirs: Record<string, string[]>
  files: Map<string, { content: string; mtimeMs: number }>
}

function headerOnly(id: string): string {
  return `${JSON.stringify({
    type: 'session',
    version: 3,
    id,
    timestamp: '2026-11-20T00:00:00.000Z',
    cwd: 'C:/work'
  })}\n${JSON.stringify({
    type: 'message',
    id: 'b1',
    parentId: null,
    timestamp: '2026-11-20T00:00:02.000Z',
    message: { role: 'user', content: `任务 ${id}`, timestamp: 1 }
  })}\n`
}

describe('SessionIndex mtime 缓存', () => {
  function setup() {
    const files = new Map<string, { content: string; mtimeMs: number }>([
      [join('C:/sessions', '--a--', '1.jsonl'), { content: headerOnly('id-1'), mtimeMs: 1000 }],
      [join('C:/sessions', '--a--', '2.jsonl'), { content: headerOnly('id-2'), mtimeMs: 2000 }]
    ])
    const fs: FakeFs = {
      dirs: { 'C:/sessions': ['--a--'], [join('C:/sessions', '--a--')]: ['1.jsonl', '2.jsonl'] },
      files
    }
    let headReads = 0
    const index = createSessionIndex({
      sessionDir: () => 'C:/sessions',
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
        headReads += 1
        const file = fs.files.get(path)
        if (!file) return Promise.reject(new Error(`ENOENT ${path}`))
        return Promise.resolve(file.content)
      }
    })
    return { index, fs, headReads: () => headReads }
  }

  it('mtime 未变时不重读头部（第二次 list 零头部读取）', async () => {
    const { index, headReads } = setup()
    const first = await index.list({})
    expect(first.items).toHaveLength(2)
    expect(headReads()).toBe(2)

    const second = await index.list({})
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id))
    expect(headReads()).toBe(2) // 没有新增读取
  })

  it('mtime 变化时重读该文件（会话追加后标题/时间刷新）', async () => {
    const { index, fs, headReads } = setup()
    await index.list({})
    expect(headReads()).toBe(2)

    const target = join('C:/sessions', '--a--', '1.jsonl')
    fs.files.set(target, {
      content: headerOnly('id-1').replace('任务 id-1', '改名后的任务'),
      mtimeMs: 3000
    })

    const result = await index.list({})
    expect(headReads()).toBe(3) // 只有变化的那一个被重读
    expect(result.items[0]?.id).toBe('id-1')
    expect(result.items[0]?.title).toBe('改名后的任务')
  })

  it('mtime 未变时 invalidate() 会强制重读（A23 改名后显式失效）', async () => {
    const { index, fs, headReads } = setup()
    await index.list({})
    expect(headReads()).toBe(2)

    const target = join('C:/sessions', '--a--', '1.jsonl')
    // 内容变了但 mtime 没变（同一毫秒写入 / 粗粒度文件系统）→ 缓存仍返回旧摘要
    fs.files.set(target, {
      content: headerOnly('id-1').replace('任务 id-1', '改过的名字'),
      mtimeMs: 1000
    })
    const stale = await index.list({})
    expect(stale.items.find((item) => item.id === 'id-1')?.title).toBe('任务 id-1')
    expect(headReads()).toBe(2)

    index.invalidate(target)
    const fresh = await index.list({})
    expect(fresh.items.find((item) => item.id === 'id-1')?.title).toBe('改过的名字')
    expect(headReads()).toBe(3)
  })

  it('invalidate() 无参数清空全部缓存（会话目录覆盖等场景的兜底）', async () => {
    const { index, headReads } = setup()
    await index.list({})
    expect(headReads()).toBe(2)
    index.invalidate()
    await index.list({})
    expect(headReads()).toBe(4)
  })

  it('会话目录切换时清空缓存（不回放旧目录的摘要）', async () => {
    const fileA = join('C:/a', '--x--', '1.jsonl')
    const fileB = join('C:/b', '--y--', '1.jsonl')
    const filesA = new Map([[fileA, { content: headerOnly('id-a'), mtimeMs: 1 }]])
    const filesB = new Map([[fileB, { content: headerOnly('id-b'), mtimeMs: 2 }]])
    const dirsA: Record<string, string[]> = {
      'C:/a': ['--x--'],
      [join('C:/a', '--x--')]: ['1.jsonl']
    }
    const dirsB: Record<string, string[]> = {
      'C:/b': ['--y--'],
      [join('C:/b', '--y--')]: ['1.jsonl']
    }
    let currentRoot = 'C:/a'
    const index = createSessionIndex({
      sessionDir: () => currentRoot,
      listDir: (path) => {
        const dirs = currentRoot === 'C:/a' ? dirsA : dirsB
        const names = dirs[path]
        if (names === undefined) throw new Error(`ENOENT ${path}`)
        return Promise.resolve<DirEntry[]>(
          names.map((name) => ({ name, isDirectory: () => !name.endsWith('.jsonl') }))
        )
      },
      statFile: (path) => {
        const file = filesA.get(path) ?? filesB.get(path)
        if (!file) throw new Error(`ENOENT ${path}`)
        return Promise.resolve({ mtimeMs: file.mtimeMs })
      },
      readHead: (path) => {
        const file = filesA.get(path) ?? filesB.get(path)
        if (!file) return Promise.reject(new Error(`ENOENT ${path}`))
        return Promise.resolve(file.content)
      }
    })

    expect((await index.list({})).items[0]?.id).toBe('id-a')
    currentRoot = 'C:/b'
    expect((await index.list({})).items[0]?.id).toBe('id-b')
  })
})

describe('SessionIndex：20 / 100 / 1000 会话实测耗时（A3）', () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function measure(
    count: number
  ): Promise<{ cold: number; warm: number; firstPage: number }> {
    const root = await mkdtemp(join(tmpdir(), `pi-index-bench-${count}-`))
    dirs.push(root)
    const groups = 10
    for (let group = 0; group < groups; group += 1) {
      const groupDir = join(root, `--C--work${group}--`)
      await mkdir(groupDir, { recursive: true })
      for (let i = 0; i < count / groups; i += 1) {
        await writeFile(
          join(groupDir, `2026-11-20T00-00-00_id-${group}-${i}.jsonl`),
          headerOnly(`id-${group}-${i}`),
          'utf8'
        )
      }
    }

    const index = createSessionIndex({ sessionDir: () => root })
    const coldStart = performance.now()
    const cold = await index.list({})
    const coldMs = performance.now() - coldStart

    const warmStart = performance.now()
    const warm = await index.list({})
    const warmMs = performance.now() - warmStart

    expect(cold.items).toHaveLength(20)
    expect(warm.items).toHaveLength(20)
    return { cold: coldMs, warm: warmMs, firstPage: warm.items.length }
  }

  it('20 / 100 / 1000 会话：冷启动与缓存命中耗时', async () => {
    for (const count of [20, 100, 1000]) {
      const { cold, warm } = await measure(count)
      console.log(
        `[perf] session-index ${count} 个会话：冷启动 ${cold.toFixed(1)}ms，缓存命中 ${warm.toFixed(1)}ms`
      )
      // A3：20 条 < 1s。1000 条也必须在 3s 内（本机实测远低于此）
      expect(cold).toBeLessThan(count <= 20 ? 1000 : 3000)
      expect(warm).toBeLessThanOrEqual(cold + 50)
    }
  }, 120_000)
})
