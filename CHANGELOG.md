# 更新日志（Changelog）

## v0.7.0（2026-11-23）

图片输入的另两条路径：拖拽与客户端压缩（A20）。

### 新增

- **拖拽图片**：把图片文件拖到输入区即可加入待发送列表，`dragover` 时整块高亮；
  拖入非图片内容不拦截（文本框/链接的默认行为不变）。
- **窗口级拖放兜底**：Electron 默认会把窗口导航到掉落的文件（拖错位置就白屏），
  现在含 `Files` 的 `dragover`/`drop` 在窗口层统一 `preventDefault`。
- **客户端先压缩**：长边 > 2000 或原始 > 2MB 的图片会等比缩放后再发送
  （先试 PNG 保透明，仍超标才退 JPEG q0.85 → q0.7）。缩略图标注「已压缩」，
  悬停显示原图尺寸与体积。
  - 理由：pi 自己会把图片重编码到 2000×2000 / 4.5MiB，但那发生在图片进了会话之后；
    客户端先压能让 IPC 传输、会话 JSONL、首 token 都更小。
  - 够小的图片（长边 ≤2000 且 ≤2MB）**原样发送**，不做任何重编码。

### 说明

- 8MB 是硬上限（超过直接拒绝并说明原因），2MB 是压缩阈值 —— 两个不同的事。

### 测试

unit 698（含 U28 压缩规则：不放大、极端比例不塌成 0 维、阈值边界）、
integration 51、e2e 45（含 E17：拖入 3000×2000 → 缩略图标注已压缩、
`naturalWidth=2000`、`title` 保留原图尺寸）。

---

## v0.6.0（2026-11-23）

对话框支持直接粘贴截图（A19）。

### 新增

- **`Ctrl+V` 粘贴图片**：截图工具复制到剪贴板后，直接在输入框粘贴即可。
  出现缩略图（可单张移除），发送时随消息一起交给 pi。
- 规则：只收 `png / jpeg / webp / gif`；单张 ≤ 8MB；每条消息 ≤ 4 张；
  超出限制或类型不符会**明确提示原因**，不静默丢弃。
- **只有图片、没有文字也能发送**（截图直接问「这是什么」）。
- 传输格式为 **data URL 数组**（`data:image/png;base64,...`）；主进程按 MIME 校验后
  转成 pi 的 `ImageContent`。

### 变更

- `session:prompt` 的 `message` 不再强制非空：新增 `superRefine`，要求「文字或图片至少有一个」。
  纯文本消息的行为不变。

### 测试

unit 692（含 U27 粘贴规则）、integration 51、e2e 44（含 E16：真实 paste 事件 →
缩略图 → 发送，mock 断言 `imageCount=1, mimeType=image/png`）。

---

## v0.5.0（2026-11-23）

新建任务可选「会话身份 agent」（A18）：让会话带着某个 agent 的 prompt / 模型 / 工具开始。

### 新增

- 新建任务弹层新增 **Agent** 选择器（`--agent <name>`），只列**扫描到的**定义：
  `<agent-dir>/agents/**/*.md`、`<workspace>/.pi/agents/**/*.md`、`<workspace>/.agents/agents/**/*.md`
  （项目级同名覆盖全局；`.chain.md` 跳过）。
- 新增只读通道 `agents:list`（带 `cwd` 以扫描项目级 agent）。

### 两个上游事实（决定了实现方式，均已实测）

1. **`--agent` 不是 pi core 的参数**，而是 `pi-open-agents` 扩展注册的 flag — 未安装时传它会让 pi
   `Error: Unknown option: --agent` 直接起不来。因此客户端先探测 `pi --help`（60s 缓存），
   **探测不到就不显示选择器**。
2. **非法 agent 名会被 pi 静默忽略**（照常启动、回落默认模型）→ 客户端用自己的扫描结果校验名字，
   UI 不提供手打入口，避免「选了 architect 实际还是默认身份」的假象。

### 说明与边界

- agent 与「起始模式」相互独立：agent 决定「谁来思考」，起始模式决定工具白名单。
- **子 agent（subagent）不是这个**：它由 `pi-subagents` 扩展在会话内部派生，子会话记录写在
  `sessions/<cwd-key>/subagents/*.jsonl`；客户端只回放父会话，因此能看到 subagent 工具卡片，
  看不到子会话的中间过程（不假装能看到）。

### 测试

unit 684（含 U26：目录扫描 / 覆盖 / capability 探测缓存 / 名字校验）、
integration 52（含 `--agent` argv 断言）、e2e 42（含 E15）。

---

## v0.4.0（2026-11-23）

新建任务的「起始模式」从占位变成真的（A17）。

### 变更

- **「起始模式」不再是空壳**：此前下拉只有一项禁用的「对话模式」，也没有对应任何 pi 参数。
  现在三档都落到 pi 的**工具选择**（不是 `--mode`，那是输出接口）：
  - `完整工具（默认）`：不加参数，pi 默认工具集；
  - `只读（不写文件、不执行命令）`：`--exclude-tools write,edit,bash,powershell`；
  - `纯对话（禁用全部工具）`：`--no-tools`。
    用 denylist 而不是 allowlist，避免把用户装的扩展工具一起关掉。
