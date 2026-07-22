import { describe, it, expect } from 'vitest';
import { addColumnToQuery, quoteIdent } from './sql-insert-column';

const fromIndex = (sql: string) => sql.search(/\bFROM\b/i);

describe('quoteIdent', () => {
  it('leaves a simple identifier unquoted', () => {
    expect(quoteIdent('region_id')).toBe('region_id');
  });

  it('double-quotes a name with a space', () => {
    expect(quoteIdent('my col')).toBe('"my col"');
  });
});

describe('addColumnToQuery', () => {
  it('seeds SELECT ... FROM when the query is blank', () => {
    const out = addColumnToQuery('', 'sku', 'raw_sales');
    expect(out).toMatch(/select/i);
    expect(out).toContain('sku');
    expect(out).toContain('raw_sales');
  });

  it('seeds SELECT ... FROM when the query is only whitespace', () => {
    const out = addColumnToQuery('   \n  ', 'sku', 'raw_sales');
    expect(out).toMatch(/select/i);
    expect(out).toContain('sku');
    expect(out).toContain('raw_sales');
  });

  it('inserts the column after the last select item, before FROM', () => {
    const out = addColumnToQuery('SELECT id FROM raw_sales', 'sku', 'raw_sales');
    expect(out.indexOf('id')).toBeLessThan(out.indexOf('sku'));
    expect(out.indexOf('sku')).toBeLessThan(fromIndex(out));
  });

  it('keeps the star and appends after it for SELECT *', () => {
    const out = addColumnToQuery('SELECT * FROM raw_sales', 'sku', 'raw_sales');
    expect(out).toContain('*');
    expect(out.indexOf('*')).toBeLessThan(out.indexOf('sku'));
    expect(out.indexOf('sku')).toBeLessThan(fromIndex(out));
  });

  it('does nothing when the bare column is already selected', () => {
    const input = 'SELECT id, sku FROM raw_sales';
    expect(addColumnToQuery(input, 'sku', 'raw_sales')).toBe(input);
  });

  it('treats a qualified existing column as a duplicate of the bare name', () => {
    const input = 'SELECT region_master.region_id FROM raw_sales';
    expect(addColumnToQuery(input, 'region_id', 'raw_sales')).toBe(input);
  });

  it('preserves a qualified column expression', () => {
    const out = addColumnToQuery('SELECT id FROM raw_sales', 'region_master.region_id', 'raw_sales');
    expect(out).toContain('region_master.region_id');
  });

  it('never emits a leading comma when adding the first column to an empty select list', () => {
    const out = addColumnToQuery('SELECT  FROM raw_sales', 'sku', 'raw_sales');
    expect(out).toContain('sku');
    expect(out).not.toMatch(/select\s*,/i);
    expect(out.split('\n').every((line) => !line.trim().startsWith(','))).toBe(true);
  });

  it('adds the first column without a comma when the query is just SELECT', () => {
    const out = addColumnToQuery('SELECT', 'sku', 'raw_sales');
    expect(out).toContain('sku');
    expect(out).not.toMatch(/select\s*,/i);
  });

  it('places commas after columns, never before, in the formatted output', () => {
    const out = addColumnToQuery('SELECT id FROM raw_sales', 'sku', 'raw_sales');
    expect(out.split('\n').every((line) => !line.trim().startsWith(','))).toBe(true);
  });

  it('inserts before the outer FROM, not a FROM inside a subquery', () => {
    const input = 'SELECT (SELECT max(x) FROM other) AS m FROM raw_sales';
    const out = addColumnToQuery(input, 'sku', 'raw_sales');
    expect(out).toContain('other');
    expect(out.indexOf('other')).toBeLessThan(out.indexOf('sku'));
    expect(out.indexOf('sku')).toBeLessThan(out.indexOf('raw_sales'));
  });
});
