# A11 打包安装验证报告（Phase 1 收口）

> 版本：v0.1.0（Electron 37.10.3 / electron-builder NSIS）
> 验证时间：2026-11-23（本机 Windows x64 开发机）
> 复现脚本：`node scripts/verify-a11-startup.mjs [--exe <path>] [--keep]`
> 相关验收项：§10 **A11**（干净 Windows 10/11 x64 安装即启动，不要求预装 Node）、**A12**（首启无 pi 的三步引导）、**A10**（工程门禁）

## 1. 结论

**A11 / A12 通过（近似干净机器验证）**，骨架结论：

- 安装包与解包产物均能**在没有外部 Node / npm / pi 的环境**下启动到主窗口并完成 IPC 握手；
- asar 产物合规：**0 个 `*.map`**、**0 个 `*.d.ts`**、**0 处 `C:\Users\FUlw` 绝对路径**、**0 个 devDependency 运行时残留**、**0 处明文密钥**，CSP 在打包后的 `index.html` 内仍生效；
- NSIS **安装 → 卸载 → 重装 → 卸载** 双向幂等：目录/快捷方式/注册表清理干净，`%APPDATA%\pi-desktop`（用户资产）按设计保留；
- 首启无 pi 时给出**三步引导**（定位 pi → 新建任务 → 发消息），无崩溃、无错误条，`bridge-status` 正常。

**未做到**：真正「未安装过 Node 的干净 Win10/11 机器」与真实机器 wall-clock 行为——见 §5「未覆盖风险」。

**2026-11-23 补齐**：§10 的最后两项缺口（A1/A6 计时硬断言、A9 `npm run audit:security`）已收口，详见 §9；A1–A13 全部 MVP 项在本机口径下闭合。

## 2. 产物清单

> 2026-11-23 11:44 **再次重新打包**（覆盖设置面板排版修复：`src/renderer/app/styles.css` + `src/renderer/features/settings/SettingsPanel.tsx`；前两次打包时间 10:40 / 10:54）。下表是**当前交付产物**的数据。

| 产物                                      | 大小                      | SHA-256                                                            |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `release/pi-desktop Setup 0.1.0.exe`      | 103,044,927 B（98.3 MiB） | `a84701254341f3ff161b57520725a41b8ed289136a55e49f3acf968a538209d2` |
| `release/win-unpacked/resources/app.asar` | 24,141,772 B（23.0 MiB）  | `885caaefa003e5eb70742a32388d5a7aab394836ebc6ef548e7cc4b661398d74` |
| `release/win-unpacked/`（解包目录）       | 341 MiB / 75 个文件       | —                                                                  |

- 产物时间戳：`pi-desktop Setup 0.1.0.exe` = **2026-11-23 11:44:36**、`app.asar` = **11:44:22**，均晚于 `src/` 全部文件的最新修改时间。
- 本次重打包后 `app.asar` 的渲染层 CSS 已含设置面板修复（`min(52vh, 460px)` 封顶、`subgrid` 两列、`position: sticky` 保存栏），并已在**打包产物**上复核：1280/1920 无横向溢出、标签列与控件列各共用一条左对齐线、保存按钮常驻面板底部（见 `docs/screenshots/settings-packaged-*.png`）。
- `app.asar` 条目 **3258** 条，其中 `node_modules` **3247** 条（**103 个生产依赖包**：react / react-dom / react-markdown / rehype-* / remark-gfm / highlight.js / zod / zustand 及其传递依赖；`npm ls --omit=dev --all` 去重 113 个包名，asar 内同名包多版本折叠到同一目录，故顶层目录更少）。
- `app.asar.unpacked/` **不存在**（无原生模块，无需外置）。
- 安装包元数据：ProductName=`pi-desktop`、FileVersion=`0.1.0`、CompanyName=`pi-desktop`。
- 签名状态：**NotSigned**（按 `electron-builder.yml` 的既定取舍，签名/公证排在正式发布）。
- 图标：**已设置** —— `resources/icon.svg` → `npm run icon` → `resources/icon.png`（1024×1024，随仓库提交）；`electron-builder.yml` 的 `win.icon` 指向它。构建日志不再出现 `default Electron icon is used`。
- 产物命名：`artifactName: ${productName}-${version}-${arch}.${ext}` → `pi-desktop-0.1.0-x64.exe`（旧名带空格，Release 上会被转成点，与 SHA256SUMS 对不上）。
- 产物与源码一致性：当前产物**包含 A6 渲染层修正**——`npx asar extract` 后 `out/renderer/assets/index-CkLLhITG.js` 内 `detachSession` 命中 **4** 次（整包二进制计数 8：含主进程侧引用），主进程 `lstat` 命中 15；即 asar 内代码就是当前 `src/` 编译结果（对应 `client.ts` 的 `exited/recycled → detachSession`）。

## 3. 验证项 / 方法 / 结果 / 证据

### 3.1 A11-1 asar 产物合规

| 检查项                      | 方法                                                                                                                | 结果                                                    | 证据                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 `*.map`                  | `npx asar list app.asar \| grep -cE '\.map$'`                                                                       | **0**                                                   | 计数输出 `0`                                                                                                                                                                                                         |
| 无 `*.d.ts`                 | `grep -cE '\.d\.ts$'`                                                                                               | **0**（仅上游包自带 2 个 `*.d.mts`，非 TS 声明可用面）  | 计数输出 `0`                                                                                                                                                                                                         |
| 无绝对路径泄漏              | 解包后 `grep -rIl 'C:\\Users\\FUlw'` / `'C:/Users/FUlw'`                                                            | **0 个文件命中**                                        | 两命令均无输出                                                                                                                                                                                                       |
| 无 devDependency 运行时残留 | `grep -c 'node_modules\\<pkg>'`：electron / vitest / typescript / eslint / playwright / jsdom / happy-dom / @vitest | **全部 0**                                              | 逐包计数均为 `0`                                                                                                                                                                                                     |
| CSP 注入                    | 读 asar 内 `out/renderer/index.html` 的 `meta[http-equiv=Content-Security-Policy]`                                  | **存在且完整**                                          | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'` |
| 无明文密钥 / 凭据文件       | 解包后全量 `grep -InE '(sk-[A-Za-z0-9]{16,}\|ghp_…\|AKIA…\|BEGIN PRIVATE KEY\|xox[baprs]-)'`                        | **0 命中**；无 `*.env*` / `*.pem` / `*.key` / `*token*` | 命令无输出（等价 §9.4 **S5** 打包产物扫描）                                                                                                                                                                          |
| 渲染进程隔离                | CDP 注入 `typeof process / require`                                                                                 | **均为 `undefined`**                                    | `checks.rendererIsolated = true`                                                                                                                                                                                     |

