import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // 로컬 .env(예: DATA_MODE=supabase)와 상관없이 외부 서비스 없이 돈다 (process.loadEnvFile은 이미 있는 값을 덮지 않음)
    env: {
      NODE_ENV: 'test',
      DATA_MODE: 'memory',
      AI_MODE: 'mock',
      MOCK_DELAY_MIN_MS: '0',
      MOCK_DELAY_MAX_MS: '0',
      LOG_DIR: path.join(tmpdir(), 'iroke-test-logs'),
    },
  },
});
