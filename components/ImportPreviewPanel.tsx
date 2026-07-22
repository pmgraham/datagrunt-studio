'use client';

import { useEffect, useRef, useState } from 'react';
import {
  previewStagedFile,
  type StagedFilePreview,
  type StagedSheetPreview,
} from '@/lib/api';
import {
  DEFAULT_READ_OPTIONS,
  isDefaultOptions,
  readOptionsKey,
  sanitizeSkipRows,
  staleSheetOptions,
  type SheetReadOptions,
} from '@/lib/import-read-options';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

interface ImportPreviewPanelProps {
  file: StagedFilePreview;
  isSingle: boolean;
  isNorm: boolean;
  options: Record<string, SheetReadOptions>;
  onOptionsChange: (key: string, opts: SheetReadOptions) => void;
  onErrorChange: (key: string, hasError: boolean) => void;
}

// Per-file import preview: sheet tabs (Excel), skip-rows/header controls, and
// a debounced live re-preview. On parse errors we keep the last good preview
// and surface the message inline. Errors are tracked per option key
// (staged_id + sheet), not per file, so a broken sheet keeps blocking Confirm
// while the user looks at a healthy one; sheets edited via the bulk controls
// but never visited are validated in the background for the same reason.
export function ImportPreviewPanel({
  file, isSingle, isNorm, options, onOptionsChange, onErrorChange,
}: ImportPreviewPanelProps) {
  const sheets = file.sheets;
  const [activeSheet, setActiveSheet] = useState<string | null>(sheets?.[0] ?? null);
  const key = readOptionsKey(file.staged_id, activeSheet);
  const opts = options[key] ?? DEFAULT_READ_OPTIONS;
  const firstSheet = sheets?.[0] ?? null;

  const initialPreview: StagedSheetPreview | null = file.columns
    ? {
        columns: file.columns,
        columns_normalized: file.columns_normalized ?? file.columns,
        rows: file.rows ?? [],
      }
    : null;

  const [previews, setPreviews] = useState<Record<string, StagedSheetPreview>>({});
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Option signature (JSON) each key was last previewed at, so the background
  // pass can tell which sheets still need validation. Marked on completion,
  // not on request start — a cancelled fetch must stay eligible for a retry.
  const handledSigsRef = useRef<Record<string, string>>({});

  const setSheetError = (errorKey: string, message: string | null) => {
    setErrors((prev) => {
      if (message === null) {
        if (!(errorKey in prev)) return prev;
        const next = { ...prev };
        delete next[errorKey];
        return next;
      }
      return prev[errorKey] === message ? prev : { ...prev, [errorKey]: message };
    });
    onErrorChange(errorKey, message !== null);
  };

  // One debounced signature covers both "options changed" and "tab changed";
  // resetKey snaps it when a different file mounts into this panel.
  const requestSig = JSON.stringify({ sheet: activeSheet, opts });
  const debouncedSig = useDebouncedValue(requestSig, 300, file.staged_id);

  useEffect(() => {
    const { sheet, opts: o } = JSON.parse(debouncedSig) as {
      sheet: string | null; opts: SheetReadOptions;
    };
    const sigKey = readOptionsKey(file.staged_id, sheet);
    const optsSig = JSON.stringify(o);
    // The upload-time preview already covers the first sheet (or the CSV)
    // at default options — no fetch needed. If that upload-time parse
    // failed (file.error), surface it and wait for the user to adjust the
    // options; the next debounced change refetches and can recover.
    const isInitial = isDefaultOptions(o) && sheet === firstSheet;
    if (isInitial) {
      handledSigsRef.current[sigKey] = optsSig;
      // The fetched-preview cache is keyed per sheet, not per options, so a
      // result fetched under non-default options must be evicted here —
      // otherwise it would shadow the upload-time preview after the user
      // resets the options back to defaults.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreviews((prev) => {
        if (!(sigKey in prev)) return prev;
        const next = { ...prev };
        delete next[sigKey];
        return next;
      });
      setSheetError(sigKey, file.error ?? null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    previewStagedFile(file.staged_id, { sheet, skip_rows: o.skip_rows, has_header: o.has_header })
      .then((res) => {
        if (cancelled) return;
        handledSigsRef.current[sigKey] = optsSig;
        setPreviews((prev) => ({ ...prev, [sigKey]: res }));
        setSheetError(sigKey, null);
      })
      .catch((err) => {
        if (cancelled) return;
        handledSigsRef.current[sigKey] = optsSig;
        setSheetError(sigKey, err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSig]);

  // Background validation for the sheets the effect above never touches:
  // bulk-applied options land on every sheet at once, and a bad skip_rows on
  // a never-visited sheet must still surface an error and block Confirm.
  // activeSheet is part of the signature so a tab switch re-checks the sheet
  // whose in-flight fetch the switch just cancelled.
  const backgroundSig = JSON.stringify({
    active: activeSheet,
    opts: (sheets ?? []).map((s) => options[readOptionsKey(file.staged_id, s)] ?? DEFAULT_READ_OPTIONS),
  });
  const debouncedBackgroundSig = useDebouncedValue(backgroundSig, 300, file.staged_id);

  useEffect(() => {
    void debouncedBackgroundSig;
    const targets = staleSheetOptions(file, options, handledSigsRef.current, activeSheet);
    let cancelled = false;
    for (const target of targets) {
      const optsSig = JSON.stringify(target.opts);
      if (isDefaultOptions(target.opts)) {
        // Defaults need no fetch: the first sheet falls back to its
        // upload-time result, other sheets are presumed fine until visited.
        handledSigsRef.current[target.key] = optsSig;
        setSheetError(target.key, target.sheet === firstSheet ? (file.error ?? null) : null);
        continue;
      }
      previewStagedFile(file.staged_id, {
        sheet: target.sheet, skip_rows: target.opts.skip_rows, has_header: target.opts.has_header,
      })
        .then((res) => {
          if (cancelled) return;
          handledSigsRef.current[target.key] = optsSig;
          setPreviews((prev) => ({ ...prev, [target.key]: res }));
          setSheetError(target.key, null);
        })
        .catch((err) => {
          if (cancelled) return;
          handledSigsRef.current[target.key] = optsSig;
          setSheetError(target.key, err instanceof Error ? err.message : String(err));
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedBackgroundSig]);

  // Fetched result wins; the upload-time preview covers the first sheet /
  // CSV before any refetch. Other sheets show nothing until their first
  // fetch resolves, which the effect triggers immediately on tab switch.
  const isFirstSheet = activeSheet === firstSheet;
  const preview: StagedSheetPreview | null =
    previews[key] ?? (isFirstSheet ? initialPreview : null);
  const error = errors[key] ?? null;

  const setOpts = (patch: Partial<SheetReadOptions>) =>
    onOptionsChange(key, { ...opts, ...patch });

  return (
    <div className="space-y-3">
      {/* Sheet tabs (Excel only) */}
      {sheets && sheets.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {sheets.map((s) => (
            <button
              key={s}
              onClick={() => setActiveSheet(s)}
              className={`px-2.5 py-1 text-[10.5px] font-mono rounded-md border transition-colors cursor-pointer ${
                s === activeSheet
                  ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold'
                  : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              {s}
              {errors[readOptionsKey(file.staged_id, s)] && (
                <span className="ml-1.5 text-red-500" title="This sheet has a preview error">●</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Read options */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <label className="flex items-center gap-1.5 font-medium">
          <span>Skip rows{sheets && sheets.length > 1 ? ' (this sheet)' : ''}:</span>
          <input
            type="number"
            min={0}
            value={opts.skip_rows}
            onChange={(e) => setOpts({ skip_rows: sanitizeSkipRows(e.target.value) })}
            className="w-16 border border-slate-200 rounded px-2 py-1 bg-white text-slate-700 font-mono outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="flex items-center gap-2 font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={opts.has_header}
            onChange={(e) => setOpts({ has_header: e.target.checked })}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
          />
          <span>First row is header</span>
        </label>
        {loading && <span className="text-slate-400 animate-pulse">Updating preview…</span>}
      </div>

      {/* Inline parse error — last good preview stays visible below */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Columns Mapping List */}
      {preview && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase font-bold tracking-wider text-slate-450 select-none">
            <span>Columns Reference (Original → Normalized)</span>
            {isNorm && <span className="text-blue-500 font-semibold normal-case">Normalized Names Will Be Used</span>}
          </div>
          <div className="flex flex-wrap gap-1.5 p-2 bg-white/70 border border-slate-200/60 rounded-md max-h-[85px] overflow-y-auto font-mono text-[9.5px] scrollbar-thin">
            {preview.columns.map((col, idx) => {
              const normName = preview.columns_normalized[idx] || col;
              return (
                <div key={idx} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200/50 rounded px-2 py-0.5 text-slate-650 shrink-0">
                  <span className="text-slate-600 font-medium">{col}</span>
                  <span className="text-slate-400 font-bold">→</span>
                  <span className="text-blue-700 font-semibold">{normName}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Preview Table (single-file import only) */}
      {isSingle && preview && (
        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm max-h-[240px] overflow-x-auto overflow-y-auto">
          <table className="w-full min-w-max text-left border-collapse text-[10.5px]">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
              <tr>
                {preview.columns.map((col, idx) => {
                  const normName = preview.columns_normalized[idx] || col;
                  return (
                    <th key={idx} className="px-3 py-2 text-slate-700 font-semibold font-mono">
                      <div className="flex flex-col">
                        <span className="truncate">{isNorm ? normName : col}</span>
                        {isNorm && normName !== col && (
                          <span className="text-[8.5px] text-slate-400 font-normal line-through truncate">({col})</span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rIdx) => (
                <tr key={rIdx} className="border-b border-slate-100 hover:bg-slate-50/50 last:border-none">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-1.5 text-slate-600 truncate max-w-[150px]">
                      {cell === null || cell === undefined ? '' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
