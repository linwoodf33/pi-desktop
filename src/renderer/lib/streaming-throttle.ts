import { useEffect, useRef, useState } from 'react'

/**
 * 流式渲染节流（§10 A7 内存/CPU 定向优化）。
 *
 * 背景：main 侧把 `evt:record` 按 16ms 合并窗口推给 renderer，一次长回复（220 个
 * `text_delta`）在 renderer 端仍会触发数十次「重新解析整段 markdown + React 重渲染」。
 * 每次解析都会产生一批短命的 AST / 字符串 / React 元素——单个回合看没问题，
 * 但 200+ 轮高频对话下这部分抖动会把分配器高水位不断抬高（实测约占 RSS 增量的 1/4）。
 *
 * 因此**流式文本的展示**按 `intervalMs` 节流（默认 80ms ≈ 12fps，人眼对文本追加足够流畅），
 * 而**定稿文本**（`message_end` / 切换任务 / 中止）永远立即生效，不引入任何延迟：
 * 兜底规则见 `shouldFlushStreaming`。
 */
export const STREAMING_RENDER_INTERVAL_MS = 80

/**
 * 是否应该立即把 `next` 渲染出来（纯函数，便于单测）。
 *
 * - 相等 → 不需要；
 * - `next` 不是 `prev` 的前缀（收缩 / 清空 / 被权威文本整体替换）→ **立即**，不做延迟，
 *   避免出现「已经定稿了但界面还停在半截文本」的错觉；
 * - `prev` 为空（新一段流式的第一个字符）→ **立即**，避免开头出现空白延迟；
 * - 正常追加 → 只有距上次渲染超过 `intervalMs` 才渲染，否则等下一个节拍。
 */
export function shouldFlushStreaming(
  prev: string,
  next: string,
  elapsedMs: number,
  intervalMs: number
): boolean {
  if (next === prev) return false
  if (prev.length === 0) return true
  if (!next.startsWith(prev)) return true
  return elapsedMs >= intervalMs
}

/** 把流式文本按 `intervalMs` 节流后再交给 UI（尾部保证：最后一次一定被渲染） */
export function useThrottledStreaming(text: string, intervalMs = STREAMING_RENDER_INTERVAL_MS): string {
  const [shown, setShown] = useState(text)
  const lastFlushRef = useRef(0)

  useEffect(() => {
    if (shown === text) return
    const elapsed = Date.now() - lastFlushRef.current
    if (shouldFlushStreaming(shown, text, elapsed, intervalMs)) {
      lastFlushRef.current = Date.now()
      setShown(text)
      return
    }
    // 追加型更新：等到下一个节拍再渲染（清理时取消，避免「定稿后又刷一次旧文本」）
    const timer = setTimeout(() => {
      lastFlushRef.current = Date.now()
      setShown(text)
    }, Math.max(intervalMs - elapsed, 0))
    return () => {
      clearTimeout(timer)
    }
  }, [text, shown, intervalMs])

  return shown
}
