// Importing the config pulls in @vitejs/plugin-react, and esbuild refuses to
// load under jsdom's TextEncoder.
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { configDefaults } from 'vitest/config';
import config from '../vitest.config';

describe('vitest test discovery', () => {
  it('skips .claude/, where the harness checks out worktrees', () => {
    // Each worktree is a full copy of this repo, so an unfiltered crawl
    // collects every test file a second time.
    expect(config.test?.exclude).toContain('**/.claude/**');
  });

  it('keeps the defaults that setting `exclude` would otherwise replace', () => {
    expect(config.test?.exclude).toEqual(expect.arrayContaining(configDefaults.exclude));
  });
});
