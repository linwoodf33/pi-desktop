import { describe, expect, it, vi } from 'vitest'

import {
  buildLaunchSpec,
  compareVersions,
  createPiLocator,
  parseVersion
} from '../../src/main/services/pi-locator'

/** §3.3 / §9.2 I10 / §10 A12：定位 + 自检的可操作错误 */

function locator(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: string[]
  dirs?: Record<string, string[]>
  version?: string
  captureCode?: number
  captureThrows?: boolean
  probe?: { state: 'ok' | 'failed' | 'missing'; message?: string }
}): ReturnType<typeof createPiLocator> {
  const exists = new Set(options.exists ?? [])
  return createPiLocator({
    platform: options.platform ?? 'linux',
    env: options.env ?? { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/u' },
    fileExists: (path) => exists.has(path),
    listDir: (path) => options.dirs?.[path] ?? [],
    runCapture: () => {
      if (options.captureThrows === true) return Promise.reject(new Error('spawn EACCES'))
      return Promise.resolve({
        code: options.captureCode ?? 0,
        stdout: options.version ?? '1.5.2\n',
        stderr: ''
      })
    },
    probeRpc: () => Promise.resolve(options.probe ?? { state: 'ok' }),
    minVersion: '1.0.0'
  })
}

describe('buildLaunchSpec：§7 约束 11 的可执行文件调用', () => {
  it('POSIX 无扩展名脚本直接执行', () => {
    expect(buildLaunchSpec('/usr/local/bin/pi', 'linux')).toEqual({
      command: '/usr/local/bin/pi',
      prefixArgs: [],
      displayPath: '/usr/local/bin/pi',
      // M5：显式标注启动形态（direct | node-shim | cmd-shim）
      launchKind: 'direct'
    })
  })

  it('Windows .exe 直接执行', () => {
    expect(buildLaunchSpec('C:\\pi\\pi.exe', 'win32')).toMatchObject({
      command: 'C:\\pi\\pi.exe',
      prefixArgs: []
    })
  })

  it('Windows .cmd 解析不出 Node 入口时走 cmd.exe /d /s /c（实参逐个校验 + 加引号）', () => {
    // 模拟「不是 Node shim」的第三方批处理：只能经 cmd
    const spec = buildLaunchSpec('C:\\Program Files\\pi\\pi.cmd', 'win32', 'cmd.exe', {
      readText: () => '@echo off',
      fileExists: () => false
    })
    expect(spec.command).toBe('cmd.exe')
    expect(spec.prefixArgs).toEqual(['/d', '/s', '/c'])
    expect(spec.windowsVerbatimArguments).toBe(true)
    expect(spec.launchKind).toBe('cmd-shim')
    // 能被 Node shim 解析时压根不会走到这里（见 pi-cmd-hardening.test.ts）
    // 含空格的参数被逐个加引号；整体再包一层，交给 cmd /s 剥掉最外层
    expect(spec.commandLine?.(['--mode', 'rpc', '--name', 'my task'])).toBe(
      '""C:\\Program Files\\pi\\pi.cmd" --mode rpc --name "my task""'
    )
  })

  it('Windows .ps1 走 powershell -File', () => {
    const spec = buildLaunchSpec('C:\\pi\\pi.ps1', 'win32')
    expect(spec.command).toBe('powershell.exe')
    expect(spec.prefixArgs).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\pi\\pi.ps1'
    ])
  })

  it('Windows 上但目标是 POSIX 脚本时不套 cmd.exe', () => {
    expect(buildLaunchSpec('C:\\pi\\pi', 'win32').command).toBe('C:\\pi\\pi')
  })
})

