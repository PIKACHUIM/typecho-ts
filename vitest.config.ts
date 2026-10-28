import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src/', import.meta.url).pathname,
      '@php': new URL('./php-compat/', import.meta.url).pathname,
    },
  },
});
