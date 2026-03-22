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
        // Thresholds reflect current Phase 1-5 test coverage and are raised
        // incrementally as each module gains dedicated tests.
        // Current: lines ~5%, functions ~45%, branches ~57%.
        lines: 4,
        branches: 55,
        functions: 44,
        statements: 4,
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
