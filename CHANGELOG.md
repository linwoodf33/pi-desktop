# 更新日志（Changelog）

## v0.2.0（2026-11-23）

主题系统 + 发布工程化。**升级安全**：配置文件与旧版本兼容（`theme` 的旧值 `dark`/`light`
自动归一到 `pi-dark`/`pi-light`，不会重置用户选择）。

### 新增

- **9 个内置主题 + 跟随系统**（`docs/themes.md`）：pi 深色（默认）、pi 浅色、GitHub Light、
  Solarized Light、Nord、Dracula、One Dark、Tokyo Night、Catppuccin Mocha。
  此前 `theme` 只持久化不生效，本次真正应用到 DOM（CSS 变量 + `data-theme` + `color-scheme`），
  「跟随系统」监听 `prefers-color-scheme` 实时切换。
- **代码高亮随主题**：语法 token 色改为主题变量，浅色主题不再出现深色语法色叠浅底。
- **应用图标**：`resources/icon.svg`（π + 桌面线）→ `npm run icon` 生成 PNG；
  exe 与安装包均为该图标，版本资源不再是 Electron 默认值（`signExecutable: false`）。
- **发布工作流** `.github/workflows/release.yml`：打 tag 自动构建 NSIS、算 SHA-256、
  创建 GitHub Release；`workflow_dispatch` 可先空跑验证流水线。
- **失败可诊断**：CI 的 unit/integration/e2e 失败时上传 `junit-*` artifact，
  发布流始终上传 `build-log`（`package.log`）。

### 修复

- 连续保存设置会堆出一摞相同的「设置已保存」提示 → 同文案改为替换。
- 设置面板排版：面板高度封顶并内部滚动、标签/控件两列对齐、保存按钮常驻底部。
- **Windows 8.3 短路径误判**：`fs.realpath` 的 JS 实现不展开短名，导致 git 工作区被判
  「非 git」、审批扩展安装目标被判越权。改用 `realpath.native`（新增
  `src/main/services/realpath-native.ts`），并补真实 8.3 短名回归用例。

### 工程

- CI 增加 `format:check`（prettier），全仓库统一格式（48 个文件），避免纯格式噪音 commit。
- 真实 pi 回归 job 在缺少 provider 凭据时显式跳过（打 warning，不假红）。
- `npm run package:dist` 固定 `--publish never`（CI 里 electron-builder 会隐式发布并失败）；
  产物命名改为 `pi-desktop-<版本>-<架构>.exe`（带空格的旧名会被 Release 转成点，
  与 `SHA256SUMS.txt` 不一致）。

### 测试规模

unit 622 / integration 48（+3 skip）/ e2e 33；CI 7 个 job 全绿。

---

## v0.1.0（2026-11-23）

Phase 1 MVP 首个发布（未签名）。

- Electron + React + TypeScript 桌面客户端，通过官方 RPC 子进程集成 pi（不 fork、不 patch）
- 三栏工作台：任务列表（本地会话索引）/ 对话（markdown + 代码高亮 + 工具卡片 + 时间线）/ 产物
- 新建任务、模型与思考档位切换、恢复与分叉、成本与 token 展示
- 审批扩展 `pi-desktop-permission`：工具调用前置钩子，超时/断连/版本不符一律 fail-closed
- 产物面板：git 优先扫描 + 快照兜底、统一 diff、文本预览、`shell.openPath`
- 长会话内存：按轮窗口化渲染（240 轮 RSS +15.1%，DOM 节点 +0）
- 安全：渲染进程无 Node、preload 白名单、IPC zod 校验、`npm run audit:security`（A9）
