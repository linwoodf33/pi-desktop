# pi-desktop 桌面客户端架构方案

- 版本：v0.4（2026-11-23）
- 状态：已实现（v0.4：把主题、模型管理、发布与诊断并入正文，MVP 事实与文档合一）
- 作者：architect
- 目标读者：executor（实现者）、reviewer

## 版本变更记录

| 版本 | 日期       | 关键变更                                                                                                                                                                                                                         |
| ---- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1 | 2026-11-20 | Electron + React + Vite；`PiTransport` 抽象；RPC 子进程默认；本地 session JSONL 为事实来源；M1–M6                                                                                                                                |
| v0.2 | 2026-11-20 | 引入「pi 在云服务器」约束；新增部署模式章节；`PiTransport` 拆为 `PiConnection` + `PiTransport`；SSH 为 P0、网关 P1、镜像 P2；新增断连恢复、约束 11–17、M1–M8                                                                     |
| v0.3 | 2026-11-20 | **SSH 否决**；**MVP 只做本地模式**；远程降为 Phase 2「常驻网关 + WSS 零配置」；远程优先的过度设计收进附录 A；里程碑重排 M1–M6 / M7–M9；补齐 v0.2 遗留 8 处缺口；待确认项改为 Q1–Q7                                               |
| v0.4 | 2026-11-23 | **并入实现事实**：新增 §12 主题系统、§13 模型管理、§14 发布工程与诊断；§5.4 补 6 条 `models:*` 通道；§7 补约束 16–18；§9/§10 补 U22–U24、E11、A14–A16。原 `docs/themes.md`、`docs/models.md`、`docs/release.md` 合并进正文后删除 |

### v0.2 → v0.3 的三条决策变更

1. **SSH 否决**：要求用户配置 sshd、密钥、`known_hosts`、堡垒机，属运维门槛而非产品能力，不作为产品路径；仅在 §3.1 保留一句「高级用户可选，暂不实现」。
2. **本地优先**：MVP 只支持 pi 与客户端同机。`PiConnection` 抽象保留（为 Phase 2 预留），但 MVP 只实现 `LocalConnection`；`RemoteFs`、`SessionMirror`、`session:reconnect`、断连审批 TTL 等远程专属设计移出 MVP 正文，收进附录 A。
3. **远程 = Phase 2 网关，且零配置**：服务端单命令/单容器部署，自动生成 token 与自签 TLS 并打印连接串；客户端只粘贴连接串，不碰证书。

---

## 1. 背景与目标

### 1.1 背景

pi（`@earendil-works/pi-coding-agent`）是终端优先的 agent harness，主交互形态为 TUI。目标是借鉴 WorkBuddy（腾讯全场景 AI 智能体桌面工作台）的形态，为 pi 提供桌面客户端。

| 维度 | WorkBuddy 做法                                                   | 对 pi-desktop 的启示                         |
| ---- | ---------------------------------------------------------------- | -------------------------------------------- |
| 入口 | 新建任务栏：模式 → 模型 → 目录 → 技能 → 描述任务，仅任务描述必填 | 「新建任务」弹层承接会话创建，其余项给默认值 |
| 布局 | 左：任务列表；中：对话；右：产物/文件                            | 三栏，右侧按需折叠                           |
| 执行 | 自主拆解步骤、逐步展示、可中断、可审计                           | 事件流可视化 + 中止按钮 + 步骤时间线         |
| 权限 | 操作本地文件前需授权，可设授权范围                               | 工具调用前审批（risk-based）                 |
| 产物 | 交付可直接使用的文件，右侧可预览                                 | 右侧产物面板 + 变更 diff                     |
| 扩展 | 专家 / 技能 / 连接器（MCP） / 资料库                             | 映射到 pi 的 extensions / skills / MCP       |
| 模式 | 办公/编程模式；模型档位；Plan 模式                               | 映射到 agent/prompt 预设与模型选择           |

### 1.2 部署形态与阶段划分（v0.3 重写）

| 阶段               | 形态                         | 通道                  | 状态                      |
| ------------------ | ---------------------------- | --------------------- | ------------------------- |
| **Phase 1（MVP）** | 本地：pi 与客户端同机        | `child_process` stdio | **本版重点，M1–M6**       |
| **Phase 2**        | 远程：云服务器常驻网关 + WSS | `wss` 多路复用        | 规划完成（附录 A），M7–M9 |
| Phase 3            | 只读镜像 / 多设备 / 内嵌终端 | 视需要                | 候选                      |

- 远程形态的价值仍然存在（长任务不因关客户端而中断、多设备同看），但**不进入 MVP**，且不再走 SSH。
- 事实来源在任何阶段都是 pi 的 session JSONL（Phase 1 在本地，Phase 2 在云端），客户端不自建并行会话库（见 D4）。

### 1.3 目标

- **G1 能力无损**：GUI 覆盖 pi 核心能力——会话（新建/恢复/分叉/分支）、流式对话、工具调用、模型与推理档位、扩展命令、MCP、技能、成本与 token。
- **G2 形态借鉴**：任务中心化 + 三栏 + 执行可审计 + 产物可见。
- **G3 零内核分叉**：不 fork、不 patch pi。
- **G4 可验证**：验收标准可被自动化测试或明确人工步骤判定。
- **G5 安全默认**：渲染进程无 Node；文件与命令能力只经主进程白名单；高风险工具执行前审批。
- **G6 演进就绪**：`PiConnection` 抽象在 MVP 即定型，Phase 2 增加一个实现即可接入远程，renderer 不改（见 A-P6）。

### 1.4 非目标

- 账号、积分、计费、团队协作。
- Office 二进制文档（docx/xlsx/pptx）渲染与人机双写。
- 移动端 / IM / 小程序。
- 自建模型网关（不代理模型请求；Phase 2 的 pi-gateway 只是 RPC 传输层）。
- **SSH 远程通道**（v0.3 否决，不排期）。
- MVP 阶段的多设备、断连后台执行、远程文件浏览。

---

## 2. 关键决策

### D1：桌面框架选 Electron（推荐）

| 方案                        | 优势                                                                                                                                                            | 劣势                                                                           | 结论         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------ |
| **Electron + React + Vite** | 主进程即 Node：可直接 `spawn('pi', ['--mode','rpc'])`；官方 RPC 客户端在 main 内使用；Phase 2 的 WebSocket/HTTPS 同语言栈；Windows 打包成熟（electron-builder） | 安装包 100MB+；内存占用较高                                                    | **推荐**     |
| Tauri 2 + React             | 体积小、内存低                                                                                                                                                  | Rust 侧不能直跑 pi 所在的 Node 生态；文件能力与 Phase 2 网关客户端需双语言维护 | 备选，不排期 |
| Web + 本地 server           | 开发最快                                                                                                                                                        | 无原生对话框/托盘/深链，安全边界弱                                             | 不采用       |

**理由（v0.3 修订）**：`SdkTransport` 已作废（远程不适用；in-process 会让 pi 崩溃拖垮窗口），因此选 Electron 的理由改为三条工程事实：(1) pi 是 Node 程序，`child_process` 直跑与版本探测同语言、无桥接层；(2) 主进程可直接实现协议编解码、`FsBridge`、`safeStorage`；(3) Phase 2 的 `wss` 与 TLS/指纹 pinning 仍在同一语言栈，不需要 Rust/Node 双实现。SDK in-process 路径降级为非目标（若将来要做，只能作本地实验特性，不进主线）。

### D2：与 pi 的集成方式 —— 协议统一为 pi RPC JSONL

| 方式                          | 优点                                                                            | 缺点                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| RPC 子进程（`pi --mode rpc`） | 崩溃隔离；与 CLI 共用安装；会话文件天然一致；扩展 UI 有正式子协议；一会话一进程 | 需定位 pi 可执行文件；JSONL 序列化开销；启动百毫秒级          |
| SDK in-process                | 零序列化、最低延迟                                                              | pi 崩溃拖垮窗口；扩展 UI 要宿主自实现；多会话共享进程资源竞争 |

**决策**：唯一协议是 `pi --mode rpc` 的 JSONL。MVP 实现 `LocalConnection`（`child_process`），`PiConnection`/`PiTransport` 接口按 Phase 2 需要定型，但**只写一个实现**；MVP 内不做多实现回归。

### D3：进程粒度 —— 一个会话一个 pi 子进程

理由：`AgentSession` 绑定单一 cwd 与模型状态；进程级隔离让中止/崩溃/重启只影响单任务，契合多任务并行体感。

**资源策略（v0.3 明确）**：默认最多 **3 个活跃 pi 子进程**；超出按 LRU 挂起（关闭 stdin 有序退出，会话已落盘）；空闲 **30 分钟**回收，仅回收 `agent_settled` 的会话。阈值可配置（默认值见 Q3）。

### D4：单一事实来源 —— pi 的 session JSONL（本地）

会话列表、标题、token/成本、历史消息一律以 pi 落盘的 JSONL（`PI_CODING_AGENT_SESSION_DIR` 或 `~/.pi/agent/sessions/`）为准；客户端只存 UI 偏好（窗口位置、栏宽、上次工作目录、主题、pi 可执行文件路径）。禁止并行会话库。Phase 2 下该 JSONL 位于云端，客户端零会话持久化（附录 A.3）。

### D5：需要内置审批扩展，MVP 装在本地

pi 不内置「工具执行前人工确认」，但 RPC 有 `extension_ui_request`/`extension_ui_response` 子协议。方案：分发 `pi-desktop-permission` 扩展，在 `tool_call` 前置钩子对高风险工具（bash / powershell / write / edit / 删除类）发起 `select` 请求，客户端渲染为审批弹窗。

- 安装位置：MVP 装在本机（工作区 `.pi/extensions/` 或全局扩展目录）；Phase 2 必须装在**云服务器**。
- 安全底线：审批超时（默认 120s）与扩展返回 `undefined` 一律视为**拒绝**。

---

## 3. 部署模式

### 3.1 阶段与通道

| 维度     | Phase 1 本地（MVP）   | Phase 2 网关（规划）           |
| -------- | --------------------- | ------------------------------ |
| 通道     | `child_process` stdio | `wss` 多路复用                 |
| 会话文件 | 本地                  | 云端（客户端不落盘）           |
| 文件访问 | 本地 fs（`FsBridge`） | 网关 fs RPC（`RemoteFs`）      |
| 断连行为 | 不适用                | pi 继续跑，客户端可重连续看    |
| 部署成本 | 零（用户本机已装 pi） | 一条命令/一个容器 + 粘贴连接串 |
| 目标用户 | **本版全部用户**      | 长任务 / 多设备用户            |

**SSH 通道：已否决，不排期。** 理由见版本变更记录；如将来有个别高级用户坚持，可作「自担运维成本」的社区实现，不进官方里程碑，也不进测试矩阵。

### 3.2 连接配置模型（MVP 只需 local）

```ts
type ConnectionConfig =
  | {
      kind: 'local'
      id: string
      label: string
      piCommand: string // 默认 'pi'，可填绝对路径（如 C:/tools/pi/pi.cmd）
      sessionDir?: string // 可选，覆盖默认会话目录
      workspaceRoots: string[] // 允许读写/产物展示的根目录
      maxActiveSessions: number // 默认 3
      idleRecycleMinutes: number // 默认 30
    }
  | {
      kind: 'gateway'
      id: string
      label: string // Phase 2
      connectionStringRef: string // safeStorage 引用名，不存明文
      workspaceRoots: string[]
    }
```

约束：配置 JSON 只允许出现 keychain **引用名**；zod schema 拒绝疑似明文密钥字段（`token`/`password`/`secret`/`privateKey` 字面量直接报错并给出字段路径）；renderer 只拿脱敏视图（Phase 2 连接串只显示 host 与指纹前 8 位）。

### 3.3 启动自检（本地，三步）

1. 定位可执行文件：显式配置优先，其次 `PATH` 中的 `pi`（Windows 注意 `pi.cmd`/`pi.exe`/`pi.ps1`，用 `shell:false` + 绝对路径解析，避免 shell 注入）。
2. `<piCommand> --version` → 记录版本；失败给出可操作提示（「PATH 中找不到 pi，请选择 pi 可执行文件」+「浏览…」按钮）。
3. 探测 `--mode rpc` 支持：启动一次子进程并发 `get_state`，收到合法 JSON 记录即通过；首条不是合法 JSON → 判定 `PROTOCOL` 污染（如用户包装脚本打印了 banner），给出诊断但不进入坏状态。

Phase 2 的网关自检见附录 A.2。

---

## 4. 整体架构

### 4.1 MVP 架构（本地）

