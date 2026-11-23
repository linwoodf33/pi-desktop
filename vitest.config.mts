import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置（架构文档 §9.1 单元测试、§9.2 集成测试）。
 *
 * 两个工程：
 * - `unit`：纯单测，node 环境，`npm run test:unit`
 * - `integration`：起真实子进程（mock pi 回放器）的链路测试，`npm run test:integration`
 *
 * `e2e`：Playwright + Electron 启动打包产物（M3 接入），`npm run test:e2e`（需先 build）
 * `perf`：性能压测（A7 内存），Playwright + Electron，`npm run test:perf:memory`（需先 build）
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          globals: false,
          restoreMocks: true
        }
      },
      {
        // Electron E2E（§9.3）：需要先 `npm run build`，启动 out/ 产物
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          globals: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false
        }
      },
      {
        // 性能压测（A7）：同样启动 out/ 产物，但跑 200+ 轮，需要更长的超时
        test: {
          name: 'perf',
          environment: 'node',
          include: ['tests/perf/**/*.test.ts'],
          globals: false,
          testTimeout: 3_600_000,
          hookTimeout: 600_000,
          fileParallelism: false
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globals: false,
          testTimeout: 60_000,
          hookTimeout: 60_000
        }
      }
    ]
  }
})
