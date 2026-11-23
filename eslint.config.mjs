import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * ESLint 平铺配置。
 *
 * 分层：
 * - main / preload / tests：Node 环境（主进程就是 Node）
 * - renderer：浏览器环境且 **不含 Node globals**，与「渲染进程无 Node」的安全约束保持一致（§9.4 S1）
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'release/**']
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      'no-console': 'off'
    }
  },

  {
    // 配置文件不参与 tsconfig 项目，关闭类型感知规则，避免 projectService 解析报错
    files: ['**/*.mjs', '**/*.js', '**/*.mts', '*.config.ts'],
    extends: [tseslint.configs.disableTypeChecked]
  },

  {
    // 主进程 / preload / 测试（含集成测试用的 .mjs mock）都是 Node 环境
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      'tests/**/*.mjs',
      'scripts/**/*.mjs',
      'src/extensions/**/*.ts',
      '*.config.ts'
    ],
    languageOptions: {
      globals: { ...globals.node }
    }
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // 渲染进程不允许触碰 Node 能力（安全约束）
      'no-restricted-globals': [
        'error',
        { name: 'require', message: '渲染进程禁止使用 Node 能力（§9.4 S1）' },
        { name: 'process', message: '渲染进程禁止使用 Node 能力（§9.4 S1）' },
        { name: '__dirname', message: '渲染进程禁止使用 Node 能力（§9.4 S1）' }
      ]
    }
  },

  {
    files: ['**/*.{test,spec}.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off'
    }
  }
)