```text
┌────────────────────────────── Electron ──────────────────────────────┐
│  Renderer (React + Vite, sandbox, no Node)                           │
│  ┌──────────┬────────────────────────┬──────────────────────────┐    │
│  │ TaskList │ Conversation           │ Artifacts / Files        │    │
│  │ (左栏)    │ (消息流 + 步骤时间线)   │ (产物、diff、预览)        │    │
│  └──────────┴────────────────────────┴──────────────────────────┘    │
│        ▲  window.pi (preload contextBridge, 白名单 IPC)               │
├────────┼─────────────────────────────────────────────────────────────┤
│  Main (Node)                                                          │
│  ┌────────────┐  ┌───────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ IpcRouter  │→ │ SessionService│→ │PiConnection│→ │ pi child proc│  │
│  │ (zod 校验)  │  │ (生命周期)     │  │  (Local)   │  │ --mode rpc   │  │
│  └────────────┘  └───────────────┘  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌───────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ ConfigStore│  │ SessionIndex  │  │ FsBridge   │  │ TranscriptLog│  │
│  │ (偏好)      │  │ (JSONL 只读)   │  │ (白名单 FS) │  │ (诊断)       │  │
│  └────────────┘  └───────────────┘  └────────────┘  └──────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                    │ JSONL over stdio (严格按 LF 分帧)
                                    ▼
                    ~/.pi/agent/sessions/**/*.jsonl  (事实来源)
```

Phase 2 在 `PiConnection` 位置插入 `GatewayConnection`，`FsBridge` 旁增 `RemoteFs`，架构图见附录 A.1。

---

## 5. 模块与接口划分

### 5.1 目录结构（MVP）

```text
pi-desktop/
  package.json
  electron.vite.config.ts
  src/main/
    index.ts                       # app 生命周期
    window.ts                      # BrowserWindow 安全配置集中处
    ipc/router.ts                  # ipcMain.handle + zod + 错误规范化
    services/session-service.ts    # 会话生命周期、LRU 与空闲回收
    services/session-index.ts      # session JSONL 只读索引
    services/config-store.ts       # 偏好与连接配置（不含密钥）
    services/fs-bridge.ts          # 本地文件能力（白名单根）
    services/pi-locator.ts         # pi 可执行文件定位与自检
    transport/types.ts             # PiConnection / PiTransport / 记录类型
    transport/local-connection.ts  # MVP 唯一实现
    transport/jsonl-reader.ts      # LF-only 分帧读取器（关键）
  src/preload/index.ts             # contextBridge 暴露 window.pi
  src/renderer/
    app/                           # 路由与布局
    features/tasks/                # 任务列表、新建任务弹层
    features/chat/                 # 消息流、markdown、工具卡片、时间线
    features/artifacts/            # 产物面板、diff、预览
    features/settings/             # 模型、审批策略、pi 路径、主题
    stores/                        # zustand: session/run/artifact
    lib/reducer.ts                 # 事件归约纯函数（重点单测对象）
  src/shared/contracts/            # DTO + zod schema
  tests/unit | integration | e2e
```

Phase 2 追加：`transport/gateway-connection.ts`、`services/remote-fs.ts`、`features/connections/`（见附录 A.4）。

### 5.2 主进程模块职责

| 模块                     | 职责                                                                                                                                         | 不做什么               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `window.ts`              | 创建窗口；`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`；拦截 `will-navigate`、`setWindowOpenHandler` | 不注入 Node 能力       |
| `pi-locator.ts`          | 定位 pi、`--version`、`--mode rpc` 连通性自检                                                                                                | 不解析会话语义         |
| `PiConnection`（Local）  | 启动/停止子进程；`openChannel` 产出一会话一通道；进程退出上报                                                                                | 不做业务状态机         |
| `PiTransport`（Channel） | 写命令、读记录、stderr 环形缓冲（末 200 行）                                                                                                 | 不做业务状态机         |
| `SessionService`         | `create/resume/fork/prompt/abort/dispose`；串行化；LRU 与空闲回收                                                                            | 不解析会话内容         |
| `SessionIndex`           | 只读扫描 JSONL，产出 id/标题/cwd/mtime/token/成本                                                                                            | 不写会话文件           |
| `FsBridge`               | 原生对话框；受限读写（`workspaceRoots` 内）；产物列表与 diff                                                                                 | 不做通用 fs 代理       |
| `ConfigStore`            | 偏好持久化（`userData/config.json`）+ schema 校验 + 迁移                                                                                     | 不存会话内容、不存密钥 |
| `IpcRouter`              | 通道注册、zod 校验、错误码映射、超时                                                                                                         | 不含业务逻辑           |

### 5.3 核心接口

```ts
interface PiConnection {
  readonly id: string
  state(): 'disconnected' | 'connecting' | 'ready' | 'degraded' | 'failed'
  onStateChange(cb: (s: string, info?: unknown) => void): () => void
  openChannel(opts: OpenChannelOptions): Promise<PiTransport>
  dispose(): Promise<void>
}

interface PiTransport {
  readonly channelId: string
  readonly link: 'local' | 'gateway' // Phase 2 增加 'gateway'
  start(opts: {
    cwd: string
    model?: string
    thinkingLevel?: string
    sessionFile?: string
    extraArgs?: string[]
  }): Promise<void>
  send(cmd: RpcCommand, id?: string): void
  onRecord(l: (rec: RpcRecord) => void): () => void
  onExit(
    l: (i: { code: number | null; signal: string | null; stderrTail: string }) => void
  ): () => void
  stop(): Promise<void>
}
```

契约要点：

- `send` 只保证写入；接受与否看匹配 `id` 的 `response.success`。
- 命令支持并发在途，**按 id 关联**，不得依赖响应顺序。
- stdout 只承载协议记录；日志一律 stderr。
- `openChannel` 失败落到通道级错误，不把仍有活跃通道的连接标记为 `failed`（Phase 2 复用）。
- 连接级状态语义：`ready` 表示「至少一个通道活跃且可继续 `openChannel`」（不是终态）；
  `degraded` 表示通道已全部退出但连接仍可用；`failed` 表示一次解析/启动失败且当前无活跃通道，
  可经一次 `connecting` 重试恢复（`failed → ready` 仍然非法，U11）。

### 5.4 IPC 契约（MVP）

统一形态 `invoke(channel, payload) -> Promise<Result<T>>`，`Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; detail?: string } }`。

| 通道                    | 入参                                                                                            | 出参                                                              | 说明                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app:getBoot`           | `{}`                                                                                            | `{ config, piStatus, lastCwd? }`                                  | 启动态聚合，减少往返                                                                                                         |
| `pi:locate`             | `{ path? }`                                                                                     | `SelfCheckResult`                                                 | 定位/自检 pi                                                                                                                 |
| `session:list`          | `{ cwd?, cursor? }`                                                                             | `{ items, nextCursor }`                                           | 读 SessionIndex                                                                                                              |
| `session:history`       | `{ sessionFile, maxRecords?, allowMissing? }`                                                   | `{ records, truncated, totalRecords, messageCount, fileAbsent? }` | **M3 补充**：只读回放 JSONL；**M4**：`maxRecords` 默认 2000；**M4 复核**：`allowMissing`（仅 fork 编排）= 文件未落盘按空会话 |
| `session:create`        | `{ cwd, model?, name? }`                                                                        | `{ sessionKey, sessionId }`                                       | 启动子进程                                                                                                                   |
| `session:resume`        | `{ sessionFile }`                                                                               | `{ sessionKey }`                                                  | 恢复既有会话                                                                                                                 |
| `session:fork`          | `{ sessionKey, entryId? }`                                                                      | `{ sessionKey }`                                                  | **M4 修订**：`entryId` = 用户消息 entry（`messageId` 保留为同义别名）                                                        |
| `session:prompt`        | `{ sessionKey, message, images?, streamingBehavior? }`                                          | `{ disposition }`                                                 | busy 时必带 `streamingBehavior`                                                                                              |
| `session:abort`         | `{ sessionKey }`                                                                                | `{ ok: true }`                                                    | 中止并等 idle                                                                                                                |
| `session:dispose`       | `{ sessionKey }`                                                                                | `{ ok: true }`                                                    | 释放子进程                                                                                                                   |
| `session:state`         | `{ sessionKey }`                                                                                | `AgentState`                                                      | models/thinkingLevel/队列/成本                                                                                               |
| `session:stats`         | `{ sessionKey }`                                                                                | `SessionStats`                                                    | **M4 补充**：pi `get_session_stats`（token/成本/上下文用量）                                                                 |
| `session:forkPoints`    | `{ sessionKey }`                                                                                | `{ points: {entryId,text}[] }`                                    | **M4 补充**：pi `get_fork_messages`（可分叉点）                                                                              |
| `model:list`            | `{}`                                                                                            | `ModelInfo[]`                                                     | provider/model/cost                                                                                                          |
| `model:set`             | `{ sessionKey, model, thinkingLevel? }`                                                         | `{ ok: true }`                                                    |                                                                                                                              |
| `models:read`           | `{}`                                                                                            | `ModelConfigView`                                                 | **A14**：读 pi 的 `models.json` + `settings.json#defaultModel`；apiKey 只返回 `hasApiKey`/`apiKeyHint`                       |
| `models:setDefault`     | `{ modelId: string \| null }`                                                                   | `ModelConfigWriteResult`                                          | **A14**：写入默认模型；`null` = 清除该键（恢复 pi 自动选择）                                                                 |
| `models:upsertProvider` | `{ id, name?, baseUrl?, api?, apiKey?, models? }`                                               | `ModelConfigWriteResult`                                          | **A14**：新增/编辑 provider；`apiKey` 省略 = 保留、`''` = 清除                                                               |
| `models:removeProvider` | `{ id }`                                                                                        | `ModelConfigWriteResult`                                          | **A14**：删除 provider 整段                                                                                                  |
| `models:upsertModel`    | `{ providerId, model }`                                                                         | `ModelConfigWriteResult`                                          | **A14**：新增/编辑单个模型                                                                                                   |
| `models:removeModel`    | `{ providerId, modelId }`                                                                       | `ModelConfigWriteResult`                                          | **A14**：删除单个模型                                                                                                        |
| `config:update`         | `{ piCommand?, sessionDir?, workspaceRoots?, maxActiveSessions?, idleRecycleMinutes?, theme? }` | `AppConfigView`                                                   | **M4 补充**：偏好持久化（拒疑似密钥字段）                                                                                    |
| `extui:respond`         | `{ sessionKey, requestId, response }`                                                           | `{ ok: true }`                                                    | **M5**：回 `extension_ui_response`；`response` 收窄为 `{kind:'select',value}` / `{kind:'cancel'}`                            |
| `permission:status`     | `{}`                                                                                            | `PermissionStatus`                                                | **M5 补充**：审批扩展安装/协议状态（只读）                                                                                   |
| `fs:pickWorkspaceFile`  | `{ sessionKey, defaultPath? }`                                                                  | `{ canceled, path?, relative? }`                                  | **A22**：选工作区内文件，主进程判定边界，返回 POSIX 相对路径；取消返回 `canceled:true`（非错误）                             |
| `fs:pickDirectory`      | `{ defaultPath? }`                                                                              | `{ path }`                                                        | 原生对话框                                                                                                                   |
| `fs:listArtifacts`      | `{ sessionKey?, sessionFile? }`                                                                 | `ArtifactList`（M6）                                              | 工作区变更列表；**M6**：会话引用二选一，出参包上 `mode/truncated/totalCount/note`                                            |
| `fs:readText`           | `{ path, maxBytes?, offset?, sessionKey?, sessionFile? }`                                       | `ReadTextResult`（M6）                                            | **M6**：默认前 64KB、`offset` 分页、二进制标记；路径必须在会话工作区（或主进程已知根）内                                     |
| `fs:diff`               | `{ path, sessionKey?, sessionFile? }`                                                           | `UnifiedDiff`（M6）                                               | **M6**：git 走 `git diff`（暂存+未暂存），非 git 走快照比对合成；上限 2MB 显式截断                                           |
| `artifact:open`         | `{ path, sessionKey?, sessionFile? }`                                                           | `{ ok: true }`                                                    | **M6**：`shell.openPath`（**不是** `openExternal`）打开前校验工作区与文件存在性，并记审计                                    |

事件（main → renderer）：

| 通道             | 载荷                                                                           | 频率策略                         |
| ---------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `evt:record`     | 归一化会话事件                                                                 | 逐条；`text_delta` 合并窗口 16ms |
| `evt:extui`      | `extension_ui_request`                                                         | 逐条，需立即响应                 |
| `evt:status`     | `{ sessionKey, status }`（`starting / running / settled / exited / recycled`） | 状态变更                         |
| `evt:diagnostic` | stderr 尾部、崩溃信息                                                          | 变更时                           |

