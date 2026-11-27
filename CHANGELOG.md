# 更新日志（Changelog）

## v0.16.8（2026-11-27）

修「点击专家切换，下拉框在对话框下面，没法显示」。

### 修复

- 专家切换下拉的弹出方向改为**向上弹**（`bottom: calc(100% + 6px)`）：控件在对话框底部，
  旧版复用了头部模型切换器「向下弹」的定位，展开内容整体跑出对话框不可见。
  模型切换器（会话头部）保持向下弹，两者共享视觉、定位各自声明。

## v0.16.7（2026-11-27）

专家（原 Agent）体验升级：新建任务可指定，会话中可动态切换；新增「压缩上下文」按钮（A40/A41）。

### 功能

- **文案**：用户可见的「Agent」统一改为「**专家**」（新建任务弹层、会话内展示等）；
  内部标识（`agents:list` 通道、`--agent` 参数、`/agent` 命令、testid）保持不变。
- **动态切换专家**（A40）：对话框底部原「专家：X」展示位升级为下拉切换器，选中后点「切换」
  即以扩展命令 `/agent <name>` 生效，**不重建会话**（消息与文件全保留）；切换后从 pi
  权威回填状态（专家/模型/推理档位同步刷新），并通过 `entry_appended` 事件实时校准。
- **压缩上下文**（A41）：对话框操作行新增「压缩上下文」按钮，调 pi `compact` 把较早对话
  总结成摘要释放窗口；成功提示 token 变化（如 `120.0k → 20.0k`）；压缩中禁止发消息与切换
  专家（SESSION_BUSY），240s 超时兜底。

### 可靠性

- 专家切换不乐观写入：扩展对未知名字静默失败（实测），客户端先过目录白名单 + 单 token
  校验，切换后读回比对，不一致给「切换未生效」告警；名字含空白/含控制字符一律拒。
- 压缩状态双源驱动（`compaction_start/end` 事件 + 动作自身）幂等；会话终止（结束/崩溃/
  空闲回收）时强制复位，恢复会话后按钮不会永久禁用。
- 工具不可用时控件常驻 + 说明原因（A33 原则），不静默隐藏：扩展未装、目录为空、历史回放、
  运行中、压缩中各有可操作的提示。

## v0.16.6（2026-11-27）

修「模型连不上时界面连刷多条空气泡，看不出发生了错误」。

### 修复

- pi 连接模型 endpoint 失败自动重试时，每次失败都会持久化一条 `content:[]`、
  `stopReason:'error'` 的 assistant 消息；旧版把它们渲染成只有「pi」角标的空气泡。
  现在透传 `stopReason`/`errorMessage` 并渲染为**错误气泡**：可懂中文标题（超时 / 无法连接 /
  认证失败 / 限流 / 上下文超限）+ 失败次数 + 可展开的技术详情（原始错误只进 `<details>`）。
- 同一轮内连续的纯失败消息在**展示层**折叠为一条（数据逐条保真，历史回放与实时一致）。
- 空 content 且无错误的收尾消息（中止瞬间的 `stopReason:'aborted'`）不再渲染空气泡；
  中止收尾即使带 `errorMessage` 也不会误报成失败，有文本的中止消息显示「已中止」注脚。

### 已知不做

失败后自动重发按钮、全局错误条联动（错误是该轮的持久事实，只在时间线内展示，
切会话/回放历史时不弹全局条）。

## v0.16.5（2026-11-26）

新增「删除会话」（A39）。

### 功能

- 任务列表：历史任务行内新增「删除」（hover/聚焦显形，行内二次确认，Esc 取消，刻意无默认焦点）。
- 删除 = 把会话 JSONL 移到**系统回收站**（`shell.trashItem`），不是硬删除；应用内不提供撤销，
  恢复走系统回收站。
- 仅允许删除历史任务：live 会话必须先「结束」——两个动作永远不出现在同一行。

### 安全

- 授权：realpath 归一（Windows 8.3/大小写）→ 会话根内深度恰好 2 的 `.jsonl` → `SessionIndex.find`
  认同的可解析会话 → `lstat` 普通文件；可选 `sessionId` 一致性校验。
- 活跃会话持有同一文件一律 `SESSION_BUSY`（不隐式 dispose）；越权 `PATH_DENIED`；
  回收站失败 `DELETE_FAILED`，**绝不**降级为永久删除。
