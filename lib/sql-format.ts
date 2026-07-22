import { format } from 'sql-formatter';

// Pretty-print SQL using the DuckDB dialect. sql-formatter places commas after
// the column they belong to (never leading/comma-first), which is what we want.
// Returns the input unchanged if the formatter throws (e.g. on an incomplete
// fragment) so a format keypress never destroys the user's text.
export function formatSql(sql: string): string {
  try {
    return format(sql, { language: 'duckdb', keywordCase: 'upper' });
  } catch {
    return sql;
  }
}

// SELECT-all statement for a table, pre-formatted like a Cmd+Shift+F pass so
// SQL inserted by the sidebar's Query action matches user-formatted SQL.
export function tableSelectSql(quotedTable: string): string {
  return formatSql(`SELECT * FROM ${quotedTable};`);
}
