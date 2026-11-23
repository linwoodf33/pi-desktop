import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  compareSnapshots,
  HASH_LIMIT_BYTES,
  isBinaryBuffer,
  takeSnapshot
} from '../../src/main/services/workspace-snapshot'

const sha1 = (buffer: Buffer): string => createHash('sha1').update(buffer).digest('hex')

/**
 * 非 git 快照比对（M6，§6.1 第 5 步）。
 *
 * 变更矩阵必须覆盖四类**真实会误导人**的情形：
 * 1. 新增 / 删除 / 修改；
 * 2. 「大小变了但内容前缀没变」（追加内容，前 1MB sha1 不变）→ 仍要算修改；
 * 3. 「只 touch 了 mtime，内容没变」→ **不能**误报；
 * 4. 依赖目录/符号链接被跳过。
 */
describe('takeSnapshot + compareSnapshots', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-snapshot-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('新增 / 修改 / 删除 / 追加内容 都能识别，且跳过 node_modules', async () => {
    const dir = join(root, 'basic')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'keep.txt'), 'keep\n', 'utf8')
    await writeFile(join(dir, 'modify.txt'), 'v1\n', 'utf8')
    await writeFile(join(dir, 'delete.txt'), 'bye\n', 'utf8')
    await writeFile(join(dir, 'append.txt'), 'head\n', 'utf8')
    await writeFile(join(dir, 'node_modules', 'dep.js'), 'noise\n', 'utf8')

    const before = await takeSnapshot(dir)
    expect(before.files.has('node_modules/dep.js')).toBe(false)
    expect(before.files.get('append.txt')?.content).toBe('head\n')

    await writeFile(join(dir, 'modify.txt'), 'v2\n', 'utf8')
    await rm(join(dir, 'delete.txt'))
    await writeFile(join(dir, 'added.txt'), 'new\n', 'utf8')
    // 追加：size 变了，但「前 1MB 的 sha1」会变（内容变了）；用更极端的场景验证 size 变化优先判定
    await writeFile(join(dir, 'append.txt'), 'head\ntail\n', 'utf8')
    await writeFile(join(dir, 'node_modules', 'dep.js'), 'noise v2\n', 'utf8')

    const after = await takeSnapshot(dir)
    const { entries, details } = compareSnapshots(before, after)
    const byPath = new Map(entries.map((entry) => [entry.path, entry.change]))

    expect(byPath.get('added.txt')).toBe('added')
    expect(byPath.get('modify.txt')).toBe('modified')
    expect(byPath.get('delete.txt')).toBe('deleted')
    expect(byPath.get('append.txt')).toBe('modified')
    expect(byPath.get('keep.txt')).toBeUndefined()
    // node_modules 不参与比对
    expect(byPath.get('node_modules/dep.js')).toBeUndefined()

    // 明细里带前后内容，够生成 diff
    const modified = details.find((detail) => detail.path === 'modify.txt')
    expect(modified?.before?.content).toBe('v1\n')
    expect(modified?.after?.content).toBe('v2\n')
  })

  it('只 touch mtime、内容不变 → 不误报', async () => {
    const dir = join(root, 'touch')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'same.txt')
    await writeFile(file, 'same content\n', 'utf8')

    const before = await takeSnapshot(dir)
    // 把 mtime 改成 1 小时后（内容不变）
    const future = new Date(Date.now() + 3600_000)
    await utimes(file, future, future)
    const after = await takeSnapshot(dir)

    expect(after.files.get('same.txt')?.mtimeMs).not.toBe(before.files.get('same.txt')?.mtimeMs)
    expect(compareSnapshots(before, after).entries).toEqual([])
  })

  it('大小变化（追加）即使前 1MB 内容相同也算修改', async () => {
    const dir = join(root, 'big')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'big.txt')
    // 1MB + 10 字节：前 1MB 参与 hash
    const head = 'a'.repeat(1024 * 1024)
    await writeFile(file, head, 'utf8')

    const before = await takeSnapshot(dir)
    await writeFile(file, `${head}0123456789`, 'utf8')
    const after = await takeSnapshot(dir)

    const beforeEntry = before.files.get('big.txt')
    const afterEntry = after.files.get('big.txt')
    // 前 1MB 的 sha1 完全一致（这是「只看 hash 就会漏报」的场景）
    expect(afterEntry?.hash).toBe(beforeEntry?.hash)
    expect(afterEntry?.size).not.toBe(beforeEntry?.size)
    // 但 size 变了 → 必须算修改
    expect(compareSnapshots(before, after).entries).toEqual([
      expect.objectContaining({ path: 'big.txt', change: 'modified' })
    ])
    // 超过内容保留上限（或内容被裁），因此不保留 content（diff 会显式说明）
    expect(afterEntry?.content).toBeUndefined()
  })

  it('大文件只保留 hash、不保留内容（内存边界）', async () => {
    const dir = join(root, 'contentlimit')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'big.txt'), 'x'.repeat(2048), 'utf8')
    const snapshot = await takeSnapshot(dir, { maxContentBytes: 100 })
    expect(snapshot.files.get('big.txt')?.hash).toHaveLength(40)
    expect(snapshot.files.get('big.txt')?.content).toBeUndefined()
  })

  it('文件数上限触发 truncated（complete=false），不静默', async () => {
    const dir = join(root, 'many')
    await mkdir(dir, { recursive: true })
    for (let index = 0; index < 20; index += 1) {
      await writeFile(join(dir, `f${index}.txt`), `${index}\n`, 'utf8')
    }
    const snapshot = await takeSnapshot(dir, { maxFiles: 5 })
    expect(snapshot.files.size).toBe(5)
    expect(snapshot.complete).toBe(false)
  })

  it('二进制文件打标（含 NUL）', async () => {
    const dir = join(root, 'binary')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    const snapshot = await takeSnapshot(dir)
    expect(snapshot.files.get('blob.bin')?.binary).toBe(true)
    expect(snapshot.files.get('blob.bin')?.content).toBeUndefined()
  })
})

