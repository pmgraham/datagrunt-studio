import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from './use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 300));
    expect(result.current).toBe('a');
  });

  it('keeps the old value until the delay elapses, then updates', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(299));
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('b');
  });

  it('restarts the delay on rapid changes so only the last value lands', () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: 'a' } },
    );

    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: 'c' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');

    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('c');
  });

  it('snaps to the current value immediately when resetKey changes', () => {
    const { result, rerender } = renderHook(
      ({ value, resetKey }) => useDebouncedValue(value, 300, resetKey),
      { initialProps: { value: 'a', resetKey: 1 } },
    );

    rerender({ value: 'b', resetKey: 2 });
    expect(result.current).toBe('b');
  });

  it('does not snap when resetKey is unchanged', () => {
    const { result, rerender } = renderHook(
      ({ value, resetKey }) => useDebouncedValue(value, 300, resetKey),
      { initialProps: { value: 'a', resetKey: 1 } },
    );

    rerender({ value: 'b', resetKey: 1 });
    expect(result.current).toBe('a');
  });
});
