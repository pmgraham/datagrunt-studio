import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePagedRows, type PagedRowsOptions, type PageSource } from './use-paged-rows';
import { fetchResultPage } from '@/lib/api';

vi.mock('@/lib/api', () => ({ fetchResultPage: vi.fn() }));

const mockFetch = vi.mocked(fetchResultPage);

interface Page {
  columns: string[];
  rows: unknown[][];
  total: number;
}

// A fetchResultPage stub whose resolution the test controls explicitly.
function deferredPage() {
  let resolve!: (page: Page) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Page>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const seed = { columns: ['id'], rows: [['seed-row']] };
const baseOptions: PagedRowsOptions = { pageIdx: 0, pageSize: 10 };

function renderPagedRows(
  source: PageSource | null,
  options: Partial<PagedRowsOptions> = {},
) {
  return renderHook(
    (props: { source: PageSource | null; options: PagedRowsOptions }) =>
      usePagedRows(props.source, seed, props.options),
    { initialProps: { source, options: { ...baseOptions, ...options } } },
  );
}

describe('usePagedRows', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('passes the seed through untouched and never fetches in static mode', () => {
    const { result } = renderPagedRows(null);
    expect(result.current).toEqual({
      columns: seed.columns, rows: seed.rows, total: null, loading: false, error: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows the seed with loading=true while the first window fetches, then the page', async () => {
    const deferred = deferredPage();
    mockFetch.mockReturnValue(deferred.promise);

    const { result } = renderPagedRows({ datasetId: 'ds1' });
    expect(result.current.rows).toEqual(seed.rows);
    expect(result.current.loading).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith({ datasetId: 'ds1', offset: 0, limit: 10 });

    await act(async () => deferred.resolve({ columns: ['id'], rows: [['fetched']], total: 42 }));
    expect(result.current).toEqual({
      columns: ['id'], rows: [['fetched']], total: 42, loading: false, error: null,
    });
  });

  it('keeps the previous page visible with loading=true while the next page fetches', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderPagedRows({ datasetId: 'ds1' });
    await act(async () => first.resolve({ columns: ['id'], rows: [['page-0']], total: 42 }));

    const second = deferredPage();
    mockFetch.mockReturnValueOnce(second.promise);
    rerender({ source: { datasetId: 'ds1' }, options: { ...baseOptions, pageIdx: 1 } });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.rows).toEqual([['page-0']]);
    expect(mockFetch).toHaveBeenLastCalledWith({ datasetId: 'ds1', offset: 10, limit: 10 });

    await act(async () => second.resolve({ columns: ['id'], rows: [['page-1']], total: 42 }));
    expect(result.current.rows).toEqual([['page-1']]);
    expect(result.current.loading).toBe(false);
  });

  it('resets to the new seed immediately when the source changes', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderPagedRows({ datasetId: 'ds1' });
    await act(async () => first.resolve({ columns: ['id'], rows: [['old-source']], total: 1 }));

    mockFetch.mockReturnValueOnce(deferredPage().promise);
    rerender({ source: { datasetId: 'ds2' }, options: baseOptions });

    expect(result.current.rows).toEqual(seed.rows);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('refetches when refreshKey bumps without sending it to the API', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderPagedRows({ sql: 'select 1' });
    await act(async () => first.resolve({ columns: ['id'], rows: [['run-1']], total: 1 }));

    mockFetch.mockReturnValueOnce(deferredPage().promise);
    rerender({ source: { sql: 'select 1' }, options: { ...baseOptions, refreshKey: 1 } });

    expect(result.current.rows).toEqual(seed.rows);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch).toHaveBeenLastCalledWith({ sql: 'select 1', offset: 0, limit: 10 });
  });

  it('returns to static passthrough when the source goes away mid-fetch', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderPagedRows({ datasetId: 'ds1' });
    expect(result.current.loading).toBe(true);

    rerender({ source: null, options: baseOptions });
    expect(result.current).toEqual({
      columns: seed.columns, rows: seed.rows, total: null, loading: false, error: null,
    });

    await act(async () => first.resolve({ columns: ['id'], rows: [['late']], total: 1 }));
    expect(result.current.rows).toEqual(seed.rows);
    expect(result.current.loading).toBe(false);
  });

  it('sends trimmed search and sort to the API without resetting rows to seed', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderPagedRows({ datasetId: 'ds1' });
    await act(async () => first.resolve({ columns: ['id'], rows: [['unfiltered']], total: 9 }));

    mockFetch.mockReturnValueOnce(deferredPage().promise);
    rerender({
      source: { datasetId: 'ds1' },
      options: { ...baseOptions, search: '  abc  ', sort: { column: 'id', direction: 'desc' } },
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch).toHaveBeenLastCalledWith({
      datasetId: 'ds1', offset: 0, limit: 10,
      search: 'abc', sortColumn: 'id', sortDirection: 'desc',
    });
    expect(result.current.rows).toEqual([['unfiltered']]);
  });

  it('surfaces a fetch error and stops loading while keeping the current rows', async () => {
    const first = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise);
    const { result } = renderPagedRows({ datasetId: 'ds1' });

    await act(async () => first.reject(new Error('backend down')));
    expect(result.current.error).toBe('backend down');
    expect(result.current.loading).toBe(false);
    expect(result.current.rows).toEqual(seed.rows);
  });

  it('ignores a stale response that resolves after a newer request started', async () => {
    const first = deferredPage();
    const second = deferredPage();
    mockFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderPagedRows({ datasetId: 'ds1' });
    rerender({ source: { datasetId: 'ds1' }, options: { ...baseOptions, pageIdx: 1 } });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve({ columns: ['id'], rows: [['fresh']], total: 2 }));
    await act(async () => first.resolve({ columns: ['id'], rows: [['stale']], total: 2 }));

    expect(result.current.rows).toEqual([['fresh']]);
    expect(result.current.loading).toBe(false);
  });
});
