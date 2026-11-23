# pi-desktop 桌面客户端架构方案

- 版本：v0.2（2026-11-20）
- 状态：待评审（v0.2 增补远程部署模式）
- 作者：architect
- 目标读者：executor（实现者）、reviewer

**v0.2 变更摘要（相对 v0.1）**

1. 新增 §3「部署模式」：远程（云服务器）为本版新增约束背景，交互通道以 SSH 隧道 RPC 为 P0、常驻网关为 P1、只读镜像为 P2。
2. `PiTransport` 拆为 `PiConnection`（物理连接 + 状态机）与 `PiTransport`（一会话一通道）双层；`SdkTransport` 移出规划。
3. 事实来源仍为 pi session JSONL，但可位于云端；客户端零持久化会话内容，仅允许可失效的元数据缓存。
4. 新增 §6.4「断连与恢复」完整小节；§7 约束清单追加 11–17；§8 里程碑扩为 M1–M8；§9/§10 补充远程用例与验收项；§11 待确认项替换为 Q1–Q10。
5. 本地部署模式保留为可选形态，原有本地链路内容不变。

---

## 1. 背景与目标

### 1.1 背景

pi（`@earendil-works/pi-coding-agent`）是终端优先的 agent harness，主交互形态为 TUI。用户希望借鉴 WorkBuddy（腾讯全场景 AI 智能体桌面工作台）的形态，为 pi 提供桌面客户端。

WorkBuddy 调研结论（来源：workbuddy.ai / workbuddy.cn 文档与手册）：

| 维度 | WorkBuddy 做法 | 对 pi-desktop 的启示 |
|---|---|---|
| 入口 | 新建任务栏：模式 → 模型 → 目录 → 技能 → 描述任务，仅任务描述必填 | 用「新建任务」弹层承接会话创建，其余项给默认值 |
| 布局 | 左：任务列表；中：对话；右：产物/文件 | 三栏，右侧按需可折叠 |
| 执行 | 自主拆解步骤、逐步展示进度、可中断、可全程审计 | 事件流可视化 + 中止按钮 + 步骤时间线 |
| 权限 | 操作本地文件前需授权，可设置授权范围 | 工具调用前审批弹窗（risk-based） |
| 产物 | 交付可直接使用的文件，右侧可直接预览 | 右侧产物面板 + 变更 diff |
| 扩展 | 专家 / 技能 / 连接器（MCP）/ 资料库 | 映射到 pi 的 extensions / skills / MCP |
| 模式 | 办公模式 / 编程模式；模型档位 auto/快速/均衡/极致；Plan 模式 | 模式切换映射到 agent/prompt 预设与模型选择 |

### 1.2 远程部署约束（v0.2 新增背景）

用户的主使用场景是「桌面客户端 + 云服务器上的 pi」：pi 与其工作区、provider 凭据都位于云服务器，桌面端只是操作台。该约束带来四类新问题，贯穿本方案：

- **连接与进程生命周期分离**：一条远程连接可承载多个会话通道；连接断开不等于会话数据丢失。
- **事实来源异地化**：session JSONL 在云端，客户端不得自建并行的会话数据库，仅允许可失效的元数据缓存。
- **路径校验必须在远端**：客户端本地校验不能作为唯一防线，文件读写与产物 diff 的能力边界由云端判定。
- **断连默认安全**：断连或审批超时不得被解释为「放行」，也不得自动重放未完成的 prompt。

本地部署（pi 与客户端同机）保留为可选形态，用于开发调试与单机场景。

### 1.3 目标

- **G1 能力无损**：GUI 覆盖 pi 核心能力——会话（新建/恢复/分叉/分支）、流式对话、工具调用、模型与推理档位切换、扩展命令、MCP、技能、成本与 token 展示。
- **G2 形态借鉴**：任务中心化 + 三栏信息架构 + 执行可审计 + 产物可见。
- **G3 零内核分叉**：不 fork、不 patch pi；pi 独立升级即可让客户端获得新能力。
- **G4 可验证**：验收标准可被自动化测试或明确的人工步骤判定。
- **G5 安全默认**：渲染进程无 Node 权限；文件系统与命令执行能力只经主进程白名单转发；工具执行前可审批。
- **G6 远程可用**：在云服务器承载 pi 的前提下，连接建立、断连恢复、远程文件读取与产物预览均可用，且断连不产生数据错乱或重复执行。

### 1.4 非目标（v0.1 明确不做）

- 云端账号、积分、计费、团队协作。
- Office 二进制文档（docx/xlsx/pptx）渲染与人机双写。
- 移动端 / IM 端 / 小程序。
- 自建模型网关（沿用 pi 的 provider 与凭据体系）。

> 注：v0.2 的「网关」（§3）是**传输层**进程池，用于承载 pi RPC 帧与事件重放，不代理模型请求，与上述「自建模型网关」非目标不冲突。

---

## 2. 关键决策

### D1：桌面框架选 Electron（推荐）

| 方案 | 优势 | 劣势 | 结论 |
|---|---|---|---|
| **Electron + React + Vite** | 主进程即 Node 运行时，可直接 `import` pi SDK 做 in-process 嵌入；官方 `RpcClient` 可直接在 main 使用；Windows 打包成熟（electron-builder）；Chromium 渲染一致性高 | 安装包约 100MB+；内存占用较高 | **推荐** |
| Tauri 2 + React | 体积小、内存低 | Rust 侧无法直接跑 pi SDK，只能靠 RPC 子进程 + 用户机器上的 Node/pi；扩展 UI 桥与文件能力需双语言维护 | 备选，P2 可评估 |
| Web + 本地 server | 开发最快 | 无原生文件对话框/托盘/深链，安全边界弱 | 不采用 |

**理由**：pi 的唯一官方进程内集成面是 Node/Bun SDK，Electron 让「进程内」与「子进程」两种集成都保留在同一种语言栈内，避免双语言成本；且 pi 本身需要 Node 22.19+，Electron 主进程天然满足。`ssh2` 是纯 JS 实现，主进程可直接使用，无需额外原生依赖。

