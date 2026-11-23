/**
 * `scripts/install-permission-extension.mjs` 的类型声明。
 *
 * 脚本本身是独立 CLI（不属于任何 tsconfig 项目，用 `.mjs` 直跑），但集成测试会 import 它来
 * 单测路径校验分支（`resolveTargetDir`）。没有这份声明时 TS 会把模块当 any，
 * 破坏 `strict` + `no-unsafe-*` 规则。
 */

export interface ResolveTargetDirOptions {
  /** 默认 `os.homedir()` */
  home?: string
  /** 默认 `process.cwd()` */
  cwd?: string
  /** 目标目录（绝对或相对 cwd） */
  target?: string
  /** 测试注入：真实路径归一（默认 `fs.realpathSync`） */
  realPath?: (value: string) => string
}

/** 安装目标目录（已 realpath 归一、已校验落在 home/cwd 内） */
export declare function resolveTargetDir(options?: ResolveTargetDirOptions): string

export declare const EXTENSION_DIR_NAME: string
export declare const MARKER_FILE: string
export declare const MANAGED_BY: string
export declare const SOURCE_FILES: readonly string[]
export declare const REPO_ROOT: string
export declare const SOURCE_DIR: string
export declare const SOURCE_VERSION: string

export declare class PathError extends Error {}
export declare class ConflictError extends Error {}

export declare function main(argv: readonly string[]): number
