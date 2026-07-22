import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDatasets, runQuery, castColumn, duckTypeToLabel, deleteDataset, uploadDatasets, downloadExport, fetchResultPage } from './api';

beforeEach(() => { vi.restoreAllMocks(); });

describe('api client', () => {
  it('listDatasets returns datasets array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ datasets: [{ id: '1', name: 'a.csv', type: 'csv', columns: [], sheet: null }] }),
    })) as any);
    const datasets = await listDatasets();
    expect(datasets[0].name).toBe('a.csv');
  });

  it('runQuery posts and returns result', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ columns: ['id'], rows: [[1]], truncated: false, code: 'x' }) }));
    vi.stubGlobal('fetch', spy as any);
    const result = await runQuery({ mode: 'sql', sql: 'SELECT 1' });
    expect(result.rows).toEqual([[1]]);
    expect(spy).toHaveBeenCalledWith('/api/query', expect.objectContaining({ method: 'POST' }));
  });
});

describe('duckTypeToLabel', () => {
  it('maps DuckDB types to UI labels', () => {
    expect(duckTypeToLabel('VARCHAR')).toBe('text');
    expect(duckTypeToLabel('BIGINT')).toBe('integer');
    expect(duckTypeToLabel('INTEGER')).toBe('integer');
    expect(duckTypeToLabel('DOUBLE')).toBe('decimal');
    expect(duckTypeToLabel('DECIMAL(18,3)')).toBe('decimal');
    expect(duckTypeToLabel('BOOLEAN')).toBe('boolean');
    expect(duckTypeToLabel('DATE')).toBe('date');
    expect(duckTypeToLabel('TIMESTAMP')).toBe('timestamp');
    expect(duckTypeToLabel('SOMETHING_ELSE')).toBe('text');
  });
});

describe('castColumn', () => {
  it('posts to the cast route and returns the result', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, failingCount: 0, example: null, nulledCount: 0, columns: [{ name: 'price', type: 'DOUBLE' }] }),
    }));
    vi.stubGlobal('fetch', spy as any);
    const result = await castColumn('abc', 'price', 'decimal');
    expect(result.ok).toBe(true);
    expect(result.columns[0].type).toBe('DOUBLE');
    expect(spy).toHaveBeenCalledWith('/api/datasets/abc/cast', expect.objectContaining({ method: 'POST' }));
  });
});

describe('deleteDataset', () => {
  it('DELETEs the dataset and returns the updated list', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ datasets: [{ id: '2', name: 'b.csv', type: 'csv', columns: [], sheet: null, table: 'b' }] }),
    }));
    vi.stubGlobal('fetch', spy as any);
    const result = await deleteDataset('1');
    expect(result.map((d) => d.id)).toEqual(['2']);
    expect(spy).toHaveBeenCalledWith('/api/datasets/1', expect.objectContaining({ method: 'DELETE' }));
  });
});

describe('uploadDatasets', () => {
  it('posts each file under the "files" field and returns datasets + errors', async () => {
    let captured: any;
    const spy = vi.fn(async (_url: string, opts: any) => {
      captured = opts;
      return {
        ok: true,
        json: async () => ({
          datasets: [{ id: '1', name: 'a.csv', type: 'csv', columns: [], sheet: null, table: 'a' }],
          errors: [{ filename: 'b.xlsx', message: 'bad' }],
        }),
      };
    });
    vi.stubGlobal('fetch', spy as any);
    const fileA = new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' });
    const fileB = new File(['x'], 'b.xlsx');
    const result = await uploadDatasets([fileA, fileB]);
    expect(result.datasets[0].name).toBe('a.csv');
    expect(result.errors[0].filename).toBe('b.xlsx');
    expect(spy).toHaveBeenCalledWith('/api/datasets', expect.objectContaining({ method: 'POST' }));
    expect((captured.body as FormData).getAll('files').length).toBe(2);
  });
});

describe('downloadExport', () => {
  it('POSTs the export body and saves the blob under the given filename', async () => {
    const blob = new Blob(['a,b'], { type: 'text/csv' });
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    vi.stubGlobal('fetch', fetchSpy as any);
    // jsdom has no createObjectURL — install spies directly.
    const createSpy = vi.fn(() => 'blob:fake');
    const revokeSpy = vi.fn();
    (URL as any).createObjectURL = createSpy;
    (URL as any).revokeObjectURL = revokeSpy;
    let downloadName: string | undefined;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    await downloadExport({ sql: 'SELECT 1', format: 'csv' }, 'results.csv');

    expect(fetchSpy).toHaveBeenCalledWith('/api/export', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT 1', format: 'csv' }),
    }));
    expect(createSpy).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
    expect(downloadName).toBe('results.csv');

    // revokeObjectURL is deferred via setTimeout for cross-browser safety
    expect(revokeSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(revokeSpy).toHaveBeenCalledWith('blob:fake');
  });

  it('surfaces the backend detail message on failure without saving', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ detail: 'Binder Error: nope' }),
    })) as any);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await expect(downloadExport({ sql: 'bad', format: 'parquet' }, 'x.parquet'))
      .rejects.toThrow('Binder Error: nope');
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