### D2：与 pi 的集成方式 —— 协议统一为 pi RPC，仅保留 RPC 通道实现

| 方式 | 优点 | 缺点 |
|---|---|---|
| RPC 子进程（`pi --mode rpc`） | 崩溃隔离；可与 CLI 共用同一份安装；会话文件天然一致；扩展 UI 有正式子协议；可多会话并行（每会话一进程） | 需定位可运行的 pi 入口；JSONL 序列化开销；启动有 ~百毫秒级延迟 |
| SDK in-process（`createAgentSession`） | 零序列化、延迟最低、可拿到全部对象引用 | pi 崩溃即拖垮窗口；扩展 UI 需要宿主自己实现；多会话共享一个进程，`PI_CODEMODE_MAX_WORKERS` 等资源竞争 |

**决策（v0.2 修订）**：抽象出 `PiConnection` + `PiTransport` 双层接口（见 §5.3），实现形式按链路分为 `LocalConnection`（`child_process` stdio）、`SshConnection`（`ssh2` exec，P0）、`GatewayConnection`（wss，P1）。**`SdkTransport` 移出规划**：SDK 必须在 pi 所在机器上跑 Node，远程部署下不适用，保留它会迫使 UI 层为两套语义做兼容。

### D3：进程粒度 —— 一个会话一个 pi 进程（本地子进程 / 远端 exec 通道）

理由：pi 的 `AgentSession` 绑定单一 cwd 与单一模型状态；进程级隔离让「中止/崩溃/重启」只影响单个任务，符合 WorkBuddy 的多任务并行体验。代价是每个空闲会话常驻一个 Node 进程；用「空闲 N 分钟回收 + 恢复时按 session 重放」缓解（回收阈值可配置，默认 30 分钟，仅回收已 settled 的会话）。远程形态下回收即关闭对应 exec 通道，连接本身保持。

### D4：单一事实来源 —— pi 的 session JSONL

会话列表、标题、token/成本、历史消息一律以 pi 落盘的 JSONL（`PI_CODING_AGENT_SESSION_DIR` 或 `~/.pi/agent/sessions/`）为准，客户端本地只存 UI 偏好（窗口位置、栏宽、上次工作目录、主题）与连接配置。禁止客户端自建一套并行的会话数据库，避免双写不一致。

v0.2 补充：远程部署下该 JSONL 位于云服务器（可经 `--session-dir` 显式指定），客户端**零持久化会话内容**；允许的本地缓存仅限元数据（列表摘要），且必须可失效（`session:list` 返回 `stale` 标记），`SessionMirror` 只读单向、禁止回写（见 §6.4）。

### D5：需要内置一个审批扩展，且安装在 pi 所在机器（待确认，见 §11-Q6）

pi 本身不内置「工具执行前人工确认」。RPC 提供 `extension_ui_request` / `extension_ui_response` 子协议，可由扩展发起确认。方案：分发一个 `permission`（`pi-desktop-permission`）扩展，在 `tool_call` 前置钩子中对高风险工具（bash / powershell / write / edit / 删除类）发起 `select` 型 UI 请求，客户端渲染为审批弹窗。

v0.2 补充：远程部署下扩展必须装在**云服务器**（本地安装无效）；超时 auto-resolve 出的 `undefined` 一律视为**拒绝**，否则断网将默认放行，违背 G5。

---

## 3. 部署模式

### 3.1 路径对比

| 维度 | (a) SSH 隧道 stdio | (b) 常驻网关 + WSS | (c) 仅同步 JSONL |
|---|---|---|---|
| 实现成本 | 低：`exec` 通道即双向流，与本地子进程同构 | 中高：自研路由/鉴权/重放/多客户端 | 低，但只读 |
| 云端依赖 | 仅 sshd + 已装 pi | 常驻服务、守护、TLS 证书 | 仅 sshd |
| 交互能力 | 完整（prompt/abort/审批/切模型） | 完整 | 无 |
| 断连语义 | 连接断开 → pi 收到 stdin EOF → 有序退出，会话已落盘 | 云端继续跑，客户端断开无影响 | — |
| 重连 | 重新 exec + `get_messages` 全量对齐（秒级） | 按 seq 重放增量（毫秒级，零重跑） | 重拉文件 |
| 多会话 | 同连接多 channel | 单连接多路复用 | 只读 |
| 安全面 | 复用 SSH 信任模型（known_hosts/密钥/2FA） | 需自建鉴权 + TLS + 端口暴露 + 限流 | 复用 SSH |
| 可观测 | 弱（仅 stderr 尾部） | 强（集中日志/指标） | 弱 |

**结论与推荐（分阶段，接口先定型）**

1. **P0（MVP）`SshTransport`**：`ssh2.Client.exec('pi --mode rpc ...')` 得到双向字节流。零云端部署、零新增攻击面、完全复用 pi 官方 RPC 协议。
2. **P1 `GatewayTransport`**：云端常驻 `pi-gateway`（进程池 + 事件 seq 环形缓冲 + token 鉴权 + 审计）。仅在出现「关掉客户端任务继续跑」「多设备同看一个会话」需求时投入。
3. **P2 `MirrorTransport`**：仅只读浏览/搜索远端 session JSONL，作为列表加速与离线查看补充，不作主交互通道。

否决「只做网关」：把可用性推迟到一段服务端代码写完并部署成功之后，且引入对外端口；SSH 路径可在一周级可用，同时把重连语义先练出来。

**模式矩阵**

| 维度 | 本地（Local） | 远程-SSH（默认） | 远程-Gateway（P1） |
|---|---|---|---|
| 通道 | `child_process` stdio | `ssh2` exec（**无 PTY**） | `wss` |
| 会话文件 | 本地 | 云端，客户端不落盘 | 云端 |
| 文件访问 | 本地 fs | SFTP + 只读 exec | 网关 fs RPC |
| 断连行为 | 不适用 | pi 退出、会话保留 | pi 继续跑 |
| 目标用户 | 开发调试/单机 | **主场景** | 多设备/长任务 |

**六项关键架构变化（v0.1 → v0.2）**

