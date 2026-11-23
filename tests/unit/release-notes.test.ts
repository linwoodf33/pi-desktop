import { describe, expect, it } from 'vitest'

import { buildReleaseNotes, extractChangelogSection } from '../../scripts/build-release-notes.mjs'

/**
 * Release notes 生成（`scripts/build-release-notes.mjs`）。
 *
 * 这层单测存在的理由：v0.2.0 首个 Release 的 notes 里出现过
 * 「- 文件：$env:INSTALLER_NAME」这种字面量（PowerShell 双引号字符串里反引号是转义符），
 * 也差点踩到 `Out-File` 的编码差异。文本生成挪到 Node 后，正确性就能在这里钉住。
 */
const CHANGELOG = `# 更新日志（Changelog）

## v0.2.0（2026-11-23）

### 新增

- 主题系统

### 修复

- 一些小问题

---

## v0.1.0（2026-11-23）

- 首个发布
`

describe('extractChangelogSection', () => {
  it('取出目标版本段落，到下一个 `## v` 之前结束', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0')
    expect(section).toBeDefined()
    expect(section).toContain('## v0.2.0')
    expect(section).toContain('主题系统')
    expect(section).toContain('一些小问题')
    // 不能把 v0.1.0 的内容带进来
    expect(section).not.toContain('v0.1.0')
  })

  it('版本不存在时返回 undefined（调用方退化为只用模板）', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeUndefined()
  })

  it('不会被前缀相同的版本误命中（0.2.0 vs 0.2.01 / 0.2.0-rc）', () => {
    const tricky = `## v0.2.01（日期）

不该命中

## v0.2.0-rc（日期）

也不该命中

## v0.2.0（日期）

应该命中
`
    const section = extractChangelogSection(tricky, '0.2.0')
    expect(section).toContain('应该命中')
    expect(section).not.toContain('不该命中')
    expect(section).not.toContain('也不该命中')
  })

  it('CRLF 行尾同样可用', () => {
    const crlf = '## v0.1.0（日期）\r\n\r\n- 内容\r\n\r\n## v0.0.9\r\n\r\n- 旧内容\r\n'
    const section = extractChangelogSection(crlf, '0.1.0')
    expect(section).toContain('- 内容')
    expect(section).not.toContain('旧内容')
  })
})

describe('buildReleaseNotes', () => {
  const base = {
    version: '0.2.0',
    installerName: 'pi-desktop-0.2.0-x64.exe',
    sha256: 'a'.repeat(64)
  }

  it('变量真的被替换（不是字面量 $env:*）', () => {
    const notes = buildReleaseNotes(base)
    expect(notes).toContain('- 版本：v0.2.0')
    expect(notes).toContain('- 文件：pi-desktop-0.2.0-x64.exe')
    expect(notes).toContain(`- SHA-256：${'a'.repeat(64)}`)
    expect(notes).toContain('Get-FileHash pi-desktop-0.2.0-x64.exe -Algorithm SHA256')
    expect(notes).not.toContain('$env:')
    expect(notes).not.toContain('{0}')
  })

  it('明确声明未签名（不假装已签名发布）', () => {
    const notes = buildReleaseNotes(base)
    expect(notes).toContain('未做代码签名')
    expect(notes).toContain('SmartScreen')
  })

  it('有 CHANGELOG 段落时追加在分隔线之后', () => {
    const notes = buildReleaseNotes({ ...base, changelogSection: '## v0.2.0\n\n- 主题系统' })
    expect(notes).toContain('---')
    expect(notes.indexOf('## v0.2.0')).toBeGreaterThan(notes.indexOf('---'))
  })

  it('没有 CHANGELOG 段落时不出现分隔线', () => {
    const notes = buildReleaseNotes(base)
    expect(notes).not.toContain('---')
  })
})
