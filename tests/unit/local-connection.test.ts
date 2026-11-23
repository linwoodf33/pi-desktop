import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import {
  buildChildEnv,
  buildPiArgs,
  READONLY_EXCLUDED_TOOLS,
  ConnectionStateMachine,
  LocalConnection,
  LocalTransport,
  quoteForCmdLine,
  StderrRingBuffer
} from '../../src/main/transport/local-connection'
import { JsonlReader } from '../../src/main/transport/jsonl-reader'
import type { RpcRecord } from '../../src/main/transport/types'

/** 可控的 stdin：可以模拟「背压」（write 返回 false）+ drain */
class FakeStdin extends Writable {
  acceptMore = true
  written: string[] = []
  ended = false

  override write(chunk: unknown): boolean {
    this.written.push(String(chunk))
    return this.acceptMore
  }

  override end(): this {
    this.ended = true
    return this
  }

  override _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    callback()
  }
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new FakeStdin()
  killCalls: Array<string | undefined> = []

  kill = vi.fn((signal?: string): boolean => {
    this.killCalls.push(signal)
    this.emitClose(null, signal ?? 'SIGTERM')
    return true
  })

  emitClose(code: number | null, signal: string | null): void {
    queueMicrotask(() => {
      this.emit('close', code, signal)
    })
  }
}

function setup(options: { launch?: Record<string, unknown> } = {}): {
  child: FakeChild
  transport: LocalTransport
  spawnImpl: ReturnType<typeof vi.fn>
  records: RpcRecord[]
  exits: Array<{ code: number | null; signal: string | null; stderrTail: string }>
  start: () => Promise<void>
} {
  const child = new FakeChild()
  const spawnImpl = vi.fn(() => child)
  const transport = new LocalTransport({
    channelId: 'test#1',
    launch: { command: 'pi', prefixArgs: [], ...options.launch },
    spawnImpl: spawnImpl as never,
    gracefulExitTimeoutMs: 20,
    killEscalationTimeoutMs: 20,
    startTimeoutMs: 1000
  })
  const records: RpcRecord[] = []
  const exits: Array<{ code: number | null; signal: string | null; stderrTail: string }> = []
  transport.onRecord((record) => records.push(record))
  transport.onExit((info) => exits.push(info))

  const start = async (): Promise<void> => {
    const pending = transport.start({ cwd: process.cwd() })
    child.emit('spawn')
    await pending
  }

  return { child, transport, spawnImpl, records, exits, start }
}

describe('buildPiArgs（真实 CLI 参数，docs/cli.md）', () => {
  it('默认只带 --mode rpc', () => {
    expect(buildPiArgs({ cwd: '/work' })).toEqual(['--mode', 'rpc'])
  })

  it('model / thinking / session / session-dir / name 与 extraArgs 按参数名拼装', () => {
    const args = buildPiArgs({
      cwd: '/work',
      model: 'anthropic/claude-sonnet-4-5',
      thinkingLevel: 'high',
      sessionFile: '/sessions/a.jsonl',
      sessionDir: '/sessions',
      sessionName: 'my task',
      extraArgs: ['--no-session']
    })
    expect(args).toEqual([
      '--mode',
      'rpc',
      '--model',
      'anthropic/claude-sonnet-4-5',
      '--thinking',
      'high',
      '--session',
      '/sessions/a.jsonl',
      '--session-dir',
      '/sessions',
      '--name',
      'my task',
      '--no-session'
    ])
  })

  it('空字符串参数被忽略（避免传一个空 cwd/name）', () => {
    expect(buildPiArgs({ cwd: '/work', model: '', sessionName: '' })).toEqual(['--mode', 'rpc'])
  })

  /**
   * 起始模式 = pi 的工具选择（**不是** `--mode`，那是输出接口）。
   * 只读用 denylist 而不是 allowlist：allowlist 会把用户装的扩展工具一并关掉。
   */
  it('toolMode=readonly → --exclude-tools（写文件与执行命令）', () => {
    const args = buildPiArgs({ cwd: '/work', toolMode: 'readonly' })
    expect(args).toEqual(['--mode', 'rpc', '--exclude-tools', READONLY_EXCLUDED_TOOLS])
    // 关键工具必须在名单里；read/grep/find/ls 不能出现（它们要保留）
    for (const name of ['write', 'edit', 'bash', 'powershell']) {
      expect(READONLY_EXCLUDED_TOOLS.split(',')).toContain(name)
    }
    for (const name of ['read', 'grep', 'find', 'ls']) {
      expect(READONLY_EXCLUDED_TOOLS.split(',')).not.toContain(name)
    }
  })

  it('toolMode=no-tools → --no-tools', () => {
    expect(buildPiArgs({ cwd: '/work', toolMode: 'no-tools' })).toEqual([
      '--mode',
      'rpc',
      '--no-tools'
    ])
  })

  it('toolMode=full（默认）不追加任何工具参数', () => {
    expect(buildPiArgs({ cwd: '/work', toolMode: 'full' })).toEqual(['--mode', 'rpc'])
    expect(buildPiArgs({ cwd: '/work' })).toEqual(['--mode', 'rpc'])
  })
})