| # | 变化 | 理由 |
|---|---|---|
| 1 | `PiTransport` 拆为 `PiConnection`（物理连接 + 状态机）与 `PiTransport`（一会话一通道） | 远程下连接与进程生命周期分离：一条 SSH 连接可承载多 channel |
| 2 | 协议唯一：只用 pi RPC JSONL；`SdkTransport` 移出规划 | SDK 必须在 pi 所在机器跑 Node，远程不适用 |
| 3 | 事实来源仍是 pi session JSONL，但位于云端；客户端**零持久化会话内容** | 避免双写不一致；允许的本地缓存仅限元数据且必须可失效 |
| 4 | 凭据分层：provider key 只在云端；SSH 口令/token 走 `safeStorage` | 渲染进程永不接触密钥 |
| 5 | 新增 `RemoteFs`，路径校验**在远端**执行；产物 diff 优先走 `git status/diff` | 本地校验不能作为唯一防线 |
| 6 | 审批扩展必须装在**云端**，超时 auto-resolve 出的 `undefined` 一律视为**拒绝** | 否则断网默认放行，违背安全目标 |

### 3.2 连接配置模型（两模式共用，仅以引用存密钥）

```ts
type ConnectionConfig =
  | { kind: 'local'; id: string; label: string }
  | { kind: 'ssh'; id: string; label: string; host: string; port: number; username: string;
      auth: { type: 'key'; privateKeyPath: string; passphraseRef?: string }
          | { type: 'agent' }
          | { type: 'password'; passwordRef: string };
      hostKeyPolicy: 'strict' | 'tofu';   // tofu = 首次指纹确认后固定
      piCommand: string;                  // 默认 'pi'，可填绝对路径
      sessionDir?: string;                // 远程 --session-dir
      workspaceRoots: string[];           // 允许浏览/读取的远端根
      keepAliveMs: number }               // 默认 15000
  | { kind: 'gateway'; id: string; label: string; url: string; tokenRef: string; workspaceRoots: string[] }
```

约束：配置 JSON 只允许出现 keychain **引用名**；zod schema 拒绝疑似明文密钥字段；renderer 只能拿到脱敏视图。

### 3.3 连接自检（三步，失败必须给出可操作提示）

1. `command -v <piCommand> && <piCommand> --version` → 存在性与版本；
2. `--help` 或版本表 → 确认支持 `--mode rpc` 与 `--session-dir`；
3. 列 `sessionDir`（SFTP 或 `ls -1`）→ 可读性。

失败示例提示：「PATH 中找不到 pi，请填写绝对路径，例如 /home/u/.npm-global/bin/pi」。

---

## 4. 整体架构

### 4.1 本地部署架构（原图，保留）

```
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
│  │ IpcRouter  │→ │ SessionService│→ │ PiTransport│→ │ pi child proc│  │
│  │ (zod 校验)  │  │ (生命周期)     │  │(Local/Ssh) │  │ --mode rpc   │  │
│  └────────────┘  └───────────────┘  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌───────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ ConfigStore│  │ SessionIndex  │  │ FsBridge   │  │ TranscriptLog│  │
│  │ (偏好)      │  │ (JSONL 只读)   │  │ (白名单 FS) │  │ (诊断/回放)   │  │
│  └────────────┘  └───────────────┘  └────────────┘  └──────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                    │ JSONL over stdio (严格按 LF 分帧)
                                    ▼
                    ~/.pi/agent/sessions/**/*.jsonl  (事实来源)
```

### 4.2 远程部署架构（v0.2 新增）

```
Electron (桌面)
  Renderer: TaskList | Conversation | Artifacts
        ▲ window.pi (IPC + zod)
  Main: ConnectionManager → SshConnection (ssh2, keepalive, host key 校验)
            │ exec channel #1..N: 'pi --mode rpc --session-dir ...'
            ├ SFTP / 只读 exec: 列目录、stat、range 读、git status/diff
            ├ SessionIndex / SessionMirror(内存 LRU) / RemoteFs
            └ stderr 环形缓冲 → 诊断
        ▲
        │ SSH (严格 host key，无 PTY)
        ▼
云服务器: pi 进程 + session JSONL + 工作区文件
```

**网关模式（P1）附加帧类型**（仅传输包装，不改 pi 协议）：

```
C→S { t:'attach', sessionKey, lastSeq?, resume?:{sessionFile} }
C→S { t:'cmd', sessionKey, rec: RpcCommand }        // 原样透传
C→S { t:'ctl', op:'list'|'fs'|'ping'|'detach' }
S→C { t:'evt', sessionKey, seq, rec: RpcRecord }    // seq 单调递增
S→C { t:'ack', sessionKey, seq } | { t:'err', code, message }
```

---

## 5. 模块与接口划分

### 5.1 目录结构（约定）

```
pi-desktop/
  package.json
  electron.vite.config.ts
  src/main/            # 主进程
    index.ts           # app 生命周期、窗口创建
    window.ts          # BrowserWindow 配置（安全项集中在此）
    ipc/router.ts      # ipcMain.handle 注册 + zod 入参校验 + 错误规范化
    services/session-service.ts
    services/session-index.ts
    services/session-source.ts   # 会话文件读取抽象（local / ssh / gateway）
    services/session-mirror.ts   # 远端会话元数据内存 LRU（只读单向，P1 起用）
    services/config-store.ts
    services/fs-bridge.ts        # 本地文件能力
    services/remote-fs.ts        # 远端文件能力抽象
    services/ssh-fs.ts           # RemoteFs 的 SFTP/只读 exec 实现
    transport/types.ts # PiConnection / PiTransport / SessionSource / RemoteFs 抽象
    transport/local-connection.ts
    transport/ssh-connection.ts
    transport/gateway-connection.ts  # P1
    transport/jsonl-reader.ts    # LF 分帧读取器（关键，三实现共用）
  src/preload/index.ts # contextBridge 暴露 window.pi（唯一入口）
  src/renderer/        # React
    app/               # 路由与布局
    features/tasks/    # 左栏任务列表、新建任务弹层
    features/chat/     # 消息流、markdown、代码块、工具卡片、时间线
    features/artifacts/ # 产物面板、diff 视图、文件预览
    features/settings/ # 模型/provider/权限/主题
    features/connections/ # 连接配置、连接自检向导、远程目录浏览器
    stores/            # zustand：sessionStore、runStore、artifactStore、connStore
    lib/reducer.ts     # 事件归约器（纯函数，重点单测对象）
  src/shared/          # 主/渲染共享
    contracts/         # DTO 与 zod schema（IPC 与事件）
    ipc-channels.ts
  tests/
    unit/ integration/ e2e/
```

