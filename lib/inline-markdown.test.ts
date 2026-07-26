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

  it('stays linear on many unterminated image opens with no ] anywhere', () => {
    // Review round 1 found a second quadratic shape: a bounded character
    // class like [^\]]* still backtracks character-by-character when the
    // terminator never appears at all. "![x" repeated has no "]" anywhere,
    // so every one of the ~n restart points used to re-scan to the end of
    // the string. Reviewer measurement: 200KB of this shape took 4.3s under
    // the regex tokenizer.
    const hostile = '![x'.repeat(50_000);
    const start = performance.now();
    const tokens = tokenizeInlineMarkdown(hostile);
    expect(performance.now() - start).toBeLessThan(1000);
    // Nothing can ever close (no "]" exists), so this must fall back to a
    // single literal-text token rather than silently dropping characters.
    expect(tokens).toEqual([{ kind: 'text', value: hostile }]);
  });

  it('scales linearly, not quadratically, as input size doubles', () => {
    const timeToTokenize = (n: number) => {
      const input = '![x'.repeat(n);
      const start = performance.now();
      tokenizeInlineMarkdown(input);
      return performance.now() - start;
    };

    // Warm up the JIT so the first real measurement isn't penalized.
    timeToTokenize(2_000);

    const small = timeToTokenize(20_000);
    const large = timeToTokenize(40_000);

    // A quadratic implementation roughly quadruples when input doubles; a
    // linear one roughly doubles. Generous slack (< 3, not < 2.2) keeps this
    // robust to measurement noise while still catching a future quadratic
    // regression structurally, instead of via a wall-clock threshold that
    // just gets bumped next time.
    expect(large / Math.max(small, 1)).toBeLessThan(3);
  });
});
