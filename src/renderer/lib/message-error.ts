/**
 * 模型调用失败的可读化（纯函数、无 DOM、无 React；文案改动只在这里）。
 *
 * 输入是 pi 的 `errorMessage` 原文（如 `Request timed out.: Connect Timeout Error (...)`），
 * 输出给 UI 直接渲染：一句可懂的中文标题 + 一句建议，原文另行折叠展示。
 */
export type ModelErrorKind =
  'timeout' | 'connection' | 'auth' | 'rate_limit' | 'context' | 'unknown'

export interface ModelErrorText {
  kind: ModelErrorKind
  /** 一句话标题（用户可懂，不含原始堆栈） */
  title: string
  /** 一句建议（可为空串） */
  hint: string
}

interface ModelErrorRule {
  kind: ModelErrorKind
  /** 对 `toLowerCase()` 后的文本做一次测试（不带 `g`，避免 lastIndex 状态） */
  pattern: RegExp
  title: string
  hint: string
}

/**
 * 规则表：**顺序即优先级**。
 * 例如 `Connect Timeout Error` 同时像 timeout 与 connection，先命中 timeout 更准确。
 */
const RULES: readonly ModelErrorRule[] = [
  {
    kind: 'timeout',
    pattern: /timed?\s?out|timeout|etimedout/,
    title: '模型请求超时',
    hint: '网络或模型服务响应过慢，可稍后重试'
  },
  {
    kind: 'connection',
    pattern:
      /connect error|connect timeout|econnrefused|econnreset|enotfound|socket hang up|network|fetch failed|tls|certificate/,
    title: '无法连接模型服务',
    hint: '检查网络 / 代理 / 模型服务地址'
  },
  {
    kind: 'auth',
    pattern: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api[-_ ]?key/,
    title: '模型认证失败',
    hint: '检查模型 API Key 与账号权限'
  },
  {
    kind: 'rate_limit',
    pattern: /\b429\b|rate limit|too many requests|quota/,
    title: '模型服务限流',
    hint: '稍后再试，或降低并发'
  },
  {
    kind: 'context',
    pattern: /context (length|window)|maximum context|too long|token limit/,
    title: '上下文超出模型上限',
    hint: '新建任务或从较早的分叉点继续'
  }
]

/** 把 pi 的 `errorMessage` 归类成中文标题；无法归类时给通用兜底（不抛） */
export function describeModelError(errorMessage: string | undefined): ModelErrorText {
  const text = (errorMessage ?? '').toLowerCase()
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { kind: rule.kind, title: rule.title, hint: rule.hint }
    }
  }
  return { kind: 'unknown', title: '模型调用失败', hint: '展开技术详情查看原始错误' }
}

/** 「连续 N 次失败」提示；N<=1 返回空串（单次失败不需要提「重试」） */
export function retryLine(count: number): string {
  if (count <= 1) return ''
  return `连续 ${count} 次尝试失败（pi 已自动重试 ${count - 1} 次）`
}