**`fs:*` 路由（补齐 v0.2 缺口）**：MVP 全部由 `FsBridge` 处理且只接受本地路径；Phase 2 按连接 `kind` 分流（local → `FsBridge`，gateway → `RemoteFs`），路由判断集中在 `services/fs-router.ts`，不在 IPC 层散落分支。

**M3 通道补充说明**（实现时发现 §6.1 第 4 步「选中历史会话只回放 JSONL 到 UI，不启动子进程」缺少对应通道）：

1. `session:history` 是**只读**通道，不碰 M2 协议层：主进程读会话 JSONL 尾部（上限 50MB，§7 约束 14）并把 `{type:'message'}` 条目归一成与 `evt:record` 同形的 `message_end` 记录，交给 `lib/reducer.ts` 同一套归约；路径必须落在会话根目录内（`PATH_DENIED` 兜底）。
2. 错误码新增 `CANCELLED`：`fs:pickDirectory` 用户取消时返回它，renderer 静默忽略（不是错误，不进错误条）。
3. `fs:pickDirectory` 在 M3 实现（原生目录对话框）；`fs:listArtifacts` / `fs:readText` / `fs:diff` / `artifact:open` / `extui:respond` 仍在 M5/M6，未注册处理器统一回 `NOT_IMPLEMENTED`。

**M4 通道补充说明**（实现时发现「token/成本展示、分叉点、设置持久化」缺通道）：

| 新通道               | 用到的 pi 命令 / 能力                  | 必要性                                                                        | 安全影响                                                                                                                                                     |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session:setName`    | `{ sessionKey? , sessionFile?, name }` | `{ ok: true }`                                                                | **A23**：改会话显示名；活跃会话走 RPC `set_session_name`，历史任务追加 `session_info`（只 append）                                                           |
| `session:stats`      | `get_session_stats`                    | §8.1 M4 要求展示会话级 token/成本；`get_state` 不含 usage，客户端不得自行估算 | 只读命令；不读本地文件、不涉密钥                                                                                                                             |
| `session:forkPoints` | `get_fork_messages`                    | 分叉必须拿到用户消息 `entryId` 才能指定分叉点                                 | 只读命令；只返回 entryId + 文本                                                                                                                              |
| `config:update`      | 无（本地 ConfigStore）                 | 设置页需要写偏好；M1–M3 的 config 是只读默认值                                | 写前 zod `.strict()` + 疑似密钥名模式校验（token/password/secret/apikey/credential/private），只落 `userData/config.json` 偏好字段（§7 约束 9/12、§9.1 U14） |

三条都不引入新的外部攻击面：`session:stats` / `session:forkPoints` 复用既有 `sessionKey` 白名单与 SessionService 串行化；`config:update` 的字段全集由 schema 枚举，未知字段与疑似密钥一律 `VALIDATION`。

**`session:history` 的 M4 修订**：`maxRecords` 默认 2000（可配置），超出只回尾部并显式 `truncated: true` + 给 `totalRecords`；路径校验在词法收敛后用 `fs.realpath` 再校一次前缀（修 junction / 符号链接逃逸，§7 约束 8）。

**M4 复核修复（2026-11-20，B1/B2）**：

1. **B1：fork 首条用户消息 = 空会话、文件懒落盘。** pi 从第一条用户消息 fork 时 `targetLeafId = null` → `newSession({parentSession})`，新会话文件要等**下一条 prompt** 才写盘。因此 `session:history` 新增 `allowMissing`（只有 fork 编排传 `true`）：文件不存在时返回 `{ records: [], fileAbsent: true }`，renderer 按空会话处理并给出可操作信息条（不再误报 `PATH_DENIED`）。
   **安全语义不变**：词法闸照旧，`fs.realpath` 失败时只有 **ENOENT** 且**父目录真实路径仍在会话根内**才按空会话返回；junction / 符号链接逃逸、权限错误、父目录不可信、父目录在根外一律 `PATH_DENIED`（`resolveSessionPath` / `resolveRealSessionPath` 的 fail-closed 语义未被放宽）。
   UI 侧 `session:forkPoints` 的选择器在选中**第一条**用户消息时显式提示「会得到一个空会话」。
2. **B2：回放走批量归约。** `sessionStore.replay()` 由逐条 `reduceRecord` 改为 `reduceRecords`（写前拷贝 + 懒建索引的单游标）：20k 条实测 8,296ms → **11.1ms**。`tests/unit/reducer-perf.test.ts` 的性能断言**改测真实回放入口 `replay()`**（保留批量路径断言），并新增「批量 === 逐条 === replay」等价性回归（含 `message_end` 权威覆盖、重复 key、乱序工具卡片、乐观用户消息替换）。

**分叉语义（M4 核实结论，依据 docs/rpc-commands.md#fork、docs/sessions.md）**：

1. `fork {entryId}` 的 `entryId` 是**用户消息** entry 的 id（由 `get_fork_messages` 给出），pi **不支持**从 assistant 消息处 fork；§8.1 的「从某条 assistant 消息处 fork」按此修正为「从某条用户消息处 fork」。
2. RPC fork 后**同一个 pi 进程**切到新会话，客户端必须移交会话句柄：旧 `sessionKey` 释放（再调用回 `SESSION_NOT_FOUND`），新 `sessionKey` 接管同一 transport；renderer 侧原任务降级为「只读回放」，新任务用新 `sessionKey` 继续。
3. 新会话由 pi 另存为新 JSONL（header 带 `parentSession`），**原会话文件字节不变**（A4）。
4. 不带 `entryId` 时走 CLI `--fork <sessionFile>`，新起进程复制整条分支（同样不改原文件）。
5. **从第一条用户消息 fork 会得到空会话**（`targetLeafId = null`）：新会话文件懒落盘，直到下一条 `prompt` 才存在。这是 pi 的既定行为（真实 pi 1.5.2 已验证），客户端按 B1 的空会话容错处理；`tests/integration/real-pi-fork.test.ts` 在 `PI_DESKTOP_REAL_PI=1` 下对真实 pi 断言该行为与 A4 字节不变。

**M5 通道补充说明（审批，§6.3 / §8.1 M5）**：

| 新增/变更                      | 用到的能力                 | 必要性                                             | 安全影响                                                                                                                                                                                               |
| ------------------------------ | -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extui:respond`（实现 + 收窄） | pi `extension_ui_response` | §6.3 审批链路回包；M3 时只占位 `response: unknown` | **只认当前通道的未决 requestId**：主进程按 `sessionKey + requestId` 登记（`services/extui-registry.ts`），伪造 / 跨会话 / 通道已换 / 选项不在清单 → `REQUEST_NOT_FOUND` + `evt:diagnostic`（§9.4 S9'） |
| `permission:status`            | 本地文件探测（无 pi 调用） | 设置页需要如实显示「扩展装没装 / 是否落后于源」    | 只读：不执行任何东西、不返回内容，只回路径 / 版本 / 协议号                                                                                                                                             |

#### 「起始模式」= pi 的工具选择（A17，v0.4 修订）

客户端新建任务弹层里的「起始模式」**不是** pi 的 `--mode`（那是输出接口：`text` / `json` / `rpc`，客户端固定 `rpc`），也不是 WorkBuddy 的「办公 / 编程 / Plan 模式」——pi 没有会话级操作模式的概念。它在 pi 侧唯一有对应物的机制是**工具选择**（`docs/cli.md`）：

| 模式           | 客户端下发                                   | 效果                                                           |
| -------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `full`（默认） | 不加参数                                     | pi 默认工具集（`read` / `bash` / `edit` / `write` + 扩展工具） |
| `readonly`     | `--exclude-tools write,edit,bash,powershell` | 只能读 / 搜索 / 列目录；保留扩展工具                           |
| `no-tools`     | `--no-tools`                                 | 全部内置与扩展工具关闭，纯问答                                 |

用 **denylist** 而不是 allowlist：`--tools read,grep,find,ls` 会把用户安装的扩展工具一并关掉，而「只读」的意图只是「不写文件、不执行命令」。

两条如实记录的局限：① pi 的 `get_state` 不返回已启用工具列表，客户端**无法**在 UI 回显「实际生效的工具集」，只能保证启动参数正确；② `--tools` / `--exclude-tools` 只在 **spawn 时**生效，会话内无法改（RPC 没有 set_tools），所以这项只能放在「新建任务」而不是运行中的工具栏。

「办公 / 编程」这类预设属于 `AGENTS.md` / skills / extensions 范畴（不是启动参数），**不做假开关**。

#### 「会话身份 agent」（A18，v0.5）

新建任务可以选一个 agent，让它带着**自己的 system prompt / 模型 / 工具 / 规则**开始会话（`--agent <name>`）。两个必须知道的事实：

1. **`--agent` 不是 pi core 的参数**，而是 `pi-open-agents` 扩展注册的启动 flag。扩展没装时传它 → pi 直接 `Error: Unknown option: --agent` 起不来。因此客户端先跑一次 `pi --help` 探测（60s 缓存），**探测不到就不显示选择器**。
2. **非法名字会被静默忽略**：`pi --agent nosuchagent` 照常启动并回落到默认模型，不报错。所以客户端用自己的扫描结果白名单校验名字（`agents:list` + `handler` 里的 `has()`），UI 不提供手打入口。

**目录扫描**（只读，project 覆盖 global 同名）：`<agent-dir>/agents/**/*.md`、`<workspace>/.pi/agents/**/*.md`、`<workspace>/.agents/agents/**/*.md`；跳过 `.chain.md`（那是 workflow 链）。`name` 取 frontmatter，缺省用文件名。列表里带 `scope`（global/project）与 `description`，供选择器显示。

**与「起始模式」的关系**：两者独立。agent 决定「谁来思考」（prompt/模型/工具集），起始模式决定「工具白名单」；同时选时参数都下发，冲突以 pi 的实际解析为准（例如 agent 自带 `tools` 时，`--exclude-tools` 仍在其之后生效）。

**子 agent（subagent）不是这个**：subagent 由 `pi-subagents` 扩展在会话**内部**派生（工具调用），子会话记录写在 `sessions/<cwd-key>/subagents/*.jsonl`（带 `parentSession`）；客户端只回放父会话 JSONL，因此看得到「调用了 subagent 的工具卡片」，看不到子会话的中间过程。

#### 粘贴图片（A19，v0.6）

对话框支持直接把截图粘进来（截图工具 → `Ctrl+V`）。

- 渲染层：`onPaste` 检查 `clipboardData.items` 里有没有 `image/*`；有就 `preventDefault` 并读成 **data URL**（纯文本粘贴仍走 textarea 默认行为，不会被拦）。
- 规则（`lib/images.ts`，纯函数可单测）：只收 `png/jpeg/webp/gif`；单张 ≤ 8MB；每条消息 ≤ 4 张；超限/类型不符会**显式提示原因**（一次 Ctrl+V 静默失败最难排查）。
- 传输：`session:prompt` 的 `images` 是 **data URL 数组**（不是裸 base64，主进程 `toImageContent` 按 `data:image/...;base64,` 解析并校验）。`message` 允许为空——**只有图片、没有文字也能发**（`superRefine` 保证两者不能同时为空）。
- 界面：缩略图条 + 单张移除；发送后清空，不会污染下一条消息。

#### 拖拽图片与客户端压缩（A20，v0.7）

- **拖拽**：把图片文件拖到输入区即可（`dragover` 时整块高亮）。`dataTransfer` 里没有图片文件时不拦截，拖文本/链接仍走浏览器默认行为。
- **窗口级兜底**：Electron（Chromium）默认会把窗口**导航到掉落的文件**，拖错位置就白屏。因此 `App` 在 `window` 上统一 `preventDefault` 掉含 `Files` 的 `dragover`/`drop`（只阻止，不处理）。
- **客户端压缩**：pi 自己会把图片重编码到 2000×2000 / 4.5MiB(base64) / JPEG q80，但那发生在图片已经进了会话之后。客户端先压一次的价值是 IPC 更小、会话 JSONL 更小、首 token 更快。规则保守且可解释：
  - 长边 ≤ 2000 且原始 ≤ 2MB → **原样发送**（不重编码，保住画质与透明通道）；
  - 否则等比缩放到长边 2000，先试 PNG（保透明），仍超标才退化到 JPEG q0.85 → q0.7；
  - 缩略图标注「已压缩」，`title` 里给原图尺寸与体积（用户能判断画质是否被牺牲）。
- 8MB 是**硬上限**（超过直接拒绝并说明原因），2MB 是**压缩阈值**，两者是不同的事。

#### 修改任务名称（A23，v0.9）

