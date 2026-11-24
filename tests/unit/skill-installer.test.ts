import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_SKILL_BYTES,
  assertAllowedSkillUrl,
  fallbackSkillName,
  installSkill,
  isPrivateAddress,
  parseSkillDocument,
  previewSkill,
  validateSkillName
} from '../../src/main/services/skill-installer'

/**
 * A32：从 URL 安装公开技能。
 *
 * 这里守的是**安全约束**（网络请求用注入替身，不真发请求）：
 * 只允许 https、拒内网、体积上限、名字白名单、不覆盖已有技能。
 */
const NL = String.fromCharCode(10)
const DOC = `---${NL}name: my-skill${NL}description: 演示技能${NL}---${NL}${NL}指令正文${NL}`

function fakeFetch(
  body: string,
  status = 200
): {
  calls: string[]
  impl: (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>
} {
  const calls: string[] = []
  return {
    calls,
    impl: (url) => {
      calls.push(url)
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body)
      })
    }
  }
}

describe('URL 安全约束', () => {
  it('只接受 https', () => {
    expect(assertAllowedSkillUrl('https://example.com/a/SKILL.md').hostname).toBe('example.com')
    expect(() => assertAllowedSkillUrl('http://example.com/a/SKILL.md')).toThrowError(/https/)
    expect(() => assertAllowedSkillUrl('file:///etc/passwd')).toThrowError(/https/)
  })

  it('拒绝内网 / 环回地址（SSRF）', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1']) {
      expect(isPrivateAddress(host)).toBe(true)
      expect(() => assertAllowedSkillUrl(`https://${host}/SKILL.md`)).toThrowError(/内网|环回/)
    }
    expect(isPrivateAddress('example.com')).toBe(false)
  })

  it('测试注入 allowLocalhost 时放行本地 http（生产恒为 false）', () => {
    expect(assertAllowedSkillUrl('http://127.0.0.1:8080/SKILL.md', true).port).toBe('8080')
  })
})

describe('名字与文档校验', () => {
  it('技能名白名单（拒绝路径穿越与大写）', () => {
    expect(validateSkillName('my-skill_1.2')).toBe('my-skill_1.2')
    expect(() => validateSkillName('../evil')).toThrowError(/不合法/)
    expect(() => validateSkillName('Has Space')).toThrowError(/不合法/)
  })

  it('URL 兜底名：…/foo/SKILL.md → foo', () => {
    expect(fallbackSkillName(new URL('https://e.com/skills/foo/SKILL.md'))).toBe('foo')
    expect(fallbackSkillName(new URL('https://e.com/bar.md'))).toBe('bar')
  })

  it('超过 512KB 被拒', () => {
    const big = 'x'.repeat(MAX_SKILL_BYTES + 1)
    expect(() => parseSkillDocument(big, new URL('https://e.com/a/SKILL.md'))).toThrowError(/过大/)
  })
})

describe('preview / install', () => {
  it('preview 不落盘，返回名称与描述', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skill-inst-'))
    const fake = fakeFetch(DOC)
    try {
      const preview = await previewSkill({
        url: 'https://example.com/skills/my-skill/SKILL.md',
        scope: 'global',
        agentDir: root,
        fetchImpl: fake.impl
      })
      expect(preview).toMatchObject({ name: 'my-skill', description: '演示技能' })
      expect(fake.calls).toHaveLength(1)
      expect(existsSync(join(root, 'skills', 'my-skill', 'SKILL.md'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('install 写到全局技能目录（内容与远端一致）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skill-inst-'))
    try {
      const result = await installSkill({
        url: 'https://example.com/skills/my-skill/SKILL.md',
        scope: 'global',
        agentDir: root,
        fetchImpl: fakeFetch(DOC).impl
      })
      expect(result.path.endsWith(join('skills', 'my-skill', 'SKILL.md'))).toBe(true)
      expect(readFileSync(result.path, 'utf8')).toBe(DOC)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('install 到项目级需要工作区；同名默认拒绝覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skill-inst-'))
    const project = join(root, 'ws')
    try {
      await expect(
        installSkill({
          url: 'https://example.com/skills/my-skill/SKILL.md',
          scope: 'project',
          agentDir: root,
          fetchImpl: fakeFetch(DOC).impl
        })
      ).rejects.toThrowError(/工作区/)

      await installSkill({
        url: 'https://example.com/skills/my-skill/SKILL.md',
        scope: 'project',
        agentDir: root,
        projectRoot: project,
        fetchImpl: fakeFetch(DOC).impl
      })
      expect(existsSync(join(project, '.pi', 'skills', 'my-skill', 'SKILL.md'))).toBe(true)

      // 第二次不覆盖
      await expect(
        installSkill({
          url: 'https://example.com/skills/my-skill/SKILL.md',
          scope: 'project',
          agentDir: root,
          projectRoot: project,
          fetchImpl: fakeFetch(DOC).impl
        })
      ).rejects.toThrowError(/同名技能已存在/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('HTTP 404 给出可读错误', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-skill-inst-'))
    try {
      await expect(
        previewSkill({
          url: 'https://example.com/x/SKILL.md',
          scope: 'global',
          agentDir: root,
          fetchImpl: fakeFetch('nope', 404).impl
        })
      ).rejects.toThrowError(/HTTP 404/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