打包只收 `out/**` + `package.json` + 生产依赖，`electron-builder.yml` 额外排除 `!**/*.map`、`!**/*.d.ts`、`!**/node_modules/@types/**`（`release/builder-debug.yml` 的 `firstOrDefaultFilePatterns` 可复核）。

### 3.2 A11-2 无 Node 依赖启动（**近似**验证）

方法（`scripts/verify-a11-startup.mjs`）：

1. 子进程 `PATH` 只留 `C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;…\WindowsPowerShell\v1.0`；
2. 清空所有 `PI_*` / `npm_*` / `NODE_*` / `NVM_*` / `VOLTA_*` / `COREPACK_*` 继承变量；
3. `HOME` / `USERPROFILE` / **`APPDATA` / `LOCALAPPDATA`** 全部指向空临时目录；
4. 全新 `--user-data-dir`（首启无配置/无会话索引）+ 空 `PI_CODING_AGENT_SESSION_DIR`；
5. 用 `--remote-debugging-port=9333` 启动，轮询 CDP，再用 Playwright `connectOverCDP` 做断言；
6. 等 `bridge-status` **离开初始态**（`pi unknown` → 真实自检结果，最多 10s）再读 DOM，避免读到异步自检的中间态。

> **实测教训（本轮修掉的验证漏洞）**：只清 `PATH` **不足以**模拟「无 pi / 无 Node」。
> `pi-locator` 的 `commonPiPaths()` 直接拼常见安装目录（`%USERPROFILE%\.pi\agent\bin`、
> `%APPDATA%\npm`、`%LOCALAPPDATA%\pi\bin`），且 `resolveNodeExecutable()` 会直接探测
> `%ProgramFiles%\nodejs\node.exe`（**不看 PATH**）。第一版脚本因此在本机命中
> `%APPDATA%\npm\pi.cmd`，读到的却是异步自检**中间态** `pi unknown`——差点被当成「无 pi 也正常」的假绿。
> 补上 `APPDATA` / `LOCALAPPDATA` 隔离并等状态收敛后，才得到真实的 `pi missing`。

| 检查项                               | 结果                   | 证据                                                                                                     |
| ------------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| 隔离 PATH 内确实没有 node/npm/npx/pi | **通过**               | `isolatedToolsAbsent = {node.exe:0, npm.cmd:0, npx.cmd:0, pi.cmd:0, pi.exe:0}`                           |
| 主窗口在 60s 内起来                  | **通过（实测 ≈0.3s）** | `steps: spawn(pid) → cdp-ready(Chrome/138.0.7204.251) → pages → bridge-status-visible`                   |
| 页面确实从 asar 加载（不是源码目录） | **通过**               | URL = `file:///C:/Users/FUlw/pi-desktop/release/win-unpacked/resources/app.asar/out/renderer/index.html` |
| IPC 握手                             | **通过**               | 异步自检收敛后 `bridgeStatus = "IPC 正常 · pi missing · 0 个历史会话"`（`bridgeStatusSettled = true`）   |
| 进程存活、无崩溃                     | **通过**               | `processAliveAfterCdp/AfterUi = true`，日志仅 `DevTools listening …`                                     |
| 渲染进程无 Node 能力                 | **通过**               | `nodeInRenderer = true`（`process`/`require` 均 `undefined`）                                            |
| CSP 在运行态生效                     | **通过**               | `cspMeta` 含 `script-src 'self'`                                                                         |
| 无「找不到 node」类错误日志          | **通过**               | `spawnedNodeErrors = []`                                                                                 |

`pi missing` 就是「无 pi 也能跑」的直接证据：`pi-locator` 在隔离 PATH + 空 HOME/APPDATA/LOCALAPPDATA 下**找不到任何 pi 可执行文件**（`missing` ≠ `unknown`：前者是自检结论，后者是尚未自检），应用仍进入正常空态并给出三步引导。

两条路径都跑了同一套断言：

| 被测可执行文件                                                     | 结果                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `release/win-unpacked/pi-desktop.exe`（解包目录）                  | `pi missing`、`firstRunGuidance=true`、`cspPresent=true`、`processAliveAfterUi=true`                                  |
| `%LOCALAPPDATA%\Programs\pi-desktop\pi-desktop.exe`（NSIS 安装后） | 同上；页面 URL = `file:///C:/Users/FUlw/AppData/Local/Programs/pi-desktop/resources/app.asar/out/renderer/index.html` |

### 3.3 A11-3 安装包安装（NSIS，per-user）

命令：`"release\pi-desktop Setup 0.1.0.exe" /S /D=%LOCALAPPDATA%\Programs\pi-desktop`

| 检查项           | 结果                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静默安装退出码   | **0**，耗时 **10.4s**                                                                                                                                                                  |
| 安装目录         | `%LOCALAPPDATA%\Programs\pi-desktop`（21 个条目，`pi-desktop.exe` 204,521,984 B；`app.asar` 24.1 MB）                                                                                  |
| 卸载注册表项     | `DisplayName=pi-desktop 0.1.0`、`DisplayVersion=0.1.0`、`UninstallString="…\Uninstall pi-desktop.exe" /currentuser`（HKCU，无需管理员）                                                |
| 快捷方式         | 开始菜单 `…\Programs\pi-desktop.lnk` 1 个（桌面快捷方式 0 个，符合 electron-builder 默认）                                                                                             |
| 安装后 userData  | 条目数 15（安装动作不写/不改用户数据）                                                                                                                                                 |
| **装完直接启动** | **通过**：以隔离 env 启动 `%LOCALAPPDATA%\Programs\pi-desktop\pi-desktop.exe`，`bridge-status-visible`、`IPC 正常 · pi unknown`、页面来自 `…\Programs\pi-desktop\resources\app.asar\…` |

