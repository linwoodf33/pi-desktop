import type { AgentSummary } from '../../shared/contracts/agents'

/**
 * A29 / A40：按目录把专家组织成树。
 *
 * pi 的 frontmatter 没有 parent 字段，唯一的层级信息是**定义文件所在目录**
 * （`agents/intranet/*.md` 属于 intranet 组），所以这里按 `group` 分段分组：
 * 根目录的直接排在最上面，其余每组一个 `<optgroup>`，条目按深度缩进。
 *
 * 从 `NewTaskDialog` 抽出来是为了让「新建任务」与「运行中切换」共用同一份分组逻辑
 * —— 两处各自实现的话，分组/排序迟早会走岔。
 */
export interface AgentTree {
  root: AgentSummary[]
  groups: Array<[string, AgentSummary[]]>
}

export function buildAgentTree(agents: readonly AgentSummary[]): AgentTree {
  const root = agents.filter((item) => item.group.length === 0)
  const grouped = new Map<string, AgentSummary[]>()
  for (const item of agents) {
    if (item.group.length === 0) continue
    const key = item.group.join('/')
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [item])
    else bucket.push(item)
  }
  const groups = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return { root, groups }
}
