// 组合测试通过独立子进程加载实际发布入口，避免测试转换器改变模块身份。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,mjs}'],
    exclude: ['tests/contract/**'],
    testTimeout: 45_000,
  },
});
