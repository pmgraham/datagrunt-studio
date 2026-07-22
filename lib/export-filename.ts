import type { ExportFormat } from './api';

// Single result → results.<ext>; multi-statement runs get the tab letter
// ("Result A" → results-a.csv) so downloads from different tabs don't collide.
export function resultExportFilename(
  activeIdx: number,
  totalResults: number,
  format: ExportFormat,
): string {
  if (totalResults <= 1) return `results.${format}`;
  return `results-${String.fromCharCode(97 + activeIdx)}.${format}`;
}
