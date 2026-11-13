import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Workspace packages are resolved to their TypeScript sources, so tests never depend on a build.
// Paths are taken from the working directory (run tests from the repository root), not from
// import.meta.url, so they keep the path the tests were started from (see preserveSymlinks).
const source = (relative: string): string => resolve(process.cwd(), relative);

export default defineConfig({
  resolve: {
    // Keeps module ids on the path the tests were started from. Needed only when the checkout lives
    // under a directory whose name contains '#' (Vite treats it as a URL fragment); see tests/README.md.
    preserveSymlinks: true,
    alias: {
      '@medicitas/kernel': source('./shared-plane/kernel/src/index.ts'),
      '@medicitas/observability': source('./shared-plane/observability/src/index.ts'),
      '@medicitas/identity': source('./shared-plane/identity/src/index.ts'),
      '@medicitas/messaging': source('./shared-plane/messaging/src/index.ts'),
      '@medicitas/cache': source('./shared-plane/cache/src/index.ts'),
      '@medicitas/runtime': source('./shared-plane/runtime/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'shared-plane/*/tests/**/*.test.ts',
            'application-plane/*/tests/unit/**/*.test.ts',
            'control-plane/*/tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/contract/**/*.test.ts'],
          setupFiles: ['tests/support/load-env.ts'],
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Black-box acceptance against the running Compose containers, through the gateway (Stage 6).
        extends: true,
        test: {
          name: 'acceptance',
          include: ['tests/acceptance/**/*.test.ts', 'tests/concurrency/**/*.test.ts'],
          setupFiles: ['tests/support/load-env.ts'],
          globalSetup: ['tests/acceptance/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
