import { useEffect, useState } from 'react'

/**
 * 图片查看器（A21）：点消息里的缩略图后看原图。
 *
 * 为什么在应用内而不是调系统看图程序：
 * - 图片是 data URL（会话里的内容），没有磁盘路径可传；
 * - 系统程序打开会把隐私内容带到外部应用，且无法 Esc 关闭；
 * - 这里只是「放大看清」，不需要借口外部程序。
 *
 * 交互：Esc / 点遮罩 / 点关闭按钮关闭（三种都能退，避免「点开了退不出去」）。
 */
export interface ImageLightboxProps {
  /** data URL 列表（同一条消息里的多张图可以左右切换） */
  images: readonly string[]
  /** 初始显示的序号 */
  initialIndex?: number
  onClose: () => void
}

export function ImageLightbox({
  images,
  initialIndex = 0,
  onClose
}: ImageLightboxProps): React.JSX.Element | null {
  const [index, setIndex] = useState(initialIndex)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (images.length <= 1) return
      if (event.key === 'ArrowRight') {
        setIndex((current) => (current + 1) % images.length)
      } else if (event.key === 'ArrowLeft') {
        setIndex((current) => (current - 1 + images.length) % images.length)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [images.length, onClose])

  const current = images[index]
  if (current === undefined) return null

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      data-testid="image-lightbox"
      onClick={(event) => {
        // 只有点遮罩本身才关闭：点图片不该误关
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <figure className="lightbox__figure">
        <img src={current} alt={`图片 ${index + 1}`} data-testid="image-lightbox-img" />
        {images.length <= 1 ? null : (
          <figcaption className="lightbox__caption">
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="image-lightbox-prev"
              onClick={() => {
                setIndex((value) => (value - 1 + images.length) % images.length)
              }}
            >
              上一张
            </button>
            <span>
              {index + 1} / {images.length}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="image-lightbox-next"
              onClick={() => {
                setIndex((value) => (value + 1) % images.length)
              }}
            >
              下一张
            </button>
          </figcaption>
        )}
      </figure>
      <button
        type="button"
        className="btn btn--ghost lightbox__close"
        data-testid="image-lightbox-close"
        onClick={onClose}
      >
        关闭（Esc）
      </button>
    </div>
  )
}
