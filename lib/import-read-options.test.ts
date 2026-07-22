import { describe, expect, it } from 'vitest';
import type { StagedFilePreview } from './api';
import {
  DEFAULT_READ_OPTIONS,
  confirmOptionFields,
  isDefaultOptions,
  readOptionsKey,
  sanitizeSkipRows,
  seedReadOptions,
  staleSheetOptions,
} from './import-read-options';

const csvFile: StagedFilePreview = {
  staged_id: 'abc_data.csv', filename: 'data.csv',
  sheets: null, columns: ['a'], columns_normalized: ['a'], rows: [['1']], error: null,
};
const excelFile: StagedFilePreview = {
  staged_id: 'def_book.xlsx', filename: 'book.xlsx',
  sheets: ['messy', 'clean'], columns: ['x'], columns_normalized: ['x'], rows: [['2']], error: null,
};

describe('readOptionsKey', () => {
  it('uses staged_id alone for CSV', () => {
    expect(readOptionsKey('abc', null)).toBe('abc');
  });
  it('scopes Excel keys per sheet', () => {
    expect(readOptionsKey('abc', 'messy')).toBe('abc::messy');
    expect(readOptionsKey('abc', 'clean')).not.toBe(readOptionsKey('abc', 'messy'));
  });
});

describe('seedReadOptions', () => {
  it('seeds one default entry per CSV file and per Excel sheet', () => {
    const seeded = seedReadOptions([csvFile, excelFile]);
    expect(Object.keys(seeded).sort()).toEqual([
      'abc_data.csv', 'def_book.xlsx::clean', 'def_book.xlsx::messy',
    ]);
    expect(Object.values(seeded).every(isDefaultOptions)).toBe(true);
  });
});

describe('confirmOptionFields', () => {
  it('emits flat fields for CSV', () => {
    const options = { 'abc_data.csv': { skip_rows: 3, has_header: false } };
    expect(confirmOptionFields(csvFile, options)).toEqual({ skip_rows: 3, has_header: false });
  });
  it('falls back to defaults for unseeded CSV', () => {
    expect(confirmOptionFields(csvFile, {})).toEqual({ ...DEFAULT_READ_OPTIONS });
  });
  it('emits sheet_options only for non-default Excel sheets', () => {
    const options = {
      'def_book.xlsx::messy': { skip_rows: 3, has_header: true },
      'def_book.xlsx::clean': { ...DEFAULT_READ_OPTIONS },
    };
    expect(confirmOptionFields(excelFile, options)).toEqual({
      sheet_options: { messy: { skip_rows: 3, has_header: true } },
    });
  });
  it('emits empty sheet_options when every sheet is default', () => {
    expect(confirmOptionFields(excelFile, {})).toEqual({ sheet_options: {} });
  });
});

describe('sanitizeSkipRows', () => {
  it('passes non-negative integers through', () => {
    expect(sanitizeSkipRows('3')).toBe(3);
    expect(sanitizeSkipRows('0')).toBe(0);
  });
  it('floors fractional input', () => {
    expect(sanitizeSkipRows('2.7')).toBe(2);
  });
  it('clamps negative input to zero', () => {
    expect(sanitizeSkipRows('-4')).toBe(0);
    expect(sanitizeSkipRows('-0.5')).toBe(0);
  });
  it('treats empty and non-numeric input as zero', () => {
    expect(sanitizeSkipRows('')).toBe(0);
    expect(sanitizeSkipRows('abc')).toBe(0);
  });
});

describe('staleSheetOptions', () => {
  const sig = (o: { skip_rows: number; has_header: boolean }) => JSON.stringify(o);

  it('returns nothing for CSV files', () => {
    expect(staleSheetOptions(csvFile, {}, {}, null)).toEqual([]);
  });

  it('skips the active sheet — the live-preview effect owns it', () => {
    const targets = staleSheetOptions(excelFile, {}, {}, 'messy');
    expect(targets.map((t) => t.sheet)).toEqual(['clean']);
  });

  it('reports every sheet whose options differ from the handled signature', () => {
    const options = {
      'def_book.xlsx::messy': { skip_rows: 5, has_header: true },
      'def_book.xlsx::clean': { ...DEFAULT_READ_OPTIONS },
    };
    const targets = staleSheetOptions(excelFile, options, {}, null);
    expect(targets).toEqual([
      { sheet: 'messy', key: 'def_book.xlsx::messy', opts: { skip_rows: 5, has_header: true } },
      { sheet: 'clean', key: 'def_book.xlsx::clean', opts: { ...DEFAULT_READ_OPTIONS } },
    ]);
  });

  it('omits sheets already handled at their current options', () => {
    const messy = { skip_rows: 5, has_header: true };
    const options = {
      'def_book.xlsx::messy': messy,
      'def_book.xlsx::clean': { ...DEFAULT_READ_OPTIONS },
    };
    const handled = {
      'def_book.xlsx::messy': sig(messy),
      'def_book.xlsx::clean': sig(DEFAULT_READ_OPTIONS),
    };
    expect(staleSheetOptions(excelFile, options, handled, null)).toEqual([]);
  });

  it('re-reports a handled sheet once its options change again', () => {
    const options = { 'def_book.xlsx::messy': { skip_rows: 9, has_header: false } };
    const handled = {
      'def_book.xlsx::messy': sig({ skip_rows: 5, has_header: true }),
      'def_book.xlsx::clean': sig(DEFAULT_READ_OPTIONS),
    };
    const targets = staleSheetOptions(excelFile, options, handled, null);
    expect(targets.map((t) => t.sheet)).toEqual(['messy']);
  });

  it('falls back to default options for unseeded sheets', () => {
    const targets = staleSheetOptions(excelFile, {}, {}, null);
    expect(targets.every((t) => isDefaultOptions(t.opts))).toBe(true);
  });
});
