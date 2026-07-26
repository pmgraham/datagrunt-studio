import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'jsdom',
    globals: true,
    // The Claude Code harness checks out worktrees under .claude/, each a full
    // copy of this repo. Vitest ignores .gitignore, so without this glob it
    // collects every test file twice and the shadow copies fail on imports
    // they have no node_modules to resolve. Spread the defaults — setting
    // `exclude` replaces them rather than merging.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