describe('launch 与 spawn 选项', () => {
  it('shell:false + 数组参数 + 指定 cwd（§7 约束 11）', async () => {
    const { spawnImpl, start } = setup()
    await start()

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnImpl.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(command).toBe('pi')
    expect(args).toEqual(['--mode', 'rpc'])
    expect(options['shell']).toBe(false)
    expect(options['windowsHide']).toBe(true)
    expect(typeof options['cwd']).toBe('string')
    expect(options['windowsVerbatimArguments']).toBeUndefined()
  })

  it('cmd.exe 发射器：prefixArgs 在前，且自行给参数加引号（verbatim）', async () => {
    const { spawnImpl, start } = setup({
      launch: {
        command: 'cmd.exe',
        prefixArgs: ['/d', '/c', '"C:\\Program Files\\pi\\pi.cmd"'],
        windowsVerbatimArguments: true
      }
    })
    await start()

    const [command, args, options] = spawnImpl.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>
    ]
    expect(command).toBe('cmd.exe')
    expect(args.slice(0, 3)).toEqual(['/d', '/c', '"C:\\Program Files\\pi\\pi.cmd"'])
    expect(args.slice(3)).toEqual(['--mode', 'rpc'])
    expect(options['windowsVerbatimArguments']).toBe(true)
  })

  it('quoteForCmdLine 只给含空白/特殊字符的 token 加引号', () => {
    expect(quoteForCmdLine('--mode')).toBe('--mode')
    expect(quoteForCmdLine('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"')
    expect(quoteForCmdLine('')).toBe('""')
    expect(quoteForCmdLine('a&b')).toBe('"a&b"')
  })

  it('spawn 失败（error 事件）→ PI_NOT_FOUND，并已进入退出态', async () => {
    const child = new FakeChild()
    const transport = new LocalTransport({
      channelId: 'test#1',
      launch: { command: 'nope' },
      spawnImpl: (() => child) as never,
      startTimeoutMs: 1000
    })
    const pending = transport.start({ cwd: process.cwd() })
    child.emit('error', new Error('ENOENT'))

    await expect(pending).rejects.toMatchObject({ code: 'PI_NOT_FOUND' })
  })
})

describe('buildChildEnv：不把父 pi 会话身份传给孩子进程', () => {
  it('剥离 PI_SESSION_FILE / PI_SESSION_ID / PI_CODING_AGENT / PI_OPEN_AGENTS_*', () => {
    const env = buildChildEnv({
      PATH: '/bin',
      HOME: '/home/u',
      PI_CODING_AGENT: 'true',
      PI_SESSION_FILE: 'C:/sessions/parent.jsonl',
      PI_SESSION_ID: 'parent-id',
      PI_OPEN_AGENTS_DEPTH: '1',
      PI_MODEL: 'kept'
    })

    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', PI_MODEL: 'kept' })
  })
})

describe('stdout 分帧与诊断', () => {
  it('半行跨 chunk 补齐后产出，非法行变成 parse_error 记录', async () => {
    const { child, records, start } = setup()
    await start()

    child.stdout.write('{"type":"agent_st')
    child.stdout.write('art"}\nnot-json\n{"type":"agent_settled"}\n')

    expect(records.map((record) => record.type)).toEqual([
      'agent_start',
      'parse_error',
      'agent_settled'
    ])
    expect(records[1]?.['error']).toBeTypeOf('string')
  })

  it('stdout 结束时 flush 未闭合的最后一行', async () => {
    const { child, records, start } = setup()
    await start()

    child.stdout.write('{"type":"agent_settled"}')
    child.stdout.end()

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(records.map((record) => record.type)).toContain('agent_settled')
  })

  it('合法但不是对象的行（标量）也变成 parse_error，不当成记录播给上层', async () => {
    const { child, records, start } = setup()
    await start()

    child.stdout.write('42\n{"type":"agent_settled"}\n')

    expect(records.map((record) => record.type)).toEqual(['parse_error', 'agent_settled'])
    expect(records[0]?.['error']).toContain('JSON 对象')
  })
})