### 3.4 A11-4 A12 首启无 pi 引导（三步内解除阻塞）

CDP 取到的实际 DOM 文本（隔离 env、无 pi、全新 userData）：

```text
开始一个任务
1. 确认 pi 可用            [定位 pi]     ← 第 1 步可点（触发 pi 自检/定位）
2. 新建任务并选择工作目录   [新建任务]     ← 第 2 步可点
3. 输入消息，Enter 发送（Shift+Enter 换行）
```

| 断言                                                | 结果                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| `empty-state` 可见                                  | **true**                                         |
| 三步引导齐全（`li` 数量 = 3，第 1 步含「定位 pi」） | **true（`onboardingSteps.length === 3`）**       |
| 第 1 / 第 2 步都有可点按钮                          | **true**（`emptyNewTask` 可见，第 1 步按钮渲染） |
| 无 `error-banner`                                   | **true**                                         |
| 进程存活（无崩溃）                                  | **true**                                         |

即 **3 步内可解除阻塞**（定位 pi → 自检 → 建任务），与 A12 文案一致。

### 3.5 A11-5 卸载 / 重装幂等

| 阶段                                         | 结果                                     | 证据                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 次卸载（`Uninstall pi-desktop.exe /S`） | **干净**，耗时 6.4s                      | 安装目录 **已删除**；开始菜单/桌面快捷方式 **0 个**；HKCU 卸载项 **0 个**；`HKCU\Software\com.pidesktop.app` 不存在；`%LOCALAPPDATA%\pi-desktop` 不存在 |
| userData 保留策略                            | **按设计保留**                           | `%APPDATA%\pi-desktop` 卸载后仍存在，条目数 15（`nsis.deleteAppDataOnUninstall: false`；想彻底清除需手删该目录）                                        |
| 第 2 次安装                                  | **退出码 0**，耗时 8.1s（第 1 次 10.4s） | exe 存在；userData 条目仍为 15（未被重置）；卸载注册表项恢复                                                                                            |
| 重装后启动                                   | **通过**                                 | 完整走完 `spawn → cdp-ready → pages → bridge-status-visible`，`IPC 正常 · pi unknown`                                                                   |
| 第 2 次卸载                                  | **干净**，耗时 4.4s                      | 安装目录 / 注册表 / 快捷方式残留均 0；userData 仍保留 15 条目                                                                                           |

> 本机验证结束时共完成 **3 轮「安装 → 启动冒烟 → 卸载」**（最终再补一轮安装+冒烟以覆盖本报告 §2 的最终产物），结束时已卸载：机器上**不留安装目录、快捷方式与注册表项**（仅保留 `%APPDATA%\pi-desktop` 用户数据，符合设计）。

### 3.6 A11-6 工程门禁（全量，真实输出）

| 命令                                 | 结果                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| `npm run typecheck`                  | **通过**（node + web 两个 project 均无输出）                        |
| `npm run lint`（`--max-warnings 0`） | **通过**，0 警告                                                    |
| `npm run test:unit`                  | **40 文件 / 592 passed \| 2 skipped（594）**（改前 585；新增 9 条） |
| `npm run test:integration`           | **4 passed \| 2 skipped 文件；44 passed \| 3 skipped（47）**        |
| `npm run test:e2e`                   | **2 文件 / 14 passed**（36.2s）                                     |
| `npm run build`                      | **通过**（renderer 1,838 kB gzip 前，构建 165ms）                   |

跳过项说明：新增的 2 条 skip 是**文件/目录符号链接**用例——Windows 上创建文件符号链接需要开发者模式或管理员权限（本机实测 `EPERM`）。同一段「链接 → 跳过」代码路径由 **junction** 用例（无需特权、`readdir` 同样报告 `isSymbolicLink()`）无条件覆盖，另有 mock 用例钉死 `lstat` 分支；POSIX runner 上这两条会真实执行。

**2026-11-23 补齐 A1/A6/A9 后的复跑结果**（同一台机器，替换上表计数）：typecheck ✓ / lint ✓（0 警告）/ unit **41 文件 · 595 passed \| 2 skipped（597，+3 条 `client-exit.test.ts`）** / integration **44 passed \| 3 skipped（不变）** / e2e **3 文件 · 16 passed（+2 条计时用例）** / build ✓ / `npm run audit:security` **退出码 0**。

### 3.7 CI 配置校验（A10）

| 检查                                          | 工具/方法                                                                                                                          | 结果                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| YAML 语法                                     | `js-yaml` / PyYAML `safe_load`                                                                                                     | **解析通过**                                                                                                                                                                    |
| GitHub Actions 语义/lint                      | `actionlint 1.7.7`（`Windows amd64` 官方二进制）                                                                                   | **0 issues（exit 0）**                                                                                                                                                          |
| Workflow schema 校验                          | `npx @action-validator/cli .github/workflows/ci.yml`                                                                               | **通过（exit 0）**                                                                                                                                                              |
| job 结构                                      | 解析                                                                                                                               | `static / unit / integration / build / e2e / security / real-pi` 七个 job，均 `runs-on: windows-latest` + `timeout-minutes`（20/20/25/20/40/20/30）                             |
| 脚本名与 `package.json` 一致                  | 提取所有 `npm run <script>` 与 `npx vitest run --project <name>`，比对 `package.json.scripts` 与 `vitest.config.mts` 的 project 名 | **无失效引用**                                                                                                                                                                  |
| `real-pi` job 门控                            | 解析 job env                                                                                                                       | **存在**，env `PI_DESKTOP_REAL_PI: '1'`，并固定安装 `@earendil-works/pi-coding-agent@1.5.2` 后跑 integration                                                                    |
| 手动门控说明                                  | 文档                                                                                                                               | `ci.yml` 头部与本报告均注明本地等价命令：`PI_DESKTOP_REAL_PI=1 npx vitest run --project integration`                                                                            |
| **Action 版本锁定（zizmor `unpinned-uses`）** | `zizmor --format plain .github/workflows/ci.yml`                                                                                   | **加固后 0 条**（加固前 **17 条**：7× checkout / 7× setup-node / 1× upload-artifact / 2× download-artifact），全部改为 40 位 commit SHA + `# vX.Y.Z` 注释                       |
| **凭据持久化（zizmor `artipacked`）**         | 同上                                                                                                                               | **加固后 0 条**（加固前 **7 条**）：7 个 job 的 `actions/checkout` 均加 `with: persist-credentials: false`                                                                      |
| 残留 zizmor 提示                              | 同上                                                                                                                               | 仅 1 条 `help[adhoc-packages]`（`npm install --global @earendil-works/pi-coding-agent@1.5.2`）—— **有意为之**，real-pi job 需要与开发机一致的固定版本，不用 lockfile 管全局工具 |