- 说明文案随选择变化，弹层里直接写清该模式禁用了什么。
- 「办公 / 编程」这类预设属于 `AGENTS.md` / skills 范畴，pi 没有对应启动参数，**不做假开关**。

### 修复

- `session:create` 的 handler 逐字段重建入参对象时漏了新字段（`toolMode`），
  导致「界面选了只读、子进程却仍带全套工具」。已修，并补 E2E 断言 argv。

### 已知局限（如实记录）

- pi 的 `get_state` 不返回已启用工具列表 → 客户端无法在 UI 回显「实际生效的工具集」；
- 工具选择只在 spawn 时生效（RPC 无 `set_tools`），所以只能放在「新建任务」，不能中途改。

### 测试

unit 668（含 U25 参数映射）、integration 50（含 argv 落盘断言）、e2e 40（含 E14）。

---

## v0.3.1（2026-11-23）

模型管理的两处体验修正（用户反馈）。

### 变更

- **编辑框不再藏在列表末尾**：点「新增 / 编辑」后，provider 列表让位给表单，
  表单紧贴「默认模型」下方并自动滚入视口；保存或取消回到列表。
  之前表单渲染在列表之后，provider 一多就得往下翻。
- **模型支持多模态**：模型行新增「多模态」开关，对应 pi 的 `input` 字段
  （勾选 = `["text","image"]`，不勾 = `["text"]`）；列表摘要显示 `image` 标记。
  未改动该开关时保持原有 `input` 不变，不会把已配好的图片输入清掉。

### 修复

- **浅色主题下「黑底黑字」**：工具栏输出（`.tool-card__output pre`）与代码块的底色曾写死成近黑色，
  主题切到浅色后文字仍是浅底配色 → 文字与底色同为暗色，工具调用输出不可读。
  根因是颜色绕过主题变量，因此不止修值：新增语义变量 `--code-bg`、`--on-accent`、`--accent-hover`、
  `--danger-text`/`--warn-text`/`--success-text`，并把提示条、diff 行、主按钮 hover 的硬编码色一并清除；
  同时修掉一个从未定义、永远走深色兜底的变量（`--panel`，影响审批卡片）。
- 主按钮 hover 底色改用 `--accent-hover`：原实现 hover 到更亮的 `--accent`，白字对比度只有 2.8:1。
- 新增结构性守卫 `tests/unit/styles-theme-vars.test.ts`：`:root` 之外禁止任何 hex / `rgb()` 字面量
  （`box-shadow` 豁免），并校验样式引用的每个主题变量都在调色板里。

### 测试

unit 657+（多模态写入 / 回读 / 未传时保留、样式不得硬编码颜色、语义色对比度）、
e2e 39（新增 provider 勾多模态 → 断言文件里 `input: ["text","image"]`；
E13 浅色主题下工具输出/代码块对比度 ≥ 4.5）。截图 `docs/screenshots/models-manager-form.png`。

---

## v0.3.0（2026-11-23）

模型管理：在客户端里直接管理 pi 的模型配置，不必手改 JSON。

### 新增

- **模型管理弹层**（顶栏「模型」，见架构文档 §13）
  - 列出 `models.json` 里的 provider 与模型（上下文 / 最大输出 / thinking），
    apiKey 只显示掩码或「无 key」；
  - 新增 / 编辑 / 删除 provider 及其模型（id、显示名、Base URL、API 类型、key、模型行）；
  - 设置默认模型（写入 `settings.json#defaultModel`，选「自动」= 清除）。
- 6 个新 IPC 通道：`models:read` / `models:setDefault` / `models:upsertProvider` /
  `models:removeProvider` / `models:upsertModel` / `models:removeModel`，全部 zod 校验。

### 安全与数据约束

- **apiKey 只进不出**：明文不进 IPC / 日志 / 审计；编辑时输入框为空（留空 = 保留原 key），
  清除需显式勾选。支持字面量、`$ENV_NAME`、`!command` 三种形式（`!` 不会在客户端执行）。
- **不动用户没建模的字段**：`compat` / `samplingParams` / `cost` / `headers` /
  `modelOverrides` 等在写回时原样保留，避免「改个名字清空兼容参数」。
- **写入可回退**：同目录临时文件 + `rename` 原子替换，覆盖前留 `.bak-<时间戳>`（保留最近 3 份）；
  坏 JSON 直接拒绝改动，不静默覆盖。

### 测试

unit 653 / integration 48（+3 skip）/ e2e 38（新增模型管理 5 条：写盘、掩码、默认模型、删除）。

---

## v0.2.0（2026-11-23）

主题系统 + 发布工程化。**升级安全**：配置文件与旧版本兼容（`theme` 的旧值 `dark`/`light`
自动归一到 `pi-dark`/`pi-light`，不会重置用户选择）。

### 新增

- **9 个内置主题 + 跟随系统**（架构文档 §12）：pi 深色（默认）、pi 浅色、GitHub Light、
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
