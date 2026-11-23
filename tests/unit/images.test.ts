import { describe, expect, it } from 'vitest'

import {
  COMPRESS_THRESHOLD_BYTES,
  MAX_EDGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  dataUrlBytes,
  dataUrlMimeType,
  isSupportedImageMime,
  needsCompression,
  planAttachments,
  planScale
} from '../../src/renderer/lib/images'

/**
 * 粘贴图片的纯规则（A19）。
 *
 * 用户按一次 Ctrl+V 之后，任何「静默丢弃」都很难被发现 —— 所以这里把
 * 「收哪些 / 拒哪些 / 为什么拒」做成纯函数并逐条断言，UI 只负责展示原因。
 */
const png = { mimeType: 'image/png', bytes: 1024, name: 'shot.png' }

describe('isSupportedImageMime', () => {
  it('接受 PNG / JPEG / WebP / GIF', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isSupportedImageMime(mime)).toBe(true)
    }
  })

  it('拒绝 SVG 与其他类型（SVG 可内含脚本，不当作截图处理）', () => {
    expect(isSupportedImageMime('image/svg+xml')).toBe(false)
    expect(isSupportedImageMime('image/bmp')).toBe(false)
    expect(isSupportedImageMime('text/plain')).toBe(false)
  })
})

describe('planAttachments', () => {
  it('正常图片全部接收', () => {
    const plan = planAttachments(0, [png, { ...png, name: 'b.png' }])
    expect(plan.accepted).toHaveLength(2)
    expect(plan.rejected).toEqual([])
  })

  it('拒掉不支持的类型，并给出可读原因', () => {
    const plan = planAttachments(0, [{ ...png, mimeType: 'image/svg+xml' }])
    expect(plan.accepted).toEqual([])
    expect(plan.rejected[0]?.reason).toContain('不支持的图片类型')
    expect(plan.rejected[0]?.reason).toContain('PNG / JPEG / WebP / GIF')
  })

  it('拒掉超过 8MB 的单张图片', () => {
    const plan = planAttachments(0, [{ ...png, bytes: MAX_IMAGE_BYTES + 1 }])
    expect(plan.accepted).toEqual([])
    expect(plan.rejected[0]?.reason).toContain('图片过大')
  })

  it('空内容的图片被拒', () => {
    const plan = planAttachments(0, [{ ...png, bytes: 0 }])
    expect(plan.rejected[0]?.reason).toContain('内容为空')
  })

  it('受「每条消息最多 4 张」约束（含已有的）', () => {
    const plan = planAttachments(MAX_IMAGES_PER_MESSAGE - 1, [png, png])
    expect(plan.accepted).toHaveLength(1)
    expect(plan.rejected[0]?.reason).toContain(`最多 ${MAX_IMAGES_PER_MESSAGE} 张`)
  })

  it('已经满了则全部拒（不会静默覆盖已有图片）', () => {
    const plan = planAttachments(MAX_IMAGES_PER_MESSAGE, [png])
    expect(plan.accepted).toEqual([])
    expect(plan.rejected).toHaveLength(1)
  })
})

describe('dataUrlBytes', () => {
  it('按 base64 长度换算原始字节（含 padding）', () => {
    // 'AAAA' = 3 字节；'AAA=' = 2 字节；'AA==' = 1 字节
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2)
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1)
  })

  it('容忍换行与空白（data URL 可能被按行折断）', () => {
    expect(dataUrlBytes('data:image/png;base64,AA\nAA')).toBe(3)
  })

  it('非 data URL / 空载荷返回 0', () => {
    expect(dataUrlBytes('')).toBe(0)
    expect(dataUrlBytes('https://example.test/a.png')).toBe(0)
    expect(dataUrlBytes('data:image/png;base64,')).toBe(0)
  })
})

describe('dataUrlMimeType', () => {
  it('取出 MIME', () => {
    expect(dataUrlMimeType('data:image/jpeg;base64,AAAA')).toBe('image/jpeg')
    expect(dataUrlMimeType('data:image/png,AAAA')).toBe('image/png')
  })

  it('不是 data URL 时返回空串', () => {
    expect(dataUrlMimeType('https://example.test/a.png')).toBe('')
  })
})

describe('planScale（等比缩放到长边 ≤ MAX_EDGE）', () => {
  it('已经够小则原样返回（不放大）', () => {
    expect(planScale(800, 600)).toEqual({ width: 800, height: 600, scaled: false })
    expect(planScale(MAX_EDGE, 100)).toEqual({ width: MAX_EDGE, height: 100, scaled: false })
  })

  it('超长边按比例缩到 MAX_EDGE，另一维等比', () => {
    expect(planScale(4000, 2000)).toEqual({ width: MAX_EDGE, height: 1000, scaled: true })
    // 竖图同理
    expect(planScale(1000, 4000)).toEqual({ width: 500, height: MAX_EDGE, scaled: true })
  })

  it('极端比例不会出现 0 维（最小 1px）', () => {
    const scaled = planScale(20000, 3)
    expect(scaled.width).toBe(MAX_EDGE)
    expect(scaled.height).toBeGreaterThanOrEqual(1)
  })

  it('非法尺寸（0/负数）原样返回，避免除零', () => {
    expect(planScale(0, 0)).toEqual({ width: 0, height: 0, scaled: false })
    expect(planScale(-5, 10)).toEqual({ width: -5, height: 10, scaled: false })
  })
})

describe('needsCompression', () => {
  it('超过 2MB 才压缩（低于此值原样发送，保住画质）', () => {
    expect(needsCompression(COMPRESS_THRESHOLD_BYTES)).toBe(false)
    expect(needsCompression(COMPRESS_THRESHOLD_BYTES + 1)).toBe(true)
    expect(needsCompression(1024)).toBe(false)
  })

  it('8MB 的硬上限与压缩阈值是两件事：超 8MB 仍然拒绝', () => {
    const plan = planAttachments(0, [
      { mimeType: 'image/png', bytes: MAX_IMAGE_BYTES + 1, name: 'huge.png' }
    ])
    expect(plan.accepted).toEqual([])
    expect(needsCompression(MAX_IMAGE_BYTES - 1)).toBe(true)
  })
})
