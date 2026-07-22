import { describe, it, expect } from 'vitest';
import { summarizeImport } from './import-summary';

describe('summarizeImport', () => {
  it('returns null when there are no errors', () => {
    expect(summarizeImport(3, [])).toBeNull();
  });

  it('reports the failed file and the success count', () => {
    const msg = summarizeImport(2, [{ filename: 'bad.csv', message: 'boom' }]);
    expect(msg).toBe('Imported 2 datasets. 1 file failed: bad.csv (boom).');
  });

  it('pluralizes for a single dataset and multiple failures', () => {
    const msg = summarizeImport(1, [
      { filename: 'a.xlsx', message: 'x' },
      { filename: 'b.xlsx', message: 'y' },
    ]);
    expect(msg).toBe('Imported 1 dataset. 2 files failed: a.xlsx (x), b.xlsx (y).');
  });
});
