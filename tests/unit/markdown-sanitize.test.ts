import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isSafeImageSrc, isSafeLink, toExternalUrl } from '../../src/renderer/lib/markdown'
import { Markdown } from '../../src/renderer/features/chat/Markdown'
import { describe, expect, it } from 'vitest'

/**
 * §9.4 S3 等价单测：恶意 markdown 不执行、危险链接不可点击。
 *
 * 说明：渲染路径是 `react-markdown`（React 元素树）+ `rehype-sanitize`，
 * 因此用 `renderToStaticMarkup` 就能验证**真实组件**的产出，不需要 DOM/jsdom。
 */
function render(markdown: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text: markdown }))
}

describe('S3：<script> 与内联 HTML', () => {
  it('raw <script> 被剥掉（不渲染 script 标签）', () => {
    const html = render('hello\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('事件属性 onerror/onclick 被剥掉', () => {
    const html = render('<img src="x" onerror="alert(1)" /><a onclick="alert(2)">x</a>')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('onclick')
  })

  it('iframe / object / style 标签被剥掉', () => {
    const html = render(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><style>body{display:none}</style>'
    )
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<object')
    expect(html).not.toContain('<style')
  })
})

describe('S3：javascript:/data:/file: 链接不可点击', () => {
  it('javascript: 链接降级为纯文本（无 href）', () => {
    const html = render('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<a ')
  })

  it('data: 链接同样被拦截', () => {
    const html = render('[点我](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('<a ')
  })

  it('file: 链接被拦截（不能读本地文件）', () => {
    const html = render('[打开](file:///C:/Windows/System32/calc.exe)')
    expect(html).not.toContain('file:///')
    expect(html).not.toContain('<a ')
  })

  it('http(s) 链接可点击，但强制 target=_blank + rel=noreferrer（导航仍由主进程拦截）', () => {
    const html = render('[文档](https://example.com/docs)')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
})

describe('S3：data: 图片被处理', () => {
  it('data: 图片降级为 alt 文本（不渲染 img）', () => {
    const html = render('![截图](data:image/png;base64,iVBORw0KGgo=)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[截图]')
  })

  it('file: 图片同样降级', () => {
    const html = render('![本地](file:///C:/secret.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[本地]')
  })

  it('https 图片正常渲染', () => {
    const html = render('![远端](https://example.com/a.png)')
    expect(html).toContain('<img src="https://example.com/a.png"')
  })
})

describe('正常 markdown 仍可渲染（不因净化失去功能）', () => {
  it('标题/列表/表格/行内代码都保留', () => {
    const html = render(
      ['## 标题', '', '- a', '- b', '', '| x | y |', '| - | - |', '| 1 | 2 |', '', '`code`'].join(
        '\n'
      )
    )
    expect(html).toContain('<h2>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<table>')
    expect(html).toContain('<code>code</code>')
  })

  it('围栏代码块渲染为 pre>code（含 hljs 高亮类）', () => {
    const html = render(['```ts', 'const a = 1', '```'].join('\n'))
    expect(html).toContain('<pre')
    expect(html).toContain('language-ts')
    // 高亮在净化之后生成：只产 span/class，不引入用户 HTML
    expect(html).toContain('hljs-keyword')
  })
})

describe('纯函数：isSafeLink / toExternalUrl / isSafeImageSrc', () => {
  it('isSafeLink：相对地址与 http(s)/mailto 放行，其余拒绝', () => {
    for (const href of ['https://a.dev', 'http://a.dev/x', 'mailto:a@b.c', '/rel', './rel', '#x']) {
      expect(isSafeLink(href)).toBe(true)
    }
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '']) {
      expect(isSafeLink(href)).toBe(false)
    }
  })

  it('toExternalUrl 只返回 http(s) 绝对 URL', () => {
    expect(toExternalUrl('https://a.dev/x')).toBe('https://a.dev/x')
    expect(toExternalUrl('/rel')).toBeUndefined()
    expect(toExternalUrl('mailto:a@b.c')).toBeUndefined()
    expect(toExternalUrl('javascript:alert(1)')).toBeUndefined()
    expect(toExternalUrl(undefined)).toBeUndefined()
  })

  it('isSafeImageSrc 只放行 http(s)', () => {
    expect(isSafeImageSrc('https://a.dev/x.png')).toBe(true)
    expect(isSafeImageSrc('data:image/png;base64,AAAA')).toBe(false)
    expect(isSafeImageSrc('file:///C:/x.png')).toBe(false)
    expect(isSafeImageSrc(undefined)).toBe(false)
  })
})