- 审计新增 `session:delete`（目标只记会话 id，不含绝对路径）。

### 顺带修复

- A23 改名授权改用新增的 `SessionIndex.find`：旧实现只校验 `session:list` 首页（20 条），
  第 21 条及之后的历史会话改名会误报 `PATH_DENIED`。

### 已知不做

批量删除、永久删除、跨设备/云端同步删除、删除空分组目录。

## v0.16.4（2026-11-26）

修「任务改名后重启，名字丢失变回 `(未命名会话)`」（A23）。

### 根因

pi 的会话名不是文件头字段，而是会话 JSONL 里的 `session_info` **记录**；`/name`、RPC
`set_session_name` 以及本项目的「历史任务改名」都**只 append**，所以改名记录一定落在
**文件尾**。而 `SessionIndex` 只读头部 32KB —— 改名当场生效（renderer 乐观更新），
下一次启动重新读盘时才暴露：标题回退成首条用户消息，甚至 `(未命名会话)`
（同一个 32KB 预算连一条 52KB 的单行记录都装不下）。

### 修复

- 新增 `services/session-tail.ts`：从文件尾**反向分块扫描**，取最后一条满足谓词的记录
  （last-wins）；截断行、CRLF、UTF-8 多字节被切断都容错，IO 失败一律 fail-soft。
- `SessionIndex` 只要文件超出头部窗口（`size > 32KB`，`size` 未知时同样视为超出）就**无条件**反向扫描尾部（窗口 128KB / 最多反扫 2MB）——last-wins 要求如此：头部即使有旧名，也要扫尾部才能发现更新的名字；
  头部连首条用户消息都没有时再做**有上限**（512KB）的前向补扫。
  标题优先级：尾部 name → 头部 name → 首条用户消息 → `(未命名会话)`；空名视为无名字。
- `session:setName` 两条路径成功后显式 `SessionIndex.invalidate(file)`，
  消除「同一毫秒两次 append、mtime 不变」时读到旧摘要的可能。
- 新增 `SessionService.sessionFileOf(sessionKey)`（活跃路径失效缓存用，拿不到就跳过）。

### 测试

- 新增 `tests/unit/session-tail.test.ts`（T1–T9，真实临时文件）。
- `session-index.test.ts` 的 fake 头部读取改为**按字节真截断**并返回 `size`
  —— 原来注入「返回整文件内容」等于豁免 32KB 预算，正是这个 bug 长期没被抓住的原因；
  另新增 S1–S8（含「重启/失效后仍读到新名」「小文件零尾部 IO」）。
- `pi-session-name.test.ts` 的「索引能读到新名字」改用 > 32KB + 60KB 单行记录的真实会话。
- `ipc-router.test.ts` 新增 I1–I4（> 64KB 会话改名、重启后仍在、活跃路径、连续改名 3 次）。

### 已知残留缺口

最后一条 `session_info` 距文件尾 > 2MB（反扫上限）时扫不到，改名后又在末尾追加 128KB–2MB 内容仍在范围内；
`--name` 建会话的早期名字仍在头部兜底。已在 `docs/architecture.md` 显式记录。

## v0.16.3（2026-11-25）

任务列表观感收尾（A36）。

### 历史任务不再显示「结束」按钮

- 之前给历史任务渲染禁用态按钮（想表达「功能存在」），结果一列灰色按钮既没有用、
  又抢注意力。**只有 live 任务显示「结束」** —— 按钮本身就是「进行中」的标记。
- 同步去掉「进行中」pill：同一事实不再说两遍。

### 结束按钮配色

- 改用危险色（`--error`）描边 + 文字，悬停淡红底：与「终止运行中的会话」语义一致，
  也从周围的中性按钮里区分得出来；确认区仍是虚线提示，不额外加粗。

### 测试

- `end-session` 相应更新：E2 历史任务无按钮也无 pill；E3/E3b 只断言按钮存在；
  E4 结束后按钮消失（降级为历史）；E7 恢复后按钮出现且可用。
- unit 853 / integration 67 / e2e **72** 全绿（`virtual-scroll` 仍为已知时序偶发）。

---

## v0.16.2（2026-11-25）

修「历史任务恢复会话后，结束按钮仍是灰的」。

### 根因

