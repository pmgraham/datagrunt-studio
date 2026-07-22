import { describe, expect, it } from 'vitest';
import { cellText, filterRows } from './row-search';

const rows: unknown[][] = [
  ['Smith', 2024, 'east'],
  ['Jones', 2024, 'west'],
  ['Smithers', 2023, 'east'],
  [null, 2022, { city: 'Boston', zip: '02101' }],
];

describe('filterRows', () => {
  it('returns all rows for an empty or whitespace query', () => {
    expect(filterRows(rows, '')).toEqual(rows);
    expect(filterRows(rows, '   ')).toEqual(rows);
  });

  it('matches a single word in any column, case-insensitively', () => {
    expect(filterRows(rows, 'WEST')).toEqual([['Jones', 2024, 'west']]);
  });

  it('matches each word independently across different columns', () => {
    // 'smith' hits column 0, '2024' hits column 1 — different columns, same row
    expect(filterRows(rows, 'smith 2024')).toEqual([['Smith', 2024, 'east']]);
  });

  it('requires every word to match somewhere in the row', () => {
    expect(filterRows(rows, 'smith west')).toEqual([]);
  });

  it('matches substrings', () => {
    expect(filterRows(rows, 'smith')).toEqual([
      ['Smith', 2024, 'east'],
      ['Smithers', 2023, 'east'],
    ]);
  });

  it('searches object cells by their JSON text', () => {
    expect(filterRows(rows, 'boston')).toEqual([
      [null, 2022, { city: 'Boston', zip: '02101' }],
    ]);
  });

  it('never matches null or undefined cells', () => {
    expect(filterRows(rows, 'null')).toEqual([]);
  });
});

describe('cellText', () => {
  it('stringifies primitives, JSON-ifies objects, empties null/undefined', () => {
    expect(cellText(42)).toBe('42');
    expect(cellText('x')).toBe('x');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});