describe('大文件读取边界（readFilePrefix 必须定点读）', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pi-desktop-snapshot-edge-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  })

  it('0 字节文件：hash = sha1(空)，content 为空串，不判二进制', async () => {
    const dir = join(root, 'empty')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'zero.txt'), '')

    const entry = (await takeSnapshot(dir)).files.get('zero.txt')
    expect(entry?.size).toBe(0)
    expect(entry?.hash).toBe(sha1(Buffer.alloc(0)))
    expect(entry?.content).toBe('')
    expect(entry?.binary).toBe(false)
  })

  it('恰好 1MB：hash 覆盖整份内容，不保留 content', async () => {
    const dir = join(root, 'exact')
    await mkdir(dir, { recursive: true })
    const body = Buffer.alloc(HASH_LIMIT_BYTES, 0x61)
    await writeFile(join(dir, 'exact.txt'), body)

    const entry = (await takeSnapshot(dir)).files.get('exact.txt')
    expect(entry?.size).toBe(HASH_LIMIT_BYTES)
    expect(entry?.hash).toBe(sha1(body))
    // 超过内容保留上限（256KB）→ 只留 hash
    expect(entry?.content).toBeUndefined()
  })

  it('1MB + 1 字节：hash 只覆盖前 1MB（前缀口径不变），size 记录全量', async () => {
    const dir = join(root, 'over')
    await mkdir(dir, { recursive: true })
    const body = Buffer.alloc(HASH_LIMIT_BYTES + 1, 0x62)
    await writeFile(join(dir, 'over.txt'), body)

    const entry = (await takeSnapshot(dir)).files.get('over.txt')
    expect(entry?.size).toBe(HASH_LIMIT_BYTES + 1)
    expect(entry?.hash).toBe(sha1(body.subarray(0, HASH_LIMIT_BYTES)))
    // 前缀 hash 与「恰好 1MB 且内容相同」的文件一致 —— 证明前缀口径
    expect(entry?.hash).toBe(sha1(Buffer.alloc(HASH_LIMIT_BYTES, 0x62)))
    expect(entry?.content).toBeUndefined()
  })

  it('超大（稀疏/末尾未写）文件：只读前 1MB，hash = sha1(1MB 零)，内存受 HASH_LIMIT_BYTES 约束', async () => {
    const dir = join(root, 'sparse')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'huge.bin')
    await writeFile(file, '')
    // 只延展逻辑大小，不真正写满 -> 模拟数据集/镜像类超大文件
    await truncate(file, 64 * 1024 * 1024)

    const beforeBytes = process.memoryUsage().arrayBuffers
    const snapshot = await takeSnapshot(dir)
    const delta = process.memoryUsage().arrayBuffers - beforeBytes

    const entry = snapshot.files.get('huge.bin')
    expect(entry?.size).toBe(64 * 1024 * 1024)
    expect(entry?.hash).toBe(sha1(Buffer.alloc(HASH_LIMIT_BYTES)))
    expect(delta).toBeLessThan(8 * 1024 * 1024)
  })

  it('3 × 24MB 文件：快照的 arrayBuffers 增量远小于单文件大小（修 B1 前 ≈ 23.87MB）', async () => {
    const dir = join(root, 'heavy')
    await mkdir(dir, { recursive: true })
    const chunk = Buffer.alloc(24 * 1024 * 1024, 0x63)
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await writeFile(join(dir, name), chunk)
    }

    const beforeBytes = process.memoryUsage().arrayBuffers
    const snapshot = await takeSnapshot(dir)
    const delta = process.memoryUsage().arrayBuffers - beforeBytes

    expect(snapshot.files.size).toBe(3)
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      expect(snapshot.files.get(name)?.hash).toBe(sha1(chunk.subarray(0, HASH_LIMIT_BYTES)))
    }
    // 定点读时增量应为 1MB 级（含少量未回收垃圾）；整读则为 ≥24MB
    expect(delta).toBeLessThan(8 * 1024 * 1024)
  })
})

describe('isBinaryBuffer', () => {
  it('NUL 即判二进制', () => {
    expect(isBinaryBuffer(Buffer.from([65, 0, 66]))).toBe(true)
    expect(isBinaryBuffer(Buffer.from('hello', 'utf8'))).toBe(false)
  })
})