**两条路径落盘效果等价（实测）**：拷一份 2200 行的会话，跑 `pi --mode rpc --session <copy>` + `set_session_name`，结果只多**一行** `session_info`，形状为
`{"type":"session_info","id":"<8位十六进制>","parentId":"<最后一条记录的 id>","timestamp":"...","name":"..."}`。
也就是说 RPC 路径**并没有**额外的副作用 —— 它写的就是这条记录。因此历史任务不需要为了「统一」而额外起一个 pi 进程：直接追加同形记录即可，落盘结果一致、且零启动开销、不会把任务临时变成「活跃」。

为了让两者**逐字节同形**，追加路径也接 `parentId = 最后一条记录的 id`、`id` 用 8 位十六进制（早期实现写的是 `parentId: null` + 12 位，属于实现偏差，已修）。

**pi 的会话名不是文件头字段**，而是会话 JSONL 里的一条 `session_info` 记录（`docs/session-format.md`；由 `/name`、`--name` 或扩展 `setSessionName()` 写入）。因此两条路径：

| 场景             | 做法                                                        | 为什么                                                                |
| ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 活跃会话         | RPC `set_session_name`，pi 自己落盘                         | 与 TUI 里 `/name` 完全一致                                            |
| 历史（回放）任务 | **追加**一条 `session_info`（`id/parentId/timestamp/name`） | 进程已不在；只 append、不改旧行 —— 最坏情况是多一行记录，不会损坏会话 |

安全与边界：历史路径要求文件是 `.jsonl` 且**在本地会话索引里**（我们用「索引里列出的文件」作授权依据，而不是比对会话根字符串 —— 会话目录可被 `PI_CODING_AGENT_SESSION_DIR` 改变，根字符串比对在真实环境里会误判，这正是「改名无法保存」的成因）。renderer 侧还有一条兜底：任务被标成 live 但子进程已回收（`SESSION_NOT_FOUND`）时，自动改用会话文件路径重试一次。`SessionIndex` 已经在读 `session_info.name`（优先于首条用户消息），所以改完刷新列表即生效，不需要额外状态。

UI：任务标题**双击**进入编辑，`Enter` 保存、`Esc` 取消；失败保持编辑态并报错。刻意**不在失焦时关闭** —— 双击的第二下会立刻让输入框失焦，否则「刚出现就被关掉」。

#### 消息里的图片与文件引用（A21/A22，v0.8）

**默认工作目录 = 用户主目录（v0.8.1 修复）**

之前 `app:getBoot.lastCwd` 与目录对话框的默认位置都是 `process.cwd()`（主进程启动目录）：从快捷方式启动时那是安装目录，从终端启动时是终端里的当前目录 —— 两个都不是用户想要的「默认工作区」。现在：

- `app:getBoot.lastCwd` / 无默认值的 `fs:pickDirectory` → **用户主目录**（`os.homedir()`）；
- 新建任务弹层的目录输入框**保持为空**（未选目录不能提交），但点「选择目录」时从**选中任务的工作区**打开；没有选中任务时交给主进程用主目录兜底；
- 「引用文件」的边界根按会话引用解析：活跃会话用 `sessionKey`→cwd，历史（回放）任务用 `sessionFile`→会话索引里该 JSONL 的 cwd，**都不退回进程启动目录**；
- 历史会话 header 缺 `cwd` 时索引里是空串，renderer 视为「未知」而不是当成合法工作区。

**A21 图片缩略图**：用户消息里的图片在对话中显示为缩略图，点击打开应用内查看器（点遮罩/点关闭/`Esc` 三种方式都能退，多图可用左右键切换）。图片在会话里的形态是 pi 的内容块 `{type:'image', data, mimeType}`，归约时统一转成 **data URL**（与 `session:prompt` 的 images 约定一致），实时与历史回放走同一条路径。一个实现细节：乐观消息被权威 `message_end` 替换时，若权威消息没有图片块（上游/夹具只回显文本），**保留本地已发送的图片** —— 否则「发了截图，回显时图没了」。

**A22 引用工作区文件**：输入框的「引用文件」按钮选一个文件，把**工作区相对路径**插进消息。

- **文件与文件夹分成两个动作**（「引用文件」/「引用文件夹」）。原因是 Electron 的平台限制（其类型文档原文）：`On Windows and Linux an open dialog can not be both a file selector and a directory selector, so if you set properties to ['openFile','openDirectory'] on these platforms, a directory selector will be shown.` —— v0.9.2 想「一个按钮两用」，结果在 Windows 上只剩目录选择器。现在按 `kind` 二选一：`['openFile']` / `['openDirectory']`。
- 为什么不是 `@path`：pi 的 `@file` **只在 CLI 解析**，`docs/cli.md` 明确写着「RPC mode rejects `@file` arguments」。所以客户端不能假装 `@` 语法能附文件；插入相对路径、让模型用自己的 `read` 工具去读，是 RPC 集成下唯一真实可行的引用方式。
- 边界由主进程判定：用户可以在原生对话框里导航到工作区外，renderer 无权决定「这算不算本任务的文件」。主进程用会话的 `workspaceOf(sessionKey)` 取根，`realpath` 两侧归一后判前缀，越界直接 `VALIDATION`（与 §5.4 路径校验同一套规则）。
- 取消不是错误：返回 `canceled: true`，UI 静默忽略（不弹红条）。

**M5 审批的三个语义点（已在实现层钉死）**：

1. **执行前同步询问**：pi 的 `tool_call` 事件在工具执行**之前**触发，返回 `{block:true, reason}` 即阻止执行（`docs/extensions.md#tool_call`）。这不是事后审计。
2. **单一审批时钟**：120s 由扩展侧权威判定（`ctx.ui.select(..., {timeout})` 超时返回 `undefined` → 拒绝）。客户端把请求里的 `timeout` **减去固定提前量**（默认 500ms）先手回 `cancelled`，结果与扩展侧一致（都是拒绝），不构成第二套时钟。
3. **协议协商**：扩展在 `session_start` 用 `setStatus`（fire-and-forget）上报 `{ext, version, protocol, enabled, tools, timeoutMs, compatible}`；客户端比对 `PERMISSION_PROTOCOL_VERSION`，不兼容时**显式告警 + 自动拒绝**该会话的审批请求（不弹窗、不静默放行）。

**策略下发方式**：设置页的审批策略（是否开启 / 工具清单 / 时钟）由客户端 spawn pi 时以环境变量 `PI_DESKTOP_PERMISSION`（单行 JSON）注入，扩展读取后生效（`services/permission-extension.ts#buildPermissionPolicyEnv`）。不写扩展目录里的配置文件，避免出现第二个写入方。

**M6 通道补充说明（产物，§6.1 / §8.1 M6）**：

四条通道的**入参都只带「会话引用 + 工作区相对路径」，不带工作区根**。根由主进程推导（`sessionKey` → `SessionService.workspaceOf`；`sessionFile` → 会话 header 的 `cwd`，路径先按会话根校验），因此 renderer 无法指定任意目录（§9.4 S6 等价项）。

| 新增/变更                                                                                                       | 必要性                                                                                                       | 安全影响                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 会话引用 `{ sessionKey? , sessionFile? }`（互斥）扩展到四条通道                                                 | §5.4 只给了 `sessionKey`，但右栏产物面板还要服务**已回放的历史任务**（没有子进程，只有会话文件）             | 引用不是根：主进程按自己的事实（SessionService / 会话 header）推导根；两者同时传 → `VALIDATION`       |
| `fs:listArtifacts` 出参由 `ArtifactEntry[]` 变为 `ArtifactList`                                                 | 需要显式告知「git / 快照」模式、`truncated`（上限 1000）、`totalCount` 与说明文案（§7 约束 14 不得静默截断） | 只读；条目路径一律工作区相对（POSIX）                                                                 |
| `ArtifactEntry` 增加 `renamed` / `oldPath` / `untracked` / `binary`                                             | 重命名的 diff 需要旧路径信息（任务书允许按文档补字段）；未跟踪与二进制需要 UI 区别对待                       | 字段是路径与布尔，不含内容                                                                            |
| `fs:diff` 出参增加 `truncated` / `mode` / `change` / `oldPath` / `binary` / `note`                              | 2MB 上限要显式标注；二进制不能假装是文本补丁；快照未保留原始内容时必须如实说明                               | 补丁最大 2MB，按行截断 + 显式提示                                                                     |
| `fs:readText` 出参增加 `binary` / `sizeBytes` / `offset`；`maxBytes` 变为可选（默认 64KB，服务端再夹一次 64KB） | 任务要求默认 64KB + `offset` 分页；二进制文件必须走「系统程序打开」而不是乱码渲染                            | 单次读取 ≤ 64KB；UTF-8 严格解码 + NUL 探测                                                            |
| `artifact:open` 改走 `shell.openPath` 并记审计                                                                  | `openExternal` 对本地路径语义不对（会交给 URL 处理器），且返回值不可观测                                     | 打开前：同一套路径校验 + `stat().isFile()`；审计只记 `action/target(相对)/outcome/code`，**不记内容** |
| 错误码新增 `NOT_FOUND` / `OPEN_FAILED`                                                                          | 区分「路径越权」与「文件不存在」/「系统打不开」（可操作提示不同）                                            | 只读错误码，不泄露路径内容                                                                            |

**M6 的路径校验（唯一入口 `services/path-guard.ts`，§7 约束 8）**：

1. **词法闸**：NUL / 控制字符 / UNC（`\\server\share`）与设备命名空间（`\\?\`、`\\.\`）/ NTFS 备用数据流（`file.txt:stream`）/ `..` 段 / 以点或空格结尾的段（Windows 会静默剥离）/ Windows 保留设备名（`CON`、`nul.txt`、`com1.log`）——任一命中即 `PATH_DENIED`。
2. **词法根闸**：`path.resolve` 后必须在根内（Windows 大小写与分隔符归一）。
3. **真实路径闸**：`fs.realpath` 归一后再判前缀。工作区内**指向工作区内的符号链接 / junction 放行**，指向根外的一律拒绝（否则第二闸形同虚设）。
4. 「不存在」的处理：默认 `NOT_FOUND`；只有调用方声明 `allowMissing`（读已删除文件的 diff）时，且**父目录真实路径仍在根内**才放行——其他任何 realpath 失败（EACCES 等）保持 fail-closed。
5. **多根白名单**（`fs:readText` / `artifact:open` 没有会话上下文、只给绝对路径时）：根集合 = 活跃会话 cwd ∪ 解析过的历史会话 cwd ∪ 配置 `workspaceRoots`，**全部由主进程推导**；集合为空则拒绝并提示「先选择任务」。

**M6 的两条产物链路（§6.1 产物流实现事实）**：

| 环节            | git 工作区                                                                                                                                      | 非 git 工作区                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 探测            | `git rev-parse --show-toplevel`（cwd = 会话工作目录，`execFile` + `shell:false`）                                                               | 探测失败 / 非仓库 → 回退，并在 `note` 里说明原因（不静默降级）                                                    |
| 列表            | `git --no-optional-locks status --porcelain=v1 -z --untracked-files=all`                                                                        | 会话开始快照 → 重扫比对（`size + mtime + 前 1MB sha1`）                                                           |
| 工作区 ≠ 仓库根 | 只保留工作区内的条目，路径换算成工作区相对（其余不显示）                                                                                        | —                                                                                                                 |
| diff            | `git diff --cached`（HEAD→index）+ `git diff`（index→worktree）按序拼接：**已暂存与未暂存都覆盖**，且不要求仓库有提交（`git diff HEAD` 做不到） | 用快照保留的内容合成 `git diff` 同形补丁（`unified-diff.ts`，公共前后缀裁剪 + LCS，规模超预算退化为整段替换）     |
| 重命名          | `git status -z` 的 `R` 条目（实测**新路径在前、旧路径在后**）；diff 用 `--find-renames` + 新旧两条 `:(literal)` pathspec                        | 不支持重命名识别（按「删除 + 新增」呈现：快照比对没有相似度信息）                                                 |
| 未跟踪文件      | `git diff` 对它为空 → 由文件内容合成「新增文件」补丁                                                                                            | 同左（快照里就是 added）                                                                                          |
| 上限            | 列表 1000 条；单文件补丁 2MB（按行截断 + 显式提示）                                                                                             | 同左；另外：快照最多 5000 文件 / 深度 8 / 5s、单文件内容保留 ≤ 256KB（总计 ≤ 32MB），超限 `note` 写「快照不完整」 |

**快照语义（避免误读，与 git 一致）**：基线是**会话开始那一刻**。会话期间新增又删除的文件在两个时点都不存在 → 不会出现在列表里（git 下未跟踪文件同理）。只 `touch` 不`改内容 → 通过 sha1 复核判为「未变化」（不误报）。符号链接不跟随（既防逃逸也防环）：判定走 **`lstat`**（只看链接本身、不解析目标），`readdir`的 dirent 与`lstat`双重把关以覆盖 TOCTOU 窗口；链接/目录等非普通文件不计入`files`，只累加到 `skippedSymlinks`/`skippedNonRegular`，且**不会**把快照标记为不完整（`tests/unit/workspace-snapshot-links.test.ts`、`workspace-snapshot-lstat.test.ts`）。

