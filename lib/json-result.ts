/**
 * Detection and formatting for the "View as JSON" results toggle.
 *
 * A result qualifies when it has exactly one column and every non-null
 * cell is a string that parses to a JSON object or array. Parseable
 * scalars ("42", "true") do not qualify — the toggle exists for document
 * blobs, not stringified primitives.
 */

function parseBlob(cell: unknown): { ok: boolean; value: unknown } {
  if (typeof cell !== 'string') return { ok: false, value: cell };
  try {
    const parsed: unknown = JSON.parse(cell);
    if (parsed !== null && typeof parsed === 'object') {
      return { ok: true, value: parsed };
    }
    return { ok: false, value: cell };
  } catch {
    return { ok: false, value: cell };
  }
}

export function isJsonBlobResult(columns: string[], rows: unknown[][]): boolean {
  if (columns.length !== 1 || rows.length === 0) return false;
  let sawBlob = false;
  for (const row of rows) {
    const cell = row[0];
    if (cell === null || cell === undefined) continue;
    if (!parseBlob(cell).ok) return false;
    sawBlob = true;
  }
  return sawBlob;
}

export function buildJsonDocument(rows: unknown[][]): string {
  const values = rows.map((row) => {
    const cell = row[0];
    if (cell === null || cell === undefined) return null;
    return parseBlob(cell).value;
  });
  const doc = values.length === 1 ? values[0] : values;
  return JSON.stringify(doc, null, 2);
}
