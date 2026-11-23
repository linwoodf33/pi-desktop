import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectPermissionExtension, buildPermissionPolicyEnv } from '../../src/main/services/permission-extension'
import { resolveTargetDir } from '../../scripts/install-permission-extension.mjs'

/**
 * 扩展安装脚本的黑盒测试（M5 第 2 项）。
 *
 * 为什么用真实 `node scripts/...` 而不是 import：脚本是独立 CLI（不属于任何 tsconfig 项目），
 * 黑盒跑能同时验证「参数解析 / 退出码 / 幂等 / 冲突保护 / 路径校验」这些只有真跑才看得见的语义。
 */

const REPO_ROOT = resolve(process.cwd())
const SCRIPT = join(REPO_ROOT, 'scripts', 'install-permission-extension.mjs')
const SOURCE_DIR = join(REPO_ROOT, 'src', 'extensions', 'permission')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

function run(args: string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

let tempRoot: string
let extensionsRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-perm-'))
  extensionsRoot = join(tempRoot, 'extensions')
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('安装脚本：幂等', () => {
  it('首次安装 → 再次安装报告「无需改动」，文件内容与源一致', () => {
    const first = run(['--target', extensionsRoot, '--status'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('未安装')

    const installed = run(['--target', extensionsRoot])
    expect(installed.code).toBe(0)
    expect(installed.stdout).toContain('已安装')
    expect(installed.stdout).toContain('写入')

    const dir = join(extensionsRoot, 'pi-desktop-permission')
    expect(existsSync(join(dir, 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'protocol.ts'))).toBe(true)
    expect(existsSync(join(dir, 'types.ts'))).toBe(true)
    expect(existsSync(join(dir, 'pi-desktop-permission.json'))).toBe(true)
    // 装的是仓库内的源（逐字节相同）
    expect(readFileSync(join(dir, 'protocol.ts'), 'utf8')).toBe(
      readFileSync(join(SOURCE_DIR, 'protocol.ts'), 'utf8')
    )

    // 幂等：第二次没有任何写入
    const again = run(['--target', extensionsRoot])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('已是最新')
    expect(again.stdout).not.toContain('写入：')

    const status = run(['--target', extensionsRoot, '--status'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain('已安装')
    expect(status.stdout).toContain('与源一致：是')
  })

  it('卸载幂等：删掉后再次卸载报告无需卸载', () => {
    run(['--target', extensionsRoot])
    const removed = run(['--target', extensionsRoot, '--uninstall'])
    expect(removed.code).toBe(0)
    expect(removed.stdout).toContain('已卸载')
    expect(existsSync(join(extensionsRoot, 'pi-desktop-permission'))).toBe(false)

    const again = run(['--target', extensionsRoot, '--uninstall'])
    expect(again.code).toBe(0)
    expect(again.stdout).toContain('无需卸载')
  })
})

describe('安装脚本：冲突与路径校验（不得破坏用户扩展）', () => {
  it('同名目录但不是本客户端装的 → 退出码 3，且不动用户文件', () => {
    const dir = join(extensionsRoot, 'pi-desktop-permission')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), '// 用户自己的实现\n', 'utf8')

    const result = run(['--target', extensionsRoot])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('冲突')
    // 用户文件原样保留
    expect(readFileSync(join(dir, 'index.ts'), 'utf8')).toBe('// 用户自己的实现\n')
  })

  it('用户同名扩展也不会被 --uninstall 删除', () => {
    const dir = join(extensionsRoot, 'pi-desktop-permission')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), '// 用户自己的实现\n', 'utf8')

    const result = run(['--target', extensionsRoot, '--uninstall'])
    expect(result.code).toBe(3)
    expect(existsSync(join(dir, 'index.ts'))).toBe(true)
  })

  it('目标路径逃出主目录/cwd → 退出码 4', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\Temp\\pi-perm' : '/tmp/../../../etc'
    const result = run(['--target', outside])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('路径校验失败')
    expect(existsSync(join(outside, 'pi-desktop-permission'))).toBe(false)
  })

  it('未知参数 → 退出码 2', () => {
    const result = run(['--nope'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('参数错误')
  })

  it('--help 打印用法且不改动磁盘', () => {
    const result = run(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--uninstall')
    expect(existsSync(join(extensionsRoot, 'pi-desktop-permission'))).toBe(false)
  })
})

describe('客户端状态检测（permission:status 的数据来源）', () => {
  it('装好之后 detectPermissionExtension 报告 installed + upToDate', () => {
    run(['--target', extensionsRoot])
    const status = detectPermissionExtension({
      globalExtensionsDir: extensionsRoot,
      sourceDir: SOURCE_DIR
    })
    expect(status.installed).toBe(true)
    expect(status.upToDate).toBe(true)
    expect(status.installedVersion).toBeTruthy()
    expect(status.protocolVersion).toBe(1)
  })

  it('未安装 / 用户自己装的同名扩展 → installed=false（不谎报可用）', () => {
    expect(
      detectPermissionExtension({ globalExtensionsDir: extensionsRoot, sourceDir: SOURCE_DIR })
        .installed
    ).toBe(false)

    const dir = join(extensionsRoot, 'pi-desktop-permission')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), '// 用户的\n', 'utf8')
    expect(
      detectPermissionExtension({ globalExtensionsDir: extensionsRoot, sourceDir: SOURCE_DIR })
        .installed
    ).toBe(false)
  })

  it('装了但源已更新 → upToDate=false（提示重装）', () => {
    run(['--target', extensionsRoot])
    const dir = join(extensionsRoot, 'pi-desktop-permission')
    writeFileSync(join(dir, 'protocol.ts'), '// 旧版本\n', 'utf8')
    const status = detectPermissionExtension({
      globalExtensionsDir: extensionsRoot,
      sourceDir: SOURCE_DIR
    })
    expect(status.installed).toBe(true)
    expect(status.upToDate).toBe(false)
  })
})

describe('策略下发（环境变量）', () => {
  it('序列化为单行 JSON，带协议版本；不含任何内容或密钥', () => {
    const env = buildPermissionPolicyEnv({
      enabled: true,
      tools: ['bash', 'write'],
      timeoutMs: 120_000
    })
    const raw = env['PI_DESKTOP_PERMISSION']
    expect(raw).toBeDefined()
    expect(raw).not.toContain('\n')
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>
    expect(parsed).toEqual({
      enabled: true,
      tools: ['bash', 'write'],
      timeoutMs: 120_000,
      protocolVersion: 1
    })
  })

  it('关掉审批时如实下发 enabled:false（由扩展侧决定不询问）', () => {
    const env = buildPermissionPolicyEnv({ enabled: false, tools: [], timeoutMs: 60_000 })
    expect(JSON.parse(env['PI_DESKTOP_PERMISSION'] ?? '{}')).toEqual({
      enabled: false,
      tools: [],
      timeoutMs: 60_000,
      protocolVersion: 1
    })
  })
})

/**
 * 回归（CI 首跑暴露）：临时目录来自 `mkdtemp`，在 Windows runner 上是 **8.3 短路径**
 * （`…\RUNNER~1\AppData\Local\Temp\...`），而 `homedir()` 是长路径
 * （`…\runneradmin`）。纯词法 `path.relative` 判前缀不同 → 被当成越权，退出码 4，
 * 连带后续「装好之后 detectPermissionExtension 报告 installed」用例全红。
 *
 * 用注入的 `realPath` 确定性复现，不依赖 runner 是否开启 8.3。
 */
describe('resolveTargetDir：同一目录的别名写法（junction）', () => {
  /**
   * 用 junction 造两个“词法不同、实际同一个目录”的绝对路径。
   *
   * CI 上的真实触发形式是 Windows 8.3 短路径（`RUNNER~1` vs `runneradmin`），
   * 但那取决于卷上是否开启 8.3，不能当测试前提；junction 同样制造“不共享词法前缀”的别名，
   * 且不需要提权（`mklink /J` 普通用户即可），也覆盖了 subst/映射盘的同类场景。
   */
  function makeJunction(link: string, target: string): boolean {
    if (process.platform !== 'win32') return false
    const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' })
    return result.status === 0 && existsSync(link)
  }

  it('主目录是真实路径、target 走别名路径 → 不报路径校验失败且返回归一后的真实路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-desktop-alias-'))
    const realHome = join(root, 'real-home')
    const linkHome = join(root, 'link-home')
    mkdirSync(realHome, { recursive: true })
    const linked = makeJunction(linkHome, realHome)

    try {
      if (!linked) {
        // 不假装通过：拿不到 junction 就显式跳过（与既有 symlink 用例同一口径）
        console.warn('[skip] 当前环境无法创建 junction，跳过别名路径用例')
        return
      }

      const dir = resolveTargetDir({
        home: realHome,
        cwd: root,
        target: join(linkHome, 'extensions')
      })
      // 返回真实路径（后续 mkdir/写文件都用它，避免同一目录出现两种写法）
      expect(dir.toLowerCase()).toBe(join(realHome, 'extensions').toLowerCase())
    } finally {
      rmSync(linkHome, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('归一只改形态不改边界：真正越权的 target 仍然报错', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-desktop-home-'))
    try {
      expect(() =>
        resolveTargetDir({ home, cwd: home, target: 'C:\\Windows\\Temp\\pi-perm' })
      ).toThrow(/必须位于用户主目录/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('相对路径按 cwd 解析后仍受根约束', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-desktop-cwd-'))
    try {
      const dir = resolveTargetDir({ home: cwd, cwd, target: join('.pi', 'extensions') })
      expect(dir.toLowerCase()).toBe(join(cwd, '.pi', 'extensions').toLowerCase())
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * 真实 8.3 短名回归（CI 上的实际形态）：
 * `%TEMP%` 以 `…\RUNNER~1\...` 短名返回，而 `os.homedir()` 是长名
 * （`…\runneradmin`）。此前纯词法比较判越权 → 退出码 4，安装链路全红。
 *
 * 短名是否生成取决于卷策略（8.3 可被关闭），拿不到就显式跳过，不假装通过。
 */
describe('resolveTargetDir：真实 8.3 短名（CI 同形态）', () => {
  /** 用 FileSystemObject 取短名（cmd 的 %~sI 在 spawnSync 参数里引号会被吃） */
  function shortPathOf(dir: string): string | undefined {
    if (process.platform !== 'win32') return undefined
    const quoted = dir.replace(/'/g, "''")
    const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${quoted}').ShortPath`
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    const short = (result.stdout ?? '').trim()
    if (short.length === 0) return undefined
    // 卷上未生成短名时 ShortPath 就等于原路径
    return short.toLowerCase() === dir.toLowerCase() ? undefined : short
  }

  it('home 是长名、target 用短名 → 不报越权，且返回长名（可直接用于写盘）', () => {
    const home = mkdtempSync(join(tmpdir(), 'pi-desktop-83-long-home-name-'))
    try {
      const shortHome = shortPathOf(home)
      if (shortHome === undefined) {
        console.warn('[skip] 当前卷未生成 8.3 短名，跳过该用例')
        return
      }

      const dir = resolveTargetDir({ home, cwd: home, target: join(shortHome, 'extensions') })
      expect(dir.toLowerCase()).toBe(join(home, 'extensions').toLowerCase())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