describe('版本解析与比较', () => {
  it('从 --version 输出里取语义化版本', () => {
    expect(parseVersion('1.5.2')).toBe('1.5.2')
    expect(parseVersion('pi 1.5.2 (node 22)')).toBe('1.5.2')
    expect(parseVersion('v2.0.0-beta.1')).toBe('2.0.0-beta.1')
    expect(parseVersion('no version here')).toBeUndefined()
  })

  it('compareVersions 比较数值段，忽略预发布后缀', () => {
    expect(compareVersions('1.5.2', '1.0.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.5.2')).toBe(-1)
    expect(compareVersions('1.5.2', '1.5.2')).toBe(0)
    expect(compareVersions('1.5.2-beta.1', '1.5.2')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
  })
})

describe('locate：显式路径 > PATH > 常见路径', () => {
  it('显式路径存在 → ok，并给出 launch', async () => {
    const pi = locator({ exists: ['/opt/pi/bin/pi'] })
    const status = await pi.locate('/opt/pi/bin/pi')

    expect(status.state).toBe('ok')
    expect(status.version).toBe('1.5.2')
    expect(pi.launch()).toMatchObject({ command: '/opt/pi/bin/pi' })
  })

  it('未指定路径时按 PATH 搜索', async () => {
    const pi = locator({ exists: ['/usr/bin/pi'] })
    const status = await pi.locate()

    expect(status.state).toBe('ok')
    expect(pi.launch()?.command).toBe('/usr/bin/pi')
  })

  it('PATH 里没有时回退到常见安装路径', async () => {
    const pi = locator({ exists: ['/home/u/.pi/agent/bin/pi'] })
    const status = await pi.locate()
    expect(status.state).toBe('ok')
  })

  it('Windows：用 PATHEXT 展开 pi.cmd', async () => {
    const pi = locator({
      platform: 'win32',
      env: { PATH: 'C:\\tools', PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: 'C:\\Users\\u' },
      dirs: { 'C:\\tools': ['pi.cmd'] }
    })
    const status = await pi.locate()

    expect(status.state).toBe('ok')
    expect(pi.launch()).toMatchObject({
      command: 'cmd.exe',
      displayPath: 'C:\\tools\\pi.cmd'
    })
  })

  it('找不到 → missing + 可操作提示（A12）', async () => {
    const pi = locator({ exists: [] })
    const status = await pi.locate()

    expect(status.state).toBe('missing')
    expect(status.message).toContain('pi')
    expect(status.message).toMatch(/设置|安装/)
    expect(pi.launch()).toBeUndefined()
  })
})

describe('自检失败路径', () => {
  it('显式路径不存在 → missing，提示检查路径', async () => {
    const pi = locator({ exists: [] })
    const status = await pi.locate('C:\\nope\\pi.cmd')
    expect(status.state).toBe('missing')
    expect(status.message).toContain('C:\\nope\\pi.cmd')
  })

  it('--version 非 0 退出 → failed，带 stderr 摘要', async () => {
    const pi = createPiLocator({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fileExists: (path) => path === '/usr/bin/pi',
      runCapture: () => Promise.resolve({ code: 1, stdout: '', stderr: 'boom\nsecond line' }),
      probeRpc: () => Promise.resolve({ state: 'ok' })
    })
    const status = await pi.locate()

    expect(status.state).toBe('failed')
    expect(status.message).toContain('boom')
  })

  it('版本过旧 → failed，提示升级', async () => {
    const pi = locator({ exists: ['/usr/bin/pi'], version: '0.9.0\n' })
    const status = await pi.locate()

    expect(status.state).toBe('failed')
    expect(status.message).toMatch(/过旧|升级/)
    expect(pi.launch()).toBeUndefined()
  })

  it('无法执行 --version（spawn 抛错）→ failed', async () => {
    const pi = locator({ exists: ['/usr/bin/pi'], captureThrows: true })
    const status = await pi.locate()
    expect(status.state).toBe('failed')
    expect(status.message).toContain('EACCES')
  })

  it('--mode rpc 探测失败（协议污染）→ failed，且不暴露 launch', async () => {
    const pi = locator({
      exists: ['/usr/bin/pi'],
      probe: { state: 'failed', message: '首条记录不是合法 JSON 协议响应' }
    })
    const status = await pi.locate()

    expect(status.state).toBe('failed')
    expect(status.message).toContain('JSON')
    expect(pi.launch()).toBeUndefined()
  })

  it('status() 返回最近一次自检结果', async () => {
    const pi = locator({ exists: ['/usr/bin/pi'] })
    expect(pi.status().state).toBe('unknown')

    await pi.locate()
    expect(pi.status().state).toBe('ok')
  })

  it('locate 不抛异常（全部失败都转成 PiSelfCheckStatus）', async () => {
    const pi = createPiLocator({
      platform: 'linux',
      env: { PATH: '' },
      fileExists: () => false,
      probeRpc: vi.fn(() => Promise.reject(new Error('不该被调用'))),
      runCapture: vi.fn(() => Promise.reject(new Error('不该被调用')))
    })
    await expect(pi.locate()).resolves.toMatchObject({ state: 'missing' })
  })
})