`continueConversation`（以及发送消息前的隐式恢复）只调了 `attachSessionKey` 挂上 sessionKey，
**没有把 `kind` 从 `history` 改成 `live`**。而界面上的「结束」按钮与「进行中」pill 都以
`kind === 'live'` 为判据 —— 于是恢复会话看起来像没成功：输入框能用了，但任务仍是「历史」外观。

### 修复

- `attachSessionKey` 的语义补全：**挂上活会话即升级为 live**（`sessionKey` + `kind: 'live'`）。
  这是「恢复成功」的唯一真实判据，两个调用点（继续对话 / 发送前自动恢复）同时受益。
- 单测把原来断言 `kind === 'history'` 的用例改为 `'live'`，并断言 `bySessionKey` 已建立。
- 新增 e2e：历史任务恢复会话后，结束按钮必须从禁用变为可用、且出现「进行中」pill。

### 测试

unit 853 / integration 67 / e2e **72**（`end-session` 8 条，新增 E7）。全绿；`virtual-scroll` 仍为已知时序偶发。

---

## v0.16.1（2026-11-25）

修 A36/A38 的三处观感问题（功能逻辑不变）。

### 结束会话按钮更可靠地可见

- **历史任务也渲染「结束」按钮**（禁用态 + `title` 说明「该任务没有运行中的会话」）：
  之前直接隐藏，用户会以为「功能没做」。
- 任务行改用 **grid 两列布局**（任务块 + 结束按钮）：此前 `flex-wrap` 在窄列表里会把按钮
  换行挤到任务块**左侧**，视觉上像下一行的标签，很容易被忽略。
- 确认区改为跨两列，行为不变（Esc 仍可取消）。

### 去掉重复的运行状态

- 对话顶部原有一个 `run-phase` 徽标与输入区下方的状态**重复**，移除顶部那份，
  只保留输入区（与 agent 同一行）；token/成本徽标与模型切换器不受影响。

### 状态按 phase 上色

- `composer-state` 增加 `data-phase`，CSS 按状态上色：
  **生成中＝绿**、**工具执行中＝蓝**、**收尾中＝黄**、**空闲＝暗**、**已中止＝红**。
- 颜色只由 DOM 属性驱动，便于 e2e 直接断言（不靠 JS 拼 class）。

### 测试

- `end-session` 的 E1/E2/E4 按新行为更新（禁用态、`title` 文案、结束按钮保留但禁用）；
  `agent-display` 增加两条断言（`data-phase` 存在、顶部 `run-phase` 已移除）。
- unit 853 / integration 67 / e2e 71 全绿（`virtual-scroll` 为已知时序偶发，单独重跑必过）。

---

## v0.16.0（2026-11-25）

pi 新版本检测与更新（A34）。

### 功能

顶栏新增「更新」按钮：检测到新版时显示「有新版」+ 圆点，点开是更新面板 —— 显示当前 / 最新版本、
检查时间、结论来源（实时查询还是上次缓存）；一键执行 `pi update`，过程逐行回显、可取消，
失败时给出**可复制的手动命令**。

### 为什么「检测」与「更新」必须分开

`pi update` **没有 dry-run**：只要远端有新版，它就直接开始下载安装 —— 想只问一句「有没有新版」它也照装。
所以检测由客户端自己请求 `https://pi.dev/api/latest-version`（pi 官方消费的同一契约，只读），
执行仍然只调 `pi update`，**不自己拼 `npm i -g`**（拼错 target/prefix 会把全局环境装歪，
而这正是用户最不想被客户端动的地方）。

### 安全 / 稳定性约束

- 检测只走 https；`PI_DESKTOP_UPDATE_CHECK_URL` 只在 host 为 `127.0.0.1` / `localhost` 时允许 http（测试用）。
- 响应体 8KB / 5s 上限；重定向最多 1 跳，且**每跳重新校验**（防 https 跳内网）。
- 执行 argv 只有 `['update']` / `['update', '--force']`，`shell: false`（renderer 无法注入参数）。
- 更新前必须**零活跃会话**（Windows 会挪动安装目录）；更新中禁用新建 / 恢复会话。
- 单飞锁：同一时刻只允许一个更新任务，第二次调用**拒绝而不排队**。
- `--force` 需内联二次确认（「已最新」时重装是修复手段，不是默认路径）。
- 日志在主进程**脱敏后**才推送（剥 ANSI、抹掉 token），单行 ≤2000、只留尾部 32KB。
- 更新中退出应用会二次确认，并先结束更新进程（SIGTERM → 2s → SIGKILL）。

