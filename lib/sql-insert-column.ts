import { formatSql } from './sql-format';

// Inserts a column into a SQL query's first/outermost SELECT list, then
// pretty-prints the result. Used by the "click a column to add it" sidebar
// affordance. The query text is treated as untrusted free-form SQL, so the
// scanner skips string literals and comments and tracks parenthesis depth to
// avoid being fooled by columns or FROM clauses inside subqueries.

const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Quote a SQL identifier only when it isn't a plain word (e.g. a CSV column
// name with spaces). Embedded double quotes are escaped by doubling.
export function quoteIdent(name: string): string {
  return SIMPLE_IDENT.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const isIdentChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

// If position `i` begins a string literal or comment, return the index just
// past it; otherwise return -1. Handles '...', "...", `...` (with doubled-quote
// escaping), -- line comments, and /* */ block comments.
function skipStringOrComment(s: string, i: number): number {
  const c = s[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === c) {
        if (s[j + 1] === c) {
          j += 2; // doubled quote = escaped quote
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return j;
  }
  if (c === '-' && s[i + 1] === '-') {
    let j = i + 2;
    while (j < s.length && s[j] !== '\n') j++;
    return j;
  }
  if (c === '/' && s[i + 1] === '*') {
    let j = i + 2;
    while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
    return Math.min(j + 2, s.length);
  }
  return -1;
}

// Locate the outermost SELECT and its matching FROM (both at paren depth 0).
// Returns the index just after SELECT and the index of FROM, or null if the
// query has no top-level SELECT ... FROM.
function findTopLevelSelectFrom(s: string): { selectEnd: number; fromStart: number } | null {
  let depth = 0;
  let i = 0;
  let selectEnd = -1;

  while (i < s.length) {
    const skipped = skipStringOrComment(s, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = s[i];
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && !isIdentChar(s[i - 1])) {
      let j = i + 1;
      while (j < s.length && isIdentChar(s[j])) j++;
      const word = s.slice(i, j).toUpperCase();
      if (depth === 0) {
        if (selectEnd === -1 && word === 'SELECT') {
          selectEnd = j;
        } else if (selectEnd !== -1 && word === 'FROM') {
          return { selectEnd, fromStart: i };
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return null;
}

// Split a select list on its top-level commas (commas inside parens/strings
// belong to function calls or subqueries and are left intact).
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const skipped = skipStringOrComment(s, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

// The comparable bare name of a select item or column expression: the last
// dotted segment of its leading reference, unquoted and lower-cased. Used only
// for duplicate detection, so aliases and complex expressions that don't reduce
// to a plain name simply won't match (and the column gets added).
function bareName(expr: string): string {
  const ref = expr.trim().split(/[\s(]/)[0] ?? '';
  const segment = ref.split('.').pop() ?? ref;
  return segment.replace(/^["`]|["`]$/g, '').toLowerCase();
}

// Add `columnExpr` to `sql` and return the formatted result.
//   - blank query        -> SELECT <columnExpr> FROM <table>
//   - top-level SELECT    -> append to that select list, before FROM
//   - already selected    -> unchanged
//   - otherwise (no FROM) -> append to the end as a best-effort fallback
export function addColumnToQuery(sql: string, columnExpr: string, table: string): string {
  if (sql.trim() === '') {
    return formatSql(`SELECT ${columnExpr} FROM ${table};`);
  }

  const found = findTopLevelSelectFrom(sql);
  if (!found) {
    // Best-effort append for unparseable input. A comma only when something
    // other than a bare SELECT precedes it — never a leading comma.
    const head = sql.trimEnd();
    const separator = /\bselect\s*$/i.test(head) ? ' ' : ', ';
    return formatSql(`${head}${separator}${columnExpr}`);
  }

  const { selectEnd, fromStart } = found;
  const selectList = sql.slice(selectEnd, fromStart);
  const items = splitTopLevelCommas(selectList)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const alreadySelected = items
    .filter((part) => part !== '*')
    .some((item) => bareName(item) === bareName(columnExpr));
  if (alreadySelected) {
    return sql;
  }

  // Insert right after the last non-whitespace character of the select list so
  // the new column lands next to the previous one rather than before FROM's
  // leading whitespace/newline.
  let insertAt = fromStart;
  while (insertAt > selectEnd && /\s/.test(sql[insertAt - 1])) insertAt--;

  // A comma only when there is already a column to follow. Adding the first
  // column to an empty select list (e.g. "SELECT  FROM t") must never produce a
  // leading comma like "SELECT, col".
  const separator = items.length > 0 ? ', ' : ' ';
  const next = `${sql.slice(0, insertAt)}${separator}${columnExpr}${sql.slice(insertAt)}`;
  return formatSql(next);
}
