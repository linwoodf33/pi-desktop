# 更新日志（Changelog）

## v0.10.1（2026-11-24）

修掉装包后暴露的三处问题（都在「本地安装包」上才看得见）。

### 修复

- **「引用文件」只弹目录选择器**：入口层 `src/main/index.ts` 的 `showOpenDialog` 把
  `properties` **硬编码**成了 `['openDirectory','createDirectory']`，调用方传的属性被整个丢掉。
  改为透传 `options.properties`。这也是为什么单元测试（直接测 fs-bridge）一直绿、而实际安装包不对。
- **顶栏版本显示 `v0.0.0`**：`appVersion` 只在 handler 里定义了默认值 `'0.0.0'`，**没在 main 注入**
  `app.getVersion()`。已接线。
- **诊断面板「复制全部」没反应**：打包后 renderer 在 `file://` 下没有 `navigator.clipboard`
  安全上下文，调用静默失败。新增 `app:copyText` 通道，由主进程 `clipboard.writeText` 执行；
  复制失败会在面板里给出错误提示。

### 测试

- 新增 E2E **E22**：直接捕获主进程传给原生对话框的 `properties`，断言「引用文件」→ `openFile`、
  「引用文件夹」→ `openDirectory` —— 专治「入口层覆盖调用方参数」这类回归。
- unit 720（通道白名单加入 `app:copyText`）、integration 51、e2e 50
  （`virtual-scroll` 有一条已知时序偶发，重跑即过）。

---

## v0.10.0（2026-11-24）

版本号可见 + 诊断面板（反馈提速）。

### 新增

- **顶栏显示客户端版本**（`app.getVersion()` → `app:getBoot.appVersion`）：
  以后能一眼确认跑的是哪一版，避免把「旧包没更新」误判成功能没修好。
- **「诊断」面板**（`app:diagnostics`，只读、脱敏）：客户端版本、pi 版本/状态/可执行文件路径、
  pi 配置目录、会话目录、`models.json` / `settings.json` 路径、默认工作目录、主题、
  已索引会话数、Electron/Chromium/Node 版本、平台与架构；支持「复制全部」。

### 说明

- 面板不含 apiKey / token，也不读会话内容；E2E 有一条断言扫描面板文本不得出现密钥形态。
- 上一版想用 `electron.vite.config.ts` 的 `renderer.define` 注入版本，实测产物里未被替换，
  改为走主进程 `app.getVersion()`（更可靠，也是 Electron 推荐做法）。

### 测试

unit 720（通道白名单含 `app:diagnostics`）、integration 51、e2e 49（E21 版本号与诊断面板）。

---

## v0.9.4（2026-11-24）

「引用文件」在 Windows 上只能选文件夹 —— 修掉并拆成两个动作。

### 根因（平台限制，不是配置错误）

Electron 类型文档原文：

> On Windows and Linux an open dialog can not be both a file selector and a directory selector,
> so if you set `properties` to `['openFile','openDirectory']` on these platforms,
> a directory selector will be shown.

v0.9.2 想让一个按钮同时选文件与文件夹，结果在 Windows 上退化成**只能选目录**。

### 修复

- 输入框拆成两个按钮：**「引用文件」**（`['openFile']`）与**「引用文件夹」**（`['openDirectory']`），
  两者选到的路径都会插入工作区相对路径，且都受工作区边界校验。
- `fs:pickWorkspaceFile` 增加 `kind: 'file' | 'directory'`（默认 `file`），沿用原有边界与取消语义。

### 测试

unit 720（新增：`kind` 决定 dialog 属性，且两者不会同时出现）、integration 51、e2e 48。

---

## v0.9.3（2026-11-24）

修掉「改名没生效、也不报错」的真因。

### 修复

- **历史任务改名后标题不更新**：`setTaskTitle` 只在「live 任务 / 标题仍是『新任务』」时写入，
  历史任务改名会被它**静默忽略** —— 于是用户看到「改名失败、顶部也没有错误」。
  新增 `renameTaskTitle`（无条件更新）供改名专用。
- 改名失败不再静默：空名字 / 找不到任务 / IPC 报错都会给可见提示。

### 说明

- 「引用文件」对话框在 v0.9.2 已改为 `openFile + openDirectory`（文件与文件夹都能选）。
  若仍只显示文件夹，说明运行的是旧安装包 —— 请在「设置 → 应用」或 Release 页面核对版本号。

### 测试

unit 717（新增：历史任务改名必须能更新标题，且旧的 `setTaskTitle` 对它无效是已知行为）、
integration 51、e2e 48（`virtual-scroll` 有一条已知时序偶发，重跑即过）。

---

## v0.9.2（2026-11-23）

两处用户反馈修复。

### 修复

- **「引用文件」对话框只能选文件** → 现在**同时允许选文件与文件夹**
  （`openFile` + `openDirectory`）；选到文件夹时插入该目录的相对路径。
- **改名后无法保存**：
  - 历史任务的授权依据从「比对会话根字符串」改为「**文件必须出现在本地会话索引里**」。
    会话目录可以被 `PI_CODING_AGENT_SESSION_DIR` 改变，根字符串比对在真实环境里会误判成
    `PATH_DENIED`，表现就是「改名保存不了」。
  - renderer 增加兜底：任务被标成 live 但子进程已被回收时（`SESSION_NOT_FOUND`），
    自动改用会话文件路径重试一次。

