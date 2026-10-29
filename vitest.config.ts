import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Unit tests cover pure logic and must not need a database or network.
    // These satisfy the startup env validation for modules that read config.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://127.0.0.1:55432/phc_test',
      SOURCES_ENABLED: 'remotive',
      ADMIN_NUMBERS: '254700000000',
      LOG_LEVEL: 'error',
      // Pinned so the suite never depends on the developer's .env. dotenv does
      // not override values already present, so these win — which is what
      // keeps "AI is unavailable" deterministic whether or not a real key is
      // configured locally.
      AI_PROVIDER: 'none',
      GEMINI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
  },
});
