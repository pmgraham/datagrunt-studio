'use client';

import { useEffect, useState } from 'react';
import { fetchResultPage } from '@/lib/api';

export interface PageSource {
  datasetId?: string;
  sql?: string;
}

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface PagedRowsOptions {
  pageIdx: number;
  pageSize: number;
  refreshKey?: string | number;
  search?: string;
  sort?: GridSort | null;
}

export interface PagedRows {
  columns: string[];
  rows: unknown[][];
  total: number | null;
  loading: boolean;
  error: string | null;
}

// Server-side pagination over a statement or dataset. A null source means
// static mode: seed rows pass through untouched and nothing is fetched.
// While the first window of a new source loads, the seed renders so grids
// backed by /query's preloaded rows appear instantly. The caller bumps
// refreshKey to force a fresh window for an unchanged source (re-runs,
// tab identity); refreshKey is never sent to the API. `search` (debounced
// by the caller) and `sort` filter/order server-side; both participate in
// the fetch but not the seed-reset identity, so editing them never blanks
// the grid back to seed rows.
export function usePagedRows(
  source: PageSource | null,
  seed: { columns: string[]; rows: unknown[][] },
  { pageIdx, pageSize, refreshKey = 0, search = '', sort = null }: PagedRowsOptions,
): PagedRows {
  const sourceKey = source ? JSON.stringify([source, refreshKey]) : null;
  const trimmedSearch = search.trim();
  const sortKey = sort ? JSON.stringify(sort) : null;
  const fetchKey = sourceKey
    ? JSON.stringify([sourceKey, pageIdx, pageSize, trimmedSearch, sortKey])
    : null;
  const [state, setState] = useState<PagedRows>({
    columns: seed.columns, rows: seed.rows, total: null, loading: sourceKey !== null, error: null,
  });

  // Adjust-state-during-render pattern (previous keys live in state, not a
  // ref — refs must not be read during render): when the source changes,
  // show the new seed immediately instead of the previous source's stale
  // page; when only the window changes (page, search, sort), keep the
  // current rows visible and flag the pending fetch.
  const [lastKeys, setLastKeys] = useState({ sourceKey, fetchKey });
  if (sourceKey !== lastKeys.sourceKey) {
    setLastKeys({ sourceKey, fetchKey });
    setState({ columns: seed.columns, rows: seed.rows, total: null, loading: sourceKey !== null, error: null });
  } else if (fetchKey !== lastKeys.fetchKey) {
    setLastKeys({ sourceKey, fetchKey });
    setState((prev) => ({ ...prev, loading: true, error: null }));
  }

  useEffect(() => {
    if (!sourceKey) return;
    let stale = false;
    const [parsedSource] = JSON.parse(sourceKey) as [PageSource, string | number];
    const parsedSort = sortKey ? (JSON.parse(sortKey) as GridSort) : null;
    fetchResultPage({
      ...parsedSource,
      offset: pageIdx * pageSize,
      limit: pageSize,
      ...(trimmedSearch ? { search: trimmedSearch } : {}),
      ...(parsedSort ? { sortColumn: parsedSort.column, sortDirection: parsedSort.direction } : {}),
    })
      .then((page) => {
        if (stale) return;
        setState({ columns: page.columns, rows: page.rows, total: page.total, loading: false, error: null });
      })
      .catch((e) => {
        if (stale) return;
        setState((prev) => ({ ...prev, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => { stale = true; };
  }, [sourceKey, pageIdx, pageSize, trimmedSearch, sortKey]);

  if (!sourceKey) {
    return { columns: seed.columns, rows: seed.rows, total: null, loading: false, error: null };
  }
  return state;
}
