/**
 * 生成 Release notes（发布工作流调用）。
 *
 * 为什么不用 PowerShell 拼：v0.2.0 首次发布踩过两脚 ——
 * 1. 双引号 here-string 里反引号是转义符，`` `$env:INSTALLER_NAME` `` 变成字面量，
 *    notes 里出现 "- 文件：$env:INSTALLER_NAME"；
 * 2. `Out-File` / `Get-Content` 的默认编码在 Windows PowerShell 5.1 与 pwsh 7 不一样，中文有乱码风险。
 * 文本处理交给 Node：UTF-8 原生、可单测、无 shell 引号层。
 *
 * 用法（环境变量由工作流提供）：
 *   PKG_VERSION=0.2.0 INSTALLER_NAME=pi-desktop-0.2.0-x64.exe INSTALLER_SHA256=<sha> \
 *     node scripts/build-release-notes.mjs --out release-notes.md
 *
 * 退出码：0 成功；1 参数缺失。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const ROOT = process.cwd()

/** 从 CHANGELOG 里取出某个版本的段落（到下一个 `## v` 之前） */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const prefix = `## v${version}`
  // 不用动态正则（也就不用担心转义）：先判前缀，再卡边界字符。
  // 标题形如 `## v0.2.0（日期）`，但 `## v0.2.01` / `## v0.2.0-rc` 不能命中。
  const start = lines.findIndex((line) => {
    if (!line.startsWith(prefix)) return false
    const rest = line.slice(prefix.length)
    // 紧跟版本号字符（数字/字母/`.`/`-`/`+`）就是另一个版本：`v0.2.01`、`v0.2.0-rc`、`v0.2.0+build`
    // 否则视为标题（`## v0.2.0（日期）` 后面是全角括号、或行尾什么也没有）
    if (rest.length > 0 && /[0-9A-Za-z.+-]/.test(rest.charAt(0))) return false
    return true
  })
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## v')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trimEnd()
}

/** 组装 notes：安装说明模板 + （可选）CHANGELOG 段落 */
export function buildReleaseNotes({ version, installerName, sha256, changelogSection }) {
  const header = [
    'Windows x64 安装包（NSIS，per-user，无需管理员权限）。',
    '',
    `- 版本：v${version}`,
    `- 文件：${installerName}`,
    `- SHA-256：${sha256}`,
    '',
    '**本产物未做代码签名**（仓库未配置签名证书），首次运行 Windows SmartScreen 可能提示',
    '“已保护你的电脑”，需点「更多信息 → 仍要运行」。校验方式（下载到任意目录后执行，结果应与上面一致）：',
    '',
    '```powershell',
    `Get-FileHash ${installerName} -Algorithm SHA256`,
    '```',
    '',
    '安装包内置 Electron 运行时，**不要求目标机预装 Node 或 pi**；pi 需另行安装，',
    '客户端会在设置里定位 pi 可执行文件（也可手动指定路径）。'
  ].join('\n')

  if (changelogSection === undefined) return `${header}\n`
  return `${header}\n\n---\n\n${changelogSection}\n`
}

function main(argv) {
  const outIndex = argv.indexOf('--out')
  const out = outIndex >= 0 ? argv[outIndex + 1] : 'release-notes.md'
  const version = process.env['PKG_VERSION']
  const installerName = process.env['INSTALLER_NAME']
  const sha256 = process.env['INSTALLER_SHA256']

  if (
    version === undefined ||
    installerName === undefined ||
    sha256 === undefined ||
    out === undefined
  ) {
    console.error('缺少环境变量：需要 PKG_VERSION / INSTALLER_NAME / INSTALLER_SHA256')
    return 1
  }

  let section
  try {
    section = extractChangelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version)
  } catch {
    section = undefined
  }
  if (section === undefined) {
    console.log(`CHANGELOG 中没有 v${version} 段落，仅使用模板 notes`)
  } else {
    console.log(`已并入 CHANGELOG 的 v${version} 段落`)
  }

  const notes = buildReleaseNotes({ version, installerName, sha256, changelogSection: section })
  // `--out` 允许绝对路径（本地调试常用），相对路径按仓库根解析
  writeFileSync(isAbsolute(out) ? out : join(ROOT, out), notes, 'utf8')
  console.log(`已写入 ${out}（${Buffer.byteLength(notes, 'utf8')} B）`)
  return 0
}

// 只在作为脚本直接运行时执行（被单测 import 时不跑）
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))
) {
  process.exitCode = main(process.argv.slice(2))
}
