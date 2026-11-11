import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: new URL('..', import.meta.url).pathname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
  },
});
