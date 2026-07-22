import { describe, it, expect } from 'vitest';
import { formatSql, tableSelectSql } from './sql-format';

describe('formatSql', () => {
  it('reformats a single-line query to multi-line with uppercase keywords', () => {
    const out = formatSql('select id, name from raw_sales_data where id > 5');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out).toContain('WHERE');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('never throws — returns a string even for unformattable input', () => {
    expect(typeof formatSql('!!! not valid @@@')).toBe('string');
  });
});

describe('tableSelectSql', () => {
  it('produces a formatted SELECT with the table on its own line', () => {
    const sql = tableSelectSql('imported.raw_sales_data');
    expect(sql).toBe('SELECT\n  *\nFROM\n  imported.raw_sales_data;');
  });

  it('preserves quoted identifiers', () => {
    expect(tableSelectSql('"documents"."my file"')).toContain('"documents"."my file"');
  });
});
