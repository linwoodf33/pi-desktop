import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildLaunchSpec, commonPiPaths } from '../../src/main/services/pi-locator'
import { LocalTransport } from '../../src/main/transport/local-connection'
import { classifyExtUi, PERMISSION_STATUS_KEY } from '../../src/shared/contracts/permission'
import type { ExtUiEvent } from '../../src/shared/contracts/types'

/**
 * **真实 pi** 审批扩展加载回归（M5）——默认跳过，需显式开启：
 *
 * ```bash
 * PI_DESKTOP_REAL_PI=1 npx vitest run --project integration tests/integration/real-pi-permission.test.ts
 * ```
 *
 * 验证的是一个 mock 永远验证不了的事实：**真实 pi 1.5.2 的扩展加载器（jiti）确实会把
 * `src/extensions/permission/` 装进 `tool_call` 前置钩子，并在 session_start 时上报版本握手**。
 *
 * 用例不调用模型（只启动 RPC 会话并读握手），所以离线可跑；
 * 「真实 pi 触发一次工具审批」需要可用的 provider，未纳入门控（见报告未验证项）。
 */
const enabled = process.env['PI_DESKTOP_REAL_PI']
const explicitPi = process.env['PI_DESKTOP_REAL_PI_COMMAND']
const detectedPi =
  explicitPi !== undefined && explicitPi.length > 0 && existsSync(explicitPi)
    ? explicitPi
    : commonPiPaths(process.platform, process.env).find((candidate) => existsSync(candidate))
const available = enabled !== undefined && enabled !== '0' && detectedPi !== undefined

const SOURCE_DIR = resolve(process.cwd(), 'src', 'extensions', 'permission')

describe.skipIf(!available)('真实 pi（M5）：审批扩展被加载并上报版本握手', () => {
  it('扩展目录可被 -e 加载；session_start 发 setStatus 握手（协议 1、120s 时钟）', async () => {
    const piPath = detectedPi as string
    const root = await mkdtemp(join(tmpdir(), 'pi-real-perm-'))
    const extensionDir = join(root, 'pi-desktop-permission')
    await cp(SOURCE_DIR, extensionDir, { recursive: true })

    const launch = buildLaunchSpec(piPath, process.platform)
    const transport = new LocalTransport({ channelId: 'real-perm', launch })

    try {
      await transport.start({
        cwd: tmpdir(),
        // --no-session：不落盘会话；-e：显式加载本地扩展目录
        extraArgs: ['--no-session', '-e', extensionDir]
      })

      const handshake = await new Promise<ExtUiEvent[]>((resolveEvents, reject) => {
        const events: ExtUiEvent[] = []
        const timer = setTimeout(() => {
          unsubscribe()
          resolveEvents(events)
        }, 15_000)
        timer.unref?.()

        const unsubscribe = transport.onRecord((record) => {
          if (record.type !== 'extension_ui_request') return
          events.push({ sessionKey: 'real', request: record })
          if (events.length >= 1) {
            clearTimeout(timer)
            unsubscribe()
            resolveEvents(events)
          }
        })
        // 失败时不要挂满 15s（transport 退出即结束）
        transport.onExit(() => {
          clearTimeout(timer)
          unsubscribe()
          reject(new Error('pi 在收到握手前退出'))
        })
      })

      const classified = handshake.map((event) => classifyExtUi(event))
      const handshakes = classified.filter((item) => item.kind === 'handshake')
      expect(handshakes.length).toBeGreaterThan(0)
      if (handshakes[0]?.kind !== 'handshake') throw new Error('unreachable')
      expect(handshakes[0].compatible).toBe(true)
      expect(handshakes[0].handshake.protocol).toBe(1)
      expect(handshakes[0].handshake.version).toBeTruthy()
      expect(handshakes[0].handshake.timeoutMs).toBe(120_000)
      expect(handshakes[0].handshake.tools).toEqual(['bash', 'powershell', 'write', 'edit'])
      // 状态栏 key 就是我们约定的握手通道
      const raw = handshake[0]?.request
      expect(raw?.['statusKey']).toBe(PERMISSION_STATUS_KEY)
    } finally {
      await transport.stop().catch(() => {})
      await rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }, 60_000)
})
