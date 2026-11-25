import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPiPackageCatalog } from '../../src/main/services/pi-package-catalog'

/**
 * 插件清单（A37 阶段 2a）：settings.json#packages → 受管目录 → package.json 摘要。
 *
 * 守的边界：
 * 1. settings 坏了只降级（空清单 + 可读原因），不抛；
 * 2. source 解析必须与 pi 的受管目录一致（npm scoped、git 的 ref、URL 的 `.git`/`#ref`）；
 * 3. 目录找不到时**省略** installedPath，而不是谎报「未安装」；
 * 4. 资源探测只表示「包目录里可能有」，按固定顺序输出。
 */
let root: string
let agentDir: string
let projectRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-pkgs-'))
  // 多套两层：C7 的相对路径 `..\..` 才能落在临时目录内（不污染系统 tmp）
  agentDir = join(root, 'a', 'b', 'agent')
  projectRoot = join(root, 'workspace')
  mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function catalog(
  overrides: Parameters<typeof createPiPackageCatalog>[0] = {}
): ReturnType<typeof createPiPackageCatalog> {
  return createPiPackageCatalog({ agentDir, homeDir: join(root, 'home'), ...overrides })
}

function writeSettings(packages: unknown[]): void {
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages }), 'utf8')
}

function writeProjectSettings(packages: unknown[]): void {
  mkdirSync(join(projectRoot, '.pi'), { recursive: true })
  writeFileSync(join(projectRoot, '.pi', 'settings.json'), JSON.stringify({ packages }), 'utf8')
}

function makePackageDir(...segments: string[]): string {
  const dir = join(...segments)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeManifest(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value), 'utf8')
}

