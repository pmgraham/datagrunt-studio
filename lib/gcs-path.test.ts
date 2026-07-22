import { describe, it, expect } from 'vitest';
import { withFormatExtension } from './gcs-path';

describe('withFormatExtension', () => {
  it('swaps a known export extension for the new format', () => {
    expect(withFormatExtension('exports/q4.csv', 'parquet')).toBe('exports/q4.parquet');
    expect(withFormatExtension('exports/q4.PARQUET', 'json')).toBe('exports/q4.json');
  });

  it('appends the extension when none of the known ones is present', () => {
    expect(withFormatExtension('exports/q4', 'csv')).toBe('exports/q4.csv');
    expect(withFormatExtension('exports/data.backup', 'csv')).toBe('exports/data.backup.csv');
  });

  it('leaves folder paths and empty input alone', () => {
    expect(withFormatExtension('exports/', 'csv')).toBe('exports/');
    expect(withFormatExtension('', 'csv')).toBe('');
    expect(withFormatExtension('   ', 'csv')).toBe('');
  });
});
