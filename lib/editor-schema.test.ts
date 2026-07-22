import { describe, it, expect } from 'vitest';
import { datasetsToSchema } from './editor-schema';

describe('datasetsToSchema', () => {
  it('maps a dataset table to its column names', () => {
    const out = datasetsToSchema([
      { table: 'raw_sales_data', name: 'raw_sales_data.csv', columns: [{ name: 'id' }, { name: 'price' }] },
    ]);
    expect(out).toEqual({ raw_sales_data: ['id', 'price'] });
  });

  it('maps multiple datasets', () => {
    const out = datasetsToSchema([
      { table: 't1', name: 'a', columns: [{ name: 'x' }] },
      { table: 't2', name: 'b', columns: [{ name: 'y' }, { name: 'z' }] },
    ]);
    expect(out).toEqual({ t1: ['x'], t2: ['y', 'z'] });
  });

  it('skips datasets without a table', () => {
    const out = datasetsToSchema([{ name: 'pending', columns: [{ name: 'x' }] }]);
    expect(out).toEqual({});
  });
});