### 结论口径

更新后一律用 `pi --version` 复验：`after === target` 才是 `updated`；进程已退出 / 待生效为 `pendingRestart`
（提示 PATH 里可能有多份 pi 或需重启终端）；命令非 0 退出为 `failed`。

**不做自动回滚**：回滚要先知道用户原本的安装方式与版本，猜错的代价比「手动重装」更大 —— 只给可复制的命令。

### 明确不做

- 静默 / 自动更新（升级会替换可执行文件，必须由用户按下）。
- pi-desktop 自身更新（未引入 `electron-updater`）。
- 扩展与模型目录更新（`--extensions` / `--models` 会改用户 `settings.json`，另立项）。

### A36：结束会话按钮

任务列表的每个 **live** 任务右侧新增「结束」按钮（历史任务没有可结束的进程，不显示）：

- 内联二次确认（`Esc` 也可取消，监听挂在整行上——焦点停在「结束」按钮时同样生效），
  文案明示「会中断正在运行的回合；已写入的历史保留」，运行中加强为「未落盘的最后一条记录可能丢失」。
- 成功后有 `filePath` → 任务降级为历史（可回放 / 可「继续对话」）；首条消息前结束（无会话文件）
  → 直接移除空任务，避免留下点了就报错的僵尸。
- `SESSION_NOT_FOUND`（已被回收/已结束）按「目标已达成」处理，不弹红色错误。
- 结束在途时按钮显示「结束中…」并禁用；连点只发一次 `session:dispose`。
- 用户主动结束不触发 A6 的「子进程意外退出」提示（靠 `runStore.ending` 区分）。
- 未新增 IPC 通道（复用已有 `session:dispose`）。

### A37：插件面板

顶栏「技能」之后新增「插件」按钮（`open-plugins`）：

- **清单**：读 `<agentDir>/settings.json#packages` + 每个受管目录的 `package.json`，显示名称/版本/说明/来源/安装位置；
  settings 缺失或损坏、目录缺失、`package.json` 缺 `description` 都会降级展示，不会让面板空白。
  清单**只代表登记事实**，不代表本次会话已成功加载。
- **从 URL/npm/git 安装**：`pi install <source>`（argv 恒为 `['install', source]`、`shell:false`），
  逐行回显、10 分钟超时、可取消。只接受 `npm:` / `git:<github|gitlab|codeberg|bitbucket>/owner/repo` /
  `https://<同域名>/owner/repo`；**拒绝** `ssh://`、`git@`、本地路径与任何含 shell 元字符/空白的 source。
- **预览**：仅 npm 源查 `registry.npmjs.org` 元数据（只读、8s、1MB、逐跳校验 host）；预览失败**不阻断**安装。
- **二次确认**：安装前必须确认，文案明示「会执行第三方代码，npm 可能跑 postinstall」。
- **复验**：exit 0 后重新读 `settings.json` 确认登记出现，再读 `package.json` 取版本；不一致按失败处理。
- 与「更新 pi」互斥；不新增 pi 侧能力（不做卸载/启用禁用/项目级安装）。

### A38：输入区显示当前 agent

输入框下方（与「空闲/运行中」状态同一行）显示 **agent：<名字>**，没有 agent 时显示「默认」。

- 事实来源：pi 的 `get_state` 与 RPC 事件**都不携带 agent**，agent 只写在会话 JSONL 的自定义条目里
  （`customType: open-agents-state` / `active_agent`）。主进程在 `session:state` 时读文件尾部
  （256KB、锁外、fail-soft），历史任务复用 `session:history` 已解析的 entries（零额外 IO）。
- 三态语义：`string` 更新；`null`（文件里显式清除）→ 回到「默认」；`undefined`（读不到/无标记）
  → **保持现值**，避免把刚由新建入参填好的名字抹掉。
- 刷新时机：新建/继续/分叉/每轮结束（既有的 `syncTaskState` 路径），不引入文件监听或轮询。
- 不新增 IPC 通道；`session:list` 不读 JSONL（避免首屏 N 次 IO），历史任务的 agent 在选中时取。

### 测试

unit 745→853（A34 检测/执行/取消 36 条 + A35 无 UI 策略 + A36 结束会话 9 条 + A37 清单/安装器 43 条）、
integration 51→67、e2e 50→71（E34-1..5、A36 的 7 条含 Esc 取消、A37 插件面板 6 条、A38 agent 显示 3 条）。

