import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: false,
    environment: 'node',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: {
        // RATIONALE: 70% is the Phase 5+ target (AGENTS.md §七).
        // Phase 1 establishes the test harness; thresholds will be raised
        // incrementally as each module gains dedicated tests.
        lines: 10,
        branches: 60,
        functions: 52,
        statements: 10,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
  resolve: {
    alias: {
      '~/': new URL('./src/', import.meta.url).pathname,
    },
  },
});
