export interface ApiColumn { name: string; type: string }

export interface ApiDataset {
  id: string;
  name: string;
  type: string;
  columns: ApiColumn[];
  sheet: string | null;
  table: string;
  schema_name: string;
}

export interface StatementResult {
  columns: string[];
  rows: any[][];
  truncated: boolean;
  statement: string;
  has_result_set: boolean;
  error?: string | null;
  detail?: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  truncated: boolean;
  sql: string;
  code: string;
  error?: string;
  detail?: string;
  results: StatementResult[];
}

export interface QueryRequestBody {
  mode: 'sql' | 'clean' | 'join';
  sql?: string;
  clean?: {
    datasetId: string;
    op: string;
    column?: string;
    value?: string;
    newName?: string;
    castType?: string;
  };
  clean_pipeline?: {
    datasetId: string;
    op: string;
    column?: string;
    value?: string;
    newName?: string;
    castType?: string;
  }[];
  join?: {
    leftId: string;
    rightId: string;
    leftKey: string;
    rightKey: string;
    how: string;
  };
  saveAs?: string;
}

async function asJson<T>(res: { ok: boolean; json: () => Promise<any> }): Promise<T> {
  let data: any;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. backend down, proxy returning HTML) — surface a
    // meaningful message rather than letting the parse error mask the real one.
    throw new Error(res.ok ? 'Unexpected non-JSON response' : `Request failed (${(res as any).status ?? 'unknown status'})`);
  }
  if (!res.ok) throw new Error(data?.detail || 'Request failed');
  return data as T;
}

export async function listDatasets(): Promise<ApiDataset[]> {
  const res = await fetch('/api/datasets');
  const data = await asJson<{ datasets: ApiDataset[] }>(res);
  return data.datasets;
}

export interface UploadError {
  filename: string;
  message: string;
}

export async function uploadDatasets(
  files: File[],
): Promise<{ datasets: ApiDataset[]; errors: UploadError[] }> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch('/api/datasets', { method: 'POST', body: form });
  return asJson<{ datasets: ApiDataset[]; errors: UploadError[] }>(res);
}

export async function runQuery(body: QueryRequestBody): Promise<QueryResult> {
  const res = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson<QueryResult>(res);
}

export async function resetSession(): Promise<ApiDataset[]> {
  const res = await fetch('/api/session/reset', { method: 'POST' });
  const data = await asJson<{ datasets: ApiDataset[] }>(res);
  return data.datasets;
}

export type ExportFormat = 'csv' | 'parquet';

export interface ExportRequestBody {
  datasetId?: string;
  sql?: string;
  format: ExportFormat;
}

// POST the export request, then save the returned file client-side under the
// given filename — the page never navigates away.
export async function downloadExport(body: ExportRequestBody, filename: string): Promise<void> {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data?.detail === 'string') detail = data.detail;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface PageRequestBody {
  datasetId?: string;
  sql?: string;
  offset: number;
  limit: number;
  search?: string;
  sortColumn?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface ResultPage {
  columns: string[];
  rows: any[][];
  total: number;
}

export async function fetchResultPage(body: PageRequestBody): Promise<ResultPage> {
  const res = await fetch('/api/page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson<ResultPage>(res);
}

export interface DatasetPreview {
  columns: string[];
  rows: any[][];
  truncated: boolean;
}

export async function fetchDatasetPreview(id: string, limit = 1000): Promise<DatasetPreview> {
  const res = await fetch(`/api/datasets/${encodeURIComponent(id)}/preview?limit=${limit}`);
  return asJson<DatasetPreview>(res);
}

export interface CastResult {
  ok: boolean;
  failingCount: number;
  example: string | null;
  nulledCount: number;
  columns: ApiColumn[];
}

export type ColumnTypeLabel = 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp';

export function duckTypeToLabel(duckType: string): ColumnTypeLabel {
  const t = duckType.toUpperCase();
  if (t.startsWith('BOOL')) return 'boolean';
  if (t.startsWith('TIMESTAMP') || t.startsWith('DATETIME')) return 'timestamp';
  if (t.startsWith('DATE')) return 'date';
  if (t.includes('INT')) return 'integer';
  if (t.startsWith('DOUBLE') || t.startsWith('DECIMAL') || t.startsWith('FLOAT') || t.startsWith('REAL') || t.startsWith('NUMERIC')) return 'decimal';
  return 'text';
}

export async function castColumn(
  datasetId: string,
  column: string,
  type: string,
  lenient = false,
): Promise<CastResult> {
  const res = await fetch(`/api/datasets/${datasetId}/cast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column, type, lenient }),
  });
  return asJson<CastResult>(res);
}

export async function deleteDataset(datasetId: string): Promise<ApiDataset[]> {
  const res = await fetch(`/api/datasets/${datasetId}`, { method: 'DELETE' });
  const data = await asJson<{ datasets: ApiDataset[] }>(res);
  return data.datasets;
}

export async function moveDatasetSchema(datasetId: string, schemaName: string): Promise<ApiDataset> {
  const res = await fetch(`/api/datasets/${datasetId}/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema_name: schemaName }),
  });
  return asJson<ApiDataset>(res);
}

export interface StagedFilePreview {
  staged_id: string;
  filename: string;
  sheets: string[] | null;
  columns: string[] | null;
  columns_normalized: string[] | null;
  rows: string[][] | null;
  error: string | null;
}

