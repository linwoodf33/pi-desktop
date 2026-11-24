import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentCatalog, parseFrontmatter } from '../../src/main/services/agent-catalog'
import type { PiLaunchSpec } from '../../src/main/transport/types'

/**
 * Agent 目录（A18）。
 *
 * 守三件事：
 * 1. frontmatter 解析够用且不脆（name/description/mode/model，引号值去掉引号）；
 * 2. 项目级同名 agent 覆盖全局；`.chain.md` 不是 agent；
 * 3. **能力探测**：`--agent` 是 pi-open-agents 扩展注册的 flag，未装时不能传
 *    （否则 pi 直接 `Error: Unknown option` 起不来），所以探测结果决定 UI 是否显示选择器。
 */
let dir: string
let agentDir: string
let projectDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-agent-catalog-'))
  agentDir = join(dir, 'agent')
  projectDir = join(dir, 'project')
  mkdirSync(join(agentDir, 'agents'), { recursive: true })
  mkdirSync(join(projectDir, '.pi', 'agents'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAgent(path: string, frontmatter: string, body = '你是 agent'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}

/** 假的能力探测：返回带/不带 `--agent` 的 help 文本 */
function fakeCapture(helpText: string): {
  runCapture: (
    spec: PiLaunchSpec,
    args: string[],
    timeoutMs: number
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    runCapture: (_spec, args) => {
      calls.push(args)
      return Promise.resolve({ code: 0, stdout: helpText, stderr: '' })
    }
  }
}

const launchSpec = { command: 'pi', prefixArgs: [] as string[] }

describe('parseFrontmatter', () => {
  it('解析单层 key: value', () => {
    const fields = parseFrontmatter(
      '---\nname: scout\ndescription: 快速侦察\nmode: primary\n---\nbody'
    )
    expect(fields).toEqual({ name: 'scout', description: '快速侦察', mode: 'primary' })
  })

  it('去掉成对引号', () => {
    expect(parseFrontmatter('---\nname: "quoted"\n---\n')).toEqual({ name: 'quoted' })
    expect(parseFrontmatter("---\nname: 'single'\n---\n")).toEqual({ name: 'single' })
  })

  it('没有 frontmatter / 未闭合时返回空对象（不抛错）', () => {
    expect(parseFrontmatter('只有正文')).toEqual({})
    expect(parseFrontmatter('---\nname: x\n')).toEqual({})
  })
})

describe('scan：目录发现与覆盖', () => {
  it('全局 + 项目级都能列出；项目同名覆盖全局', async () => {
    writeAgent(join(agentDir, 'agents', 'architect.md'), 'name: architect\ndescription: 全局版')
    writeAgent(join(agentDir, 'agents', 'nested', 'reviewer.md'), 'name: reviewer')
    writeAgent(
      join(projectDir, '.pi', 'agents', 'architect.md'),
      'name: architect\ndescription: 项目版'
    )

    const catalog = createAgentCatalog({
      agentDir,
      launch: () => launchSpec,
      runCapture: fakeCapture('pi --agent <value>').runCapture
    })
    const view = await catalog.list(projectDir)

    expect(view.agents.map((agent) => agent.name)).toEqual(['architect', 'reviewer'])
    const architect = view.agents.find((agent) => agent.name === 'architect')
    expect(architect?.scope).toBe('project')
    expect(architect?.description).toBe('项目版')
    // 嵌套子目录也会被发现
    expect(view.agents.find((agent) => agent.name === 'reviewer')?.scope).toBe('global')
  })

  it('未写 name 时用文件名；`.chain.md` 被跳过', async () => {
    writeFileSync(join(agentDir, 'agents', 'worker.md'), '---\ndescription: 无 name\n---\n', 'utf8')
    writeFileSync(join(agentDir, 'agents', 'flow.chain.md'), '---\nname: flow\n---\n', 'utf8')

    const catalog = createAgentCatalog({ agentDir, launch: () => undefined })
    const view = await catalog.list()
    expect(view.agents.map((agent) => agent.name)).toEqual(['worker'])
  })

  it('空目录 → 空列表（不报错）', async () => {
    const catalog = createAgentCatalog({ agentDir, launch: () => undefined })
    expect((await catalog.list()).agents).toEqual([])
  })
})

describe('能力探测：--agent 是否可用', () => {
  it('pi --help 里有 --agent → supportsAgentFlag=true', async () => {
    writeAgent(join(agentDir, 'agents', 'scout.md'), 'name: scout')
    const capture = fakeCapture(
      'Usage: pi [options]\n  --agent <value>   Default agent to use at startup'
    )
    const catalog = createAgentCatalog({
      agentDir,
      launch: () => launchSpec,
      runCapture: capture.runCapture
    })

    const view = await catalog.list()
    expect(view.supportsAgentFlag).toBe(true)
    expect(view.note).toBeUndefined()
    expect(capture.calls).toEqual([['--help']])
  })

  it('help 里没有 --agent → 不支持，并给出可操作说明（未装扩展）', async () => {
    const catalog = createAgentCatalog({
      agentDir,
      launch: () => launchSpec,
      runCapture: fakeCapture('Usage: pi [options]\n  --mode <mode>').runCapture
    })
    const view = await catalog.list()
    expect(view.supportsAgentFlag).toBe(false)
    expect(view.note).toContain('pi-open-agents')
  })

  it('未定位 pi（launch 返回 undefined）→ 不支持，不跑子进程', async () => {
    const capture = fakeCapture('--agent <value>')
    const catalog = createAgentCatalog({
      agentDir,
      launch: () => undefined,
      runCapture: capture.runCapture
    })
    const view = await catalog.list()
    expect(view.supportsAgentFlag).toBe(false)
    expect(view.note).toContain('尚未定位 pi')
    expect(capture.calls).toEqual([])
  })

  it('探测结果有缓存（同一 pi 命令不重复跑 --help）', async () => {
    const capture = fakeCapture('--agent <value>')
    const catalog = createAgentCatalog({
      agentDir,
      launch: () => launchSpec,
      runCapture: capture.runCapture,
      probeTtlMs: 60_000
    })
    await catalog.list()
    await catalog.list()
    await catalog.list()
    expect(capture.calls).toHaveLength(1)
  })

  it('探测抛错时降级为「不支持」，并把原因带回给 UI', async () => {
    const catalog = createAgentCatalog({
      agentDir,
      launch: () => launchSpec,
      runCapture: vi.fn(() => Promise.reject(new Error('spawn ENOENT')))
    })
    const view = await catalog.list()
    expect(view.supportsAgentFlag).toBe(false)
    expect(view.note).toContain('spawn ENOENT')
  })
})

describe('has：名字校验（pi 对未知 agent 会静默忽略）', () => {
  it('只认扫描到的名字', async () => {
    writeAgent(join(agentDir, 'agents', 'scout.md'), 'name: scout')
    const catalog = createAgentCatalog({ agentDir, launch: () => undefined })
    const view = await catalog.list()
    expect(catalog.has(view, 'scout')).toBe(true)
    expect(catalog.has(view, 'nosuchagent')).toBe(false)
  })
})

describe('目录分组（A29：树状展示的依据）', () => {
  it('根目录 agent 的 group 为空；子目录 agent 的 group 是目录分段', async () => {
    writeAgent(join(agentDir, 'agents', 'root-agent.md'), 'name: root-agent')
    writeAgent(join(agentDir, 'agents', 'team', 'child-agent.md'), 'name: child-agent')
    writeAgent(join(agentDir, 'agents', 'team', 'deep', 'grand.md'), 'name: grand')

    const catalog = createAgentCatalog({ agentDir, launch: () => undefined })
    const view = await catalog.list()
    const byName = new Map(view.agents.map((item) => [item.name, item]))
    expect(byName.get('root-agent')?.group).toEqual([])
    expect(byName.get('child-agent')?.group).toEqual(['team'])
    expect(byName.get('grand')?.group).toEqual(['team', 'deep'])
  })

  it('项目级 agent 也按项目 agents 目录分段（不与全局混层级）', async () => {
    writeAgent(join(projectDir, '.pi', 'agents', 'proj.md'), 'name: proj-agent')
    writeAgent(join(projectDir, '.pi', 'agents', 'sub', 'proj-child.md'), 'name: proj-child')

    const catalog = createAgentCatalog({ agentDir, launch: () => undefined })
    const view = await catalog.list(projectDir)
    const byName = new Map(view.agents.map((item) => [item.name, item]))
    expect(byName.get('proj-agent')?.group).toEqual([])
    expect(byName.get('proj-child')?.group).toEqual(['sub'])
  })
})
