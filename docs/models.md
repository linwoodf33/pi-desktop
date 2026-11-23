# 模型管理（Models）

客户端里直接管理 pi 的模型配置，不用去手改 JSON。

入口：顶栏 **「模型」** 按钮。

## 管的是哪两份文件

| 文件                        | 管什么                             | 客户端行为                                          |
| --------------------------- | ---------------------------------- | --------------------------------------------------- |
| `<agent-dir>/models.json`   | provider 与模型（`providers.*`）   | 增删改 provider / model，**保留**客户端没建模的字段 |
| `<agent-dir>/settings.json` | `defaultModel`（新会话的启动模型） | 只改这一个键，其余键原样保留                        |

`<agent-dir>` = `PI_CODING_AGENT_DIR` 环境变量，默认 `~/.pi/agent`。

**生效时机**：pi 在**启动会话时**读取这些配置。所以改完对「已经在跑的会话」不生效，
新开会话才用新配置（弹层里也这么写，不假装热更新）。

## 能做什么

- **看**：所有自定义 provider、它们的模型、上下文窗口 / 最大输出 / 是否 thinking；
  apiKey 只显示掩码（`key sk-…3456`）或「无 key」。
- **默认模型**：下拉选择（选项来自会话可用的模型列表），写入 `settings.json#defaultModel`；
  选「自动」= 删除该键，恢复 pi 自己的选择。
- **新增 / 编辑 provider**：id、显示名、Base URL、API 类型（`openai-completions` /
  `openai-responses` / `anthropic-messages` / `google-generative-ai` / `azure-openai-responses`）、
  apiKey，以及若干模型行（id / 名称 / 上下文 / 最大输出 / thinking）。
- **删除 provider**：二次确认后从 `models.json` 移除整段。

## 三条安全/数据约束（实现细节）

1. **apiKey 只进不出**：读取时主进程只计算 `hasApiKey` 与掩码 `apiKeyHint`，明文不进 IPC、
   不进日志、不进审计日志；编辑已有 provider 时输入框永远空白，占位「已配置（留空=保留）」，
   要清除必须显式勾「清除已配置的 key」。
   pi 支持的三种 key 形式都接受：字面量、`$ENV_NAME`、`!command`（`!` 开头**不会**在客户端执行，
   只原样写入配置）。
2. **不动用户没建模的字段**：`compat`、`samplingParams`、`cost.tiers`、`headers`、
   `modelOverrides`、`thinkingLevelMap` 等在写回时对象级就地合并、原样保留。
   否则「打开客户端改个名字」就会把用户辛苦调的兼容参数清空。
3. **写入可回退**：先写同目录临时文件再 `rename`（同卷原子），覆盖前留
   `<文件名>.bak-<时间戳>` 备份，只保留最近 3 份。**坏 JSON 直接拒绝改动**，不静默覆盖。

## 校验规则

在 IPC 边界（zod）与服务层各校验一次：

- provider / model id：`[A-Za-z0-9._:/-]{1,128}`，不允许 `..`、不允许以 `/` 开头或结尾
  （pi 里真实存在 `google/gemma-3-12b-it` 这种带斜杠的 id）；
- `baseUrl`：必须是 http(s)。**刻意允许 http** —— 内网自建 endpoint（如 `http://10.x.x.x:6001/v1`）
  是真实用法；
- `api`：只接受上面五个枚举值，避免拼错导致 pi 启动时才报错；
- `contextWindow` / `maxTokens`：正整数且有上界。

## 与「会话内切换模型」的区别

|                  | 位置                      | 作用范围                         |
| ---------------- | ------------------------- | -------------------------------- |
| 模型管理（本文） | 顶栏「模型」              | 磁盘配置 → 之后启动的会话        |
| 切换当前模型     | 对话区顶部（`model:set`） | 只影响当前会话，并记进会话 JSONL |

## 已知不做

- 不管理 `models-store.json`（pi 扩展/探测缓存，属上游状态）；
- 不做模型连通性测试（要真发请求、要 key，留给 pi 自己）；
- 不支持在这里配 OAuth 登录流程。