### 5.2 主进程模块职责

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `window.ts` | 创建 BrowserWindow；强制 `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`；拦截 `will-navigate` 与 `setWindowOpenHandler` | 不向渲染进程注入任何 Node 能力 |
| `ConnectionManager` | 管理 `ConnectionConfig` 的生命周期与状态机；按 id 取连接；连接级资源与诊断汇总 | 不解析会话语义，不持有会话状态 |
| `PiConnection` 实现 | `LocalConnection`（子进程）、`SshConnection`（ssh2 exec + keepalive + host key 校验）、`GatewayConnection`（P1）；`openChannel` 产出一会话一通道 | 不做业务状态机 |
| `Transport`（Channel） | 启动/停止 pi 进程（本地）或 exec（远端）；写命令；读事件；进程退出与错误上报 | 不做业务状态机 |
| `SessionService` | 会话生命周期与资源回收；`create/resume/fork/prompt/abort/dispose`；进程级串行化 | 不解析会话语义 |
| `SessionIndex` / `SessionSource` | 只读扫描/读取 session JSONL，产出列表（id、标题、cwd、mtime、token、成本）；`SessionSource` 抽象 local/ssh/gateway 三种来源 | 不写会话文件 |
| `SessionMirror` | 远端会话元数据内存 LRU，供列表加速与离线查看 | **只读单向，禁止回写远端** |
| `FsBridge` | 本地文件对话框、受限读写（仅工作区内 + 显式授权路径）、产物列表与 diff | 不做通用 fs 代理 |
| `RemoteFs` | 远端列目录/stat/range 读/只读 git 命令；**路径校验在远端执行** | 不做本地路径校验替代品 |
| `ConfigStore` | 偏好与连接配置持久化（`app.getPath('userData')/config.json`），schema 校验 + 迁移；密钥仅存引用名 | 不存会话内容，不存明文密钥 |
| `IpcRouter` | 通道注册、入参 zod 校验、错误码映射、超时 | 不含业务逻辑 |

### 5.3 `PiConnection` / `PiTransport` 接口（核心抽象）

```ts
interface PiConnection {
  readonly id: string;
  state(): 'disconnected'|'connecting'|'ready'|'degraded'|'reconnecting'|'failed';
  onStateChange(cb: (s: string, info?: unknown) => void): () => void;
  openChannel(opts: OpenChannelOptions): Promise<PiTransport>;   // 一会话一通道
  dispose(): Promise<void>;
}

interface PiTransport {               // 与 v0.1 等价，仅增 link 元信息
  readonly channelId: string;
  readonly link: 'local' | 'ssh' | 'gateway';
  start(opts: { cwd: string; model?: string; thinkingLevel?: string; sessionFile?: string; extraArgs?: string[] }): Promise<void>;
  send(cmd: RpcCommand, id?: string): void;
  onRecord(l: (rec: RpcRecord) => void): () => void;
  onExit(l: (i: { code: number|null; signal: string|null; stderrTail: string }) => void): () => void;
  stop(): Promise<void>;
}

interface SessionSource {
  list(o: { cwd?: string; limit?: number; cursor?: string }): Promise<SessionSummary[]>;
  stat(f: string): Promise<{ mtime: number; size: number }>;
  readTail(f: string, maxBytes: number): Promise<string>;
  readAll(f: string): Promise<string>;          // 50MB 上限
}

interface RemoteFs {
  list(dir: string): Promise<DirEntry[]>;
  stat(p: string): Promise<FileStat>;
  readText(p: string, o: { offset?: number; limit: number }): Promise<{ text: string; truncated: boolean }>;
  readBinary(p: string, maxBytes: number): Promise<{ data: Uint8Array }>;
  execReadonly(cmd: 'git-status' | 'git-diff', args: string[]): Promise<{ stdout: string; code: number }>;
}
```

契约要点：
- `send` 只保证「写入」，不保证被接受；接受与否由匹配 `id` 的 `response.success` 表达。
- 命令必须支持并发在途（异步处理），客户端**按 id 关联**，不得依赖响应顺序。
- 子进程 stdout **只**承载协议记录；stderr 单独收集环形缓冲（最后 200 行）供诊断展示。
- `openChannel` 是远程形态的唯一会话入口：连接可用但通道失败必须落到通道级错误，不得把连接标记为 `failed`。
- 三个实现（local / ssh / gateway）共用同一个 `JsonlReader`，分帧语义不得分叉。

### 5.4 IPC 契约（`window.pi`，渲染进程唯一出口）

统一形态：`invoke(channel, payload) -> Promise<Result<T>>`，`Result<T> = { ok: true, data: T } | { ok: false, error: { code: string, message: string, detail?: string } }`。

