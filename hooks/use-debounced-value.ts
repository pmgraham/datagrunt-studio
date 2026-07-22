'use client';

import { useEffect, useState } from 'react';

// Returns `value` once it has been stable for `delayMs`. When `resetKey`
// changes, the debounce snaps to the current value immediately — callers
// use it to keep a lagging value from leaking across identity changes
// (new run, tab switch).
export function useDebouncedValue<T>(value: T, delayMs = 300, resetKey?: unknown): T {
  const [debounced, setDebounced] = useState(value);

  // Adjust-state-during-render pattern (same as usePagedRows' seed reset):
  // the previous resetKey lives in state, not a ref, because refs must not
  // be read during render (react-hooks/refs).
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    if (debounced !== value) setDebounced(value);
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
