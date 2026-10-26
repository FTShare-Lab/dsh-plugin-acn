// 契约测试单独启用，运行器负责真实服务和临时凭据的生命周期。
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/contract/**/*.test.ts'], testTimeout: 30_000 } });