| 通道 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `conn:list` | `{}` | `ConnectionConfigView[]` | 连接配置脱敏列表 |
| `conn:test` | `{ config }` | `SelfCheckResult` | 三步自检（§3.3），不建立会话 |
| `conn:connect` | `{ configId }` | `{ state }` | 建立物理连接（不启动 pi） |
| `conn:disconnect` | `{ configId }` | `{ ok: true }` | 断开物理连接，释放所有通道 |
| `conn:pickRemoteDir` | `{ configId, path?, mode: 'file'|'dir' }` | `{ path }` | 远程目录浏览器，替代原生对话框 |
| `session:list` | `{ configId, cwd?, cursor? }` | `{ items, nextCursor, stale }` | `stale=true` 表示来自缓存 |
| `session:create` | `{ configId, cwd, model?, mode?, name? }` | `{ sessionKey, sessionId }` | 启动子进程/exec 通道 |
| `session:resume` | `{ configId, sessionFile }` | `{ sessionKey }` | 恢复既有会话 |
| `session:fork` | `{ sessionKey, messageId? }` | `{ sessionKey }` | 新建分支会话 |
| `session:reconnect` | `{ sessionKey }` | `{ sessionKey }` | 断连后重开通道并全量对齐（§6.4） |
| `session:prompt` | `{ sessionKey, message, images?, streamingBehavior? }` | `{ disposition }` | 流式中必须带 `streamingBehavior` |
| `session:abort` | `{ sessionKey }` | `{ ok: true }` | 中止并等 idle |
| `session:dispose` | `{ sessionKey }` | `{ ok: true }` | 释放子进程/通道 |
| `session:state` | `{ sessionKey }` | `AgentState` | models / thinkingLevel / 队列 / 成本 |
| `model:list` | `{ configId }` | `ModelInfo[]` | provider/model/cost |
| `model:set` | `{ sessionKey, model, thinkingLevel? }` | `{ ok: true }` | |
| `extui:respond` | `{ sessionKey, requestId, response }` | `{ ok: true }` | 回 `extension_ui_response` |
| `fs:pickDirectory` | `{ defaultPath? }` | `{ path }` | 原生对话框（仅本地连接） |
| `fs:listArtifacts` | `{ sessionKey }` | `ArtifactEntry[]` | 工作区内变更/新建文件 |
| `fs:readText` | `{ path, maxBytes }` | `{ text, truncated }` | 仅工作区/授权路径 |
| `fs:diff` | `{ path, sessionKey }` | `UnifiedDiff` | 相对会话起始快照 |
| `artifact:open` | `{ sessionKey, path }` | `{ localPath }` | 远端产物下载到临时目录后打开，关闭即清理 |

事件通道（main → renderer，`webContents.send`）：

| 通道 | 载荷 | 频率策略 |
|---|---|---|
| `evt:record` | 归一化后的 session 事件 | 逐条，`text_delta` 合并窗口 16ms |
| `evt:extui` | `extension_ui_request` | 逐条，需 UI 立即响应 |
| `evt:status` | 进程状态（starting/running/settled/exited/restarting） | 状态变更时 |
| `evt:diagnostic` | stderr 摘要、崩溃信息 | 变更时 |
| `evt:conn` | 连接状态机变更（`idle/connecting/ready/degraded/reconnecting/failed`） | 状态变更时 |
| `evt:netstat` | RTT、seq 水位 | 采样 1s，供 UI 降级提示 |

### 5.5 渲染进程模块

| 模块 | 职责 |
|---|---|
| `stores/sessionStore` | 会话元数据、选中会话、消息树（按 branch） |
| `stores/runStore` | 当前运行状态：`idle / streaming / tool_running / awaiting_approval / settling` |
| `stores/artifactStore` | 产物列表与选中产物 |
| `stores/connStore` | 连接配置列表、连接状态、断连横幅与重连入口 |
| `lib/reducer.ts` | **纯函数**：`(state, record) => newState`，消费合并后的记录；负责把 delta 增量拼接，并在 `message_end` 用权威消息整体替换 |
| `features/chat/ToolCard` | 工具名、参数摘要（可展开全文）、耗时、状态、输出前 N 行 + 展开 |
| `features/chat/Timeline` | 按 assistant turn 分组的步骤时间线 |
| `features/artifacts/DiffView` | unified diff 着色、按文件折叠 |
| `features/connections` | 连接配置表单、自检向导、远程目录浏览器 |
| `features/settings` | 模型/provider、推理档位、审批策略、主题、快捷键 |

---

## 6. 数据流

### 6.1 启动

1. `app.whenReady` → 读 ConfigStore → 创建窗口 → 载入 preload。
2. Renderer 挂载后调用 `conn:list`；若有默认连接则 `conn:connect`（或按需懒连接）。
3. 调用 `session:list`（带 `configId`），主进程经 `SessionSource` 扫描返回摘要；远端结果可能来自 `SessionMirror`，此时 `stale=true`。
4. 若配置了 `lastCwd`，默认选中该 cwd 的最近会话并展示（**不自动 resume 进程**，仅回放 JSONL 到 UI，首次发送消息时才启动子进程/通道）。

### 6.2 单轮对话（主链路）

```
用户输入 (renderer)
  → 乐观插入 user 消息
  → window.pi.invoke('session:prompt', {sessionKey, message, streamingBehavior?})
  → IpcRouter 校验 → SessionService → Transport.send({type:'prompt',...})
  → pi stdout: response(prompt, disposition=started|queued|handled)
      · handled → 不等待 settled，直接结束本轮 UI 等待
  → pi stdout: message_update / tool_execution_* / message_end / ...
  → JsonlReader 按 LF 切分 → 解析 → Transport.onRecord
  → IpcRouter 合并 text_delta（16ms）→ evt:record → renderer
  → reducer 更新 runStore/消息树 → 增量渲染
  → message_end：用权威消息覆盖增量内容（防止拼接漂移）
  → agent_settled：runStore → idle，刷新 SessionIndex（token/成本/标题）
```

**关键约束**：`prompt` 的 `success` 只代表「已接受/已排队/已被扩展处理」，不代表模型已完成。UI 的「完成」判定必须挂 `agent_settled`，而不是 `prompt` 的响应。远程链路下该约束同样成立：连接抖动不得被折算成 `agent_settled`。

### 6.3 工具审批（extension UI 子协议）

```
pi: tool_call 前置钩子 (permission 扩展，安装在 pi 所在机器)
  → 扩展发起 extension_ui_request (kind=select, 选项: 允许一次/本会话允许/拒绝)
  → Transport.onRecord → evt:extui → 审批弹窗
  → 用户选择 → extui:respond({requestId, response})
  → Transport.send({type:'extension_ui_response', id: requestId, ...})
  → 扩展据此放行或拒绝 → 工具执行或返回拒绝结果
超时（默认 120s 无响应）→ 客户端发送「拒绝」并提示
会话销毁 → 对所有未决请求发送拒绝，避免 pi 侧挂起
```

