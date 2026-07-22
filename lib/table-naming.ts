/**
 * Client-side preview of the DuckDB table name the backend will create for an
 * import, used to warn "table already exists" before confirming.
 *
 * This MUST stay in lockstep with backend/app/session_registry.py
 * (`_sanitize`, `to_snake_case`, `base_table_name`). The contract tests in
 * table-naming.test.ts pin the shared cases — in particular the order in
 * `sanitizeName` (replace non-alphanumerics, THEN collapse runs), which the
 * reverse order gets wrong for inputs like "a--b" (`a_b`, not `a__b`).
 */

/** Strip a single trailing file extension. Mirror of Python `Path(name).stem`. */
function fileStem(name: string): string {
  return name.replace(/\.[^/.]+$/, '');
}

/** Mirror of backend `_sanitize`: replace non-alphanumerics, then collapse runs. */
export function sanitizeName(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Mirror of backend `to_snake_case`, used for the `documents` schema. */
export function toSnakeCase(filename: string): string {
  const sanitized = fileStem(filename).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return sanitized.replace(/^_+|_+$/g, '') || 'document';
}

/** The base table name before any collision suffix. Mirror of backend `base_table_name`. */
export function baseTableName(filename: string, sheet: string | null, schema: string): string {
  if (schema === 'documents' || schema === 'rationalized') {
    return toSnakeCase(filename);
  }
  const stem = sanitizeName(fileStem(filename)) || 'dataset';
  const sheetPart = sheet ? `_${sanitizeName(sheet)}` : '';
  return `${stem}${sheetPart}`;
}

/**
 * Fully-qualified `session.<schema>.<table>` path the backend would target.
 * Note: the backend appends a `_2`-style suffix on collision; this returns the
 * un-suffixed base, which is exactly what an existence check needs.
 */
export function targetTablePath(filename: string, sheet: string | null, schema: string): string {
  const cleanSchema = sanitizeName(schema) || 'imported';
  return `session.${cleanSchema}.${baseTableName(filename, sheet, cleanSchema)}`;
}