describe('createPiPackageCatalog', () => {
  it('C1 settings.json 不存在 → 空清单、无 error', async () => {
    const view = await catalog().list()
    expect(view.agentDir).toBe(agentDir)
    expect(view.packages).toEqual([])
    expect(view.globalSettingsError).toBeUndefined()
  })

  it('C2 settings.json 损坏 → globalSettingsError 非空、降级为空清单、不抛', async () => {
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), '{ "packages": [', 'utf8')
    const view = await catalog().list()
    expect(view.packages).toEqual([])
    expect(view.globalSettingsError).toBeTruthy()
    expect((view.globalSettingsError ?? '').length).toBeLessThanOrEqual(200)
  })

  it('C3 npm: 无作用域包 → <agentDir>/npm/node_modules/<name>', async () => {
    writeSettings(['npm:pi-web-access'])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', 'pi-web-access')
    writeManifest(dir, { name: 'pi-web-access', version: '1.0.0' })

    const view = await catalog().list()
    expect(view.packages).toHaveLength(1)
    expect(view.packages[0]).toMatchObject({
      source: 'npm:pi-web-access',
      kind: 'npm',
      scope: 'global',
      name: 'pi-web-access',
      version: '1.0.0',
      installedPath: dir,
      filtered: false,
      resources: []
    })
  })

  it('C4 npm scoped + 版本后缀 → node_modules/@scope/pkg，版本不算进名字', async () => {
    writeSettings(['npm:@scope/pkg@1.2.3'])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', '@scope', 'pkg')
    // 故意不写 package.json 的 name：验证兜底名也来自 npm 包名
    writeManifest(dir, { version: '1.2.3' })

    const view = await catalog().list()
    expect(view.packages[0]).toMatchObject({
      kind: 'npm',
      name: '@scope/pkg',
      installedPath: dir,
      version: '1.2.3'
    })
  })

  it('C5 git:host/user/repo（带 ref）→ <agentDir>/git/host/user/repo', async () => {
    writeSettings(['git:github.com/user/repo@v1.2.0'])
    const dir = makePackageDir(agentDir, 'git', 'github.com', 'user', 'repo')
    writeManifest(dir, { name: 'repo' })

    const view = await catalog().list()
    expect(view.packages[0]).toMatchObject({
      kind: 'git',
      name: 'repo',
      installedPath: dir
    })
  })

  it('C6 https URL 的 .git 与 #ref 都不进目录', async () => {
    writeSettings(['https://github.com/user/repo.git#main'])
    const dir = makePackageDir(agentDir, 'git', 'github.com', 'user', 'repo')
    writeManifest(dir, { name: 'repo' })

    const view = await catalog().list()
    expect(view.packages[0]).toMatchObject({
      kind: 'git',
      installedPath: dir
    })
  })

  it('C7 相对路径 / ~ / 绝对路径 → kind local，各自解析正确', async () => {
    const relativeSource = '..\\..\\pi-init\\x'
    const relativeDir = resolve(agentDir, relativeSource)
    const tildeDir = join(root, 'home', 'tools', 'pkg')
    const absoluteDir = join(root, 'abs', 'pkg')

    writeSettings([relativeSource, '~/tools/pkg', absoluteDir])
    makePackageDir(relativeDir)
    makePackageDir(tildeDir)
    makePackageDir(absoluteDir)

    const view = await catalog().list()
    const bySource = new Map(view.packages.map((pkg) => [pkg.source, pkg]))
    expect(bySource.get(relativeSource)).toMatchObject({
      kind: 'local',
      installedPath: relativeDir
    })
    expect(bySource.get('~/tools/pkg')).toMatchObject({
      kind: 'local',
      installedPath: tildeDir
    })
    expect(bySource.get(absoluteDir)).toMatchObject({
      kind: 'local',
      installedPath: absoluteDir
    })
  })

  it('C8 对象形态：extensions 非空 → filtered，autoload:false 透出', async () => {
    writeSettings([{ source: 'npm:pi-web-access', extensions: ['-a.ts'], autoload: false }])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', 'pi-web-access')
    writeManifest(dir, { name: 'pi-web-access' })

    const view = await catalog().list()
    expect(view.packages[0]).toMatchObject({
      source: 'npm:pi-web-access',
      filtered: true,
      autoload: false
    })
  })

  it('C9 受管目录不存在 → 无 installedPath，条目仍保留', async () => {
    writeSettings(['npm:ghost-pkg'])
    const view = await catalog().list()
    expect(view.packages).toHaveLength(1)
    expect(view.packages[0]).toMatchObject({ kind: 'npm', name: 'ghost-pkg' })
    expect(view.packages[0]).not.toHaveProperty('installedPath')
    expect(view.packages[0]).not.toHaveProperty('manifestError')
  })

  it('C10 package.json 缺失 → manifestError 非空、name 回落', async () => {
    writeSettings(['npm:manifest-less'])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', 'manifest-less')
    const view = await catalog().list()
    expect(view.packages[0]).toMatchObject({
      name: 'manifest-less',
      installedPath: dir
    })
    expect(view.packages[0]?.manifestError).toBeTruthy()
    expect((view.packages[0]?.manifestError ?? '').length).toBeLessThanOrEqual(200)
  })

  it('C11 package.json 无 version/description → 字段省略（不是空串）', async () => {
    writeSettings(['npm:minimal'])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', 'minimal')
    writeManifest(dir, { name: 'minimal' })

    const view = await catalog().list()
    expect(view.packages[0]?.name).toBe('minimal')
    expect(view.packages[0]).not.toHaveProperty('version')
    expect(view.packages[0]).not.toHaveProperty('description')
    expect(view.packages[0]).not.toHaveProperty('manifestError')
  })

  it('C12 资源探测：extensions/ + skills/ → 固定顺序输出', async () => {
    writeSettings(['npm:rich'])
    const dir = makePackageDir(agentDir, 'npm', 'node_modules', 'rich')
    writeManifest(dir, { name: 'rich' })
    mkdirSync(join(dir, 'skills'), { recursive: true })
    mkdirSync(join(dir, 'extensions'), { recursive: true })

    const view = await catalog().list()
    expect(view.packages[0]?.resources).toEqual(['extensions', 'skills'])
  })

  it('C13 项目级条目 scope=project；项目 settings 损坏时全局条目仍在', async () => {
    writeSettings(['npm:global-pkg'])
    writeManifest(makePackageDir(agentDir, 'npm', 'node_modules', 'global-pkg'), {
      name: 'global-pkg'
    })
    writeProjectSettings(['npm:project-pkg'])
    // 注意：项目条目的受管目录仍在 agentDir 下（pi 的受管位置与项目无关）
    writeManifest(makePackageDir(agentDir, 'npm', 'node_modules', 'project-pkg'), {
      name: 'project-pkg'
    })

    const ok = await catalog().list(projectRoot)
    expect(ok.projectRoot).toBe(projectRoot)
    expect(ok.packages).toEqual([
      expect.objectContaining({ name: 'global-pkg', scope: 'global' }),
      expect.objectContaining({ name: 'project-pkg', scope: 'project' })
    ])
    expect(ok.projectSettingsError).toBeUndefined()

    writeFileSync(join(projectRoot, '.pi', 'settings.json'), '{ broken', 'utf8')
    const broken = await catalog().list(projectRoot)
    expect(broken.projectSettingsError).toBeTruthy()
    expect(broken.packages).toEqual([
      expect.objectContaining({ name: 'global-pkg', scope: 'global' })
    ])
  })

  it('C14 结果按 name 升序', async () => {
    writeSettings(['npm:zeta', 'npm:alpha'])
    const view = await catalog().list()
    expect(view.packages.map((pkg) => pkg.name)).toEqual(['alpha', 'zeta'])
  })
})