断连期间的审批语义见 §6.4。

### 6.4 断连与恢复（v0.2 新增核心小节）

状态机：`idle → connecting → ready ⇄ degraded → reconnecting → ready | failed`（退避 1/2/4/8/15s，上限 5 次）。

**SSH 语义**
1. 断连 → pi 收到 stdin EOF → 有序退出，会话已落盘，客户端不会把断连伪装成「完成」。
2. 2s 内显示横幅「连接已中断，会话已保存」，禁用发送。
3. `session:reconnect`：重开 `exec` 同 `--session <file>` → `get_state` + `get_messages` → 与镜像集合对齐（远端为准，丢弃未确认增量）。
4. **不自动重放未完成的 prompt**：显示「上次运行被中断」+「重发」按钮（原文回填，用户确认），避免副作用重复执行。
5. 认证失败 / host key 变更 → 直接 `failed`，不重试。

**网关语义**：带 `lastSeq` 重连 → 缓冲命中则仅重放增量；缓冲被覆盖 → `err{code:'GAP'}` → 回退 `get_messages` 全量快照；网关重启 → 按 SSH 语义处理。

**审批在断连期间**：主进程缓存未决请求，重连后重弹；TTL 60s 超时按拒绝回执并告知用户。

**产物流**：`agent_settled → git status（只读）→ 变更列表 → 按需 git diff（2MB 上限）`；非 git 用「会话开始快照（size+mtime+sha1 前 1MB）→ 重扫」；预览按 range 读 64KB，二进制/超大走 `artifact:open`（下载到 temp，关闭即清理）。

### 6.5 会话恢复 / 崩溃恢复

- 恢复：`session:resume` → 启动子进程/通道（带既有 session 文件）→ `session:state` 拉全量 → 用 JSONL 回放渲染历史 → 订阅事件。
- 崩溃：`onExit` 非 0 → `evt:diagnostic` 显示 stderr 尾部 → 提示「重连」。重连 = 新进程 + 同一 session 文件；**不自动重放未完成的 prompt**（避免重复执行有副作用的工具），改为展示「上次运行被中断」的系统消息并允许用户重发。
- 连接级断连（SSH/网络）与进程级崩溃的差异处理见 §6.4。

---

## 7. 实现约束清单（易错点，executor 必读）

1. **分帧**：严禁用 Node `readline` 读 stdout——它会按 `U+2028`/`U+2029` 切分，而这些字符在 JSON 字符串内合法。必须自写字节/UTF-8 流读取器，**只在 LF 处切分**，并剥离可选的前导 CR。
2. **背压**：必须持续读取 stdout；停止读取会阻塞 pi。写 stdin 需处理 `drain`。
3. **stdout 纯净**：日志一律走 stderr；客户端不得向子进程 stdout 写入非协议内容。
4. **并发在途**：命令必须带唯一 `id`，按 id 关联；不能用「顺序」假设。
5. **流式中发送**：会话 busy 时 `prompt` 必须带 `streamingBehavior`（`steer` / `followUp`），否则 pi 直接返回错误——UI 要区分「打断当前步」与「排队」两个按钮语义。
6. **关停顺序**：关闭 stdin 请求有序退出，给足时间后 kill；不要在 dispose 时立刻 kill 造成会话文件截断。
7. **消息权威性**：`message_end` 覆盖增量；`agent_end` ≠ 结束（后面可能还有重试/压缩/排队消息），只认 `agent_settled`。
8. **路径安全**：`fs:*` 一律先 `path.resolve` 再校验是否位于已授权根目录内（防 `..` 与符号链接逃逸）。
9. **凭据隔离**：API key 只存在主进程/pass by env 传给子进程，渲染进程永不接触。
10. **单实例**：`app.requestSingleInstanceLock()`，第二个实例聚焦已有窗口并转发深链参数。
11. **SSH 必须无 PTY**：只用 `exec`，禁止 `shell()` 或 `pty:true`（PTY 会回显输入并把 LF 转 CRLF，破坏 JSONL）。
12. **启动横幅污染**：若用登录 shell，命令写 `exec pi --mode rpc ...`；自检阶段若首条记录不是合法 JSON，判定 `PROTOCOL` 污染并给出诊断，不进入坏状态。
13. **命令注入**：远端 exec 参数一律 POSIX 单引号转义（含 `'`、`$()`、反引号、换行）；`piCommand`、`sessionDir` 同规则。
14. **重连不重放**：禁止自动重发 prompt / 自动重试工具调用。
15. **镜像单向**：`SessionMirror` 只从远端同步，禁止回写。
16. **超时预算**：连接 10s、单命令 60s（`prompt` 除外，走事件）、审批 120s（与扩展侧一致）、SFTP 30s；可配置但不得为 0。
17. **大小上限**：`readAll` 50MB、预览 64KB、diff 2MB、stderr 200 行/64KB；超限必须显式提示。

---

## 8. MVP 范围与里程碑

### 8.1 MVP（v0.2）必做

- **M1 骨架**：Electron + Vite + React + TS；安全窗口配置；preload 白名单；IPC 路由 + zod；单测可跑。
- **M2 通道层**：`JsonlReader`（LF-only，三实现共用）+ `PiConnection`/`PiTransport` 接口 + `LocalConnection`；能完成「创建会话 → 发一句 → 流式看到回复 → 正常退出」。
- **M3 远程通道（新）**：`SshConnection`（host key 严格/tofu、key/agent/口令、keepalive、无 PTY）+ 三步自检 + `RemoteFs`(SFTP) + `SessionSource`(远端分页) + 连接配置 UI。
- **M4 界面**：三栏布局、任务列表、消息流（markdown + 代码高亮）、工具卡片、时间线、停止按钮、错误条、**连接状态条与断连横幅**。
- **M5 体验**：新建任务弹层（**远程目录浏览器**、模型选择、会话名）、模型/推理档位切换、恢复与分叉（`switch_session`/`fork`/`clone`）、`get_session_stats` 成本与 token 展示。
- **M6 审批**：`pi-desktop-permission` 扩展（云端安装脚本 + 版本握手）+ 审批弹窗 + 超时/断连即拒绝。
- **M7 产物**：远端产物列表（git 优先）+ unified diff 预览 + 文本预览 + 下载打开。
- **M8 断连恢复（新）**：连接状态机 + `session:reconnect` + 全量对齐 + 「上次运行被中断」语义。

