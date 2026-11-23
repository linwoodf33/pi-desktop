import type { PiApi } from '../shared/contracts/api'

/**
 * `window.pi` 的全局类型声明（preload contextBridge 的暴露面）。
 * 被 renderer 的 tsconfig 引用，renderer 因此获得完整的通道类型。
 */
declare global {
  interface Window {
    pi: PiApi
  }
}
