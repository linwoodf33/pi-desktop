import { describe, expect, it } from 'vitest'

import {
  assertCmdSafeArg,
  buildCmdCommandLine,
  quoteForCmdLine
} from '../../src/main/transport/local-connection'
import {
  buildLaunchSpec,
  extractNodeShimScript,
  resolveNodeExecutable
} from '../../src/main/services/pi-locator'
import { IpcFailure } from '../../src/shared/contracts/result'

/**
 * `pi.cmd` 风险修复的对抗性测试（M5 第 5 项）。
 *
 * 结论先行：Windows 下 `.cmd` 必须经 `cmd.exe`，而旧实现把实参拼进**一条命令行**，
 * 因此存在真实注入面（引号开关语义 / `%` 展开 / 换行拆命令）。修复策略：
 * 1. 能解析出 Node 入口 → 用 `node <入口>` + 参数数组，彻底不走 cmd；
 * 2. 解析不出 → 仍走 cmd，但含 `"` / `%` / CR / LF / NUL 的实参**直接报 VALIDATION**。
 *
 * 下面用真实攻击载荷断言这两条路径都不产生可执行注入。
 */

const OFFICIAL_SHIM = `@ECHO off
SETLOCAL
SET "node=node"
"%node%" "%~dp0pi-launcher.js" %*
`

const NPM_SHIM = `@ECHO off
"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*
`

const PI_CALL_ARGS = ['--mode', 'rpc', '--name', 'my session']

describe('extractNodeShimScript：识别官方 / npm 两种 shim', () => {
  it('官方 pi.cmd → pi-launcher.js', () => {
    expect(extractNodeShimScript(OFFICIAL_SHIM)).toBe('pi-launcher.js')
  })

  it('npm shim（%dp0%\\node_modules\\...\\cli.js）→ cli.js 相对路径', () => {
    expect(extractNodeShimScript(NPM_SHIM)).toBe(
      'node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'
    )
  })

  it('普通批处理（不含 node 入口）→ undefined（退回 cmd 分支）', () => {
    expect(extractNodeShimScript('@echo off\r\nstart "" "C:\\pi\\pi.exe" %*\r\n')).toBeUndefined()
  })
})

describe('buildLaunchSpec：优先绕过 cmd.exe', () => {
  const fileExists = (path: string): boolean =>
    path === 'C:\\pi\\pi-launcher.js' ||
    path === 'C:\\pi\\node.exe' ||
    path === 'C:\\nodejs\\node.exe'

  it('能解析出 Node 入口 + 找到 node → node-shim（零 cmd、零转义）', () => {
    const spec = buildLaunchSpec('C:\\pi\\pi.cmd', 'win32', 'cmd.exe', {
      readText: () => OFFICIAL_SHIM,
      fileExists,
      nodePath: 'C:\\nodejs\\node.exe'
    })
    expect(spec.launchKind).toBe('node-shim')
    expect(spec.command).toBe('C:\\nodejs\\node.exe')
    expect(spec.prefixArgs).toEqual(['C:\\pi\\pi-launcher.js'])
    // 没有 commandLine：参数走数组，Node 自己处理引号
    expect(spec.commandLine).toBeUndefined()
    // 恶落实参也只是数组元素，不会被 shell 解释
    expect(spec.prefixArgs).toEqual(['C:\\pi\\pi-launcher.js'])
  })

  it('解析不出 Node 入口 → cmd-shim 仍可用（安全参数）', () => {
    const spec = buildLaunchSpec('C:\\pi\\pi.cmd', 'win32', 'cmd.exe', {
      readText: () => '@echo off\r\necho hi\r\n',
      fileExists: () => false
    })
    expect(spec.launchKind).toBe('cmd-shim')
    expect(spec.command).toBe('cmd.exe')
    expect(spec.commandLine?.(PI_CALL_ARGS)).toBe('"C:\\pi\\pi.cmd --mode rpc --name "my session""')
  })

  it('.exe / posix 脚本 → direct（无 cmd）', () => {
    expect(buildLaunchSpec('C:\\pi\\pi.exe', 'win32').launchKind).toBe('direct')
    expect(buildLaunchSpec('/usr/local/bin/pi', 'linux').launchKind).toBe('direct')
  })
})

