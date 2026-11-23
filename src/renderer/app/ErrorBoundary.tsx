import { Component, type ErrorInfo, type ReactNode } from 'react'

import { useRunStore } from '../stores/runStore'

/**
 * 渲染期未捕获异常的兜底（E6：错误界面，不白屏）。
 *
 * React 的 error boundary 只能是 class 组件；这里把错误同时灌进 runStore 的错误条，
 * 这样用户能看到「哪一步失败」，也能继续操作其它面板。
 */
export interface ErrorBoundaryProps {
  children: ReactNode
}

export interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    useRunStore.getState().pushBanner({
      level: 'error',
      message: `渲染异常：${error.message}`,
      ...(info.componentStack === undefined || info.componentStack === null
        ? {}
        : { detail: info.componentStack.slice(0, 2000) })
    })
  }

  override render(): ReactNode {
    const error = this.state.error
    if (error === null) return this.props.children

    return (
      <div className="crash" data-testid="render-crash">
        <h1>界面渲染出错</h1>
        <p className="crash__message">{error.message}</p>
        <p className="empty__hint">
          pi 会话本身仍在主进程运行；关闭错误提示后可继续操作其它面板。
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            this.setState({ error: null })
          }}
        >
          重试渲染
        </button>
      </div>
    )
  }
}
