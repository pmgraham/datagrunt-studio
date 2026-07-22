import { describe, expect, it } from 'vitest';
import { resultExportFilename } from './export-filename';

describe('resultExportFilename', () => {
  it('uses a plain name for a single result set', () => {
    expect(resultExportFilename(0, 1, 'csv')).toBe('results.csv');
    expect(resultExportFilename(0, 1, 'parquet')).toBe('results.parquet');
  });

  it('suffixes the tab letter for multi-statement runs, matching the tab labels', () => {
    expect(resultExportFilename(0, 3, 'csv')).toBe('results-a.csv');
    expect(resultExportFilename(2, 3, 'parquet')).toBe('results-c.parquet');
  });
});