**触发时机（不轮询）**：只有 `evt:status=settled`（renderer 收到后调一次）与用户点「刷新」。会话 `starting` 时 main 侧顺带建立基线快照（非 git 工作区才做，异步不阻塞会话创建）；若某次扫描时基线还没建立，会补建并在 `note` 里显式说明「此前的变更不可见」。

### 5.5 渲染进程模块

| 模块                           | 职责                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `stores/sessionStore`          | 会话元数据、选中会话、消息树（按 branch）                                                                     |
| `stores/runStore`              | `idle / streaming / tool_running / awaiting_approval / settling`                                              |
| `stores/artifactStore`         | 产物列表与选中产物（M6：按 taskId 分桶 + diff/预览缓存 + 显式 scanning/loading/error 位）                     |
| `lib/reducer.ts`               | 纯函数 `(state, record) => state`：拼接 delta，`message_end` 用权威消息整体替换                               |
| `lib/artifact-actions.ts`      | M6 产物编排：列表扫描（settled / 手动刷新）、按需拉 diff/预览、确认后调 `artifact:open`                       |
| `features/chat/ToolCard`       | 工具名、参数摘要（可展开）、耗时、状态、输出前 N 行 + 展开                                                    |
| `features/chat/Timeline`       | 按 assistant turn 分组的时间线；**按轮窗口化渲染**（只挂载视口 + 上下文缓冲，见 `lib/use-virtual-timeline`）  |
| `lib/virtual-window.ts`        | 虚拟滚动纯计算：槽位几何 / 窗口范围 / 滚动锚点补偿 / 按会话隔离的高度缓存（A7 方案 A）                        |
| `lib/use-virtual-timeline.ts`  | 虚拟滚动状态机：测量后缓存高度、跟随底部、回底/跳转到某轮、会话切换重置                                       |
| `lib/virtual-bridge.ts`        | 非可视观测钩子 `window.__piDesktopVirtual`（挂载/总轮数等计数，供压测与 E2E，不含消息内容）                   |
| `features/artifacts/DiffView`  | unified diff 着色、按文件折叠（补丁内容只作为 React 文本节点渲染，无 HTML sink）                              |
| `features/artifacts/Artifacts` | M6 右栏：变更数量徽标、非 git 说明、预览/diff 切换、「系统程序打开」二次确认                                  |
| `features/settings`            | 模型/provider、推理档位、审批策略、pi 路径、主题（M4：可编辑并持久化到 ConfigStore，pi 路径含三步自检可视化） |
| `features/tasks/NewTaskDialog` | M4 新建任务弹层：目录（必填）/ 模型 / 推理档位 / 会话名 / 起始模式（M4 仅对话模式）                           |

---

## 6. 数据流

### 6.1 启动

1. `app.whenReady` → 读 ConfigStore → 建窗 → 载 preload。
2. Renderer 调 `app:getBoot`；若未配置 pi 或自检失败，直接进入「定位 pi」引导。
3. `session:list` 返回最近会话摘要（默认按 mtime 倒序，首屏 20 条）。
4. 选中最近会话时**只回放 JSONL 到 UI，不启动子进程**；首次发送消息才 `session:create/resume`。

### 6.2 单轮对话

```text
用户输入 → 乐观插入 user 消息
  → invoke 'session:prompt'（busy 时带 streamingBehavior）
  → IpcRouter 校验 → SessionService → transport.send({type:'prompt',...})
  → response(prompt, disposition = started | queued | handled)
       · handled → 扩展命令，本轮不等待 settled
  → message_update / tool_execution_* / message_end / ...
  → JsonlReader 按 LF 切分 → transport.onRecord
  → IpcRouter 合并 text_delta(16ms) → evt:record → reducer → 渲染
  → message_end 用权威消息覆盖增量
  → agent_settled → runStore=idle，刷新 SessionIndex（token/成本/标题）
```

**关键约束**：`prompt` 的成功只表示已接受/已排队/已被扩展处理；「完成」只认 `agent_settled`。

### 6.3 工具审批

```text
pi: tool_call 前置钩子（pi-desktop-permission 扩展，本地安装）
  → extension_ui_request{kind:'select', options:[允许一次/本会话允许/拒绝]}
  → evt:extui → 审批弹窗
  → 用户选择 → extui:respond → extension_ui_response
  → 扩展放行或拒绝
超时 120s → 发送拒绝并提示；会话销毁 → 对所有未决请求发送拒绝
```

**超时语义统一（补齐 v0.2 缺口）**：全系统只有**一个**审批时钟 120s，由扩展侧权威判定，客户端只做同值倒计时展示；v0.2 里断连期间另设的 60s TTL 已移入附录 A（Phase 2 才存在，且与主时钟同源，不构成第二套语义）。

**M5 实现事实（与上图逐条对应）**：

| 环节            | 实现位置                                                                 | fail-closed 行为                                                                             |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 前置钩子        | `src/extensions/permission/index.ts`（`pi.on('tool_call')`）             | 无 UI / 超时 / `undefined` / 未知选项 / 抛异常 / 未知工具名 → 一律 `{block:true}`            |
| 请求形状        | 同上（`ctx.ui.select`，`timeout` = 策略时钟）                            | 人类文本 + 末行机器元数据（`pi-desktop-permission/v1 {...}`），客户端按 `choices` 下标取选项 |
| 事件转发        | `SessionService.handleRecord` → `evt:extui`                              | 同时把 `requestId + channelId` 登记进 `extui-registry`                                       |
| 弹窗            | `renderer/lib/approval.ts` + `features/chat/ApprovalDialog`              | 纯文本渲染（不走 HTML），参数已脱敏 / 截断                                                   |
| 回包            | `extui:respond` → `SessionService.respondExtUi`                          | 只接受登记过的 `requestId` + 当前通道 + 选项内取值                                           |
| 超时            | 扩展侧 120s（权威）；客户端 `timeout - 500ms` 先手 `cancelled`           | 两者结果一致：拒绝                                                                           |
| 会话销毁 / 退出 | `SessionService.denyPendingExtUi`                                        | 对所有未决请求回 `cancelled` 并记诊断；通道已关时忽略（扩展侧仍有 120s 兜底）                |
| 本会话允许      | 扩展侧内存 `Set<sessionId::tool>`；客户端 `permissionStore.allowedTools` | 只在本进程本会话有效，`session_shutdown` / 会话退出即清空，不跨会话 / 进程                   |

### 6.4 子进程退出与崩溃恢复（本地）

- 正常退出（stdin 关闭 / quit）→ `evt:status=exited`，会话文件完整，UI 显示「会话已结束」。
- 异常退出（非 0 / 信号）→ `evt:diagnostic` 展示 stderr 尾部 → 提供「重新打开会话」按钮（新进程 + 同一 session 文件 + `get_messages` 回放）。
- **不自动重放未完成的 prompt**；展示「上次运行被中断」系统消息 + 「重发」按钮（原文回填，用户确认）。
- 空闲回收（30 分钟）与 LRU 挂起走优雅停止路径，UI 上表现为可一键唤醒，不产生错误提示。

Phase 2 的连接级断连/重连见附录 A.5。

---

## 7. 实现约束清单（executor 必读）

1. **分帧**：严禁用 `readline` 读 stdout——它会按 `U+2028`/`U+2029` 切分，而它们在 JSON 字符串内合法。自写 UTF-8 流读取器，**只在 LF 切分**并剥离可选前导 CR。
2. **背压**：必须持续读取 stdout；停止读取会阻塞 pi。写 stdin 处理 `drain`。
3. **stdout 纯净**：子进程 stdout 只承载协议；客户端不得向其 stdout 写非协议内容。
4. **并发在途**：命令带唯一 `id`，按 id 关联，不假设顺序。
5. **流式中发送**：busy 时 `prompt` 必须带 `streamingBehavior`（`steer` / `followUp`），UI 区分「打断当前步」与「排队」。
6. **关停顺序**：先关 stdin 等有序退出，超时才 kill；禁止 dispose 立刻 kill（会导致会话文件截断）。
7. **消息权威性**：`message_end` 覆盖增量；`agent_end` ≠ 结束，只认 `agent_settled`。
8. **路径安全**：`fs:*` 先 `path.resolve`（含 realpath 处理符号链接）再校验是否在 `workspaceRoots` 内；Windows 额外做大小写归一与 UNC/短路径（8.3）归一。**M6 落地方式**：所有 `fs:*` 与 `artifact:open` 统一走 `services/path-guard.ts` 一个校验器（词法黑名单 → 词法根闸 → `fs.realpath` 真实路径闸），单独通道不得自写前缀判断；允许工作区内指向工作区内的符号链接，拒绝一切逃逸；完整规则见 §5.4 的「M6 的路径校验」。
9. **凭据（v0.3 修订）**：**MVP 客户端不持有任何 provider key**——key 由 pi 自身配置（`~/.pi` 下的环境或配置文件）持有，客户端只传 `cwd` 与参数，绝不读取、不落盘、不进日志。**Phase 2**：provider key 只在云端；客户端唯一持有的秘密是网关连接串（`safeStorage`）。
10. **单实例**：`app.requestSingleInstanceLock()`，第二实例聚焦并转发深链参数。
11. **可执行文件调用**：`spawn` 用 `shell:false` + 数组参数；Windows 上若目标是 `.cmd`/`.ps1`，**优先解析出 Node 入口**（官方 `pi.cmd` → `%~dp0pi-launcher.js`、npm shim → `node_modules/.../cli.js`）后直接 `node <入口>` + 参数数组，完全绕过 cmd.exe。解析不出时才用 `cmd.exe /d /s /c`，且实参含 `"` / `%` / CR / LF / NUL 一律报 `VALIDATION`。

    **M5 风险评估结论**：旧实现（单行 `cmd.exe /d /s /c`）存在真实注入面——cmd 的引号是开关语义（`\"` 不是转义，一个 `"` 即可闭合引号注入 `& calc`），`%` 在引号内仍会展开，换行会拆命令；而 `--name` / `--model` / `--session` 都来自 renderer。现按上述两层策略消除，对抗性用例见 `tests/unit/pi-cmd-hardening.test.ts`。

12. **持久化边界**：`config.json` 只存偏好与非敏感配置；禁止写入会话内容、消息片段、token。
13. **超时预算**：pi 启动 10s、单命令 60s（`prompt` 走事件不设总超时）、审批 120s；可配置但不得为 0。
14. **大小上限**：回放/`readAll` 50MB、预览 64KB、diff 2MB、stderr 200 行/64KB；超限必须显式提示（不静默截断）。
15. **构建产物**：打包后不得出现 `NODE_ENV=development`、sourcemap 与本机绝对路径。

16. **主题**：调色板只有一份真源（`shared/contracts/theme.ts`），运行时写成 `<html>` 的 CSS 变量 + `color-scheme`（§12）；**对比度是断言不是审美**——逐主题按 WCAG AA 校验（正文 ≥ 4.5、强调/状态/代码 token ≥ 3），不达标就改色，不放宽阈值。
17. **模型配置（A14）**：写 pi 的 `models.json` / `settings.json` 时——apiKey **只进不出**（不进 IPC / 日志 / 审计）；客户端未建模的字段（`compat`/`samplingParams`/`cost`/`headers`/`modelOverrides`）必须原样保留；写入走「临时文件 + rename」原子替换并留 `.bak-<时间戳>`（保留 3 份）；坏 JSON 拒绝改动而非覆盖。
18. **发布**：产物命名不带空格（GitHub 会把空格转点，与 `SHA256SUMS.txt` 对不上）；`electron-builder` 一律显式 `--publish never`（CI 环境下它会隐式发布并因缺 `GH_TOKEN` 失败）；Release notes 由 Node 脚本生成（§14），不放 shell 里拼。

---

## 8. 里程碑

### 8.1 Phase 1（MVP，M1–M6）

| ID     | 里程碑 | 交付判定                                                                                                                                                                                 |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | 骨架   | Electron + Vite + React + TS 可启动；安全窗口配置；preload 白名单；IPC 路由 + zod；`typecheck/lint/test:unit` 可跑                                                                       |
| **M2** | 通道层 | `JsonlReader`（LF-only）+ `PiConnection`/`PiTransport` 接口 + `LocalConnection` + `pi-locator`；脚本级完成「创建会话 → 发一句 → 流式收完 → 优雅退出」                                    |
| **M3** | 界面   | 三栏布局、任务列表、消息流（markdown + 代码高亮）、工具卡片、时间线、停止按钮、错误条                                                                                                    |
| **M4** | 体验   | 新建任务弹层（目录/模型/会话名）、模型与推理档位切换、恢复与分叉、成本与 token 展示、并行上限与回收设置                                                                                  |
| **M5** | 审批   | `pi-desktop-permission` 扩展（安装脚本 + 版本握手）+ 审批弹窗 + 超时即拒绝 + 本会话允许                                                                                                  |
| **M6** | 产物   | 工作区变更列表 + unified diff 预览 + 文本预览 + 系统程序打开（**实现事实**见 §5.4「M6 通道补充说明」：git 与非 git 双链路、统一路径校验器、1000/64KB/2MB 上限、`shell.openPath` + 审计） |

