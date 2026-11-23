/**
 * `scripts/build-release-notes.mjs` 的类型声明。
 *
 * 脚本是独立 CLI（`.mjs` 直跑，不进任何 tsconfig 项目），但单测会 import 它的纯函数；
 * 没有这份声明时 TS 把模块当 any，会破坏 strict + `no-unsafe-*` 规则。
 */
export interface BuildReleaseNotesInput {
  /** 不带 `v` 前缀的版本号，如 `0.2.0` */
  version: string
  /** 安装包文件名，如 `pi-desktop-0.2.0-x64.exe` */
  installerName: string
  /** 安装包 SHA-256（小写 hex） */
  sha256: string
  /** CHANGELOG 里对应版本的段落；缺省则只输出模板 */
  changelogSection?: string
}

/** 取出 CHANGELOG 中某个版本的段落（到下一个 `## v` 之前）；找不到返回 undefined */
export declare function extractChangelogSection(
  changelog: string,
  version: string
): string | undefined

/** 组装 Release notes（模板 + 可选 CHANGELOG 段落） */
export declare function buildReleaseNotes(input: BuildReleaseNotesInput): string