**未验证**：CI 尚未在 GitHub 上真实跑过（本仓库当前工作目录不是 git 仓库，也没有远端）。上述结论只覆盖「配置正确性 + 本地同名命令等价性」。

## 4. 本次一并收口的两项技术债

### 4.1 技术债 #3：快照用 `lstat`、链接按非普通文件跳过并计数

改动 `src/main/services/workspace-snapshot.ts`：

- `describeFile` 由 `stat` 改为 **`lstat`**：快照看**链接本身**，不解析目标（避免把工作区外/网络盘/环链的目标内容拉进快照）；
- `describeFile` 返回判别式结果 `{kind: 'entry' | 'symlink' | 'nonRegular' | 'error'}`：
  - `symlink` → 计入 `skippedSymlinks`，**不再**把 `complete` 置 false（设计性跳过 ≠ 扫描失败）；
  - `nonRegular`（目录/设备/管道）→ 计入 `skippedNonRegular`；
  - `error`（真 ENOENT/EACCES 等）→ 仍 `complete = false`（语义不变）；
- `readdir` 的 `dirent.isSymbolicLink()` 与 `lstat` 双重把关，覆盖「dirent 与 stat 之间被换成链接」的 TOCTOU 窗口（残留窗口见 §5）;
- `WorkspaceSnapshot` **新增**两个只增字段 `skippedSymlinks` / `skippedNonRegular`（`scanned`、`complete`、`compareSnapshots` 语义不变）；
- `readFilePrefix` 的**定点读**（`open` + `handle.read(len, 0)`）与 5s deadline 逐文件检查**未改动**。

新增测试 9 条（`tests/unit/workspace-snapshot-links.test.ts` 7 + `workspace-snapshot-lstat.test.ts` 2）：

| 用例                                         | 断言要点                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 工作区内目录 junction                        | 不遍历/不收录、`skippedSymlinks=1`、`complete=true`、真实目录照常收录                                                    |
| 指向工作区外的 junction                      | 快照路径集合恰为工作区内文件；不含 `secret`/`nested`（区外内容 0 泄漏）                                                  |
| 断链 junction（目标已删）                    | 不崩溃、`complete=true`、计入 `skippedSymlinks`                                                                          |
| junction 改指向 + 目标内容变化               | `compareSnapshots` **无任何条目**（不误判为内容变化）                                                                    |
| 文件符号链接（区外/区内）                    | 不收录、计数 1、目标文件不重复计数（Windows 需特权，按能力门控）                                                         |
| 链接旁普通文件哈希回归                       | `scanned=2`、两文件正常收录，未把整棵树当链接跳过                                                                        |
| **mock 伪造 dirent + 磁盘上是区外 junction** | `lstat` → `skippedSymlinks=1` 且 `complete=true`；**反证**：临时改回 `stat` 时该用例变红（`expected 0 to be 1`），已还原 |
| mock 伪造 dirent + 磁盘上文件已被删          | `complete=false`（真失败仍要显式标注）                                                                                   |

### 4.2 技术债 #2 核查：`DEFAULT_APPROVAL_TOOLS` 单一化 —— **已确认（客户端单一定义，扩展侧同值副本 + 钉死测试）**

`grep -rn DEFAULT_APPROVAL_TOOLS src tests` 结果（定义点仅 2 处）：

```text
src/shared/contracts/permission.ts:36   export const DEFAULT_APPROVAL_TOOLS: readonly string[] = ['bash','powershell','write','edit']   ← 客户端唯一来源
src/extensions/permission/protocol.ts:48  export const DEFAULT_APPROVAL_TOOLS: readonly string[] = ['bash','powershell','write','edit'] ← 扩展侧同值副本（不可消除）
src/main/services/config-store.ts:7       import { DEFAULT_APPROVAL_TOOLS } from '../../shared/contracts/permission'                    ← 只 import
tests/unit/approval-defaults.test.ts      import 两份并逐项比对                                                                          ← 一致性钉死
```

- `config-store.ts` 已无自有字面量（原重复定义已消除，注释明确「清单单一来源」）；
- 扩展侧副本**不可合并**：扩展由 pi 用 jiti 加载、装到 `~/.pi/agent/extensions` 后只能依赖自身目录（`protocol.ts` 头部注释已说明）；
- `tests/unit/approval-defaults.test.ts` 断言「两份相等」+「ConfigStore 视图 = 共享常量」+「值等于 `['bash','powershell','write','edit']`」，改一边不改另一边会红。

**结论：无需改动。** 审批文案硬编码问题已由 `src/renderer/lib/approval-copy.ts`（41 行）承接、`ApprovalDialog.tsx` 改为引用；`extension_ui_cancel` 的 registry 清理已由 `extui-registry.ts#discard`（L131 实现）覆盖；`artifacts.ts` 的 UTF-8 末尾截断容忍已由 `TextDecoder` 严格解 + 序列长度判定（L478–L511）实现。