describe('stderr 环形缓冲（末 200 行 / 64KB）', () => {
  it('只保留最后 200 行，并显式标注已截断（约束 14：不静默截断）', () => {
    const buffer = new StderrRingBuffer(200, 64 * 1024)
    for (let i = 0; i < 250; i += 1) buffer.push(`line-${i}\n`)

    expect(buffer.size()).toBe(200)
    expect(buffer.truncated()).toBe(true)
    const tail = buffer.tail().split('\n')
    expect(tail[0]).toContain('已截断')
    expect(tail[0]).toContain('50')
    expect(tail[1]).toBe('line-50')
    expect(tail[200]).toBe('line-249')
  })

  it('未发生丢弃时没有截断标记', () => {
    const buffer = new StderrRingBuffer()
    buffer.push('only one line\n')
    expect(buffer.truncated()).toBe(false)
    expect(buffer.tail()).toBe('only one line')
  })

  it('超过字节上限时从最旧的行开始丢', () => {
    const buffer = new StderrRingBuffer(200, 100)
    buffer.push(`${'a'.repeat(60)}\n`)
    buffer.push(`${'b'.repeat(60)}\n`)

    const tail = buffer.tail()
    expect(tail).not.toContain('a'.repeat(60))
    expect(tail).toContain('b'.repeat(60))
    expect(buffer.truncated()).toBe(true)
  })

  it('未闭合的尾巴也计入字节预算：无 LF 超长行不会无限增长', () => {
    const buffer = new StderrRingBuffer(200, 64)
    for (let i = 0; i < 100; i += 1) buffer.push('z'.repeat(10))

    // 总量远超 64 字节，但缓冲只留尾部，且标记为已截断
    expect(Buffer.byteLength(buffer.tail(), 'utf8')).toBeLessThanOrEqual(64 + 120)
    expect(buffer.truncated()).toBe(true)
    expect(buffer.tail()).toContain('[stderr 已截断')
    // 尾部内容是最新写入的部分（全是 z）
    expect(buffer.tail().endsWith('z'.repeat(10))).toBe(true)
  })

  it('未闭合的尾巴在 finish() 时计入，且之前的预估尾部已含它', () => {
    const buffer = new StderrRingBuffer()
    buffer.push('partial line')
    expect(buffer.size()).toBe(0)
    // 流式过程中就能看到半行（诊断更有用）
    expect(buffer.tail()).toBe('partial line')
    buffer.finish()
    expect(buffer.tail()).toBe('partial line')
    expect(buffer.size()).toBe(1)
  })

  it('transport 退出时把 stderr 尾部放进 exit info（§6.4 诊断）', async () => {
    const { child, exits, start } = setup()
    await start()

    child.stderr.write('boom: provider failed\n')
    child.emitClose(1, null)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(exits).toHaveLength(1)
    expect(exits[0]?.code).toBe(1)
    expect(exits[0]?.stderrTail).toContain('boom: provider failed')
  })
})

describe('stdin 背压（§7 约束 2）', () => {
  it('write 返回 false 时后续命令排队，drain 后按顺序泵出', async () => {
    const { child, transport, start } = setup()
    await start()

    child.stdin.acceptMore = false
    transport.send({ type: 'get_state' }, 'c1')
    transport.send({ type: 'get_available_models' }, 'c2')

    // 只写出了第一条（第二条在队列里等 drain）
    expect(child.stdin.written).toHaveLength(1)
    expect(child.stdin.written[0]).toContain('"id":"c1"')

    child.stdin.acceptMore = true
    child.stdin.emit('drain')

    expect(child.stdin.written).toHaveLength(2)
    expect(child.stdin.written[1]).toContain('"id":"c2"')
  })

  it('命令写入是一行一条 JSON + LF（严格 JSONL 帧）', async () => {
    const { child, transport, start } = setup()
    await start()

    transport.send({ type: 'prompt', message: 'hi' }, 'req-1')

    expect(child.stdin.written).toEqual(['{"type":"prompt","message":"hi","id":"req-1"}\n'])
  })

  it('通道已关闭后 send 抛 PI_EXITED', async () => {
    const { child, transport, start } = setup()
    await start()

    child.emitClose(0, null)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(() => transport.send({ type: 'get_state' })).toThrowError(/通道已关闭/)
  })
})