> 移除 `SdkTransport`（原 P2 项作废，理由见 §3.1「六项关键架构变化」#2）。

### 8.2 P1 候选

网关（seq 重放 / 多客户端 / 鉴权 / 审计）；多标签并行任务视图；图片/文件拖拽输入（`prompt` 的 `images` 字段）；扩展命令面板（斜杠命令）；MCP 服务器管理 UI；主题与快捷键自定义；导出会话（HTML/JSONL）。

### 8.3 P2 候选

只读镜像搜索（`MirrorTransport`）；独立 PTY 终端面板；Office 文档预览；内嵌文件浏览器（多标签 + 右侧 AI 栏）；多连接在线。

---

## 9. 测试矩阵

### 9.1 单元（Vitest）

| ID | 场景 | 期望 |
|---|---|---|
| U1 | `JsonlReader` 收到跨 chunk 边界的半个 JSON | 补齐后产出 1 条记录，不产出半条 |
| U2 | JSON 字符串内含 `U+2028`/`U+2029` | 不切分，1 条记录 |
| U3 | CRLF 行 | 剥离 CR 后正常解析 |
| U4 | 非法 JSON 行 | 不崩溃，产出 parse 诊断，后续行继续 |
| U5 | `reducer` 处理 `text_delta` 序列后接 `message_end` | 最终文本 == `message_end` 权威文本 |
| U6 | `reducer` 收到重复 `message_end` | 幂等，不重复追加 |
| U7 | `agent_end` 后仍有排队事件 | 状态保持 `settling`，直到 `agent_settled` |
| U8 | IPC 入参缺字段/类型错 | 返回 `ok:false, code:VALIDATION`，不进入业务层 |
| U9 | `fs:readText` 路径含 `../` 或指向授权外符号链接 | 拒绝，`code:PATH_DENIED` |
| U10 | 审批请求超时 | 自动发送拒绝响应且 UI 状态复位 |
| U11 | 连接状态机非法迁移（如 `failed → ready` 直接跳跃） | 状态不倒退，非法迁移被拒绝并记录 |
| U12 | POSIX 单引号转义函数对 `'`、`$()`、反引号、换行 | 输出不可逃逸出单引号包裹，无额外命令 |
| U13 | 重连对齐：本地有未确认增量、远端已多出消息 | 以远端为准，不重复、不丢条 |
| U14 | 二次聚合（增量拼接后再整体替换）前后文本 | 完全一致，幂等 |
| U15 | 网关事件 seq 出现空洞 | 触发 `GAP`，回退全量快照 |
| U16 | `readTail` 作用于 100MB 会话文件 | 只读尾部、不 OOM、不整文件载入 |
| U17 | 连接配置 schema 遇到疑似明文密钥字段 | 拒绝并给出字段路径 |

### 9.2 集成（主进程 + 真实/mock pi 子进程）

| ID | 场景 | 期望 |
|---|---|---|
| I1 | 启动 → prompt → 收到完整事件序列 → settled | 记录顺序符合 golden JSONL，UI 状态回 idle |
| I2 | 会话 busy 时无 `streamingBehavior` 的 prompt | 客户端报错并提示，不挂起 |
| I3 | `steer` 与 `followUp` 分别注入 | 消息插入时机符合协议（当前轮工具调用后 / 整轮结束后） |
| I4 | `abort` 运行中的会话 | 在合理时间内回 idle，进程存活可继续用 |
| I5 | 子进程被强杀 | `evt:diagnostic` 收到 stderr 尾部，UI 显示「重连」，重连后可继续对话 |
| I6 | 扩展命令（`/xxx`）经 prompt 发送 | `disposition=handled`，客户端不等待 settled |
| I7 | 恢复既有 session 文件 | 历史消息与 pi 内部状态一致（消息数、末条内容） |
| I8 | 10 个会话并行进程 | 无端口/资源冲突；空闲回收后恢复可用 |
| I9 | 高频 `text_delta`（>500 条/秒） | 主进程合并后 renderer 帧率不下降（CPU 采样断言） |
| I10 | `iptables DROP` 制造 30s 断网后恢复 | 重连后消息条数与末条哈希与远端 JSONL 一致 |
| I11 | 云端 `kill -9` 后重连 | 无重复工具执行记录 |
| I12 | RTT 200ms + 2% 丢包 | 无错帧（JSONL 解析零失败），首 token 增量 ≤ 1.5×RTT |
| I13 | 远端工具输出 >100KB | 可经 `RemoteFs` 按需读取 `fullOutputPath`，不整块推入 UI |
| I14 | 同一连接上 3 个会话并行 | 事件不串流，通道互不干扰 |
| I15 | 审批等待期间断连并超过 TTL | 视为拒绝生效，重连后流程继续 |
| I16 | 网关事件缓冲溢出 | 回退 `get_messages` 全量快照，无静默丢事件 |
| I17 | 云端未安装 `pi-desktop-permission` 扩展 | UI 显式告警（高风险工具不静默放行） |
| I18 | 登录 shell 启动横幅污染首条记录 | 判定 `PROTOCOL`，给出诊断且不进入坏状态 |

### 9.3 E2E（Playwright + Electron）

