# 发布与产物（Release）

本文说明：应用图标怎么来的、安装包怎么打、Release 怎么发、**以及在本机网络受限时怎么拿到
CI 的失败详情**。

---

## 1. 目录与真源

| 东西       | 位置                                    | 说明                                          |
| ---------- | --------------------------------------- | --------------------------------------------- |
| 图标真源   | `resources/icon.svg`                    | 唯一真源，手写 SVG                            |
| 图标产物   | `resources/icon.png`                    | 1024×1024 透明底，**随仓库提交**              |
| 图标生成   | `npm run icon` / `npm run icon:preview` | 用项目内 Electron 渲染，不引入图像库          |
| 打包配置   | `electron-builder.yml`                  | `win.icon: icon.png`、`signExecutable: false` |
| 安装包     | `release/pi-desktop-<版本>-<架构>.exe`  | NSIS，per-user                                |
| 发布工作流 | `.github/workflows/release.yml`         | tag `v*` → 构建 → 建 Release                  |

**图标为什么提交 PNG 而不是每次构建重生成**：渲染要起一个 GUI（Electron）进程，
在 GitHub runner 上曾整步失败且拿不到输出；图标是确定性产物，提交后打包只依赖文件存在。
改图标时：改 `resources/icon.svg` → `npm run icon:preview` 看各档位 → 提交 `resources/icon.png`。

图标设计：π 站在一条「桌面线」上（π + desk = 把 pi 放上桌面）；配色取自应用主题
（accent `#4c9ef0`、面板深色 `#14181d`）。踩过的两个 SVG 坑记在 `resources/icon.svg` 注释里：

1. XML 注释里不能出现连续两个连字符 —— 写 `--bg-panel` 会让整份 SVG 解析失败，渲染出空白图；
2. 直线（零高度包围盒）用 `objectBoundingBox` 渐变会退化成不可见 —— 必须 `userSpaceOnUse`。

## 2. 发一版

```bash
# 1) 改版本（tag 必须与 package.json 一致，工作流会校验）
npm version 0.2.0 --no-git-tag-version
git commit -am "chore: 0.2.0"
git push

# 2) 打 tag 并推送 → 触发 Release 工作流
git tag -a v0.2.0 -m "pi-desktop v0.2.0"
git push origin v0.2.0
```

工作流做的事（`package` job，Windows x64）：

1. 校验 tag 与 `package.json` 版本一致；
2. 确认 `resources/icon.png` 存在且 ≥256×256；
3. `typecheck` + `format:check` + `test:unit`（最小门禁；全量回归在 `ci.yml`）；
4. `npm run package:dist`（**显式 `--publish never`**，见下）；
5. 计算 SHA-256 写入 `SHA256SUMS.txt`；
6. 上传 Actions artifact `pi-desktop-<版本>-win-x64`（安装包 + blockmap + 校验和）**和** `build-log`；
7. `gh release create` 挂上上述文件（仅 tag 触发；`workflow_dispatch` 只到第 6 步）。

### 为什么 `--publish never`

electron-builder 在 CI 环境里会**隐式推断要发布**（日志：`Implicit publishing triggered by CI detection`），
没有 `GH_TOKEN` 就直接失败。发布动作一律交给 `gh release create` 显式完成，
打包脚本固定 `--publish never`（这也是 v27 的默认要求）。

### 为什么不用第三方 release action

本仓库策略是「所有 action 固定到 commit SHA」。`gh` CLI 在 windows runner 上自带，
`gh release create` 一行完成同样的事，少一个需要长期跟踪 SHA 的依赖。

### 签名

仓库没有代码签名证书，产物**未签名**：首次运行会有 SmartScreen 提示（「更多信息 → 仍要运行」）。
Release notes 里写明这一点，并给出校验命令。要签名时给 job 加 secrets 并打开签名步骤。

## 3. 校验下载到的安装包

```powershell
Get-FileHash .\pi-desktop-<版本>-x64.exe -Algorithm SHA256   # 与 SHA256SUMS.txt / Release 页面一致
```

GitHub 的 Release 资产 API 也会给出每个资产的 `digest`（`sha256:…`），
用 `gh api repos/<owner>/<repo>/releases/tags/v<版本>` 可以核对，不必下载 `SHA256SUMS.txt`。

> 不同机器构建的产物 SHA 不同（NSIS 打包含时间戳，不可复现）；以 **CI 发布的那份** 为准。

## 4. 本机拿不到 CI 日志时怎么办

本机网络对以下域名不可达（代理与直连都不通），因此某些 gh 能力用不了：

| 用途             | 域名                                             | 症状                                          |
| ---------------- | ------------------------------------------------ | --------------------------------------------- |
| Actions 完整日志 | `results-receiver.actions.githubusercontent.com` | DNS 解析超时                                  |
| Release 资产下载 | `release-assets.githubusercontent.com`           | i/o timeout（直连）/ connection reset（代理） |

可用的替代通道（都不依赖上面两个域名）：

```bash
# 失败用例的完整断言堆栈（ci.yml 里 unit/integration/e2e 失败时上传 junit-*）
gh run download <runId> -n junit-unit -D ./reports

# 构建失败的完整输出（release.yml 里 always 上传 build-log）
gh run download <runId> -n build-log -D ./

# 失败注解（最快，一眼看堆栈摘要）
gh ann <jobId>        # = gh api repos/linwoodf33/pi-desktop/check-runs/<jobId>/annotations
```

`gh run view <runId> --json jobs` 可以拿到 jobId / step 级结论。

## 5. 本地打包与冒烟

```bash
npm run icon          # 若改了 svg
npm run package:dist  # → release/pi-desktop-<版本>-x64.exe
node scripts/verify-a11-startup.mjs   # 在近乎干净的环境变量下启动 win-unpacked 冒烟
```

安装包元数据（实测 v0.1.0）：`ProductName=pi-desktop`、`FileVersion=<版本>`、图标为 π。