## 5. 未覆盖风险（明确「未验证」）

1. **不是真正的干净机器**：本机装有 Node v26.13.0 / npm / pi（`C:\Users\FUlw\.pi\agent\bin\pi`、`%APPDATA%\npm\pi.cmd`、`C:\Program Files\nodejs\node.exe`）。验证靠「隔离 PATH + 空 HOME/USERPROFILE/APPDATA/LOCALAPPDATA + 全新 userData」近似。**未验证**：从未装过 Node 的 Win10/11 上安装（例如 `VC++ 运行库`、SmartScreen 首次运行拦截、企业策略）。
2. **locator 的「常见目录直探」无法被环境隔离完全屏蔽**：`resolveNodeExecutable()` 会直接探测 `%ProgramFiles%\nodejs\node.exe`（不看 PATH）。本次 `pi missing` 证明「无 pi 时应用照常启动」；但「真无 Node 时 locator 的探测耗时/日志」**未验证**（不影响启动，只影响未来定位 pi 的提示）。
3. **无代码签名**：安装包 `NotSigned` → 真实用户会看到 SmartScreen 警告，安装需要点「更多信息 → 仍要运行」。属既定取舍（签名排到正式发布），但**未做**签名后行为验证。
4. ~~应用图标未设置~~ **已修复**：图标由 `resources/icon.svg` 生成（`npm run icon`），`win.icon` 指向 `resources/icon.png`，exe/安装包/快捷方式均为 π 图标。
5. ~~`win-unpacked/pi-desktop.exe` 版本资源是 Electron 默认值~~ **已修复**：`win.signAndEditExecutable: false` 改为 `win.signExecutable: false`（只跳签名，保留图标与版本资源）。实测 exe：ProductName=`pi-desktop`、FileDescription=`pi-desktop`、FileVersion=`0.1.0`、CompanyName=`pi-desktop`。
6. **`app.asar` 内有 103 个生产依赖包**（含 `zod/src/*.ts`、`style-to-object/src/*.ts` 等上游原始 TS 源码与 `*.d.mts`）。不放宽任何验收（无 `*.map`、无自家源码），但 asar 内有第三方 source 属于上游分发习惯，**未做**体积优化（可用 `files` 白名单进一步裁剪）。
7. **TOCTOU 残留窗口**：`lstat` 与 `open` 之间若文件被换成链接，仍会读到目标前 ≤1MB。上限由 `HASH_LIMIT_BYTES` 兜住（不会整读），**未验证**极端竞态下的行为。
8. **未做真实 30 分钟 wall-clock / 真实 provider**：A11 只覆盖启动与安装；A7 的 RSS 结论来自 240 轮压测（见 `docs/perf/a7-memory.md`），不含真实 provider 回复长度分布。
9. **CI 未在 GitHub 实跑**（见 §3.7），也没有远端可推。
10. **多显示器/DPI/暗色主题/中文本地化以外的语言**未在安装后逐项走查（安装启动与首启空态已覆盖）。
11. **~~A9 的 `npm run audit:security` 不存在~~（已收口，2026-11-23）**：新增 `scripts/audit-security.mjs` + `npm run audit:security`，覆盖「生产依赖 `npm audit` 高危门禁 + S1–S6 的命令行可验证部分」，并提供 `--with-tests`（跑既有安全单测）与 `--skip-network`（纯离线）。离线时降级为 warning 并显式提示「本次门禁未生效」。实测：`通过 7 · 失败 0 · 警告 0 · 跳过 1`，退出码 0；负向自检（人为塞入 `*.map` 与假 `sk-` key）→ S5 FAIL、退出码 1。详见 §9。

## 6. §10 A1–A13 逐条状态

| 项                                                         | 状态                        | 依据 / 缺口                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 首 token ≤ 1.5s（本地 mock）                            | ✅ **通过（计时断言）**     | e2e `timing.e2e.test.ts`：3 个全新会话逐次断言 click→首个流式 token，实测两次采样 **134–218ms**（3 次采样的中位数 150–212ms，阈值 1500ms）；计时用页面内 `performance.now()` + `MutationObserver`，见 §9.1                                                                      |
| A2 工具调用可见（名称/摘要/状态/输出）                     | ✅                          | `reducer-tools.test.ts`、`timeline.test.ts`、e2e E2 工具卡片                                                                                                                                                                                                                    |
| A3 20 条 <1s / 100 条 <3s                                  | ✅                          | `session-index.test.ts`（L230 `elapsed < 1000`）、`session-index-cache.test.ts`（20/100/1000 实测预算断言）                                                                                                                                                                     |
| A4 恢复与分叉、原文件字节不变                              | ✅                          | integration `rpc-chain` 分叉回归（`PI_DESKTOP_REAL_PI` 门控的真实 pi 用例 + mock 链路）                                                                                                                                                                                         |
| A5 高危工具 100% 审批 / 本会话允许                         | ✅                          | `approval-flow.test.ts`、`permission-wire.test.ts`、`approval-defaults.test.ts`                                                                                                                                                                                                 |
| A6 强杀后 2s 内可操作、历史完整                            | ✅ **通过（计时断言）**     | e2e `timing.e2e.test.ts`：`process.kill(pid,'SIGKILL')` 强杀 mock pi → 「继续对话」出现 **6–9ms**（阈值 2000ms）→ 历史条数/内容不变 → resume 拿到**新 pid** → 可继续对话；单测 `client-exit.test.ts` 钉死 `exited/recycled → detachSession` 机制。**含一处产品修正**（见 §9.2） |
| A7 30 分钟 >200 轮 RSS < 30%                               | ✅（本机 240 轮）           | `docs/perf/a7-memory.md`：RSS +15.1%、活 DOM +0；**未做**真实 30min wall-clock                                                                                                                                                                                                  |
| A8 3 会话上限 / 挂起可唤醒 / 空闲回收                      | ✅                          | `session-service.test.ts`（L569+：上限回收、`LIMIT_EXCEEDED`、占位不突破）                                                                                                                                                                                                      |
| A9 S1–S6 + `audit:security`                                | ✅ **通过（脚本已补）**     | `scripts/audit-security.mjs`（`npm run audit:security`）：`npm audit --omit=dev` 高危门禁（0 high / 0 critical，生产依赖 114）+ S1–S6 静态核查全绿；`--with-tests` 跑 5 个安全单测；离线降级为 warning。见 §9.3                                                                 |
| A10 typecheck/lint/unit/e2e + Windows CI                   | ✅（本地）/ ⚠️（CI 未实跑） | §3.6 全绿；§3.7 配置校验通过，GitHub 上未跑                                                                                                                                                                                                                                     |
| **A11 干净 Win10/11 安装即启动、无需预装 Node**            | ✅ **通过（近似干净机器）** | §3.1–3.3、3.5：asar 合规 + 隔离 env 启动（unpacked 与已安装两种路径）+ 安装/卸载/重装幂等；真实干净机器未验证                                                                                                                                                                   |
| **A12 首启无 pi 三步内解除阻塞**                           | ✅ **通过**                 | §3.2/§3.4：`pi missing`（真无 pi，自检已收敛）+ 三步引导 DOM 断言 + 无错误条 + 进程存活                                                                                                                                                                                         |
| A13 产物面板 / 2MB 截断 / PATH_DENIED / 系统程序打开需确认 | ✅                          | `artifacts-service.test.ts`、`artifact-store.test.ts`、`path-guard.test.ts`（U9/U18 对抗矩阵）、`unified-diff.test.ts`、`diff-parser.test.ts`                                                                                                                                   |

