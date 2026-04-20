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
        // Added: core/types, mesh/bus, gateway/router tests (P1-1 iteration 1).
        // Added: runner happy-path/utility tests + memory/store embeddings &
        //        importance/superseded coverage (P1-1 iteration 2).
        // Added: gateway/rpc (47 tests) + runner kernel API (8 tests) +
        //        workflow-kernel timeout fix (P1-1 iteration 3).
        // Added: mesh_send/mesh_plan orchestration e2e tests + workflow-kernel
        //        race fix (P2-1 mesh E2E).
        lines: 36,
        branches: 68,
        functions: 74,
        statements: 36,
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
