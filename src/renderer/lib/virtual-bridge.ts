/**
 * 虚拟滚动的**非可视**观测/控制钩子（A7 可观测性）。
 *
 * 为什么需要它：
 * - 压测（`tests/perf/a7-memory.test.ts`）要额外记录「已挂载轮数 / 总轮数」，
 *   用来证明「DOM 节点数与轮数解耦」，而这些数字在组件内部；
 * - E2E 要验证「跳转到离屏轮次后内容可见」——离屏轮次根本没在 DOM 里，
 *   只能通过一个受控入口请求「滚动到第 N 轮」。
 *
 * 约束：
 * - **不渲染任何 UI、不写 console、不暴露消息内容**（只有计数与滚动尺寸）；
 * - 挂在 `window.__piDesktopVirtual` 上，随组件卸载移除；
 * - 主进程协议层完全不涉及（§7 约束：renderer 自观测）。
 */
export interface VirtualMetrics {
  /** 当前真实挂载（渲染）的轮次数 */
  mountedTurns: number
  /** 会话总轮次数 */
  totalTurns: number
  /** 页内活 DOM 节点数（document 全树 TreeWalker 计数） */
  liveDomNodes: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** 是否处于「跟随底部」状态 */
  following: boolean
  /** 是否停在底部（容差内） */
  atBottom: boolean
}

export interface VirtualControl {
  /** 读取当前度量（只在被调用时计算，不影响渲染） */
  metrics: () => VirtualMetrics
  /** 滚动到第 index 轮（0 基），离屏轮次会被挂载并渲染出来 */
  scrollToTurn: (index: number) => void
  /** 回到最新消息（底部） */
  scrollToBottom: () => void
}

const GLOBAL_KEY = '__piDesktopVirtual'

type GlobalWithControl = Record<string, unknown>

/** 注册钩子；返回注销函数（卸载时调用，避免测试之间互相污染） */
export function installVirtualControl(control: VirtualControl): () => void {
  // SAFETY: `globalThis` 在 renderer 里就是 window；这里只写入/删除一个约定 key
  // （`__piDesktopVirtual`），读写两侧都走 VirtualControl 接口，不做别的投影。
  const scope = globalThis as unknown as GlobalWithControl
  scope[GLOBAL_KEY] = control
  return () => {
    if (scope[GLOBAL_KEY] === control) delete scope[GLOBAL_KEY]
  }
}

/** 页内活 DOM 节点数（与压测同口径：document 全树 walk） */
export function countLiveDomNodes(): number {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL)
  let count = 0
  while (walker.nextNode()) count += 1
  return count
}