### 测试

unit 716（新增路由级用例：索引内的会话文件可改名且原内容不变；索引外的 `.jsonl` 被
`PATH_DENIED`）、integration 51、e2e 48。

---

## v0.9.1（2026-11-23）

历史任务改名与 RPC `set_session_name` 对齐（A23 追补）。

### 变更

- 追加的 `session_info` 记录与 pi 的 RPC 路径**逐字段同形**：
  `parentId` 改为**最后一条记录的 id**（此前写的是 `null`），`id` 改为 **8 位十六进制**
  （此前 12 位）。

### 实测结论（为什么不为「统一」而起进程）

拷一份 2200 行的会话，走 `pi --mode rpc --session <copy>` + `set_session_name`，
结果只多 **1 行** `session_info` —— RPC 路径没有额外副作用，写的就是这条记录。
所以历史任务直接追加同形记录即可：落盘结果与 RPC 一致，且零启动开销、不会把任务
临时变成「活跃」。

### 测试

unit 714（断言 `parentId` 接最后一条记录、`id` 匹配 `^[0-9a-f]{8}$`）、integration 51、e2e 48。

---

## v0.9.0（2026-11-23）

任务可以改名了（A23）。

### 新增

- **双击任务标题改名**：`Enter` 保存、`Esc` 取消；失败保持编辑态并报错。
- 两条落盘路径（`session:setName`）：
  - **活跃会话** → RPC `set_session_name`，由 pi 自己写进会话 JSONL（与 TUI 的 `/name` 一致）；
  - **历史（回放）任务** → 追加一条 `session_info` 记录（`id/parentId/timestamp/name`）。
    只 **append**、不改写既有内容 —— 最坏情况是多一行，不会损坏会话。
- 历史路径要求文件是 `.jsonl` 且**在会话根内**（主进程 `realpath` 后判前缀），
  否则「改名字」就成了任意文件追加。

### 实现说明

- pi 的会话名**不是文件头字段**，而是 `session_info` 记录；`SessionIndex` 已经优先读它，
  所以改完刷新列表即生效，无需额外状态。
- 编辑框**刻意不在失焦时关闭**：双击的第二下会立刻让输入框失焦，否则「刚出现就被关掉」。

### 测试

unit 714（含 U31：追加记录形状/原内容不变/索引读得到/非法输入被拒）、integration 51、
e2e 48（含 E20：双击改名；按标题断言，因为改名会按 updatedAt 重排）。

---

## v0.8.1（2026-11-23）

修复「默认工作区 = 程序启动目录」。

### 修复

- **默认工作目录改为用户主目录**：`app:getBoot.lastCwd` 与无默认值的目录对话框之前用
  `process.cwd()`（从快捷方式启动时是安装目录，从终端启动时是终端当前目录）。现在统一为
  `os.homedir()`。
- **选中已有任务后，目录从该任务的工作区打开**：新建任务弹层点「选择目录」时以选中任务的
  `cwd` 为起始位置；输入框保持为空（未选目录不能提交）。
- **「引用文件」的工作区根按任务解析**：活跃会话用 `sessionKey`，历史（回放）任务用
  `sessionFile` → 从会话索引读该 JSONL 的 `cwd`。两者都不可用时明确报错，
  **不再退回进程启动目录**（这正是本次 bug 的来源）。
- 历史会话 header 缺 `cwd`（索引里是空串）时按「未知」处理，不当作合法工作区。

### 测试

unit 710（新增回归：`app:getBoot.lastCwd === homedir()` 且 `!== process.cwd()`）、
integration 51、e2e 47。

---

## v0.8.0（2026-11-23）

对话里的图片可见、可放大；输入框可直接引用工作区文件（A21/A22）。

### 新增

- **消息图片缩略图 + 原图查看器**：用户消息里的图片现在显示为缩略图，点击在应用内看原图
  （Esc / 点遮罩 / 点关闭都能退，多图可用方向键或按钮切换）。图片从会话内容块
  （`{type:'image', data, mimeType}`）转成 data URL，实时与历史回放同一条路径。
- **「引用文件」按钮**：选一个工作区内的文件，把**工作区相对路径**插进输入框。
  - 边界由主进程判定（`workspaceOf(sessionKey)` + `realpath` 归一后判前缀），
    选到工作区外直接拒绝并提示；
  - 取消返回 `canceled:true`，不弹错误条。

### 为什么不是 `@path`

pi 的 `@file` **只在 CLI 解析**，`docs/cli.md` 明确写「RPC mode rejects `@file` arguments」。
所以客户端不假装支持 `@` 语法；插入相对路径、让模型用自己的 `read` 工具去读，
是 RPC 集成下唯一真实可行的引用方式。

### 修复

- 乐观用户消息被权威 `message_end` 替换时，若权威消息没有图片块（上游只回显文本），
  **保留本地已发送的图片** —— 否则「发了截图，回显时图没了」。
- 去重键只在带图片时追加 `:img<N>`：文本消息的 key 形状保持不变，避免无谓的行为变化。

### 测试

unit 710（含 U29 图片归约、U30 文件引用边界）、integration 51、e2e 47（含 E18/E19）。

---

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
