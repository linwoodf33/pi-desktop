import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { EventChannel } from '../../src/shared/ipc-channels'
import { createSessionHistory, DEFAULT_MAX_RECORDS } from '../../src/main/services/session-history'
import { createSessionService } from '../../src/main/services/session-service'
import { buildLaunchSpec, commonPiPaths } from '../../src/main/services/pi-locator'
import { LocalConnection } from '../../src/main/transport/local-connection'

/**
 * **真实 pi** 回归（M4 复核修复 B1）——默认跳过，需显式开启：
 *
 * ```bash
 * PI_DESKTOP_REAL_PI=1 npx vitest run --project integration tests/integration/real-pi-fork.test.ts
 * ```
 *
 * 为什么要单独一条：B1 只有真实 pi 能复现——从**第一条用户消息** fork 时 pi 走
 * `newSession({parentSession})` 建空会话，新会话文件**懒落盘**（下一条 prompt 前不存在），
 * 而 mock pi 是自实现，永远给不出这个差异。
 *
 * 用例不调用模型（只有 `get_fork_messages` / `fork` / `get_state`），所以离线也能跑；
 * 会话文件用 pi v3 格式的合成样本（只含用户/助手文本消息）。
 */
const enabled = process.env['PI_DESKTOP_REAL_PI']
const explicitPi = process.env['PI_DESKTOP_REAL_PI_COMMAND']
const detectedPi =
  explicitPi !== undefined && explicitPi.length > 0 && existsSync(explicitPi)
    ? explicitPi
    : commonPiPaths(process.platform, process.env).find((candidate) => existsSync(candidate))
const available = enabled !== undefined && enabled !== '0' && detectedPi !== undefined

describe.skipIf(!available)('真实 pi（B1）：从首条用户消息分叉 = 空会话、文件懒落盘', () => {
  it('fork 后新会话文件不存在；allowMissing 按空会话、默认仍 PATH_DENIED；落盘后可回放', async () => {
    const piPath = detectedPi as string
    const root = await mkdtemp(join(tmpdir(), 'pi-real-fork-'))
    const groupDir = join(root, '--work--')
    await mkdir(groupDir, { recursive: true })
    const sessionFile = join(groupDir, '2026-11-20T00-00-00_real-probe.jsonl')

    const entries = [
      {
        type: 'session',
        version: 3,
        id: 'real-probe-1',
        timestamp: '2026-11-20T00:00:00.000Z',
        cwd: process.cwd()
      },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-11-20T00:00:01.000Z',
        message: { role: 'user', content: '第一句问题', timestamp: 1735689601000 }
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-11-20T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '第一句回答' }],
          timestamp: 1735689602000
        }
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'a1',
        timestamp: '2026-11-20T00:00:03.000Z',
        message: { role: 'user', content: '第二句问题', timestamp: 1735689603000 }
      }
    ]
    await writeFile(
      sessionFile,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8'
    )

    const connection = new LocalConnection({
      resolveLaunch: () => Promise.resolve(buildLaunchSpec(piPath, process.platform))
    })
    const service = createSessionService({
      connection,
      emit: (_channel: EventChannel, _payload: unknown) => {},
      limits: () => ({ maxActiveSessions: 2, idleRecycleMinutes: 30 }),
      sessionDir: () => root,
      commandTimeoutMs: 60_000,
      settleTimeoutMs: 60_000,
      reaperIntervalMs: 10_000_000
    })
    const history = createSessionHistory({ sessionRoot: () => root })

    try {
      const { sessionKey } = await service.resume({ sessionFile })
      const points = await service.forkPoints({ sessionKey })
      // pi 只把用户消息列为可分叉点
      expect(points.points.map((point) => point.text)).toEqual(['第一句问题', '第二句问题'])

      // A4 的基线要在 resume **之后**取：pi 打开会话时会自己追加
      // model_change / thinking_level_change 之类条目（是 pi 的正常行为，不是 fork 造成的）
      const beforeForkBytes = await readFile(sessionFile)

      // 从**第一条**用户消息分叉
      const forked = await service.fork({ sessionKey, entryId: points.points[0]?.entryId ?? '' })
      const forkedState = await service.state({ sessionKey: forked.sessionKey })
      const forkedFile = forkedState.sessionFile
      expect(forkedFile).toBeDefined()
      expect(forkedFile).not.toBe(sessionFile)

      // B1 的事实前提：新会话文件此时**还不存在**（pi 懒落盘）
      await expect(stat(forkedFile as string)).rejects.toMatchObject({ code: 'ENOENT' })

      // 默认路径仍 fail-closed（realpath 语义没被放宽）
      await expect(history.read({ sessionFile: forkedFile as string })).rejects.toMatchObject({
        code: 'PATH_DENIED'
      })

      // fork 编排（allowMissing）→ 空会话，不抛错
      const empty = await history.read({
        sessionFile: forkedFile as string,
        allowMissing: true
      })
      expect(empty).toEqual({
        records: [],
        truncated: false,
        messageCount: 0,
        totalRecords: 0,
        fileAbsent: true
      })

      // A4：fork 不写回原会话文件（字节不变）
      expect(await readFile(sessionFile)).toEqual(beforeForkBytes)

      // ③ 落盘后可正常回放（这里由用例写入，等价于 pi 在下一条 prompt 后写盘）
      await writeFile(
        forkedFile as string,
        [
          JSON.stringify({
            type: 'session',
            version: 3,
            id: 'real-probe-fork',
            timestamp: '2026-11-20T00:01:00.000Z',
            cwd: process.cwd()
          }),
          JSON.stringify({
            type: 'message',
            id: 'f1',
            parentId: null,
            timestamp: '2026-11-20T00:01:01.000Z',
            message: { role: 'user', content: '分叉后的第一句', timestamp: 1735689661000 }
          }),
          ''
        ].join('\n'),
        'utf8'
      )
      const after = await history.read({ sessionFile: forkedFile as string })
      expect(after.fileAbsent).toBeUndefined()
      expect(after.messageCount).toBe(1)
      expect(after.messageCount).toBeLessThanOrEqual(DEFAULT_MAX_RECORDS)
    } finally {
      await service.disposeAll()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
