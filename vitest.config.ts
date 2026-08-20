import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // 集成测试需要真实数据库时按环境变量跳过
    // 见 test/integration 各 spec 的 describe.skipIf
  },
});
