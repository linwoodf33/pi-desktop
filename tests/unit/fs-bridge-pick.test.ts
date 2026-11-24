import { describe, expect, it } from 'vitest'

import { createFsBridge } from '../../src/main/services/fs-bridge'

/**
 * A22/A24：选文件 vs 选文件夹。
 *
 * Electron 文档明确：Windows/Linux 上 `openFile` + `openDirectory` 同时设置时
 * **只会弹目录选择器**（v0.9.2 的实际表现就是这个）。所以必须按需二选一。
 */
function bridgeWith(captured: { options?: { properties: readonly string[] } }) {
  return createFsBridge({
    showOpenDialog: (options) => {
      captured.options = options
      return Promise.resolve({ canceled: true, filePaths: [] })
    }
  })
}

describe('fs-bridge.pickFile（kind 决定 dialog 属性）', () => {
  it('kind=file（默认）→ 只给 openFile', async () => {
    const captured: { options?: { properties: readonly string[] } } = {}
    await bridgeWith(captured).pickFile({})
    expect(captured.options?.properties).toEqual(['openFile'])
  })

  it('kind=directory → 只给 openDirectory', async () => {
    const captured: { options?: { properties: readonly string[] } } = {}
    await bridgeWith(captured).pickFile({ kind: 'directory' })
    expect(captured.options?.properties).toEqual(['openDirectory'])
  })

  it('两者不同时出现（否则 Windows 会退化成目录选择器）', async () => {
    const captured: { options?: { properties: readonly string[] } } = {}
    await bridgeWith(captured).pickFile({ kind: 'directory' })
    expect(captured.options?.properties).not.toContain('openFile')
  })
})