describe('fetchResultPage', () => {
  it('POSTs offset/limit and returns the page', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ columns: ['n'], rows: [[25]], total: 300 }) }));
    vi.stubGlobal('fetch', spy as any);
    const page = await fetchResultPage({ sql: 'SELECT 1', offset: 25, limit: 25 });
    expect(page.total).toBe(300);
    expect(page.rows).toEqual([[25]]);
    expect(spy).toHaveBeenCalledWith('/api/page', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sql: 'SELECT 1', offset: 25, limit: 25 }),
    }));
  });

  it('throws the backend detail on error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ detail: 'limit must be between 1 and 200' }),
    })) as any);
    await expect(fetchResultPage({ sql: 'x', offset: 0, limit: 999 }))
      .rejects.toThrow('limit must be between 1 and 200');
  });

  it('includes the search filter in the body when provided', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ columns: [], rows: [], total: 0 }) }));
    vi.stubGlobal('fetch', spy as any);
    await fetchResultPage({ sql: 'SELECT 1', offset: 0, limit: 25, search: 'smith 2024' });
    expect(spy).toHaveBeenCalledWith('/api/page', expect.objectContaining({
      body: JSON.stringify({ sql: 'SELECT 1', offset: 0, limit: 25, search: 'smith 2024' }),
    }));
  });

  it('includes sort fields in the body when provided', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ columns: [], rows: [], total: 0 }) }));
    vi.stubGlobal('fetch', spy as any);
    await fetchResultPage({ sql: 'SELECT 1', offset: 0, limit: 25, sortColumn: 'n', sortDirection: 'desc' });
    expect(spy).toHaveBeenCalledWith('/api/page', expect.objectContaining({
      body: JSON.stringify({ sql: 'SELECT 1', offset: 0, limit: 25, sortColumn: 'n', sortDirection: 'desc' }),
    }));
  });
});

describe('gcs api client', () => {
  it('listGcsBuckets returns bucket names', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ buckets: ['alpha', 'beta'] }) }));
    vi.stubGlobal('fetch', spy as any);
    const { listGcsBuckets } = await import('./api');
    expect(await listGcsBuckets()).toEqual(['alpha', 'beta']);
    expect(spy).toHaveBeenCalledWith('/api/gcs/buckets');
  });

  it('listGcsBuckets passes the project as a query param when given', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ buckets: ['alpha'] }) }));
    vi.stubGlobal('fetch', spy as any);
    const { listGcsBuckets } = await import('./api');
    expect(await listGcsBuckets('my-proj')).toEqual(['alpha']);
    expect(spy).toHaveBeenCalledWith('/api/gcs/buckets?project=my-proj');
  });

  it('listGcsProjects returns project ids and names', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ projects: [{ id: 'p1', name: 'One' }] }) }));
    vi.stubGlobal('fetch', spy as any);
    const { listGcsProjects } = await import('./api');
    expect(await listGcsProjects()).toEqual([{ id: 'p1', name: 'One' }]);
    expect(spy).toHaveBeenCalledWith('/api/gcs/projects');
  });

  it('listGcsObjects passes bucket and prefix as query params', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ folders: [], files: [] }) }));
    vi.stubGlobal('fetch', spy as any);
    const { listGcsObjects } = await import('./api');
    await listGcsObjects('alpha', 'raw/');
    expect(spy).toHaveBeenCalledWith('/api/gcs/objects?bucket=alpha&prefix=raw%2F&kind=datasets');
  });

  it('importFromGcs posts bucket, objects and schema', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ previews: [], datasets: [], errors: [] }) }));
    vi.stubGlobal('fetch', spy as any);
    const { importFromGcs } = await import('./api');
    await importFromGcs('alpha', ['raw/a.csv']);
    expect(spy).toHaveBeenCalledWith('/api/gcs/import', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ bucket: 'alpha', objects: ['raw/a.csv'], schema_name: 'imported' });
  });

  it('exportToGcs returns the uri and surfaces backend detail on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ uri: 'gs://alpha/out.csv' }) })) as any);
    const { exportToGcs } = await import('./api');
    expect(await exportToGcs({ sql: 'SELECT 1', format: 'csv', bucket: 'alpha', path: 'out' })).toBe('gs://alpha/out.csv');

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ detail: 'No Google Cloud credentials found' }) })) as any);
    await expect(exportToGcs({ sql: 'SELECT 1', format: 'csv', bucket: 'alpha', path: 'out' }))
      .rejects.toThrow('No Google Cloud credentials found');
  });
});