---

## v0.15.1（2026-11-24）

修「新建任务里 agent 选择消失」。

### 根因

弹层只在**打开那一刻**探测一次 `pi --help` 是否支持 `--agent`：

1. 应用刚启动时 pi 还没自检完 → `piLocator.launch()` 为空 → 探测返回 `supportsAgentFlag: false`
   （附注「尚未定位 pi」）；
2. 弹层的 effect 只依赖 `[cwd]`，不会重试；
3. 旧 UI 在 `supportsAgentFlag !== true` 时**整块不渲染** → 用户看到的是「agent 选择没了」，
   而且没有任何提示。

### 修复

- 选择器**常驻**：始终渲染，不可用时 `disabled` 并在下方说明原因（检测中 / 未注册 `--agent`
  （带服务端 note）/ 无主 agent / 正常）。
- effect 依赖加入 **pi 自检状态**：自检完成后自动重查，消除「打开弹层太快就永远看不到」的竞态。
- 文案明确「只列主 agent（与 TUI `/agent` 一致）」。

### 测试

- 新增 E2E：mock 的 `--help` 不含 `--agent` 时，选择器**仍存在**、`disabled`、hint 有说明。
- 既有 E2E 相应改为「等选项加载完再断言」（选择器现在常驻，出现≠已加载）。
- unit 745、integration 51、e2e 50（`virtual-scroll` 一条已知时序偶发，重跑即过）。

---

## v0.15.0（2026-11-24）

诊断按钮左移 + 技能面板支持「从 URL 安装公开技能」。

### 变更

- **「诊断」按钮移到顶栏最左**（紧跟应用名），模型/技能按钮保持原顺序。

### 新增

- **从 URL 安装技能**（技能面板内）：粘贴技能 `SKILL.md` 的 https 链接 → **预览**（名称/描述/体积）
  → 选择**全局**（`~/.pi/agent/skills`）或**项目级**（当前工作区 `.pi/skills`）→ 安装。
  安装后清单自动刷新；同名技能默认**拒绝覆盖**（需显式勾选）。
- 新增通道 `skills:preview` / `skills:install`。

### 安全约束（硬性，不可配置放宽）

- **只允许 https**（唯一例外：e2e 用环境变量 `PI_DESKTOP_ALLOW_LOCAL_SKILL_FETCH=1` 放行本地 http）；
- **拒绝内网/环回字面量 IP**（10/8、172.16/12、192.168/16、169.254/16、127/8、::1、fc/fd/fe80）——
  且**每一跳重定向都重新校验**，防「https 跳到内网」；
- **512KB 体积上限 + 15s 超时**（技能是提示词，不是二进制包）；
- **技能名白名单** `^[a-z0-9][a-z0-9._-]{0,63}$`（frontmatter 优先，缺省用 URL 文件名）—— 杜绝路径穿越；
- 写入为「临时文件 + rename」，目标目录必须在技能根内（第二道闸）。

### 局限（如实说明）

只安装**单个 `SKILL.md`**，不拉取技能目录里的 `scripts/`、`references/`、`assets/`。
需要附带文件的技能请手动 clone。

### 测试

unit 745（A32：https-only、内网拒绝、体积上限、名字白名单、预览不落盘、安装写入、
不覆盖同名、404 报错）、integration 51、e2e 49。

---

## v0.14.0（2026-11-24）

顶栏新增「技能」按钮，显示当前可用技能。

### 新增

- **技能面板**（只读）：列出现有技能的名称、描述与来源分组。
  - 扫描位置与 pi 一致：全局 `<agent-dir>/skills/**/SKILL.md` + 当前任务工作区的
    `.pi/skills/**`、`.agents/skills/**`（**项目级同名覆盖全局**）。
  - 按「项目 / 全局」分组展示；有工作区才扫项目级。
  - **只显示 name/description**：pi 也只把这两项给模型，正文按需加载 —— 面板不读正文、不执行。
- 新增只读通道 `skills:list`（入参 `{ cwd? }`）。

### 说明

- 技能 = **含 `SKILL.md` 的目录**（Agent Skills 规范）；目录里的其他 md 是技能内部资料，不算技能定义。
- 缺 frontmatter `name` 时用目录名兜底。

### 测试

unit 735（扫描/只认 SKILL.md/项目覆盖全局/目录名兜底）、integration 51、e2e 49（面板可开、
有技能列清单、无技能给放置提示、无读取错误）。

