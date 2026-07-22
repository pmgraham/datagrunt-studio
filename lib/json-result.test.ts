import { describe, it, expect } from 'vitest';
import { isJsonBlobResult, buildJsonDocument } from './json-result';

describe('isJsonBlobResult', () => {
  it('accepts a single column of JSON objects', () => {
    const rows = [['{"a": 1}'], ['{"b": 2}']];
    expect(isJsonBlobResult(['doc'], rows)).toBe(true);
  });

  it('accepts a single column of JSON arrays', () => {
    const rows = [['[1, 2]'], ['[{"x": true}]']];
    expect(isJsonBlobResult(['doc'], rows)).toBe(true);
  });

  it('rejects multi-column results even if every cell is JSON', () => {
    const rows = [['{"a": 1}', '{"b": 2}']];
    expect(isJsonBlobResult(['header', 'line_items'], rows)).toBe(false);
  });

  it('rejects non-JSON strings', () => {
    const rows = [['{"a": 1}'], ['not json at all']];
    expect(isJsonBlobResult(['doc'], rows)).toBe(false);
  });

  it('rejects parseable scalar strings', () => {
    expect(isJsonBlobResult(['doc'], [['42']])).toBe(false);
    expect(isJsonBlobResult(['doc'], [['true']])).toBe(false);
    expect(isJsonBlobResult(['doc'], [['"quoted"']])).toBe(false);
  });

  it('accepts nulls mixed with JSON objects', () => {
    const rows = [['{"a": 1}'], [null], [undefined]];
    expect(isJsonBlobResult(['doc'], rows)).toBe(true);
  });

  it('rejects a result that is entirely null', () => {
    expect(isJsonBlobResult(['doc'], [[null], [null]])).toBe(false);
  });

  it('rejects empty results', () => {
    expect(isJsonBlobResult(['doc'], [])).toBe(false);
  });

  it('rejects non-string cells such as numbers', () => {
    expect(isJsonBlobResult(['doc'], [[42]])).toBe(false);
  });
});

describe('buildJsonDocument', () => {
  it('unwraps a single row to the bare object', () => {
    const out = buildJsonDocument([['{"a": 1}']]);
    expect(out).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('renders multiple rows as a pretty-printed array', () => {
    const out = buildJsonDocument([['{"a": 1}'], ['{"b": 2}']]);
    expect(out).toBe(JSON.stringify([{ a: 1 }, { b: 2 }], null, 2));
  });

  it('preserves nulls as null entries', () => {
    const out = buildJsonDocument([['{"a": 1}'], [null]]);
    expect(out).toBe(JSON.stringify([{ a: 1 }, null], null, 2));
  });

  it('falls back to the raw string for unparseable cells', () => {
    const out = buildJsonDocument([['{"a": 1}'], ['broken {']]);
    expect(out).toBe(JSON.stringify([{ a: 1 }, 'broken {'], null, 2));
  });
});
