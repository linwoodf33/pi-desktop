import { realpath as realpathCallback } from 'node:fs'

/**
 * 真实路径归一（**native** 版本）。
 *
 * 为什么必须用 native：Node 的 JS 实现 `fs.promises.realpath()` / `fs.realpathSync()`
 * **不展开 Windows 8.3 短名**——实测对含短名的目录原样返回短名，
 * 只有 `fs.realpathSync.native()`（内部走 `GetFinalPathNameByHandle`）才返回长路径。
 *
 * 后果：把「同一目录的短名与长名」当成两个不同目录。凡是拿路径比前缀的地方都会误判：
 * git 工作区探测被判成「非 git」、审批扩展安装目标被判成越权、E2E 比较产物绝对路径不等。
 * CI 首跑就是这样红的（runner 的 `%TEMP%` 是 8.3 短名，而 `homedir()` 与
 * `git rev-parse` 返回长名，两者词法前缀不同）。
 *
 * 注意：`fs.promises.realpath` 上**没有** `.native`（运行时为 `undefined`），
 * 所以这里手动把回调版包成 Promise；也不要用 `promisify`，它对重载签名的推断会退化。
 *
 * 行为与 `fs.realpath` 一致：路径不存在时 reject（调用方自行决定退回词法路径）。
 */
export function realpathNative(value: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    realpathCallback.native(value, (error, resolved) => {
      if (error !== null) {
        rejectPromise(error)
        return
      }
      resolvePromise(resolved)
    })
  })
}