describe('cmd 分支：注入载荷必须被拒绝而不是被转义', () => {
  // 真实攻击意图：闭合引号后接新命令
  const payloads = [
    'x" & calc.exe & "',
    'x"&calc&"',
    '%PATH%',
    'x%1%*',
    'a\r\ncalc.exe',
    'a\ncalc.exe',
    `a${String.fromCharCode(0)}b`
  ]

  it.each(payloads)('实参 %j 被拒绝为 VALIDATION', (payload) => {
    try {
      assertCmdSafeArg(payload, 'pi 参数')
      expect.unreachable('不安全实参必须抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(IpcFailure)
      expect((error as IpcFailure).code).toBe('VALIDATION')
      // 错误信息不回显整段载荷（只给前 80 字符的转义预览）
      expect((error as IpcFailure).message).toContain('cmd.exe')
    }
  })

  it('buildCmdCommandLine 遇到恶意实参直接抛错（绝不产生可执行命令行）', () => {
    expect(() => buildCmdCommandLine('C:\\pi\\pi.cmd', ['--name', 'x" & calc & "'])).toThrow(
      IpcFailure
    )
  })

  it('安全实参：特殊字符被整体包引号（引号内 & | > ^ 都是字面量）', () => {
    const line = buildCmdCommandLine('C:\\pi\\pi.cmd', ['--name', 'a & b | c > d ^ e'])
    expect(line).toBe('"C:\\pi\\pi.cmd --name "a & b | c > d ^ e""')
  })

  it('可执行文件路径本身也校验（防止 pi 路径带引号做注入）', () => {
    expect(() => buildCmdCommandLine('C:\\pi x"\\pi.cmd', [])).toThrow(IpcFailure)
  })

  it('quoteForCmdLine：空串与普通 token', () => {
    expect(quoteForCmdLine('')).toBe('""')
    expect(quoteForCmdLine('plain')).toBe('plain')
    expect(quoteForCmdLine('two words')).toBe('"two words"')
  })
})

describe('resolveNodeExecutable：PATH / 常见目录', () => {
  it('Windows：从 PATH 命中 node.exe', () => {
    const found = resolveNodeExecutable(
      'win32',
      { PATH: 'C:\\tools;C:\\nodejs' },
      (path) => path === 'C:\\nodejs\\node.exe',
      () => []
    )
    expect(found).toBe('C:\\nodejs\\node.exe')
  })

  it('Windows：PATHEXT 目录内容兜底（大小写不敏感）', () => {
    const found = resolveNodeExecutable(
      'win32',
      { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' },
      () => false,
      (dir) => (dir === 'C:\\tools' ? ['NODE.EXE'] : [])
    )
    expect(found).toBe('C:\\tools\\NODE.EXE')
  })

  it('找不到 node → undefined（调用方回退 cmd 分支）', () => {
    expect(
      resolveNodeExecutable(
        'win32',
        { PATH: '' },
        () => false,
        () => []
      )
    ).toBeUndefined()
  })

  it('POSIX：从 PATH 命中 node', () => {
    const found = resolveNodeExecutable(
      'linux',
      { PATH: '/usr/bin:/usr/local/bin' },
      (path) => path === '/usr/local/bin/node',
      () => []
    )
    expect(found).toBe('/usr/local/bin/node')
  })
})

/**
 * 修复前后的可观测差别（作为回归锚点）：
 * 旧实现遇到 `x" & calc` 会生成 `"... --name "x\" & calc"`（cmd 在第二个 `"` 处结束引号，
 * `&` 变成命令分隔符）；新实现对这类实参直接抛 VALIDATION，命令行根本不会生成。
 */
describe('修复前后对比（回归锚点）', () => {
  const shimless = {
    readText: () => '@echo off\r\necho x\r\n',
    fileExists: () => false
  }

  it('修复前会注入的载荷，修复后连命令行都构造不出来', () => {
    const spec = buildLaunchSpec('C:\\pi\\pi.cmd', 'win32', 'cmd.exe', shimless)
    const build = (): string | undefined => spec.commandLine?.(['--name', 'x" & calc.exe & "'])
    expect(build).toThrow(IpcFailure)
  })

  it('同一条命令在 node-shim 分支下完全绕过 cmd（载荷只是普通数组元素）', () => {
    const spec = buildLaunchSpec('C:\\pi\\pi.cmd', 'win32', 'cmd.exe', {
      readText: () => OFFICIAL_SHIM,
      fileExists: (path) => path === 'C:\\pi\\pi-launcher.js',
      nodePath: 'C:\\nodejs\\node.exe'
    })
    expect(spec.commandLine).toBeUndefined()
    expect(spec.command).toBe('C:\\nodejs\\node.exe')
  })
})
