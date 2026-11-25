import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_NO_UI_POLICY,
  PERMISSION_EXTENSION_NAME,
  PERMISSION_PROTOCOL_VERSION
} from '../../shared/contracts/permission'
import type { PermissionPolicy, PermissionStatus } from '../../shared/contracts/types'

/**
 * 审批扩展的「安装状态检测」与「策略下发」（M5）。
 *
 * 两件事，都与安全语义相关：
 * 1. **状态检测**（`permission:status`）：告诉设置页扩展装没装、装的是哪个版本、
 *    是否落后于仓库内的源。只读文件系统，不执行任何东西。
 * 2. **策略下发**：把设置页的审批策略序列化成一个环境变量，客户端 spawn pi 时注入。
 *    扩展读 `PI_DESKTOP_PERMISSION` 决定「是否开启 / 哪些工具需要审批 / 时钟」。
 *
 * 为什么不写扩展自己的配置文件：配置的所有者是客户端（设置页 + ConfigStore），
 * 客户端本来完全控制子进程环境，多一个写入方只会带来「两边不一致」的坑。
 */

export const PERMISSION_EXTENSION_DIR_NAME = PERMISSION_EXTENSION_NAME
export const EXTENSION_MARKER_FILE = `${PERMISSION_EXTENSION_NAME}.json`
export const MANAGED_BY = 'pi-desktop'
/** 策略环境变量名（与扩展侧 `POLICY_ENV_KEY` 同值） */
export const PERMISSION_POLICY_ENV_KEY = 'PI_DESKTOP_PERMISSION'

export interface PermissionExtensionDeps {
  /** `~/.pi/agent/extensions`（全局扩展根） */
  globalExtensionsDir?: string
  /** `<repo>/.pi/extensions`（项目本地扩展根；不存在则跳过） */
  projectExtensionsDir?: string
  /** 仓库内的扩展源目录（用于判断「已装版本是否落后」） */
  sourceDir?: string
  fileExists?: (path: string) => boolean
  readText?: (path: string) => string | undefined
}

function defaultGlobalExtensionsDir(): string {
  return join(homedir(), '.pi', 'agent', 'extensions')
}

interface MarkerFile {
  managedBy?: unknown
  version?: unknown
  files?: unknown
}

/**
 * 检测扩展安装状态。
 *
 * 判定口径：
 * - 目录存在 **且** 标记文件 `managedBy === 'pi-desktop'` → 视为本客户端安装（installed=true）；
 * - 其他情况（目录存在但无标记 → 用户自己的同名扩展）installed=false，不谎报可用；
 * - `upToDate` 逐文件与仓库源比对（读不到源时按 false 处理，宁可提示重装）。
 */
export function detectPermissionExtension(deps: PermissionExtensionDeps = {}): PermissionStatus {
  const fileExists = deps.fileExists ?? ((path: string) => existsSync(path))
  const readText =
    deps.readText ??
    ((path: string): string | undefined => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    })

  const roots = [
    deps.projectExtensionsDir,
    deps.globalExtensionsDir ?? defaultGlobalExtensionsDir()
  ].filter((root): root is string => root !== undefined && root.length > 0)

  for (const root of roots) {
    const dir = join(root, PERMISSION_EXTENSION_DIR_NAME)
    const markerText = readText(join(dir, EXTENSION_MARKER_FILE))
    if (markerText === undefined) continue

    let marker: MarkerFile
    try {
      marker = JSON.parse(markerText) as MarkerFile
    } catch {
      continue
    }
    if (marker.managedBy !== MANAGED_BY) continue

    // 没有源目录可比（打包后仓库源不在应用内）→ 不给出「落后」这种负面判断，
    // 只报告已安装的版本；否则会在用户刚装好时误报「建议重装」。
    const upToDate =
      deps.sourceDir === undefined
        ? true
        : compareWithSource(dir, deps.sourceDir, fileExists, readText)

    return {
      installed: true,
      extensionDir: dir,
      ...(typeof marker.version === 'string' ? { installedVersion: marker.version } : {}),
      protocolVersion: PERMISSION_PROTOCOL_VERSION,
      upToDate
    }
  }

  return {
    installed: false,
    extensionDir: join(roots.at(0) ?? defaultGlobalExtensionsDir(), PERMISSION_EXTENSION_DIR_NAME),
    protocolVersion: PERMISSION_PROTOCOL_VERSION,
    upToDate: false
  }
}

const COMPARED_FILES = ['index.ts', 'protocol.ts', 'types.ts'] as const

function compareWithSource(
  installedDir: string,
  sourceDir: string,
  fileExists: (path: string) => boolean,
  readText: (path: string) => string | undefined
): boolean {
  for (const name of COMPARED_FILES) {
    const sourcePath = join(sourceDir, name)
    if (!fileExists(sourcePath)) return false
    const installed = readText(join(installedDir, name))
    const source = readText(sourcePath)
    if (installed === undefined || source === undefined) return false
    if (installed !== source) return false
  }
  return true
}

/**
 * 审批策略 → 子进程环境变量值（单行 JSON）。
 *
 * 只下发**策略**，不含任何内容/密钥；扩展侧解析失败会回退到「默认审批开启」（fail-closed）。
 */
export function buildPermissionPolicyEnv(
  // noUi 允许缺省（老调用方/旧 renderer 的补丁里没有它）：缺省按 deny 下发，
  // 这样扩展侧永远只有「显式 deny / 显式 allow」两种形态，不存在「字段缺失」歧义。
  policy: Pick<PermissionPolicy, 'enabled' | 'tools' | 'timeoutMs'> & {
    noUi?: PermissionPolicy['noUi']
  }
): Record<string, string> {
  return {
    [PERMISSION_POLICY_ENV_KEY]: JSON.stringify({
      enabled: policy.enabled,
      tools: policy.tools,
      timeoutMs: policy.timeoutMs,
      // 即使 deny 也显式输出：避免「缺字段」与「deny」两种线上形态混用
      noUi: policy.noUi ?? DEFAULT_NO_UI_POLICY,
      protocolVersion: PERMISSION_PROTOCOL_VERSION
    })
  }
}
