# pi-desktop

pi（`@earendil-works/pi-coding-agent`）的桌面客户端，Electron + React + TypeScript。
架构与里程碑见 [`docs/architecture.md`](docs/architecture.md)。

当前状态：**M3 界面层**。在 M1 骨架与 M2 通道层之上完成三栏工作台：

- **布局**：左「任务列表」/ 中「对话」/ 右「产物」（可折叠，M6 才填内容）；暗色、等宽字体显示代码与工具输出，1280×800 与 1920×1080 均不破版
- **任务列表**：`session:list` 读本地会话索引（标题/时间/cwd/token/成本，缺失显示「—」）；点击选中即**只读回放** JSONL（`session:history`，不启动子进程）；「新建任务」先弹原生目录选择（`fs:pickDirectory`）再 `session:create`
- **消息流**：markdown 渲染 + 代码高亮，**无 `dangerouslySetInnerHTML`**（`react-markdown` + `rehype-sanitize` + `rehype-highlight`）；流式增量 + `message_end` 权威整体替换；工具卡片（名称/参数摘要可展开/状态/耗时/输出前 12 行可展开/`fullOutputPath` 提示）；按 assistant turn 分组的时间线
- **运行态**：`idle / streaming / tool_running / settling`（只认 `agent_settled`）；停止按钮点击即置灰并提示「已中止」（`session:abort`）；`evt:status` 按 `sessionKey` 关联
- **错误条**：`evt:diagnostic`、IPC `Result.error`、渲染期未捕获异常（`ErrorBoundary`）统一展示，不白屏
- **状态管理**：zustand `sessionStore` / `runStore` / `artifactStore`（占位），事件归约统一在 `lib/reducer.ts` 纯函数

尚未实现：新建任务弹层（模型/推理档位/会话名）、恢复与分叉、成本展示（M4）、审批扩展（M5）、产物面板（M6）。

历史版本（M2 通道层）摘要：`JsonlReader`（只在 LF 切分）、`LocalConnection`/`LocalTransport`（一会话一子进程、关停阶梯）、`PiLocator` 三步自检、`SessionService`（串行化 + 按 id 关联 + 并行上限/空闲回收）、`SessionIndex`。

## 环境要求

| 项 | 版本 |
|---|---|
| Node | ≥ 22.19（pi 的要求；本仓库脚本在 Node 26 上验证） |
| Electron | 37.x（内置 Node 22.16，满足 pi 的 Node ≥ 22） |
| 包管理器 | npm（本仓库使用 npm 11） |

## 常用脚本

```bash
npm install        # 安装依赖
npm run dev        # 启动开发模式（electron-vite dev，打开窗口）
npm run build      # 构建 main / preload / renderer 三端到 out/
npm run typecheck  # tsc 检查 node 侧 + web 侧
npm run lint       # eslint（--max-warnings 0）
npm run test:unit  # vitest 单元测试（tests/unit）
npm run test:integration # 集成链路测试（mock pi 子进程，tests/integration）
npm run test:e2e   # Electron E2E（Playwright，先 build；E1/E2/E4，用 mock pi 顶替真实 pi）
# 真实 pi 链路（会消耗一次模型调用）：
# PI_DESKTOP_REAL_PI=1 npm run test:integration
npm run package    # 构建后 electron-builder --dir，产出 release/win-unpacked
npm run package:dist # 构建后打完整安装包（NSIS）
```

## 目录结构

```text
src/main/                 主进程（Node）
  index.ts                app 生命周期、单实例锁、窗口与 IPC 装配
  window.ts               BrowserWindow 安全配置、导航/开窗拦截、权限默认拒绝
  ipc/router.ts           ipcMain.handle 集中注册 + zod 校验 + Result 规范化
  ipc/handlers.ts         通道处理器装配（M2：session:* / model:* / app:getBoot / pi:locate）
  services/               config-store / fs-bridge（pickDirectory）/ session-index / session-history / session-service / pi-locator / record-batcher
  transport/              jsonl-reader（LF-only 分帧）/ protocol（记录守卫）/ local-connection（LocalConnection + LocalTransport）
src/preload/index.ts      contextBridge 暴露 window.pi（§5.4 白名单，无任意 channel 透传）
src/renderer/             React 三栏布局
  app/                    App（布局 + 接线）/ ErrorBanner / ErrorBoundary / styles.css
  features/tasks/         任务列表（会话索引 + 新建任务）
  features/chat/          Conversation / Timeline / Markdown / ToolCard / Composer
  features/artifacts/     产物占位（可折叠，M6）
  stores/                 zustand：sessionStore / runStore / artifactStore
  lib/                    reducer（事件归约）/ timeline / markdown（净化策略）/ format / client（事件接线）/ actions（编排）
src/shared/ipc-channels.ts  invoke 与 event 通道名的唯一来源
src/shared/contracts/     Result、错误码、DTO、zod schema、PiApi 类型
tests/unit                vitest 单元测试（平铺，node 环境，由 tsconfig.node.json 检查）
tests/integration         集成链路测试 + `fixtures/mock-pi.mjs`（协议回放器）
tests/e2e                 Electron E2E（Playwright + out/ 产物；E1/E2/E4）
```

## 设置项：pi 路径

M2 已能定位并启动 pi，但**不读取 pi 的 provider 配置**（key 由 pi 自己持有，客户端不读取、不落盘、不进日志）。当前设置项：

- 默认值：`piCommand: "pi"`（从 PATH 解析）；开发/自动化可用环境变量 `PI_DESKTOP_PI_COMMAND` 覆盖（E2E 用它指向 mock pi）
- 位置：`src/main/services/config-store.ts` 的默认视图，界面上以只读输入框展示（`src/renderer/features/settings/SettingsPanel.tsx`）
- 三步自检已实现：定位（含 `C:/tools/pi/pi.cmd` 这类绝对路径）→ `--version`（要求 ≥ 1.0.0）→ `--mode rpc` 发 `get_state` 验证协议纯净
- Windows 上 `.cmd` 发射器走 `cmd.exe /d /s /c ""<路径>" args..."`（§7 约束 11，不做 shell 字符串拼接）
- 持久化（`userData/config.json`）与 schema 迁移排在 M4；**不会**存储任何 provider key（key 由 pi 自身配置持有，客户端绝不读取）

## 安全默认

- 渲染进程无 Node：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`
- preload 只暴露 §5.4 列出的方法，每个方法绑定固定通道；renderer 拿不到 `ipcRenderer`
- 未注册通道返回 `UNKNOWN_CHANNEL`；白名单内未实现通道返回 `NOT_IMPLEMENTED`
- 导航与外链一律拦截：`will-navigate` 阻断、`setWindowOpenHandler` 返回 `deny`，http(s) 外链需二次确认后才 `shell.openExternal`
- 生产构建注入严格 CSP（`electron.vite.config.ts` 的 `productionCspPlugin`）

## 已知限制（M3）

- `npm run dev` / E2E 需要图形环境（本仓库在 Windows 桌面验证；无头 CI 只能跑 build + `electron --version`）
- 历史会话回放：超过 50MB 只读尾部并显式提示；工具卡片的 `fullOutputPath` 只提示不读取（M6 才做文件预览）
- 右栏产物面板为占位（M6）；新建任务弹层只有「选目录」（模型/推理档位/会话名在 M4）
- 会话列表的 token/成本字段：M2 的 `SessionIndex` 尚未解析 usage，界面显示「—」，M4 补齐
- E2E 用 `PI_DESKTOP_PI_COMMAND` + `PI_CODING_AGENT_SESSION_DIR` 隔离真实 pi 与会话目录；真实 pi 链路仍需人工验证
