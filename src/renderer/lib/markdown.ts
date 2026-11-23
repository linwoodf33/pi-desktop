import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'

/**
 * Markdown 安全策略（§9.4 S3）——渲染走 `react-markdown`（React 元素树），
 * **不使用 `dangerouslySetInnerHTML`**，因此天然没有「未净化 HTML 注入 DOM」的 sink。
 *
 * 三道防线：
 * 1. `rehype-sanitize` 的白名单 schema（只放行 http/https/mailto 与相对地址，
 *    `javascript:` / `data:` / `file:` 一律剥离；`<script>`、`on*` 事件属性不在白名单里）；
 * 2. 代码高亮放在净化**之后**（`rehype-highlight` 只产 span/class，不会引入用户 HTML）；
 * 3. 链接点击由组件统一 preventDefault，只有 http(s) 才交给主进程二次确认后打开（§9.4 S4）。
 */
export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    /** 只放行这三种协议（相对地址由 schema 的其它规则处理，不含协议不会被这条拦截） */
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https']
  },
  attributes: {
    ...defaultSchema.attributes,
    // 高亮产物（净化之后生成）与代码语言标记需要 className
    code: [...(defaultSchema.attributes?.['code'] ?? []), ['className', /^language-./, 'hljs']],
    pre: [...(defaultSchema.attributes?.['pre'] ?? []), 'className']
  }
}

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 链接是否安全：相对路径/锚点算安全（不会导航出应用），其余按协议白名单 */
export function isSafeLink(href: string): boolean {
  const value = href.trim()
  if (value.length === 0) return false
  if (/^(\.{0,2}\/|#|\?)/.test(value)) return true
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return true
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * 外链归一：只返回 http(s) 绝对 URL，其余（`javascript:`、`data:`、`file:`、相对地址）返回 undefined。
 * 组件据此决定「可点击打开」还是「纯文本展示」。
 */
export function toExternalUrl(href: string | undefined): string | undefined {
  if (href === undefined) return undefined
  if (!isSafeLink(href)) return undefined
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

/** 图片只允许 http(s)（`data:` 图片可携带攻击面，`file:` 会读本地文件） */
export function isSafeImageSrc(src: string | undefined): boolean {
  if (src === undefined) return false
  try {
    const url = new URL(src)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
