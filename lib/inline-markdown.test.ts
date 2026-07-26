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
    // Take the FASTEST of several runs. Scheduling jitter and GC only ever add
    // time, so the minimum is the best estimate of the real cost — averaging
    // would let one noisy run dominate. An earlier version of this test timed a
    // single run of ~0.7ms and divided by `Math.max(small, 1)`, which clamped
    // the denominator while the numerator kept full noise; it failed on CI at a
    // ratio of 5.7 with no regression present.
    const timeToTokenize = (n: number, budgetMs = Infinity) => {
      const input = '![x'.repeat(n);
      let fastest = Infinity;
      for (let run = 0; run < 7; run += 1) {
        const start = performance.now();
        tokenizeInlineMarkdown(input);
        const elapsed = performance.now() - start;
        fastest = Math.min(fastest, elapsed);
        // Bail once a single run blows the budget: a quadratic implementation
        // takes seconds here, and repeating it six more times turns a clear
        // failure into a worker timeout.
        if (elapsed > budgetMs) break;
      }
      return fastest;
    };

    // Warm up the JIT so the first real measurement isn't penalized.
    timeToTokenize(5_000);

    const small = timeToTokenize(100_000, 500);

    // A quadratic implementation is already seconds-slow at this size, so fail
    // here with a legible number rather than spending a minute on the doubled
    // input first. Linear runs in single-digit milliseconds, so the headroom is
    // enormous and this cannot trip on slow hardware alone.
    expect(small).toBeLessThan(500);

    const large = timeToTokenize(200_000);

    // Doubling the input roughly doubles a linear scan and roughly quadruples a
    // quadratic one. Measured locally across 10 trials this ratio sits between
    // 1.4 and 2.1, so a bound of 3 leaves real slack while still catching the
    // structural regression — rather than pinning a wall-clock number that just
    // gets bumped the next time it goes red.
    expect(large / small).toBeLessThan(3);
  });
});
