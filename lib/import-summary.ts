import type { UploadError } from './api';

// Build a one-line notice after a multi-file import. Returns null when every
// file succeeded — the new datasets appearing in the list is the confirmation.
export function summarizeImport(createdCount: number, errors: UploadError[]): string | null {
  if (errors.length === 0) return null;
  const failed = errors.map((e) => `${e.filename} (${e.message})`).join(', ');
  const datasetWord = createdCount === 1 ? 'dataset' : 'datasets';
  const fileWord = errors.length === 1 ? 'file' : 'files';
  return `Imported ${createdCount} ${datasetWord}. ${errors.length} ${fileWord} failed: ${failed}.`;
}
