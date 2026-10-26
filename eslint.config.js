// 类型规则覆盖工程源码；运行时导入边界只约束产品模块。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'lib/**', '.artifacts/**', 'coverage/**'] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/dsh-adapter/**', 'src/plugins/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@deepseek-ai/*'], allowTypeImports: true, message: '运行时依赖只允许出现在 adapter 和插件入口。' }],
      }],
    },
  },
);
