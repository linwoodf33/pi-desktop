import { describe, expect, it } from 'vitest'

import { createFsBridge } from '../../src/main/services/fs-bridge'
import { IpcFailure } from '../../src/shared/contracts/result'

/**
 * `fs:pickDirectory`（M3 前置修复 2）：新建任务必须由用户选择工作目录。
 *
 * 原生对话框本身不可在单测里弹，这里注入 `showOpenDialog` 验证：
 * 参数正确、取消映射为 `CANCELLED`（renderer 静默忽略）、选中返回路径。
 */
describe('fs:pickDirectory', () => {
  it('打开原生目录对话框，返回选中路径', async () => {
    const calls: Array<{ title: string; defaultPath?: string; properties: readonly string[] }> = []
    const bridge = createFsBridge({
      showOpenDialog: (options) => {
        calls.push(options)
        return Promise.resolve({ canceled: false, filePaths: ['D:/projects/demo'] })
      }
    })

    const result = await bridge.pickDirectory({ defaultPath: 'C:/work' })

    expect(result.path).toBe('D:/projects/demo')
    expect(calls[0]?.properties).toContain('openDirectory')
    expect(calls[0]?.defaultPath).toBe('C:/work')
  })

  it('取消时抛 CANCELLED（不是 INTERNAL，renderer 不展示错误条）', async () => {
    const bridge = createFsBridge({
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] })
    })

    await expect(bridge.pickDirectory({})).rejects.toBeInstanceOf(IpcFailure)
    await expect(bridge.pickDirectory({})).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('没有传 defaultPath 时不带该参数（避免原生对话框收到 undefined）', async () => {
    const calls: Array<{ defaultPath?: string }> = []
    const bridge = createFsBridge({
      showOpenDialog: (options) => {
        calls.push(options)
        return Promise.resolve({ canceled: false, filePaths: ['C:/x'] })
      }
    })

    await bridge.pickDirectory({})
    expect('defaultPath' in (calls[0] ?? {})).toBe(false)
  })
})