### 8.2 Phase 2（远程，M7–M9）

| ID     | 里程碑                     | 范围要点                                                                                                                                                                       |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M7** | 网关服务端 `pi-gateway`    | `install.sh` / `docker run` 单命令部署；自动生成 token + 自签 TLS + 打印连接串；`wss` 帧（attach/cmd/ctl/evt/ack）；seq 环形缓冲（10k/会话）；token 鉴权与限流；`rotate-token` |
| **M8** | 客户端 `GatewayConnection` | 粘贴连接串导入（TOFU 指纹确认）；多路复用与 seq 重放；连接状态机与断连横幅；`session:reconnect`                                                                                |
| **M9** | 远端文件与产物             | `RemoteFs`（列目录/stat/range 读/只读 git）；远程目录浏览器；远端产物 diff 与下载打开                                                                                          |

### 8.3 Phase 3（候选）

只读镜像搜索、多设备同看、内嵌 PTY 终端、Office 预览、多网关切换。

---

## 9. 测试矩阵

> 标注规则：**[MVP]** 第一阶段必过；**[P2]** Phase 2 必过，不阻塞 MVP 验收。

### 9.1 单元（Vitest）

| ID  | 阶段 | 场景                                                                                                         | 期望                                                                                                                  |
| --- | ---- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| U1  | MVP  | 跨 chunk 边界的半个 JSON                                                                                     | 补齐后 1 条记录，不产出半条                                                                                           |
| U2  | MVP  | 字符串内含 `U+2028`/`U+2029`                                                                                 | 不切分                                                                                                                |
| U3  | MVP  | CRLF 行                                                                                                      | 剥离 CR 后正常解析                                                                                                    |
| U4  | MVP  | 非法 JSON 行                                                                                                 | 不崩溃，产出诊断，后续继续                                                                                            |
| U5  | MVP  | `reducer` delta 序列 + `message_end`                                                                         | 最终文本 == 权威文本                                                                                                  |
| U6  | MVP  | 重复 `message_end`                                                                                           | 幂等                                                                                                                  |
| U7  | MVP  | `agent_end` 后仍有排队事件                                                                                   | 保持 `settling` 直到 `agent_settled`                                                                                  |
| U8  | MVP  | IPC 入参缺失/类型错                                                                                          | `ok:false, code:VALIDATION`，不进业务层                                                                               |
| U9  | MVP  | `fs:readText` 含 `../`、符号链接逃逸、UNC 变体                                                               | `PATH_DENIED`                                                                                                         |
| U10 | MVP  | 审批超时                                                                                                     | 自动发拒绝，UI 复位                                                                                                   |
| U11 | MVP  | `LocalConnection` 状态机非法迁移（`failed → ready`）                                                         | 拒绝并记录                                                                                                            |
| U12 | MVP  | 增量拼接 + 整体替换二次聚合                                                                                  | 幂等一致                                                                                                              |
| U13 | MVP  | `readTail` 作用于 100MB 会话                                                                                 | 只读尾部、不 OOM                                                                                                      |
| U14 | MVP  | 配置 schema 出现明文 `token`/`password` 字段                                                                 | 拒绝并给字段路径                                                                                                      |
| U15 | P2   | 连接串解析（合法/缺字段/指纹格式错）                                                                         | 合法项解出 URL+token+指纹；非法项拒绝且不回显 token                                                                   |
| U16 | P2   | seq 空洞                                                                                                     | 触发 `GAP` 回退全量快照                                                                                               |
| U17 | P2   | 重连对齐（本地有未确认增量、远端多出消息）                                                                   | 以远端为准，不重复不丢条                                                                                              |
| U18 | MVP  | 路径对抗矩阵（`..`/UNC/设备名/ADS/尾随点空格/保留名/工作区内符号链接放行/逃逸 junction 拒绝/Windows 大小写） | 攻击形态全部 `PATH_DENIED`，合法形态放行（`tests/unit/path-guard.test.ts`）                                           |
| U19 | MVP  | unified diff 解析与截断                                                                                      | 文件/hunk/行类型正确；超限按行截断并带显式说明（`tests/unit/unified-diff.test.ts`、`tests/unit/diff-parser.test.ts`） |
| U20 | MVP  | 非 git 快照比对（新增/修改/删除/`touch` 不误报/大小变化内容前缀相同）                                        | 变更集合正确，`touch` 不算变化（`tests/unit/workspace-snapshot.test.ts`）                                             |
| U21 | MVP  | 产物服务上限与审计（列表 1000、预览 64KB、diff 2MB、`artifact:open` 四种结果）                               | 超限显式 `truncated`；审计只含 `action/target/outcome/code`（`tests/unit/artifacts-service.test.ts`）                 |
| U22 | MVP  | 主题注册表：9 套调色板逐项 WCAG 对比度（正文 ≥4.5 / 强调·状态·代码 token ≥3 / scheme 与背景亮度一致）        | 全部达标；`dark`/`light` 历史值归一为 `pi-dark`/`pi-light`（`tests/unit/theme.test.ts`）                              |
| U23 | MVP  | 模型配置：apiKey 脱敏、未知字段保留、原子写 + 备份轮转、坏 JSON 拒绝、非法 id/baseUrl/api                    | 明文不出视图；`compat`/`headers` 等原样保留；`../evil`、`ftp://` 被拒（`tests/unit/model-config-store.test.ts`）      |
| U24 | MVP  | 提示条同文案去重（连续保存不堆叠）                                                                           | 同 `level+message+detail` 替换而非追加，最多 5 条（`tests/unit/run-store-banners.test.ts`）                           |

### 9.2 集成（主进程 + 真实/mock pi 子进程）

| ID  | 阶段 | 场景                                                                                       | 期望                                                                                                                 |
| --- | ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| I1  | MVP  | 启动 → prompt → 完整事件序列 → settled                                                     | 顺序符合 golden JSONL，状态回 idle                                                                                   |
| I2  | MVP  | busy 且无 `streamingBehavior`                                                              | 客户端明确报错，不挂起                                                                                               |
| I3  | MVP  | `steer` 与 `followUp` 分别注入                                                             | 插入时机符合协议                                                                                                     |
| I4  | MVP  | 运行中 `abort`                                                                             | 合理时间内回 idle，进程可继续用                                                                                      |
| I5  | MVP  | 强杀子进程                                                                                 | `evt:diagnostic` 有 stderr 尾部；可重开会话继续对话                                                                  |
| I6  | MVP  | 扩展命令（`/xxx`）经 prompt                                                                | `disposition=handled`，不等 settled                                                                                  |
| I7  | MVP  | 恢复既有 session 文件                                                                      | 消息数与末条内容与 pi 一致                                                                                           |
| I8  | MVP  | 请求 10 个会话、上限 3                                                                     | 超限挂起可唤醒；无资源冲突                                                                                           |
| I9  | MVP  | 高频 `text_delta`（>500/s）                                                                | 合并后 renderer 帧率不降                                                                                             |
| I10 | MVP  | pi 不存在 / 版本过老 / 首条记录非 JSON                                                     | 三步自检给出可操作提示，不进入坏状态                                                                                 |
| I11 | P2   | 断网 30s 恢复                                                                              | 重连后条数与末条哈希与云端一致                                                                                       |
| I12 | P2   | 云端 `kill -9` 后重连                                                                      | 无重复工具执行记录                                                                                                   |
| I13 | P2   | RTT 200ms + 2% 丢包                                                                        | 零解析失败，首 token 增量 ≤ 1.5×RTT                                                                                  |
| I14 | P2   | 远端工具输出 >100KB                                                                        | 经 `RemoteFs` 按需读取 `fullOutputPath`                                                                              |
| I15 | P2   | 同网关 3 会话并行                                                                          | 事件不串流                                                                                                           |
| I16 | MVP  | 真实 git 仓库：`fs:listArtifacts` / `fs:diff` 全链路（已暂存重命名 + 未暂存修改 + 未跟踪） | 列表含 `renamed/oldPath`，补丁覆盖暂存与未暂存，未跟踪合成 `new file`（`tests/integration/artifacts-chain.test.ts`） |
| I17 | MVP  | 非 git 工作区：会话开始快照 → 重扫 → diff/预览                                             | 标注「非 git 工作区，快照比对」，diff/预览可用                                                                       |

### 9.3 E2E（Playwright + Electron）

| ID  | 阶段 | 场景                                                                                                       | 期望                                                                                                                         |
| --- | ---- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E1  | MVP  | 首次启动（无配置）                                                                                         | 空态 + 「定位 pi / 新建任务」引导，无报错                                                                                    |
| E2  | MVP  | 新建任务 → 选目录 → 发「列出当前目录」                                                                     | 流式回复，工具卡片含 bash 调用与输出                                                                                         |
| E3  | MVP  | 审批「拒绝」                                                                                               | 工具未执行，对话显示拒绝结果，流程继续                                                                                       |
| E4  | MVP  | 点击停止                                                                                                   | 300ms 内按钮置灰并显示已中止，可继续发消息                                                                                   |
| E5  | MVP  | 关闭窗口再打开                                                                                             | 任务列表在，选中会话历史完整                                                                                                 |
| E6  | MVP  | 主进程异常（mock 抛出）                                                                                    | 错误对话框，不白屏                                                                                                           |
| E7  | P2   | 粘贴连接串导入                                                                                             | 指纹确认后可连；指纹不符阻断且不落配置                                                                                       |
| E8  | P2   | 断网 → 横幅 → 重连 → 继续                                                                                  | 无重复消息，发送恢复                                                                                                         |
| E9  | P2   | 远端产物 diff 与下载打开                                                                                   | 预览正确，临时文件关闭即清理                                                                                                 |
| E10 | MVP  | 产物面板：settled 自动扫描 → diff 可见 → 确认后用系统程序打开（`shell.openPath` 被 stub） → 清理文件后刷新 | 变更可见、只在确认后调外部程序、清理后回到空态（`tests/e2e/app.e2e.test.ts`）                                                |
| E11 | MVP  | 主题切换（9 套逐一切换 + 重载保持 + 跟随系统）                                                             | `data-theme`/`--bg` 生效、浏览器实算对比度 ≥4.5、截图留档（`tests/e2e/theme.e2e.test.ts`）                                   |
| E12 | MVP  | 模型管理：打开弹层 → 新增 provider → 设默认模型 → 删除（隔离到临时 `PI_CODING_AGENT_DIR`）                 | 真写进 `models.json`/`settings.json`；界面只出现掩码；预置 provider 的额外字段仍在（`tests/e2e/models-manager.e2e.test.ts`） |

### 9.4 安全

| ID  | 阶段 | 场景                                              | 期望                                              |
| --- | ---- | ------------------------------------------------- | ------------------------------------------------- |
| S1  | MVP  | renderer 调 `require('fs')`                       | 失败                                              |
| S2  | MVP  | 调用未注册 IPC 通道                               | 拒绝                                              |
| S3  | MVP  | 恶意 markdown（script 标签、`javascript:`）       | 不执行，链接拦截                                  |
| S4  | MVP  | `will-navigate` 外链                              | 阻止，`openExternal` 前确认                       |
| S5  | MVP  | 打包产物扫描                                      | 无 API key/token 落盘；日志无敏感串               |
| S6  | MVP  | 写入 `workspaceRoots` 之外                        | `FsBridge` 拒绝（含符号链接与 UNC）               |
| S7  | P2   | 网关 token 缺失/过期/暴力尝试                     | 拒绝 + 限流 + 错误不泄露细节                      |
| S8  | P2   | 明文 `ws://` 连接                                 | 默认拒绝（仅 localhost 调试开关可放行）           |
| S9  | P2   | 伪造其他通道 id 的审批请求                        | 拒绝                                              |
| S10 | P2   | 远端越权路径（`../../etc/passwd`）                | 由**远端**拒绝                                    |
| S9' | MVP  | 伪造 `requestId` / 跨会话回 `extui:respond`（M5） | `REQUEST_NOT_FOUND` + `evt:diagnostic`，不送达 pi |

---

## 10. 验收标准

**功能 [MVP]**

