# 主题（Themes）

内置 1 个默认主题 + 8 个流行社区配色，另有「跟随系统」。切换位置：底部「设置 → 主题」。

## 内置主题

| id                 | 名称             | 明暗 | 来源                                 |
| ------------------ | ---------------- | ---- | ------------------------------------ |
| `pi-dark`          | pi 深色（默认）  | 暗   | 本应用原生配色（沿用 pi 的视觉，Q6） |
| `pi-light`         | pi 浅色          | 亮   | 同族浅色                             |
| `github-light`     | GitHub Light     | 亮   | GitHub Primer                        |
| `solarized-light`  | Solarized Light  | 亮   | Solarized（高对比度变体，见下）      |
| `nord`             | Nord             | 暗   | Nord（Arctic Ice Studio）            |
| `dracula`          | Dracula          | 暗   | Dracula                              |
| `one-dark`         | One Dark         | 暗   | Atom One Dark                        |
| `tokyonight`       | Tokyo Night      | 暗   | Tokyo Night（enkia）                 |
| `catppuccin-mocha` | Catppuccin Mocha | 暗   | Catppuccin                           |

「跟随系统」按 `prefers-color-scheme` 解析为 `pi-dark` / `pi-light`，并在系统主题变化时
实时切换（不需要重启窗口）。

## 实现方式

- **单一真源**：`src/shared/contracts/theme.ts` 里的 `THEMES` 注册表（id / 显示名 / 明暗 / 21 个颜色）。
  设置面板选项、单元测试、E2E 断言、截图回归全部读它，不在 CSS 里维护第二份。
- **运行时应用**：`src/renderer/lib/theme.ts#useAppliedTheme` 把调色板写成
  `<html>` 上的 CSS 变量（`--bg`、`--bg-panel`、`--text`、`--accent`…），同时设置
  `data-theme` 与 `color-scheme`（后者让原生滚动条/输入框/下拉跟着明暗）。
- **首帧兜底**：`styles.css` 的 `:root` 保留一份 `pi-dark` 变量，配置到达前不会闪白。
- **代码高亮也走变量**：`--code-comment` / `--code-keyword` / … 由主题提供，
  否则浅色主题里代码块会出现「深色语法色叠浅底」。

## 对比度政策（不是装饰性选择）

`tests/unit/theme.test.ts` 用 WCAG 2.1 相对亮度公式对**每个主题**做断言：

| 项                                            | 阈值                 |
| --------------------------------------------- | -------------------- |
| 正文 / 次要文本 vs 背景（含 panel、elevated） | ≥ 4.5（AA）          |
| 强调色 / ok / warn / error vs 背景            | ≥ 3（AA 非文本）     |
| 代码 token 色 vs 代码块底色                   | ≥ 3                  |
| `scheme` 声明与背景亮度一致                   | 浅色主题底必须比字亮 |

因此有**两处刻意偏离上游原版**（已在源码注释里说明）：

1. **Solarized Light**：原版正文 `#586e75` on `#eee8d5` 只有 4.39:1，低于 AA。
   按同色相加深到 4.5+:1 的「高对比度变体」，色相仍是 Solarized 家族。
2. **注释色**：Dracula / One Dark / Tokyo Night / Catppuccin 的官方注释色对各自
   elevated 底只有 1.7–2.6:1（编辑器里可忍，12px 中文行里不可读）。统一提亮一档到 ≥3:1。

E2E（`tests/e2e/theme.e2e.test.ts`）再用**浏览器算出来的颜色**验一遍正文对比度 ≥ 4.5，
并对每个主题出一张整窗截图 `docs/screenshots/theme-<id>.png`。

## 新增一个主题

1. 在 `src/shared/contracts/theme.ts` 的 `THEMES` 里加一项（21 个颜色键，缺一个 TS 就报错）；
2. `npm run test:unit -- theme` —— 对比度断言会立刻告诉你哪些颜色不达标；
3. `npm run test:e2e -- theme` 出截图，人工看一眼观感；

不需要改 CSS、设置面板或配置层：选项列表由注册表生成，配置里的 id 通过 zod 枚举校验，
历史值（`dark` / `light`）在 `config-store` 读盘时归一为 `pi-dark` / `pi-light`（升级不重置主题）。
