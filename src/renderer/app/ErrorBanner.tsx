import { useRunStore } from '../stores/runStore'

/**
 * 错误条（§8.1 M3「错误条」/ E6）：
 * 三个来源统一展示——`evt:diagnostic`（主进程上报）、IPC 失败（`Result.error`）、
 * 渲染期未捕获异常（由 `ErrorBoundary` 灌入同一 store）。
 *
 * 只展示消息与可选 detail（stderr 尾部），不放大对象、不记录敏感数据（§7 约束 9）。
 */
export function ErrorBanner() {
  const banners = useRunStore((state) => state.banners)
  const dismissBanner = useRunStore((state) => state.dismissBanner)

  if (banners.length === 0) return null

  return (
    <div className="banners" data-testid="error-banner">
      {banners.map((banner) => (
        <div className={`banner banner--${banner.level}`} key={banner.id} role="alert">
          <div className="banner__body">
            <span className="banner__message">{banner.message}</span>
            {banner.detail === undefined ? null : (
              <details className="banner__detail">
                <summary>详情</summary>
                <pre>{banner.detail}</pre>
              </details>
            )}
          </div>
          <button
            type="button"
            className="banner__close"
            aria-label="关闭"
            onClick={() => {
              dismissBanner(banner.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