- A1 新建会话 1 次点击发出首条消息，首个 token ≤ 1.5s（本地 mock provider 基准）。
- A2 工具调用在 UI 可见「名称 + 参数摘要 + 状态 + 输出」，与事件一一对应。
- A3 会话列表展示 20 条历史（标题/时间/cwd/token/成本）与 JSONL 一致，**耗时 < 1s**；100 条 < 3s（分块读尾部 + mtime 缓存）。
- A4 支持恢复与分叉；分叉后原会话文件字节不变。
- A5 高风险工具默认 100% 触发审批；「本会话允许」在同一 sessionKey 内不再弹窗。

**健壮性 [MVP]**

- A6 强杀子进程后 2s 内出现可操作入口，重开历史完整、可继续对话。
- A7 连续 30 分钟高频对话（>200 轮）渲染进程 RSS 增长 < 30%。
- A8 达到 3 个活跃会话上限后第 4 个进入挂起态并可一键唤醒；空闲 30 分钟回收后再打开不报错。

**安全 [MVP]**

- A9 S1–S6 全通过；`npm run audit:security` 无高危。

**工程 [MVP]**

- A10 `typecheck`/`lint`/`test:unit`/`test:e2e` 全绿，CI 在 Windows 通过。
- A11 干净 Windows 10/11 x64 安装即启动（不要求预装 Node；pi 通过设置项指定可执行文件）。
- A12 首启无 pi 时给出可操作引导，人工 3 步内解除阻塞（定位 → 自检 → 建任务）。
- A13 会话 `agent_settled` 后产物面板显示工作区变更（git：`status`+`diff`；非 git：快照比对并**显式标注**），单文件 diff 超 2MB 截断有提示，越权路径 100% `PATH_DENIED`，「用系统程序打开」需用户确认且经主进程校验后走 `shell.openPath`。
- A14 模型管理：客户端可列出 / 新增 / 编辑 / 删除 pi `models.json` 里的 provider 与模型，可设默认模型；**apiKey 明文不出主进程**（界面只有掩码）；写回保留客户端未建模字段；写入原子替换 + 备份，坏 JSON 拒绝改动；改动对已在运行的会话不生效且有明示。
- A15 主题：内置 9 套主题 + 跟随系统，切换立即生效并持久化；每个主题正文对比度 ≥ 4.5、强调/状态/代码 token ≥ 3（单测按 WCAG 断言），浅色主题下代码高亮可读；历史配置值不致主题被重置。
- A23 任务改名：任务标题双击可改名（Enter 保存 / Esc 取消）；活跃会话走 RPC `set_session_name`，历史任务追加 `session_info`（只 append，不改写既有会话内容，且文件必须在会话根内）；刷新列表即读到新名字。
- A22 文件引用：输入框可「引用文件」（限本会话工作区内），插入工作区相对路径；越界被主进程拒绝；取消不报错。不提供 `@path` 语义（RPC 不支持）。
- A21 图片缩略图：用户消息里的图片显示缩略图，点击可在应用内查看原图（Esc/遮罩/按钮关闭，多图可切换）。
- A20 拖拽与压缩：可把图片文件拖入输入区（含窗口级导航兜底）；超过 2000px 长边或 2MB 的图片在客户端先等比压缩，缩略图标注「已压缩」并保留原图尺寸信息；8MB 以上直接拒绝并说明原因。
- A19 粘贴图片：`Ctrl+V` 可把剪贴板截图粘进对话框（png/jpeg/webp/gif，单张 ≤8MB、每条 ≤4 张），发送时以 data URL 交给 pi；只有图无文字也可发送；超限/类型不符显式提示原因。
- A18 会话身份 agent：新建任务可从扫描到的 agent 定义中选择（`--agent`）；`pi --help` 无该 flag 时不显示选择器，未知名字被客户端拒绝（不依赖 pi 的静默忽略）；子 agent（subagent）的中间过程不在父会话里，UI 不假装能看到。
- A17 起始模式：新建任务可选「完整工具 / 只读 / 纯对话」，分别翻译成 pi 的默认工具集、`--exclude-tools write,edit,bash,powershell`、`--no-tools`（`tests/unit/local-connection.test.ts` + 集成断言 argv + E2E E14）；不在 UI 里假装能回显 pi 实际生效的工具集。
- A16 发布工程：`v*` tag 一键构建 NSIS 安装包并创建 Release（含 SHA-256 校验和与 CHANGELOG 段落）；产物带应用图标与正确版本资源；CI 失败可用 `junit-*`/`build-log` artifact 诊断（本机网络不可达 Actions 日志主机时仍然可查）。

**Phase 2 [P2]**

- A-P1 单命令部署网关 5 分钟内可用（含打印连接串），客户端粘贴即连，全程无需命令行知识。
- A-P2 断网 30s 恢复：≤5s 出现重连入口，重连后消息条数与云端 JSONL 完全一致。
- A-P3 重连不产生任何自动重发或重复工具执行。
- A-P4 网关 token 与 provider key 不出现在客户端 userData / 日志 / 崩溃转储。
- A-P5 越权路径 100% 由远端拒绝，本地校验非唯一防线。
- A-P6 新增 `GatewayConnection` 后 renderer 不改（以「仅注册新连接类型」的 diff 证明）。

---

## 11. 待用户确认项（v0.3）

| ID  | 问题                                                          | 建议                                                            |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| Q1  | 远程网关是否列入路线图（Phase 2 现在做，还是先交付 MVP 再定） | 先交付 MVP（M1–M6），M7 前再决策                                |
| Q2  | 是否随包捆绑 pi（自带 Node/pi 运行时）                        | MVP 复用用户已装 pi（A11 + 设置项指定路径）；捆绑作为发布期优化 |
| Q3  | 本地并行与回收默认值（3 个活跃 / 30 分钟空闲回收）            | 按此默认，设置页可改                                            |
| Q4  | 审批默认策略（高风险工具清单与是否默认开启）                  | 默认开启，仅 bash/powershell/write/edit/删除类                  |
| Q5  | 是否提供「办公模式」等非编程预设                              | MVP 不做，M4 之后评估                                           |
| Q6  | 主题与品牌（沿用 pi 视觉 vs 独立品牌）                        | 沿用 pi，降低决策成本                                           |
| Q7  | 会话目录是否默认显式 `--session-dir`（便于备份与工作区隔离）  | 建议沿用 pi 默认目录，设置项可覆盖                              |

---

## 12. 主题系统与视觉

> 原 `docs/themes.md` 合并进本节。

**单一真源**：`src/shared/contracts/theme.ts` 的 `THEMES` 注册表（id / 显示名 / 明暗 / 21 个颜色）。设置面板选项、单测、E2E 断言、截图回归全部读它，CSS 里不维护第二份调色板。

**运行时应用**：`src/renderer/lib/theme.ts#useAppliedTheme` 把调色板写成 `<html>` 的 CSS 变量（`--bg`、`--panel`、`--text`、`--accent`…）+ `data-theme` + `color-scheme`（后者让原生滚动条 / 输入框 / 下拉跟随明暗）。`styles.css` 的 `:root` 保留一份 `pi-dark` 兜底首帧，配置到达前不闪白。选「跟随系统」时监听 `prefers-color-scheme` 实时切换，不必重启窗口。

**代码高亮也走变量**：`--code-comment/keyword/string/number/title/builtin/deletion` 由主题提供，否则浅色主题里代码块会出现「深色语法色叠浅底」。

**语义色也走变量（v0.3.1 修的真实缺陷）**：`--code-bg`（代码块 / 工具输出底色）、`--on-accent`（强调实底上的文字）、`--accent-hover`（主按钮 hover 底，必须仍撑住白字 4.5:1）、`--danger-text` / `--warn-text` / `--success-text`（提示条与 diff 行文字）。此前这些位置是写死的近黑色 / 浅粉浅绿，主题切浅色后出现「黑底黑字」，工具调用输出直接不可读。

**结构性守卫**：`tests/unit/styles-theme-vars.test.ts` 解析 `styles.css`——除 `:root`（兜底默认值，须与 `pi-dark` 一致）与 `var()` 回退外，**不允许出现任何 hex / `rgb()` 字面量**（`box-shadow` 的投影按行豁免），并校验样式里用到的每个 `var(--x)` 都在调色板里（拼错变量名会静默失效——`--panel` 就是这么被发现的：该变量从未定义，审批卡片永远走深色兜底）。E2E `E13` 再用浏览器实算的颜色复验「浅色主题下工具输出与代码块对比度 ≥ 4.5、底色亮度 > 0.5」。

| id                 | 名称             | 明暗 | 来源                               |
| ------------------ | ---------------- | ---- | ---------------------------------- |
| `pi-dark`          | pi 深色（默认）  | 暗   | 本应用原生配色（沿用 pi 视觉，Q6） |
| `pi-light`         | pi 浅色          | 亮   | 同族浅色                           |
| `github-light`     | GitHub Light     | 亮   | GitHub Primer                      |
| `solarized-light`  | Solarized Light  | 亮   | Solarized（高对比度变体，见下）    |
| `nord`             | Nord             | 暗   | Nord（Arctic Ice Studio）          |
| `dracula`          | Dracula          | 暗   | Dracula                            |
| `one-dark`         | One Dark         | 暗   | Atom One Dark                      |
| `tokyonight`       | Tokyo Night      | 暗   | Tokyo Night（enkia）               |
| `catppuccin-mocha` | Catppuccin Mocha | 暗   | Catppuccin                         |

**对比度政策（不是装饰性选择）**：`tests/unit/theme.test.ts` 用 WCAG 2.1 相对亮度公式对每个主题断言——正文/次要文本 vs 背景（含 panel、elevated）≥ 4.5；强调色与 ok/warn/error ≥ 3；代码 token vs 代码块底色 ≥ 3；`scheme` 声明必须与背景亮度一致。E2E（`tests/e2e/theme.e2e.test.ts`）再用**浏览器算出的颜色**验一遍 ≥ 4.5，并为每套主题出整窗截图 `docs/screenshots/theme-<id>.png`。

因此有两处**刻意偏离上游原版**（源码注释亦有说明）：Solarized Light 原版正文只有 4.39:1（同色相加深到 4.5+）；Dracula / One Dark / Tokyo Night / Catppuccin 的官方注释色对各自 elevated 底仅 1.7–2.6:1（提亮一档到 ≥3）。

**新增一个主题**：在注册表加一项（缺字段 TS 直接报错）→ 跑 `npm run test:unit -- theme` 看对比度断言 → 跑 `npm run test:e2e -- theme` 出截图人工复核。不改 CSS、设置面板或配置层；配置里历史值 `dark`/`light` 由 `config-store` 读盘时归一为 `pi-dark`/`pi-light`（升级不重置主题），非法值退回 `system`。

---

## 13. 模型管理（A14）

> 原 `docs/models.md` 合并进本节。

入口：顶栏「模型」按钮 → 弹层。管的是 **pi 磁盘上的配置**，与会话内切换模型是两件事。

| 文件                        | 管什么                           | 客户端行为                                      |
| --------------------------- | -------------------------------- | ----------------------------------------------- |
| `<agent-dir>/models.json`   | provider 与模型（`providers.*`） | 增删改 provider / model，保留客户端未建模的字段 |
| `<agent-dir>/settings.json` | `defaultModel`（新会话启动模型） | 只改这一个键，其余键原样保留                    |

`<agent-dir>` = `PI_CODING_AGENT_DIR` 环境变量，默认 `~/.pi/agent`。**生效时机**：pi 在启动会话时读取这些配置，所以改动对已在运行的会话不生效（弹层里有明示，不假装热更新）。

**能做什么**：列出 provider 与模型（上下文 / 最大输出 / 是否 thinking / 是否多模态）；新增 / 编辑 / 删除 provider 及其模型（id、显示名、Base URL、API 类型、key、模型行：名称 / 上下文 / 最大输出 / thinking / 多模态）；设置默认模型（选「自动」= 删除该键）。

**交互**：点「新增 / 编辑」后**列表让位给表单**（表单紧贴「默认模型」下方并自动滚入视口），保存或取消即回列表——用户不需要在长列表里往下找编辑框。

**多模态**：模型行的「多模态」开关对应 pi 的 `input` 字段——勾选写 `["text","image"]`，不勾写 `["text"]`（pi 默认）。**未传该字段时不动原值**，避免「只改个名字」把已配好的图片输入清掉；读取时由 `input` 是否含 `image` 反推开关状态，不额外维护第二份事实。

**三条数据/安全约束（§7 约束 17）**：

