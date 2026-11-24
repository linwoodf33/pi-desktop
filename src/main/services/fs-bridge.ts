import { IpcFailure } from '../../shared/contracts/result'

/**
 * FsBridge（架构文档 §5.2）：原生对话框 + `workspaceRoots` 内的受限读写、产物列表与 diff。
 *
 * M3 只实现 **`fs:pickDirectory`**（原生目录对话框）：M2 用主进程 cwd 兜底建会话，
 * M3 起新建任务必须先由用户选择工作目录。其余能力仍留在 M6：
 *
 * TODO(M6): `fs:listArtifacts` / `fs:readText` / `fs:diff` / `artifact:open` 与路径安全
 *           （§7 约束 8：`path.resolve` + realpath 处理符号链接 → 校验 workspaceRoots；
 *           Windows 额外做大小写归一与 UNC/短路径归一，§9.1 U9、§9.4 S6）。
 */
export interface PickDirectoryResult {
  path: string
}

export interface FsBridgeDeps {
  /** 原生目录对话框（测试注入；生产用 electron dialog） */
  showOpenDialog: (options: {
    title: string
    defaultPath?: string
    properties: readonly string[]
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface PickFileResult {
  canceled: boolean
  path?: string
}

export interface FsBridge {
  pickDirectory(input: { defaultPath?: string }): Promise<PickDirectoryResult>
  /**
   * A22/A24：选择文件**或**文件夹（`kind` 决定）。
   *
   * 为什么必须分成两种而不能再合成一个：Electron 文档明确写着
   * 「On Windows and Linux an open dialog can not be both a file selector and a
   * directory selector, so if you set `properties` to `['openFile','openDirectory']`
   * on these platforms, a directory selector will be shown.」
   * 也就是说同时设置两者在 Windows 上只会弹**目录选择器**（v0.9.2 的实际表现）。
   */
  pickFile(input: { defaultPath?: string; kind?: 'file' | 'directory' }): Promise<PickFileResult>
}

export function createFsBridge(deps: FsBridgeDeps): FsBridge {
  return {
    async pickDirectory(input) {
      const result = await deps.showOpenDialog({
        title: '选择工作目录',
        ...(input.defaultPath === undefined ? {} : { defaultPath: input.defaultPath }),
        // createDirectory：允许在选择器里新建目录（Windows/macOS 原生支持）
        properties: ['openDirectory', 'createDirectory']
      })
      const picked = result.filePaths[0]
      if (result.canceled || picked === undefined || picked.length === 0) {
        // 取消不是错误，但也不能返回空路径：用专用错误码让 renderer 静默忽略
        throw new IpcFailure('CANCELLED', '已取消目录选择')
      }
      return { path: picked }
    },

    async pickFile(input) {
      const result = await deps.showOpenDialog({
        title: input.kind === 'directory' ? '引用工作区文件夹' : '引用工作区文件',
        ...(input.defaultPath === undefined ? {} : { defaultPath: input.defaultPath }),
        // 只能二选一：同时设置会在 Windows 上退化成目录选择器（见接口注释）
        properties: input.kind === 'directory' ? ['openDirectory'] : ['openFile']
      })
      const picked = result.filePaths[0]
      if (result.canceled || picked === undefined || picked.length === 0) {
        // 取消不是错误：返回 canceled 标志，由上层静默忽略（不要把取消做成红色报错）
        return { canceled: true }
      }
      return { canceled: false, path: picked }
    }
  }
}
