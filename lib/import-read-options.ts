import type { ConfirmImportItem, StagedFilePreview } from './api';

export interface SheetReadOptions {
  skip_rows: number;
  has_header: boolean;
}

export const DEFAULT_READ_OPTIONS: SheetReadOptions = { skip_rows: 0, has_header: true };

// CSV options key on staged_id alone; Excel options key on staged_id + sheet.
export function readOptionsKey(stagedId: string, sheet: string | null): string {
  return sheet === null ? stagedId : `${stagedId}::${sheet}`;
}

export function isDefaultOptions(o: SheetReadOptions): boolean {
  return o.skip_rows === 0 && o.has_header;
}

// The backend requires a non-negative integer; floor-and-clamp here so a
// fractional or garbage input can never reach pydantic as a raw 422.
export function sanitizeSkipRows(raw: string | number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function seedReadOptions(files: StagedFilePreview[]): Record<string, SheetReadOptions> {
  const seeded: Record<string, SheetReadOptions> = {};
  for (const file of files) {
    const sheets = file.sheets ?? [null];
    for (const sheet of sheets) {
      seeded[readOptionsKey(file.staged_id, sheet)] = { ...DEFAULT_READ_OPTIONS };
    }
  }
  return seeded;
}

export interface SheetValidationTarget {
  sheet: string;
  key: string;
  opts: SheetReadOptions;
}

// Non-active sheets whose options changed since they were last handled
// (signature = JSON of the options). The active sheet is excluded because the
// live-preview effect already fetches and reports errors for it; the caller
// validates the returned sheets in the background so a bulk-applied bad
// skip_rows on a never-visited sheet still blocks Confirm.
export function staleSheetOptions(
  file: StagedFilePreview,
  options: Record<string, SheetReadOptions>,
  handledSigs: Record<string, string>,
  activeSheet: string | null,
): SheetValidationTarget[] {
  if (!file.sheets) return [];
  return file.sheets
    .filter((sheet) => sheet !== activeSheet)
    .map((sheet) => {
      const key = readOptionsKey(file.staged_id, sheet);
      return { sheet, key, opts: options[key] ?? DEFAULT_READ_OPTIONS };
    })
    .filter(({ key, opts }) => handledSigs[key] !== JSON.stringify(opts));
}

export function confirmOptionFields(
  file: StagedFilePreview,
  options: Record<string, SheetReadOptions>,
): Pick<ConfirmImportItem, 'skip_rows' | 'has_header' | 'sheet_options'> {
  if (file.sheets === null) {
    const o = options[readOptionsKey(file.staged_id, null)] ?? DEFAULT_READ_OPTIONS;
    return { skip_rows: o.skip_rows, has_header: o.has_header };
  }
  const sheet_options: Record<string, SheetReadOptions> = {};
  for (const sheet of file.sheets) {
    const o = options[readOptionsKey(file.staged_id, sheet)] ?? DEFAULT_READ_OPTIONS;
    if (!isDefaultOptions(o)) sheet_options[sheet] = o;
  }
  return { sheet_options };
}
