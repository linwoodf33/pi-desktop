import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type * as FsPromises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `readFilePrefix` 的 IO 契约（B1 回归）：
 *
 * 1. >1MB 文件**不得**走 `readFile` 整读，只能 `open` + `handle.read(..., HASH_LIMIT_BYTES, 0)`；
 * 2. 句柄必须在 finally 中关闭 —— 读取抛错时也不泄漏 fd。
 *
 * 这里通过包装真实 `node:fs/promises` 来记录调用参数（不是纯 stub，真实读写仍然发生）。
 */
const io = vi.hoisted(() => ({
  readFilePaths: [] as string[],
  reads: [] as Array<{ path: string; length: number; position: number | null }>,
  openPaths: [] as string[],
  closes: 0,
  /** 包装后的真实句柄（用于事后验证 fd 真的关了） */
  realHandles: [] as FileHandle[],
  /** 命中该路径的 read 会抛错（模拟读取中途失败） */
  failReadFor: undefined as string | undefined
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: (async (path: string, ...rest: unknown[]) => {
      io.readFilePaths.push(String(path))
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.readFile,
    open: (async (path: string, ...rest: unknown[]) => {
      const real = await (actual.open as (...args: unknown[]) => Promise<FileHandle>)(path, ...rest)
      io.openPaths.push(String(path))
      io.realHandles.push(real)
      const wrapped = {
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          io.reads.push({ path: String(path), length, position })
          if (io.failReadFor === String(path)) throw new Error('模拟读取失败')
          return real.read(buffer, offset, length, position)
        },
        close: async () => {
          io.closes += 1
          return real.close()
        }
      }
      return wrapped as unknown as FileHandle
    }) as typeof actual.open
  }
})

const { HASH_LIMIT_BYTES, takeSnapshot } =
  await import('../../src/main/services/workspace-snapshot')

describe('workspace-snapshot 大文件读取的 IO 契约', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-desktop-snapshot-io-'))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    io.readFilePaths.length = 0
    io.reads.length = 0
    io.openPaths.length = 0
    io.realHandles.length = 0
    io.closes = 0
    io.failReadFor = undefined
  })

  it('>1MB 文件：不整读，定点 read 长度 = HASH_LIMIT_BYTES 且 offset = 0，句柄被关闭', async () => {
    const dir = join(root, 'big')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'big.bin')
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 0x41))

    const snapshot = await takeSnapshot(dir)

    expect(snapshot.files.get('big.bin')?.size).toBe(2 * 1024 * 1024)
    // 关键断言：大文件绝不进入 readFile（整读路径）
    expect(io.readFilePaths).not.toContain(file)
    // 整个快照不该有任何整读调用
    expect(io.readFilePaths).toEqual([])
    expect(io.openPaths).toContain(file)
    const bigReads = io.reads.filter((read) => read.path === file)
    expect(bigReads).toHaveLength(1)
    expect(bigReads[0]?.length).toBe(HASH_LIMIT_BYTES)
    expect(bigReads[0]?.position).toBe(0)
    expect(io.closes).toBe(1)
    await expectAllClosed()
  })

  it('小文件（≤1MB）：也只读 size 字节且不走 readFile（单一有上限读取路径），content 仍保留', async () => {
    const dir = join(root, 'small')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'small.txt')
    writeFileSync(file, 'hello\n')

    const snapshot = await takeSnapshot(dir)

    expect(snapshot.files.get('small.txt')?.content).toBe('hello\n')
    // 大文件才需要夹取；小文件读长度 = 文件大小，但有上限的 read 路径是唯一路径
    expect(io.readFilePaths).not.toContain(file)
    const reads = io.reads.filter((read) => read.path === file)
    expect(reads).toHaveLength(1)
    expect(reads[0]?.length).toBe(6)
    expect(reads[0]?.position).toBe(0)
    expect(io.closes).toBe(1)
    await expectAllClosed()
  })

  it('读取中途抛错：句柄仍被关闭（不泄漏 fd），文件被跳过且快照标记不完整', async () => {
    const dir = join(root, 'fail')
    mkdirSync(dir, { recursive: true })
    const bad = join(dir, 'bad.bin')
    const good = join(dir, 'good.bin')
    writeFileSync(bad, Buffer.alloc(HASH_LIMIT_BYTES + 1024, 0x42))
    writeFileSync(good, Buffer.alloc(HASH_LIMIT_BYTES + 1024, 0x43))
    io.failReadFor = bad

    const snapshot = await takeSnapshot(dir)

    expect(io.openPaths).toContain(bad)
    // 抛错文件被跳过、另一文件正常进入快照
    expect(snapshot.files.has('bad.bin')).toBe(false)
    expect(snapshot.files.has('good.bin')).toBe(true)
    // 不宣称快照完整
    expect(snapshot.complete).toBe(false)
    // fd 不泄漏：每个 open 都恰好 close 一次
    expect(io.openPaths).toHaveLength(2)
    expect(io.closes).toBe(2)
    // 失败的读取只发生一次，没有隐藏的重试循环
    expect(io.reads.filter((read) => read.path === bad)).toHaveLength(1)
    await expectAllClosed()
  })

  it('反复快照 200 轮后所有真实句柄都已关闭（fd 不累积泄漏）', async () => {
    const dir = join(root, 'loop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), Buffer.alloc(HASH_LIMIT_BYTES + 512, 0x44))

    for (let round = 0; round < 200; round += 1) {
      await takeSnapshot(dir)
    }

    expect(io.openPaths).toHaveLength(200)
    expect(io.closes).toBe(200)
    await expectAllClosed()
  })
})

/** 已关闭的真实 FileHandle 再读会抛错（EBADF / file closed）——这是「fd 真的关了」的直接证据 */
async function expectAllClosed(): Promise<void> {
  for (const handle of io.realHandles) {
    await expect(handle.read(Buffer.alloc(1), 0, 1, 0)).rejects.toThrow()
  }
}