## 7. Phase 1 是否可以宣告完成

**可以宣告 Phase 1 完成（本机口径，全部 MVP 验收项 A1–A13 闭合）**。

原登记的两条缺口已收口（2026-11-23，见 §9）：

1. **A1 / A6 的计时类端到端硬断言**已补齐：`tests/e2e/timing.e2e.test.ts`（首 token 134–218ms ≤ 1.5s；强杀→可操作入口 6–9ms ≤ 2s），并新增 `tests/unit/client-exit.test.ts` 钉死「子进程退出 → 会话降级为可 continue 的历史任务」；
2. **A9 的 `npm run audit:security`** 已实现并被本机实跑验证（含负向自检）。

其余 A2–A5、A8、A10（本地）、**A11**、**A12**、A13 均有可复现证据，工程门禁全绿（typecheck / lint / unit **595 passed \| 2 skipped** / integration **44 passed \| 3 skipped** / e2e **16** / build / `audit:security` 退出码 0）。

发布前仍应补的收尾动作（已写入 §5，均不阻塞 Phase 1 骨架）：

- 真机干净安装（A11 完整口径，含 SmartScreen/运行库）；
- CI 在 GitHub 实跑一次（配置已通过 actionlint + schema 校验）；
- ~~应用图标 + exe 版本资源~~ → 已完成：图标见 `resources/icon.svg`，`signExecutable: false` 已生效（见 `docs/release.md`）。
- `release/` 产物早于本次 A6 渲染层改动（`src/renderer/lib/client.ts`）—— 已收口（2026-11-23 10:54 重新打包并复验，见 §10）。

## 8. 复现命令

```bash
# 1) 产物合规
npx asar list release/win-unpacked/resources/app.asar | grep -cE '\.map$'        # 期望 0
npx asar extract release/win-unpacked/resources/app.asar /tmp/asar-x
grep -rIl 'C:\\Users\\FUlw' /tmp/asar-x                                            # 期望无输出
grep -rInE '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' /tmp/asar-x  # 期望无输出

# 2) 无 Node 启动 + A12 首启引导（近似干净机器）
node scripts/verify-a11-startup.mjs                    # 解包产物
node scripts/verify-a11-startup.mjs --exe "$LOCALAPPDATA/Programs/pi-desktop/pi-desktop.exe"  # 已安装

# 3) 安装 / 卸载幂等（PowerShell）
Start-Process 'release\pi-desktop Setup 0.1.0.exe' -ArgumentList '/S', "/D=$env:LOCALAPPDATA\Programs\pi-desktop" -Wait
Start-Process "$env:LOCALAPPDATA\Programs\pi-desktop\Uninstall pi-desktop.exe" -ArgumentList '/S' -Wait

# 4) CI 校验
npx @action-validator/cli .github/workflows/ci.yml
actionlint -no-color .github/workflows/ci.yml
zizmor --format plain .github/workflows/ci.yml      # 期望 0 error / 0 warning（仅 1 条 adhoc-packages help）

# 5) 门禁
npm run typecheck && npm run lint && npm run test:unit && npm run test:integration && npm run test:e2e && npm run build

# 6) A9 安全门禁（静态，秒级；含依赖漏洞；可选带安全单测）
npm run audit:security
npm run audit:security -- --with-tests    # 额外跑 window-security / channels / ipc-router / markdown-sanitize / path-guard
node scripts/audit-security.mjs --skip-network   # 纯离线环境

# 7) A1 / A6 计时断言（单独跑，输出实测毫秒）
npx vitest run --project e2e tests/e2e/timing.e2e.test.ts --reporter=verbose
```

## 9. A1 / A6 计时断言与 A9 安全门禁（2026-11-23 补齐）

### 9.1 A1 首 token ≤ 1.5s

- 用例：`tests/e2e/timing.e2e.test.ts`（Playwright + 真实 `out/` 产物 + mock pi）。
- 口径：3 个**全新会话**，每个「新建任务 → 点一次发送 → 首个 `[data-testid="timeline-streaming"]` 出现」。
  计时在**页面内**用 `performance.now()` + `MutationObserver`（起点是点击那一刻，终点是目标节点出现的那一帧），
  避免 CDP 往返与轮询间隔污染；mock provider 的「首字延迟」= `MOCK_PI_DELAY_MS=60`。
