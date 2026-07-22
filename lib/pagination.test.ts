import { describe, expect, it } from 'vitest';
import { PAGE_SIZES, DEFAULT_PAGE_SIZE, pageCount } from './pagination';

describe('pagination helpers', () => {
  it('offers multiples of 25 up to 200, defaulting to 50', () => {
    expect([...PAGE_SIZES]).toEqual([25, 50, 75, 100, 125, 150, 175, 200]);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  it('computes page counts, with a minimum of one page', () => {
    expect(pageCount(300, 50)).toBe(6);
    expect(pageCount(301, 50)).toBe(7);
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(1, 200)).toBe(1);
  });
});