1. **apiKey 只进不出**：读取时主进程只计算 `hasApiKey` 与掩码 `apiKeyHint`（`sk-…3456`），明文不进 IPC / 日志 / 审计；编辑已有 provider 时输入框永远空白（留空 = 保留原值），清除必须显式勾选。支持 pi 的三种形式：字面量、`$ENV_NAME`、`!command`（`!` 开头**不会**在客户端执行，只原样写入配置）。
2. **不动用户没建模的字段**：`compat`、`samplingParams`、`cost.tiers`、`headers`、`modelOverrides`、`thinkingLevelMap` 等在写回时对象级就地合并、原样保留——否则「打开客户端改个名字」就会清空用户调好的兼容参数。（`input` 属已建模字段，但同样在「未提供时保留」。）
3. **写入可回退**：同目录临时文件 + `rename`（同卷原子），覆盖前留 `<文件名>.bak-<时间戳>` 并只保留最近 3 份；**坏 JSON 直接拒绝改动**，不静默覆盖用户文件。

**校验规则**（IPC 边界 zod + 服务层各一次）：provider/model id 为 `[A-Za-z0-9._:/-]{1,128}` 且不允许 `..`、不以 `/` 开头或结尾（pi 里真实存在 `google/gemma-3-12b-it` 这类带斜杠的 id）；`baseUrl` 只接受 http(s)——**刻意放行 http**，内网自建 endpoint（如 `http://10.x.x.x:6001/v1`）是真实用法；`api` 只接受 5 个枚举值，避免拼错到 pi 启动才报错。

**已知不做**：不管理 `models-store.json`（pi 扩展/探测缓存，属上游状态）；不做连通性测试（要真发请求、要 key）；不做 OAuth 登录流程。

---

## 14. 发布工程与诊断（A16）

> 原 `docs/release.md` 合并进本节。

### 14.1 应用图标

`resources/icon.svg` 是唯一真源（π 站在一条「桌面线」上，配色取应用主题）；`npm run icon` 用项目内 Electron 渲染出 `resources/icon.png`（1024×1024 透明底），`npm run icon:preview` 额外派生 16/24/32/48/64/128/256 预览图。

**PNG 随仓库提交、CI 不重渲**：渲染要起 GUI 进程，在 GitHub runner 上曾整步失败且拿不到 stdout；图标是确定性产物，提交后打包只依赖「文件存在且 ≥256×256」。改图标：改 svg → `icon:preview` 看各档 → 提交 png。

三个已踩的坑（源码注释里也有）：XML 注释不能含连续两个连字符（写 `--bg-panel` 会让整份 SVG 解析失败，渲出空白图）；直线（零高度包围盒）用 `objectBoundingBox` 渐变会退化成不可见，必须 `userSpaceOnUse`；Electron `capturePage()` 受系统 DPI 影响（200% 缩放的机器上 1024 窗口产出 2048 图），必须 `force-device-scale-factor=1`。

### 14.2 打包配置

- `win.icon: icon.png`；`win.signExecutable: false`（**不是** `signAndEditExecutable: false`——后者会把图标与版本资源一起跳过，导致 exe 在任务管理器里显示 "Electron"）。
- `artifactName: ${productName}-${version}-${arch}.${ext}` → `pi-desktop-<版本>-x64.exe`：不带空格，避免 GitHub 把空格转成点后与 `SHA256SUMS.txt` 记录的文件名对不上。
- 脚本固定 `--publish never`：electron-builder 在 CI 环境会**隐式推断要发布**（日志 `Implicit publishing triggered by CI detection`），缺 `GH_TOKEN` 直接失败。

### 14.3 Release 工作流

`.github/workflows/release.yml`：`push tag v*` → 校验 tag 与 `package.json` 版本一致（不一致直接 fail）→ 确认图标存在且 ≥256 → `typecheck` + `format:check` + `test:unit` → `npm run package:dist` → 计算 SHA-256 写 `SHA256SUMS.txt` → 上传 Actions artifact（安装包 + `build-log`）→ `node scripts/build-release-notes.mjs` 生成 notes（模板 + CHANGELOG 对应版本段落）→ `gh release create`。`workflow_dispatch` 只构建不发布，用于打 tag 前验证流水线。

不引第三方 release action：本仓库策略是所有 action 固定到 commit SHA，而 `gh` 在 windows runner 上自带。安全细节：tag 名一律经 `env` 传入（不内联 `${{ }}`）；带 `contents: write` 的发布 job **不用** actions 缓存（防缓存投毒）。

发版：`npm version X.Y.Z --no-git-tag-version` → 提交 → `git tag -a vX.Y.Z` → 推送 tag。

### 14.4 校验与诊断

**校验产物**：`Get-FileHash .\pi-desktop-<版本>-x64.exe -Algorithm SHA256` 与 `SHA256SUMS.txt` / Release 页面一致。Release 资产 API 也返回每个资产的 `digest`（`sha256:…`），用 `gh api repos/<owner>/<repo>/releases/tags/v<版本>` 可核对，不必下载校验和文件。注意不同机器构建的 SHA 不同（NSIS 打包含时间戳，不可复现），以 CI 发布的那份为准。

**本机网络受限时的诊断通道**：开发机对 `results-receiver.actions.githubusercontent.com`（Actions 日志）与 `release-assets.githubusercontent.com`（Release 资产下载）不可达，因此 `gh run view --log` / `gh release download` 不可用。替代通道（都不依赖上述域名）：

| 需求             | 通道                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| 失败用例完整堆栈 | CI 里 unit/integration/e2e 失败时上传 `junit-*` → `gh run download <run> -n junit-unit` |
| 构建失败完整输出 | release 工作流 `if: always()` 上传 `build-log`（`package.log`）                         |
| 快速看堆栈摘要   | `gh ann <jobId>`（= `gh api …/check-runs/<jobId>/annotations`）                         |
| job / step 结论  | `gh run view <runId> --json jobs`                                                       |

另：本机 `HTTP(S)_PROXY` 对 `api.github.com` 时好时坏（会表现为 `gh auth status` 误报 token invalid），已在用户级 `NO_PROXY` 追加 GitHub 相关域名。

---

## 15. 参考来源

- pi 文档（本地安装）：`README.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`docs/cli-integration.md`、`docs/sessions.md`、`docs/environment-variables.md`、`docs/session-format.md`、`docs/extensions.md`、`docs/sdk.md`（仅参考，`SdkTransport` 已作废）
- WorkBuddy：`https://www.workbuddy.ai/docs/workbuddy/Overview`、`/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar`、`https://www.workbuddy.cn/work/`、社区手册 `https://neohoy.github.io/workbuddybook/start/`

---

## 附录 A：Phase 2 远程设计（网关模式，零配置）

> 本附录为 Phase 2 实现依据，MVP 不实现。SSH 相关设计（`ssh2` exec、无 PTY、POSIX 转义、host key 校验、SFTP、登录横幅污染）全部作废，不再保留。

### A.1 架构

```text
Electron (桌面)
  Renderer (与 MVP 同一套 IPC，不改)
        ▲ window.pi
  Main: ConnectionRegistry
          ├ LocalConnection（MVP 已有）
          └ GatewayConnection（新增）
               ├ 连接串解析 → token(safeStorage) + 指纹
               ├ wss 多路复用：attach / cmd / ctl / evt / ack
               ├ seq 重放（环形缓冲）与 GAP 回退
               ├ RemoteFs（列目录/stat/range 读/只读 git）
               └ 连接状态机 + 断连横幅
        ▲ wss (TLS, 自签 + TOFU)
        ▼
云服务器: pi-gateway (Node)
            ├ 进程池：一会话一 pi 子进程（pi --mode rpc）
            ├ 会话事件 seq 环形缓冲（默认 10k/会话）
            ├ token 鉴权 + 限流 + 审计日志（脱敏）
            └ session JSONL / 工作区文件（事实来源）
```

### A.2 零配置部署与连接串

**服务端（两条路径，任选其一）**

```bash
# 1) 安装脚本（自动生成 token、自签证书、打印连接串）
curl -fsSL https://get.pi-desktop.dev/gateway.sh | sh

# 2) 容器（等价效果；日志里出现连接串）
docker run -d --name pi-gateway -p 8443:8443 -v pi-data:/data ghcr.io/pi-desktop/gateway:latest
docker logs pi-gateway
```

首次启动输出（默认只打印一次，重复需显式 `--show-connection-string`）：

```text
pi-gateway 已启动
  监听:  https://<public-ip>:8443
  指纹:  sha256:9f3a1c...（客户端首次连接会要求确认）
  连接串（复制到客户端「添加远程连接」）：
  pigw://v1/eyJ1IjoiaHR0cHM6Ly8xLjIuMy40Ojg0NDMiLCJmIjoic2hhMjU2Ojl...
```

**连接串格式（v1：单一不透明串，避免手动分字段）**

```text
pigw://v1/<base64url(JSON)>
JSON = { v:1, u:'https://host:8443', f:'sha256:<base64url>', t:'<token>' }
```

- 客户端只显示 host + 指纹前 8 位；token 解码后立即写入 `safeStorage`，UI 不再回显，复制按钮需二次确认。
- 支持 `--qr` 打印终端二维码（内容同连接串），供多设备场景。

**客户端导入流程（3 步，无需命令行）**：粘贴连接串 → 显示 host/指纹并确认（TOFU）→ 写入 `safeStorage` 并连接。指纹不符直接阻断且不写配置。**不做证书手动配置**，自签证书由 pinning 替代 CA 校验。

### A.3 事实来源

云端 session JSONL 是唯一事实来源；客户端零持久化会话内容。允许的本地缓存仅元数据（列表摘要），必须可失效（`session:list` 返回 `stale`），任何缓存不得回写云端。

### A.4 接口增量

```ts
interface SessionSource {
  // Phase 2
  list(o: { cwd?: string; limit?: number; cursor?: string }): Promise<SessionSummary[]>
  readTail(f: string, maxBytes: number): Promise<string>
  readAll(f: string): Promise<string> // 50MB 上限
}

interface RemoteFs {
  // Phase 2
  list(dir: string): Promise<DirEntry[]>
  stat(p: string): Promise<FileStat>
  readText(
    p: string,
    o: { offset?: number; limit: number }
  ): Promise<{ text: string; truncated: boolean }>
  readBinary(p: string, maxBytes: number): Promise<{ data: Uint8Array }>
  execReadonly(
    cmd: 'git-status' | 'git-diff',
    args: string[]
  ): Promise<{ stdout: string; code: number }>
}
```

新增 IPC：`conn:list/test/connect/disconnect`、`conn:importString`、`conn:pickRemoteDir`、`session:reconnect`、`artifact:fetch`；新增事件：`evt:conn`、`evt:netstat`。`session:list` 增 `configId` 与 `stale` 字段（MVP 侧预留参数位，不实现网关分支）。

**帧格式**

```text
C→S attach { sessionKey, lastSeq?, resume?:{sessionFile} }
C→S cmd    { sessionKey, rec }        // 原样透传 RpcCommand
C→S ctl    { op:'list'|'fs'|'ping'|'detach' }
S→C evt    { sessionKey, seq, rec }   // seq 单调递增
S→C ack    { sessionKey, seq } | err { code, message }
```

### A.5 断连与恢复

状态机：`ready ⇄ degraded → reconnecting → ready | failed`（退避 1/2/4/8/15s，上限 5 次）。

1. 断连 → 横幅「连接已中断，任务仍在云端运行」，禁用发送。
2. 带 `lastSeq` 重连：缓冲命中只重放增量；被覆盖 → `GAP` → `get_messages` 全量快照对齐。
3. **不自动重放未完成的 prompt**；提供「上次运行被中断/已完成」提示与「重发」按钮。
4. 鉴权失败（401）/ 指纹变更 → 直接 `failed`，不重试、不降级。
5. 审批挂起期间断连：未决请求在主进程保留，重连后重弹；仍以唯一的 120s 时钟判定超时，超时即拒绝。
6. 空闲回收语义（补齐 v0.2 缺口）：SSH 已作废；网关下「回收」= `detach` 通道（pi 进程按网关策略继续或挂起），**从不因客户端回收而 kill 正在运行的会话**；`detach` 后是否继续执行由 Q1 的路线图决策决定。

### A.6 安全约束

- token：24 字节随机，`safeStorage` 存储，日志一律打码；服务端仅存哈希；`rotate-token` 使旧串失效。
- TLS 必须有（`wss`），自签 + 指纹 pinning（TOFU）；拒绝 `ws://`（localhost 调试开关除外）。
- 限流：每 token 每分钟 attach ≤ 10、并发通道 ≤ 8、失败鉴权指数退避。
- 远端路径校验在**远端**执行（`RemoteFs` 与网关 fs RPC 双侧校验），本地校验不作为唯一防线。

### A.7 保留但不实现

- SSH 通道（`ssh2` exec）：**不实现**。若社区自行实现，须沿用同一 `PiConnection` 接口与 `JsonlReader`，不得改动 renderer。
- 只读镜像（`MirrorTransport`）：Phase 3 候选。
