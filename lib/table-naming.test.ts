import { describe, it, expect } from 'vitest';
import { sanitizeName, toSnakeCase, baseTableName, targetTablePath } from './table-naming';

// These cases are the cross-language contract with backend/app/session_registry.py.
// The same inputs are asserted in backend/tests/test_session_registry.py; if you
// change one side, change both.

describe('sanitizeName (mirror of backend _sanitize)', () => {
  it('replaces non-alphanumerics with underscores', () => {
    expect(sanitizeName('hello world')).toBe('hello_world');
    expect(sanitizeName('a.b-c')).toBe('a_b_c');
  });

  it('collapses runs AFTER replacing — "a--b" is a_b, not a__b', () => {
    // This is the ordering bug the previous client copy had.
    expect(sanitizeName('a--b')).toBe('a_b');
    expect(sanitizeName('x  ..  y')).toBe('x_y');
  });

  it('strips leading and trailing underscores', () => {
    expect(sanitizeName('__weird__.csv__')).toBe('weird_csv');
    expect(sanitizeName('.hidden')).toBe('hidden');
  });
});

describe('toSnakeCase (mirror of backend to_snake_case)', () => {
  it('lowercases the stem and snake-cases it', () => {
    expect(toSnakeCase('My Report.PDF')).toBe('my_report');
    expect(toSnakeCase('Q4-Forecast.xlsx')).toBe('q4_forecast');
  });

  it('falls back to "document" for an empty stem', () => {
    expect(toSnakeCase('.pdf')).toBe('document');
  });
});

describe('baseTableName (mirror of backend base_table_name)', () => {
  it('sanitizes the stem for the imported schema', () => {
    expect(baseTableName('raw_sales_data.csv', null, 'imported')).toBe('raw_sales_data');
    expect(baseTableName('a--b.csv', null, 'imported')).toBe('a_b');
  });

  it('appends a sanitized sheet suffix', () => {
    expect(baseTableName('book.xlsx', 'Sheet 1', 'imported')).toBe('book_Sheet_1');
  });

  it('falls back to "dataset" when the stem sanitizes to empty', () => {
    expect(baseTableName('---.csv', null, 'imported')).toBe('dataset');
  });

  it('uses snake_case for the documents schema', () => {
    expect(baseTableName('My Report.pdf', null, 'documents')).toBe('my_report');
  });

  it('uses snake_case for the rationalized schema', () => {
    expect(baseTableName('My Report.pdf', null, 'rationalized')).toBe('my_report');
  });

  it('passes already-snake-cased rationalized names through unchanged', () => {
    // The backend pre-bakes the _page_images suffix into the name, so
    // snake-casing must be idempotent.
    expect(baseTableName('my_report_page_images', null, 'rationalized')).toBe(
      'my_report_page_images',
    );
  });
});

describe('targetTablePath', () => {
  it('builds session.<schema>.<base>', () => {
    expect(targetTablePath('raw_sales_data.csv', null, 'imported')).toBe(
      'session.imported.raw_sales_data',
    );
  });

  it('sanitizes a custom schema name', () => {
    expect(targetTablePath('data.csv', null, 'my-schema')).toBe('session.my_schema.data');
  });

  it('routes the documents schema through snake_case', () => {
    expect(targetTablePath('My Report.pdf', null, 'documents')).toBe(
      'session.documents.my_report',
    );
  });
});
