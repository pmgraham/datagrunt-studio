// Shared row search used by the query results panel and the data preview
// modal — one implementation so their search behavior can never drift.

export function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') {
    try {
      return JSON.stringify(cell);
    } catch {
      return String(cell);
    }
  }
  return String(cell);
}

// Every whitespace-separated word must match at least one cell in the row;
// each word may match a different column. Case-insensitive substring match.
export function filterRows(rows: unknown[][], query: string): unknown[][] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const cells = row.map((cell) => cellText(cell).toLowerCase());
    return words.every((word) => cells.some((cell) => cell.includes(word)));
  });
}