---

## v0.13.1（2026-11-24）

agent 列表与 TUI `/agent` 对齐：只显示主 agent。

### 变更

- 选择器只列 **`mode: primary` / `all`**（**不写 mode 视为 `all`**），
  **排除 `mode: subagent`** —— 与 pi TUI 的 `/agent` 行为一致（subagent 是给子代理工具调用的身份）。
- 树状分组保留（按定义目录），只是成员集合变小了。

### 测试

unit 731（新增 A30：缺省/all/primary 保留、subagent 排除；扫描结果不含 subagent）、
integration 51、e2e 48（夹具里加了一个 `mode: subagent` 的 agent，断言它不出现在选择器）。

---

## v0.13.0（2026-11-24）

新建任务的 agent 选择改成**树状**（按定义目录分组）。

### 变更

- agent 下拉现在是树：根目录的 agent 直接列出，子目录（如 `agents/intranet/`、`agents/team/`）
  渲染成 `<optgroup label="目录名">`，条目按深度缩进并带 `└` 前缀。
- 选项后缀标出 `（主）`（frontmatter `mode: primary`）与 `（项目）`（项目级定义），
  一眼能看出「谁是主 agent、谁是子 agent、来自哪一层」。

### 为什么按目录分组

pi / pi-open-agents 的 frontmatter **没有 parent 字段**，唯一的层级信息就是
定义文件所在目录。所以父子关系由目录结构推导：`agents/intranet/architect.md`
属于 `intranet` 组，`group: ['intranet']`。契约里新增 `group: string[]`（根为 `[]`）。

### 测试

unit 729（目录分组：根 / 一层 / 两层、项目级独立分段）、integration 51、
e2e 48（agent 选择器：`optgroup label=team`、子项文本含 `└`）。

---

## v0.12.0（2026-11-24）

引用选择器排版修正 + 多行粘贴折叠。

### 修复

- **引用选择器排版**：`.picker__*` 之前**完全没有样式**（只有结构），表现为列表挤在一起、
  长路径撑开弹层。现在补齐：工具栏（上一级 / 路径 / 引用此文件夹）单行不换行、
  路径用等宽字体且优先显示尾部、列表目录在前并带 hover、列表区独立滚动
  （`max-height: min(52vh, 420px)`）。

### 新增

- **多行粘贴折叠**：粘贴多行文本（≥ 6 行或 ≥ 800 字符）时，输入框里只插入一行占位符
  `[paste #1-20 lines]`；**发送时自动展开成完整原文**。
  - 占位符被删掉后不再展开（避免「删了却还在发」）；
  - 短文本粘贴保持原生行为，不打扰。
  - 折叠逻辑在 `lib/paste.ts`（纯函数：`planPaste` / `expandPastes` / `pruneBlocks`）。

### 测试

unit 727（A28：阈值、占位符格式、展开、删除后不展开）、integration 51、
e2e 48（多行粘贴 → 占位符 → 发送后上游收到完整原文）。

---

## v0.11.0（2026-11-24）

「引用文件 / 引用文件夹」统一成一个入口。

### 变更

- 输入框只保留一个 **「引用」** 按钮，弹出**应用内选择器**：同一列表里文件夹与文件并列，
  点文件夹进入、点文件直接插入；顶部有「上一级」与「引用此文件夹」。
- 为什么不再用原生对话框：Windows/Linux 上 `openFile` + `openDirectory` 同时设置只会弹
  目录选择器（Electron 文档明确），原生对话框**无法**一个入口两用。自绘列表才能真正统一，
  且跨平台行为一致。
- 边界不变：每次列举都经主进程 `path-guard` 收敛（工作区外的路径一律拒绝），
  符号链接不跟随；单目录超过 500 条显式提示（不静默截断）。

### 接口

- 新增只读通道 `fs:listWorkspaceDir`（入参 `{ sessionKey? , sessionFile?, path? }`），
  返回 `{ relative, entries, truncated, parentRelative? }`。
- `fs:pickWorkspaceFile` 保留（含 `kind`），但 UI 已改用应用内选择器。

### 测试

unit 720、integration 51、e2e 47（E18 重写为驱动应用内选择器：选文件 → 插入 `note.txt`；
进子目录 → 「引用此文件夹」→ 插入 `sub`）。`virtual-scroll` 有一条已知时序偶发。

---

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
