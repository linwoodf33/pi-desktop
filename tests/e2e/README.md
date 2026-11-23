# E2E 测试（Playwright + Electron）

`app.e2e.test.ts` 覆盖 §9.3 的 E1 / E2 / E4，启动的是**打包产物**（`out/`），因此运行前需要先 build：

```bash
npm run test:e2e     # = npm run build && vitest run --project e2e
```

要点（都在用例里注释了）：

- pi 用 `tests/integration/fixtures/mock-pi.mjs` 顶替：`PI_DESKTOP_PI_COMMAND` 指向一个临时 `.cmd` 包装
  （走 §7 约束 11 的 `cmd.exe /d /s /c` 分支）；`MOCK_PI_TOOL=1` 让一轮里产生一次 bash 工具调用；
- 会话目录用 `PI_CODING_AGENT_SESSION_DIR` 指向临时空目录，避免读到开发机真实会话；
- 原生目录对话框无法自动化：用 `electronApp.evaluate` 在主进程内替换 `dialog.showOpenDialog`（不改产品代码）；
- `--user-data-dir` 指向临时目录，避免单实例锁与用户数据互相影响。

未覆盖（MVP 验收里仍需人工或后续里程碑）：

- E3 审批（M5）、E5 关闭重开后的历史完整性、E6 主进程异常注入（E3/E5/E10 实际已在 `app.e2e.test.ts` 内）；
- 真实 pi + 真实 provider 的链路（E2E 用 mock 保证确定性）。

## 计时类用例：`timing.e2e.test.ts`（§10 A1 / A6）

单独一个文件、各自独立 Electron 实例（独立 userData / 会话目录），因为计时口径要求干净的基线：

```bash
npx vitest run --project e2e tests/e2e/timing.e2e.test.ts --reporter=verbose
```

- **A1 首 token ≤ 1.5s**：3 个全新会话，逐次断言「点发送 → `[data-testid="timeline-streaming"]` 出现」；
  计时在**页面内** `performance.now()` + `MutationObserver`（不经过 CDP 往返）。
  不含 pi 冷启动（新建任务时已 `session:create`）。实测 142/218/212ms（中位数 212ms）。
- **A6 强杀 → 2s 内可操作入口**：mock pi 通过 `MOCK_PI_PID_FILE` 落盘自身 pid，测试用
  `process.kill(pid,'SIGKILL')` 真强杀 → 断言「继续对话」≤2s 出现 → 历史完整 → resume 后 pid 变化、可继续对话。
  实测 6–9ms。
- 抖动系数：`PI_DESKTOP_TIMING_FACTOR` 默认 1，**只能放大**（>1 才生效）；CI 需要放宽必须显式设置并在报告中注明。