- 不计入 pi **冷启动**（本架构「新建任务」时已 `session:create` 拉起子进程，点发送只走 `session:prompt` 热路径）。
- 实测（本机，两次跑）：`134 / 150 / 166ms` 与 `142 / 218 / 212ms`；中位数 **150–212ms**；阈值 1500ms（逐次断言 + 中位数双重断言）。
- 抖动系数：`PI_DESKTOP_TIMING_FACTOR` **只能放大**（>1 才生效），默认 1；CI 需要放宽时必须显式设置并在报告中注明，不会自动放宽。

### 9.2 A6 强杀 → 2s 内可操作入口

- 用例：`tests/e2e/timing.e2e.test.ts`；夹具 `tests/integration/fixtures/mock-pi.mjs` 新增可选 `MOCK_PI_PID_FILE`（**只在 `--mode rpc` 长驻进程**里落盘自身 pid），测试用 `process.kill(pid,'SIGKILL')` 真强杀（不是模拟崩溃）。
- 断言链：强杀 → ≤2000ms 出现「继续对话」按钮 + 只读回放提示 + 退出横幅 → 历史消息条数与文本完全不变 → resume 后按钮消失、**pid 变化（确实是新进程）**、无错误条 → 再发一条真的收到回复。
- 实测（本机）：可操作入口 **6ms / 9ms**（阈値 2000ms）。
- **产品修正**（`src/renderer/lib/client.ts`）：`evt:status=exited` 原先只弹一条 warn 横幅，任务的 `sessionKey` 仍指向已死进程（「继续对话」不出现，再发消息只会 `SESSION_NOT_FOUND`）。现改为 `exited` / `recycled` 时 `detachSession(taskId)`（保留 `filePath` 与对话，降级为 history），与分叉后的降级语义一致。回归钉死：`tests/unit/client-exit.test.ts`（exited → detach、recycled → detach、running → 不动）。

### 9.3 A9 `npm run audit:security`

`scripts/audit-security.mjs`（无第三方依赖，秒级）分两部分：

| 检查          | 做法                                                                                                                                                       | 失败条件                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `A9-dep`      | `npm audit --omit=dev --audit-level=high --json`，解析 `metadata.vulnerabilities`                                                                          | high/critical > 0；输出不可解析且非离线 |
| `S1`          | preload/renderer 产物无 `require('fs'/'child_process'/'net')`、无 `process.binding`；主进程 `nodeIntegration:false`/`contextIsolation:true`/`sandbox:true` | 任一命中                                |
| `S2`          | 从 `src/shared/ipc-channels.ts` 抽白名单，逐条断言 preload 固定通道绑定；主进程含 `UNKNOWN_CHANNEL`；未暴露 `ipcRenderer` 本体                             | 任一条未绑定/缺拒绝路径                 |
| `S3`          | `rehype-sanitize` 在依赖、`markdown.ts`（`defaultSchema`）、渲染产物（`defaultSchema` + `mailto`）                                                         | 任一缺失                                |
| `S4`          | 主进程产物 + `window.ts` 含 `will-navigate` / `setWindowOpenHandler` / `action: "deny"` / `openExternal`，且 `preventDefault()`                            | 任一缺失                                |
| `S5`          | 扫 `out/` 全部文本产物：`*.map`、开发机绝对路径、6 类密钥特征；若 `app.asar` 存在则校验清单无 `*.map`                                                      | 任一命中                                |
| `S6`          | 主进程产物含 `PATH_DENIED`；`path-guard.ts` 有 `realpath` 归一与 `workspaceRoot` 归属判定（S6 是 **MVP 本地项**，不是 Phase 2 远端项）                     | 任一缺失                                |
| `S1-S6-tests` | `--with-tests` 时跑 `window-security` / `channels` / `ipc-router` / `markdown-sanitize` / `path-guard` 五个单测                                            | vitest 非 0                             |

- 离线 / registry 不可达：`A9-dep` 降级为 **WARN**（明确写「本次依赖漏洞门禁未生效」），其余纯静态检查照常执行，**不因离线失败**。
- 显式 skip（Phase 2 项，不冒充已覆盖）：S7 / S8 / S9（网关与伪造通道 id）/ S10（远端越权）。
- 本机实测：`通过 7 · 失败 0 · 警告 0 · 跳过 1`，退出码 **0**；`--with-tests` → `通过 8 · 失败 0`；
  负向自检（人为放 `out/renderer/assets/fake.map` 与假 `sk-proj-…`）→ S5 FAIL、退出码 **1**；离线模拟（`npm_config_registry=http://127.0.0.1:9`）→ `A9-dep` WARN、退出码 0。

## 10. 交付前重新打包 + 产物复验 + CI 加固（2026-11-23 10:54–10:57）

### 10.1 为什么必须重打包

`release/` 旧产物（exe `10:40`、asar `10:41`）早于 A6 渲染层修正 `src/renderer/lib/client.ts`（`10:46`，`exited/recycled → detachSession`），
即旧安装包**不含**「强杀后仍可继续对话」的修复，不能作为交付物。

| 项                        | 旧产物（重打包前）                | 新产物（重打包后）                                                                |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| 安装包大小                | 103,043,852 B                     | 103,043,674 B（−178 B）                                                           |
| 安装包 SHA-256            | `d8b6abb4…cae4e1d`                | `e2b1bb62c1f57e51942f430270b9b1eb884902c1065aea3f709bace87a7a805b`                |
| 安装包时间戳              | 2026-11-23 10:40                  | **2026-11-23 10:54:49**                                                           |
| `app.asar` 大小 / SHA-256 | 24,139,526 B / `3dc0b0bc…e4b6089` | 24,139,733 B / `4132f4c312ece51ed64a228ac35f88215827c429f59367bbe4a4fda9940e14f6` |
| `app.asar` 时间戳         | 10:41                             | **10:54:33**                                                                      |
| 是否含 A6 `detachSession` | **否**                            | **是**（`out/renderer/assets/index-CkLLhITG.js` 命中 4 次）                       |

时间顺序证据：`find src -newer "release/pi-desktop Setup 0.1.0.exe" -type f` → **无输出**（`src/` 最新改动 10:46 < 产物 10:54:49）。