describe('stop 关停顺序（§7 约束 6：关 stdin → 等退出 → 超时 kill）', () => {
  it('先关 stdin 并等待有序退出，不立即 kill', async () => {
    const { child, transport, start } = setup()
    await start()

    const stopping = transport.stop()
    expect(child.stdin.ended).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()

    child.emitClose(0, null)
    await stopping

    expect(child.kill).not.toHaveBeenCalled()
  })

  it('优雅退出超时后才 kill', async () => {
    const { child, transport, start } = setup()
    await start()

    await transport.stop()

    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('stop 幂等：重复调用复用同一个 promise', async () => {
    const { child, transport, start } = setup()
    await start()

    const first = transport.stop()
    const second = transport.stop()
    expect(second).toBe(first)

    child.emitClose(0, null)
    await first
  })
})

describe('U11：连接状态机拒绝非法迁移', () => {
  it('failed → ready 被拒绝并记录', () => {
    const onIllegal = vi.fn()
    const machine = new ConnectionStateMachine(onIllegal)

    expect(machine.transition('connecting')).toBe(true)
    expect(machine.transition('failed')).toBe(true)
    expect(machine.transition('ready')).toBe(false)
    expect(machine.state()).toBe('failed')
    expect(onIllegal).toHaveBeenCalledWith('failed', 'ready')
  })

  it('合法路径 connected → ready → degraded → ready 通过', () => {
    const machine = new ConnectionStateMachine()
    expect(machine.transition('connecting')).toBe(true)
    expect(machine.transition('ready')).toBe(true)
    expect(machine.transition('degraded')).toBe(true)
    expect(machine.transition('ready')).toBe(true)
    expect(machine.state()).toBe('ready')
  })

  it('disconnected → ready 直接跳级被拒绝', () => {
    const machine = new ConnectionStateMachine()
    expect(machine.transition('ready')).toBe(false)
    expect(machine.state()).toBe('disconnected')
  })

  it('ready / degraded / failed 都允许经 connecting 再开通道（不是终态）', () => {
    const ready = new ConnectionStateMachine()
    ready.transition('connecting')
    ready.transition('ready')
    expect(ready.transition('connecting')).toBe(true)
    expect(ready.state()).toBe('connecting')

    const degraded = new ConnectionStateMachine()
    degraded.transition('connecting')
    degraded.transition('ready')
    degraded.transition('degraded')
    expect(degraded.transition('connecting')).toBe(true)

    const failed = new ConnectionStateMachine()
    failed.transition('connecting')
    failed.transition('failed')
    expect(failed.transition('connecting')).toBe(true)
    expect(failed.transition('ready')).toBe(true)
    expect(failed.state()).toBe('ready')
  })

  it('dispose 之后（disconnected）只允许重新 connecting', () => {
    const machine = new ConnectionStateMachine()
    machine.transition('connecting')
    machine.transition('ready')
    expect(machine.transition('disconnected')).toBe(true)
    expect(machine.transition('degraded')).toBe(false)
    expect(machine.transition('connecting')).toBe(true)
  })
})

/** 用可注入的 spawnImpl 构造真实 LocalConnection（不启动真子进程） */
function createConnection(): {
  connection: LocalConnection
  children: FakeChild[]
  states: string[]
  illegal: string[]
  failNextLaunch: (times?: number) => void
} {
  const children: FakeChild[] = []
  const states: string[] = []
  const illegal: string[] = []
  let launchFailures = 0
  const connection = new LocalConnection({
    resolveLaunch: () => {
      if (launchFailures > 0) {
        launchFailures -= 1
        return Promise.reject(new Error('找不到 pi'))
      }
      return Promise.resolve({ command: 'pi', prefixArgs: [] })
    },
    spawnImpl: (() => {
      const child = new FakeChild()
      children.push(child)
      // start() 在本轮同步执行内注册 'spawn' 监听，微任务里发事件刚好赶上
      queueMicrotask(() => child.emit('spawn'))
      return child
    }) as never,
    onStateChange: (state) => states.push(state),
    onIllegalTransition: (info) => illegal.push(info.message),
    gracefulExitTimeoutMs: 20,
    startTimeoutMs: 1000
  })
  return {
    connection,
    children,
    states,
    illegal,
    failNextLaunch: (times = 1) => {
      launchFailures = times
    }
  }
}

describe('LocalConnection：多通道（§D3 / §10 A8 / §9.2 I8 前提）', () => {
  it('顺序开 3 个通道都成功，连接保持 ready', async () => {
    const { connection, children, states, illegal } = createConnection()

    const first = await connection.openChannel({ cwd: process.cwd() })
    const second = await connection.openChannel({ cwd: process.cwd() })
    const third = await connection.openChannel({ cwd: process.cwd() })

    expect([first, second, third].map((transport) => transport.channelId)).toEqual([
      'local#1',
      'local#2',
      'local#3'
    ])
    expect(children).toHaveLength(3)
    expect(connection.state()).toBe('ready')
    // ready 下再开通道不重复报 connecting（避免多会话时状态抖动）
    expect(states).toEqual(['connecting', 'ready'])
    expect(illegal).toEqual([])
  })

  it('并发开 3 个通道也不互相打断', async () => {
    const { connection, children, illegal } = createConnection()

    const transports = await Promise.all([
      connection.openChannel({ cwd: process.cwd() }),
      connection.openChannel({ cwd: process.cwd() }),
      connection.openChannel({ cwd: process.cwd() })
    ])

    expect(new Set(transports.map((transport) => transport.channelId)).size).toBe(3)
    expect(children).toHaveLength(3)
    expect(connection.state()).toBe('ready')
    expect(illegal).toEqual([])
  })

  it('所有通道退出后连接降为 degraded，再开通道可恢复 ready', async () => {
    const { connection, children } = createConnection()
    const transport = await connection.openChannel({ cwd: process.cwd() })
    const child = children[0]
    if (!child) throw new Error('没有创建子进程')

    child.emitClose(0, null)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(connection.state()).toBe('degraded')

    const again = await connection.openChannel({ cwd: process.cwd() })
    expect(again.channelId).toBe('local#2')
    expect(connection.state()).toBe('ready')
    expect(transport.channelId).toBe('local#1')
  })

  it('一个通道退出不影响其它通道：连接仍为 ready', async () => {
    const { connection, children } = createConnection()
    await connection.openChannel({ cwd: process.cwd() })
    await connection.openChannel({ cwd: process.cwd() })

    children[0]?.emitClose(1, null)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(connection.state()).toBe('ready')
  })
})

describe('LocalConnection：失败后可重试（§3.3 / §10 A12，免重启恢复）', () => {
  it('首个通道启动失败 → failed；再次 openChannel 可重试成功 → ready', async () => {
    const { connection, children, states, illegal, failNextLaunch } = createConnection()
    failNextLaunch(1)

    await expect(connection.openChannel({ cwd: process.cwd() })).rejects.toThrowError(/找不到 pi/)
    expect(connection.state()).toBe('failed')

    const transport = await connection.openChannel({ cwd: process.cwd() })
    expect(transport.channelId).toBe('local#1')
    expect(connection.state()).toBe('ready')
    expect(children).toHaveLength(1)
    expect(illegal).toEqual([])
    expect(states).toEqual(['connecting', 'failed', 'connecting', 'ready'])
  })

  it('部分通道已活跃时，新通道启动失败不回退到 failed', async () => {
    const { connection, failNextLaunch } = createConnection()
    await connection.openChannel({ cwd: process.cwd() })

    failNextLaunch(1)
    await expect(connection.openChannel({ cwd: process.cwd() })).rejects.toThrowError()
    expect(connection.state()).toBe('ready')
  })

  it('子进程 spawn 报错（真实启动失败）同样可通过重试恢复', async () => {
    const children: FakeChild[] = []
    let failNext = true
    const connection = new LocalConnection({
      resolveLaunch: () => Promise.resolve({ command: 'pi', prefixArgs: [] }),
      spawnImpl: (() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => {
          if (failNext) {
            failNext = false
            child.emit('error', new Error('ENOENT'))
            return
          }
          child.emit('spawn')
        })
        return child
      }) as never,
      startTimeoutMs: 1000
    })

    await expect(connection.openChannel({ cwd: process.cwd() })).rejects.toMatchObject({
      code: 'PI_NOT_FOUND'
    })
    expect(connection.state()).toBe('failed')

    await expect(connection.openChannel({ cwd: process.cwd() })).resolves.toBeDefined()
    expect(connection.state()).toBe('ready')
  })

  it('dispose 后状态是 disconnected（终端态）', async () => {
    const { connection } = createConnection()
    await connection.openChannel({ cwd: process.cwd() })

    await connection.dispose()
    expect(connection.state()).toBe('disconnected')
  })
})

describe('JsonlReader 与 transport 协作：U+2028 不切分', () => {
  it('writer 侧把 U+2028 放在字符串里，transport 仍按一条记录解析', async () => {
    const { child, records, start } = setup()
    await start()

    child.stdout.write(`${JSON.stringify({ type: 'message_end', text: 'a\u2028b' })}\n`)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ text: 'a\u2028b' })
  })

  it('JsonlReader 独立实例与 transport 行为一致（回归保护）', () => {
    const seen: unknown[] = []
    const reader = new JsonlReader({ onRecord: (record) => seen.push(record) })
    reader.push('{"t":"a\u2029b"}\n')
    expect(seen).toEqual([{ t: 'a\u2029b' }])
  })
})
