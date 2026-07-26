import { describe, it, expect } from 'vitest';
import { tokenizeInlineMarkdown } from './inline-markdown';

describe('tokenizeInlineMarkdown', () => {
  it('splits an image out of surrounding text', () => {
    expect(tokenizeInlineMarkdown('see ![chart](img/p1.png) here')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'image', alt: 'chart', src: 'img/p1.png' },
      { kind: 'text', value: ' here' },
    ]);
  });

  it('handles bold, italic and code', () => {
    expect(tokenizeInlineMarkdown('**b** *i* `c`')).toEqual([
      { kind: 'strong', value: 'b' },
      { kind: 'text', value: ' ' },
      { kind: 'em', value: 'i' },
      { kind: 'text', value: ' ' },
      { kind: 'code', value: 'c' },
    ]);
  });

  it('leaves plain text as a single token', () => {
    expect(tokenizeInlineMarkdown('nothing special')).toEqual([
      { kind: 'text', value: 'nothing special' },
    ]);
  });

  it('treats an unterminated image as plain text', () => {
    expect(tokenizeInlineMarkdown('![alt](no-close')).toEqual([
      { kind: 'text', value: '![alt](no-close' },
    ]);
  });

  it('stays linear on the pathological input that froze the tab', () => {
    // The F19 payload: an opening bracket followed by tens of thousands of
    // "](" with no closing paren. The old nested-lazy pattern went quadratic.
    const hostile = '![' + ']('.repeat(50_000);
    const start = performance.now();
    tokenizeInlineMarkdown(hostile);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