### 10.2 新产物启动冒烟（近似干净机器）

`node scripts/verify-a11-startup.mjs` → **退出码 0 / `ok: true`**（完整 JSON 证据文件由脚本输出）：

```json
{
  "exe": "…\release\win-unpacked\pi-desktop.exe",
  "exeExists": true,
  "steps": ["spawn pid=15244 → cdp-ready Chrome/138.0.7204.251 → pages(1) → bridge-status-visible"],
  "pages[0].url": "file:///C:/Users/FUlw/pi-desktop/release/win-unpacked/resources/app.asar/out/renderer/index.html",
  "checks": {
    "isolatedToolsAbsent": { "node.exe": 0, "npm.cmd": 0, "npx.cmd": 0, "pi.cmd": 0, "pi.exe": 0 },
    "bridgeStatus": "IPC 正常 · pi missing · 0 个历史会话",
    "firstRunGuidance": true,
    "onboardingSteps": 3,
    "cspPresent": true,
    "rendererIsolated": true,
    "nodeInRenderer": true,
    "noErrorBanner": true,
    "processAliveAfterCdp": true,
    "processAliveAfterUi": true,
    "spawnedNodeErrors": []
  }
}
```

### 10.2b 新安装包 NSIS 安装 → 启动 → 卸载（本机复核）

| 阶段                                                   | 结果                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 静默安装（`/S /D=%LOCALAPPDATA%\Programs\pi-desktop`） | **exit 0**，10.4s；`pi-desktop.exe` 204,521,984 B（mtime 10:54:46）、`resources/app.asar` **24,139,733 B**（= 新 asar 大小）                                                                                                                                             |
| 安装后启动冒烟（隔离 env）                             | **exit 0 / `ok: true`**；页面 URL = `file:///C:/Users/FUlw/AppData/Local/Programs/pi-desktop/resources/app.asar/out/renderer/index.html`；`IPC 正常 · pi missing`、`firstRunGuidance=true`、三步引导、`cspPresent=true`、`rendererIsolated=true`、`spawnedNodeErrors=[]` |
| 静默卸载                                               | **exit 0**，7.9s；安装目录 **已删除**、开始菜单快捷方式 **0 个**、HKCU 卸载项 **0 个**、`%APPDATA%\pi-desktop` **按设计保留**                                                                                                                                            |

### 10.3 新产物合规扫描（asar，全部期望值达成）

| 检查                                 | 命令                                                                                                                 | 结果                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 条目总数                             | `npx asar list … \| wc -l`                                                                                           | 3258（`node_modules` 3247）                         |
| 无 `*.map`                           | 条目过滤                                                                                                             | **0**                                               |
| 无 `*.d.ts`                          | 条目过滤                                                                                                             | **0**                                               |
| 无 `C:\Users\FUlw` / `C:/Users/FUlw` | `npx asar extract` 后 `grep -rIl`                                                                                    | **0 命中**                                          |
| 无明文密钥                           | 6 类特征 `grep -rInE`                                                                                                | **0 命中**                                          |
| 无凭据文件                           | `.env*` / `*.pem` / `*.key` / `id_rsa` / `credentials*`                                                              | **0 个**                                            |
| 无 devDependency 残留                | `electron / vitest / typescript / eslint / playwright / jsdom / happy-dom / electron-builder / electron-vite / vite` | **全部 0**                                          |
| `app.asar.unpacked/`                 | 条目过滤                                                                                                             | **0 条**（无原生模块）                              |
| CSP 注入                             | `out/renderer/index.html` 的 `meta[http-equiv]`                                                                      | **存在且完整**（`script-src 'self'`，与 §3.1 一致） |

### 10.4 CI 加固（zizmor）

加固前后（`zizmor 1.33.1`，`zizmor --format plain .github/workflows/ci.yml`）：

| 规则                   | 加固前 | 加固后        |
| ---------------------- | ------ | ------------- |
| `error[unpinned-uses]` | **17** | **0**         |
| `warning[artipacked]`  | **7**  | **0**         |
| `help[adhoc-packages]` | 1      | 1（有意保留） |

锁定到的版本（v4 大版本内最新，保留 `# vX.Y.Z` 注释）：

| Action                      | 锁定 SHA                                   | 版本注释 |
| --------------------------- | ------------------------------------------ | -------- |
| `actions/checkout`          | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0   |
| `actions/setup-node`        | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0   |
| `actions/upload-artifact`   | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2   |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4.3.0   |

`artipacked` 处置：7 个 job 的 `actions/checkout` 统一加 `with: persist-credentials: false`。
上传的 artifact 只有 `out/`（构建产物，无 `.git`、无 `node_modules`、无密钥）；下载侧同样只取 `out/`。
**job 拆分、`timeout-minutes`、`PI_DESKTOP_REAL_PI=1` 的 real-pi 语义与断言强度均未改动**（字典 diff 仅涉及 `uses:` 行与新增 `with:` 两行/处）。

CI 校验复跑：`npx @action-validator/cli .github/workflows/ci.yml` → **exit 0**；YAML 解析 → `jobs: static,unit,integration,build,e2e,security,real-pi`（7 个）。
`actionlint` 本机不可用（二进制未安装），本轮以 `@action-validator/cli` + zizmor + YAML 解析三者替代；历史结论（§3.7 中 actionlint 0 issues）保持有效，因为本轮未改结构与表达式。

### 10.5 门禁快速复跑（未连带破坏）

| 命令                                 | 结果                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `npm run typecheck`                  | **exit 0**                                           |
| `npm run lint`（`--max-warnings 0`） | **exit 0**，0 警告                                   |
| `npm run test:unit`                  | **41 文件 / 595 passed \| 2 skipped（597）**，exit 0 |
| `npm run build`（打包前置）          | 通过（renderer 1,838.52 kB，vitest 无关）            |

e2e / integration 未重跑：本轮唯一代码侧改动是 `.github/workflows/ci.yml`（CI 配置）与本文档，业务代码零改动。