| ID | 场景 | 期望 |
|---|---|---|
| E1 | 首次启动（无配置） | 显示空态与「新建任务」引导，无报错 |
| E2 | 新建任务 → 选目录 → 发送「列出当前目录」 | 流式出现回复，工具卡片显示 bash 调用与输出 |
| E3 | 审批弹窗「拒绝」 | 工具未执行，对话中显示拒绝结果，流程继续 |
| E4 | 点击停止 | 300ms 内按钮变为不可用并显示已中止，会话可继续发新消息 |
| E5 | 关闭窗口再打开 | 任务列表仍在，选中会话历史完整 |
| E6 | 触发主进程异常（mock 抛出） | 显示错误对话框，不白屏 |
| E7 | 首次连接向导（3 步） | 可完成；指纹不符立即阻断且不落配置 |
| E8 | 断网 → 横幅 → 重连 → 继续对话 | 无重复消息，发送按钮恢复可用 |
| E9 | 本地/远程连接来回切换 | 无残留路径与残留会话，上下文隔离 |
| E10 | 远端产物 diff 与临时文件打开 | 预览正确；关闭后临时文件被清理 |

### 9.4 安全测试

| ID | 场景 | 期望 |
|---|---|---|
| S1 | renderer 尝试 `require('fs')` | 失败（无 Node 集成） |
| S2 | 渲染进程调用未注册的 IPC 通道 | 拒绝 |
| S3 | 恶意 markdown 内嵌 `<script>` / `javascript:` 链接 | 不执行，链接被拦截 |
| S4 | `will-navigate` 到外部 URL | 阻止并交给 `shell.openExternal` 前确认 |
| S5 | 检查打包产物 | 无 API key 落盘到 userData；日志不含 token |
| S6 | 远端 host key 变更 | 连接阻断，不降级为 tofu 放行 |
| S7 | 网关 token 缺失/过期 | 拒绝连接，错误信息不泄露细节 |
| S8 | 远端越权路径（`../../etc/passwd`、根外符号链接） | 由**远端**拒绝，不依赖本地校验 |
| S9 | renderer 尝试读取口令/私钥明文 | 无法获取（仅引用名，密钥在 `safeStorage`） |
| S10 | 伪造其他通道 id 的审批请求 | 拒绝，只接受当前通道 id 的请求 |
| S11 | exec 参数注入（`; rm -rf`、`$(...)`） | 不产生额外命令 |

---

## 10. 验收标准

**功能**
- A1 新建会话后 1 次点击即可发送首条消息，首次 token 在 1.5s 内出现（本地 mock provider 基准）；**远程基准：RTT ≤ 50ms 时首 token ≤ 2.5s**。
- A2 任意一轮对话中，工具调用在 UI 上可见「名称 + 参数摘要 + 状态 + 输出」，且与 pi 事件一一对应。
- A3 会话列表能正确展示至少 20 个历史会话的标题、时间、cwd、token 与成本，且与 JSONL 一致。
- A4 支持恢复、分叉；分叉后原会话文件字节不变。
- A5 高风险工具在默认策略下 100% 触发审批；「本会话允许」在同一 sessionKey 内不再重复弹窗。
- A5b 可保存 ≥3 个连接配置（含本地与远程），切换后上下文隔离。

**健壮性**
- A6 强杀 pi 子进程后，UI 在 2s 内呈现可操作的重连入口，重连后历史完整、可继续对话。
- A7 连续 30 分钟高频对话（>200 轮）无内存单调增长（渲染进程 RSS 增长 < 30%）。
- A8 空闲 30 分钟后会话进程被回收，再次点击不报错。

**安全**
- A9 S1–S5 全部通过；`npm run audit:security` 无高危项。

**工程**
- A10 `npm run typecheck`、`npm run lint`、`npm run test:unit`、`npm run test:e2e` 全绿；CI 在 Windows 上通过。
- A11 打包产物可在干净 Windows 10/11 x64 机器上安装并启动（无预装 Node 依赖要求，pi 通过配置项指定可执行文件）。

**远程与连接（v0.2 新增）**
- A12 断网 30s 恢复：≤5s 出现重连入口，重连后消息条数与远端 JSONL 完全一致。
- A13 RTT 100ms / 丢包 1% 下无 >300ms 渲染卡顿，`agent_settled` 正常到达。
- A14 重连不产生任何自动重发或重复工具执行。
- A15 provider key 不出现在桌面端 userData / 日志 / 崩溃转储（自动化扫描）。
- A16 越权用例 100% 由远端拒绝，本地校验非唯一防线。
- A17 三适配层（local / ssh / gateway）均有单测，替换实现不改 renderer（以「新增 mock 连接」回归证明）。

---

## 11. 待用户确认项

| ID | 问题 | 建议 |
|---|---|---|
| Q1 | 云服务器 SSH 是否可用（端口、密钥登录、是否有堡垒机/跳板） | 必须明确；若不可用则默认路径切为网关 |
| Q2 | 是否允许云端常驻网关（systemd 自启） | 先规划允许，但 MVP 不阻塞 |
| Q3 | 云端 pi 启动方式（PATH / 绝对路径 / node dist/cli.js） | `piCommand` 配置项，默认 `pi`，自动探测 |
| Q4 | 会话目录是否显式 `--session-dir` | 建议显式，便于备份与授权根划分 |
| Q5 | `workspaceRoots` 范围 | 建议单项目目录，按连接可加白名单 |
| Q6 | 审批默认策略 | 仅高风险（bash/powershell/write/edit/delete） |
| Q7 | 断连期间是否要后台继续执行 | 要 → 网关升为 P0 |
| Q8 | 是否需要多设备同看同一会话 | 是 → 网关升为 P0 |
| Q9 | 主题与品牌 | 沿用 pi |
| Q10 | 是否需要办公模式预设 | 延后到 M5 之后 |

---

## 12. 参考来源

- pi 文档（本地安装）：`README.md`、`docs/sdk.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`docs/cli-integration.md`、`docs/sessions.md`、`docs/environment-variables.md`、`docs/session-format.md`、`docs/json.md`、`docs/extensions.md`
- WorkBuddy：`https://www.workbuddy.ai/docs/workbuddy/Overview`、`/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Task-Bar`、`https://www.workbuddy.cn/work/`、社区手册 `https://neohoy.github.io/workbuddybook/start/`
- `ssh2`（Node SSH 客户端）：MIT，纯 JS，支持 `exec` 通道、keepalive 与 host key 校验