export interface PreviewResponse {
  is_single: boolean;
  files: StagedFilePreview[];
}

export interface ConfirmImportItem {
  staged_id: string;
  filename: string;
  normalize_columns: boolean;
  sheet?: string | null;
  schema_name: string;
  overwrite?: boolean;
  skip_rows?: number;
  has_header?: boolean;
  sheet_options?: Record<string, { skip_rows: number; has_header: boolean }>;
}

export async function previewUploads(files: File[]): Promise<PreviewResponse> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch('/api/datasets/preview', { method: 'POST', body: form });
  return asJson<PreviewResponse>(res);
}

export async function confirmImports(
  items: ConfirmImportItem[],
): Promise<{ datasets: ApiDataset[]; errors: UploadError[] }> {
  const res = await fetch('/api/datasets/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: items }),
  });
  return asJson<{ datasets: ApiDataset[]; errors: UploadError[] }>(res);
}

export interface StagedSheetPreview {
  columns: string[];
  columns_normalized: string[];
  rows: string[][];
}

export async function previewStagedFile(
  stagedId: string,
  body: { sheet?: string | null; skip_rows: number; has_header: boolean },
): Promise<StagedSheetPreview> {
  const res = await fetch(`/api/datasets/staged/${encodeURIComponent(stagedId)}/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return asJson<StagedSheetPreview>(res);
}

export interface PdfUploadResponse {
  doc_id: string;
  filename: string;
}

export interface PdfExtractResponse {
  json_text: string;
  markdown_text: string;
  images: string[];
  page_images?: string[];
}

export interface PdfRationalizeResponse {
  schema: string;
  saved: boolean;
  dataset: ApiDataset | null;
  save_error: string | null;
}

export async function uploadPdf(file: File): Promise<PdfUploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/pdf/upload', {
    method: 'POST',
    body: form,
  });
  return asJson<PdfUploadResponse>(res);
}

export async function importPdfFromGcs(bucket: string, object: string): Promise<PdfUploadResponse> {
  const res = await fetch('/api/pdf/import-gcs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, object }),
  });
  return asJson<PdfUploadResponse>(res);
}

export async function extractPdf(docId: string, overwrite: boolean = false): Promise<PdfExtractResponse> {
  const res = await fetch(`/api/pdf/extract/${docId}?overwrite=${overwrite}`, {
    method: 'POST',
  });
  return asJson<PdfExtractResponse>(res);
}

export async function rationalizePdf(
  docId: string,
  prompt: string,
  useLocal: boolean,
  model: string,
  usePageImages: boolean = false
): Promise<PdfRationalizeResponse> {
  const res = await fetch(`/api/pdf/rationalize/${docId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, use_local: useLocal, model, use_page_images: usePageImages }),
  });
  return asJson<PdfRationalizeResponse>(res);
}

export async function getOllamaModels(): Promise<{ models: string[]; active: boolean }> {
  const res = await fetch('/api/pdf/ollama-models');
  return asJson<{ models: string[]; active: boolean }>(res);
}

export async function getGeminiModels(): Promise<{ models: string[]; active: boolean }> {
  const res = await fetch('/api/pdf/gemini-models');
  return asJson<{ models: string[]; active: boolean }>(res);
}

export interface GcsObjectEntry {
  name: string;
  size: number;
  updated: string | null;
}

export interface GcsListing {
  folders: string[];
  files: GcsObjectEntry[];
}

export interface GcsProject {
  id: string;
  name: string;
}

export async function listGcsProjects(): Promise<GcsProject[]> {
  const res = await fetch('/api/gcs/projects');
  const data = await asJson<{ projects: GcsProject[] }>(res);
  return data.projects;
}

export async function listGcsBuckets(project?: string): Promise<string[]> {
  const url = project
    ? `/api/gcs/buckets?project=${encodeURIComponent(project)}`
    : '/api/gcs/buckets';
  const res = await fetch(url);
  const data = await asJson<{ buckets: string[] }>(res);
  return data.buckets;
}

export type GcsObjectKind = 'datasets' | 'pdf';

export async function listGcsObjects(
  bucket: string,
  prefix = '',
  kind: GcsObjectKind = 'datasets'
): Promise<GcsListing> {
  const params = new URLSearchParams({ bucket, prefix, kind });
  const res = await fetch(`/api/gcs/objects?${params.toString()}`);
  return asJson<GcsListing>(res);
}

export interface GcsImportResult {
  previews: StagedFilePreview[];
  datasets: ApiDataset[];
  errors: UploadError[];
}

export async function importFromGcs(
  bucket: string,
  objects: string[],
  schemaName = 'imported',
): Promise<GcsImportResult> {
  const res = await fetch('/api/gcs/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, objects, schema_name: schemaName }),
  });
  return asJson<GcsImportResult>(res);
}

export type GcsExportFormat = 'csv' | 'parquet' | 'json';

export interface GcsExportRequestBody {
  datasetId?: string;
  sql?: string;
  format: GcsExportFormat;
  bucket: string;
  path: string;
}

export async function exportToGcs(body: GcsExportRequestBody): Promise<string> {
  const res = await fetch('/api/gcs/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await asJson<{ uri: string }>(res);
  return data.uri;
}
