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
  /** A22：选择单个文件（用于「引用工作区文件」；路径由调用方再校验是否在工作区内） */
  pickFile(input: { defaultPath?: string }): Promise<PickFileResult>
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
        title: '引用工作区文件',
        ...(input.defaultPath === undefined ? {} : { defaultPath: input.defaultPath }),
        properties: ['openFile']
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
