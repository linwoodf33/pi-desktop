import { memo, useMemo, type ComponentProps, type ReactNode } from 'react'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import ReactMarkdown from 'react-markdown'

import { markdownSanitizeSchema, toExternalUrl } from '../../lib/markdown'

/**
 * Markdown 渲染组件（§5.5 features/chat）。
 *
 * 安全（§9.4 S3/S4）——**没有 `dangerouslySetInnerHTML`**：
 * - 渲染走 `react-markdown`（输出是 React 元素树，没有 HTML 注入 sink）；
 * - `rehype-sanitize` 按白名单净化（协议只放行 http/https/mailto）；
 * - `rehype-highlight` 在净化之后加高亮 span（只产 span/class，不引入用户 HTML）；
 * - 外链**不在 renderer 里导航**：渲染成 `target="_blank"` 的普通链接，点击进入主进程
 *   `setWindowOpenHandler`（一律 deny 新窗口 + 用户二次确认后才 `shell.openExternal`）。
 *
 * 性能（A7）：markdown 解析（remark + rehype + sanitize + highlight）是 renderer 里最贵的一步，
 * 而流式增量会让父组件每来一个 `text_delta` 就重渲染整条时间线。因此本组件用 `memo`
 * 按 `text`/`streaming` 缓存结果——已定稿的历史消息不再重复解析（否则是 O(轮数²) 的重复
 * 解析，200 轮后会占满主线程并放大内存抖动）。`components` 必须是模块级常量，
 * 否则每次渲染都换新引用会让 memo 失效。
 */
export interface MarkdownProps {
  text: string
  /** 流式渲染时用轻量样式（不做打字动画，避免长文本抖动） */
  streaming?: boolean
}

type RehypePlugins = NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>
type RemarkPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>

const REMARK_PLUGINS: RemarkPlugins = [remarkGfm]
const REHYPE_PLUGINS: RehypePlugins = [
  [rehypeSanitize, markdownSanitizeSchema],
  [rehypeHighlight, { detect: false, ignoreMissing: true }]
]
const COMPONENTS: ComponentProps<typeof ReactMarkdown>['components'] = {
  a: MarkdownLink,
  img: MarkdownImage
}

function MarkdownBase({ text, streaming = false }: MarkdownProps) {
  const className = streaming ? 'md md--streaming' : 'md'

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** 已定稿消息的 markdown 不再重复解析（A7：避免流式期间 O(轮数²) 重解析） */
export const Markdown = memo(MarkdownBase)

interface LinkProps {
  href?: string | undefined
  children?: ReactNode
}

/**
 * 链接：只把 http(s) 渲染成可点击的 `target="_blank"`。
 * 相对路径/锚点/危险协议一律降级为纯文本，点击不产生任何导航。
 */
function MarkdownLink({ href, children }: LinkProps) {
  const external = useMemo(() => toExternalUrl(href), [href])

  if (external === undefined) {
    return <span className="md-link md-link--inert">{children}</span>
  }

  return (
    <a className="md-link" href={external} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  )
}

interface ImageProps {
  src?: string | undefined
  alt?: string | undefined
}

/** 图片：只渲染 http(s)；`data:` / `file:` 直接降级为 alt 文本 */
function MarkdownImage({ src, alt }: ImageProps) {
  const safe = useMemo(() => toExternalUrl(src), [src])
  if (safe === undefined) return <span className="md-link--inert">[{alt ?? 'image'}]</span>
  return <img src={safe} alt={alt ?? ''} />
}
