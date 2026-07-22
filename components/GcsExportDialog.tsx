'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, AlertCircle, CheckCircle2, Cloud } from 'lucide-react';
import { exportToGcs, listGcsBuckets, listGcsProjects, type GcsExportFormat, type GcsProject } from '@/lib/api';
import { withFormatExtension } from '@/lib/gcs-path';

interface GcsExportDialogProps {
  // Exactly one of datasetId or sql, mirroring the /export contract.
  source: { datasetId?: string; sql?: string };
  baseName: string;
  onClose: () => void;
}

const FORMATS: GcsExportFormat[] = ['csv', 'parquet', 'json'];

export default function GcsExportDialog({ source, baseName, onClose }: GcsExportDialogProps) {
  const [format, setFormat] = useState<GcsExportFormat>('csv');
  const [projects, setProjects] = useState<GcsProject[]>([]);
  const [project, setProject] = useState('');
  const [buckets, setBuckets] = useState<string[]>([]);
  const [bucket, setBucket] = useState('');
  const [path, setPath] = useState(`${baseName}.csv`);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    listGcsProjects()
      .then((found) => {
        if (cancelled) return;
        setProjects(found);
        if (found.length > 0) setProject(found[0].id);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoadingProjects(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset bucket state synchronously for the new project's fetch
    setLoadingBuckets(true);
    setBuckets([]);
    setBucket('');
    listGcsBuckets(project)
      .then((names) => {
        if (cancelled) return;
        setBuckets(names);
        if (names.length > 0) setBucket(names[0]);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoadingBuckets(false); });
    return () => { cancelled = true; };
  }, [project]);

  const pickFormat = (next: GcsExportFormat) => {
    setFormat(next);
    setPath((prev) => withFormatExtension(prev, next));
  };

  const handleExport = async () => {
    if (!bucket || busy) return;
    setBusy(true);
    setError(null);
    setUri(null);
    try {
      const result = await exportToGcs({ ...source, format, bucket, path });
      setUri(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-md flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-slate-200 flex items-center justify-between px-4 bg-slate-50">
          <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
            <Cloud className="w-3.5 h-3.5 text-blue-600" />
            Export to Google Cloud Storage
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">Format</label>
            <div className="flex gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => pickFormat(f)}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium border transition-all cursor-pointer ${
                    format === f
                      ? 'bg-blue-50 border-blue-300 text-blue-700'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="gcs_export_project" className="block text-[11px] font-semibold text-slate-600 mb-1.5">Project</label>
            {loadingProjects ? (
              <div className="text-xs text-slate-400 flex items-center gap-2 py-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading projects…
              </div>
            ) : (
              <select
                id="gcs_export_project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-md px-2.5 py-1.5 bg-white text-slate-700 font-mono"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name !== p.id ? `${p.id} — ${p.name}` : p.id}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="gcs_export_bucket" className="block text-[11px] font-semibold text-slate-600 mb-1.5">Bucket</label>
            {loadingBuckets ? (
              <div className="text-xs text-slate-400 flex items-center gap-2 py-1.5">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading buckets…
              </div>
            ) : (
              <select
                id="gcs_export_bucket"
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                className="w-full text-xs border border-slate-200 rounded-md px-2.5 py-1.5 bg-white text-slate-700 font-mono"
              >
                {buckets.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="gcs_export_path" className="block text-[11px] font-semibold text-slate-600 mb-1.5">
              Destination path
            </label>
            <input
              id="gcs_export_path"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={`exports/${baseName}.${format}`}
              className="w-full text-xs border border-slate-200 rounded-md px-2.5 py-1.5 bg-white text-slate-700 font-mono"
            />
            <p className="mt-1 text-[10px] text-slate-400">
              Folder paths (ending in /) get the filename appended automatically.
            </p>
          </div>

          {error && (
            <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {uri && (
            <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="font-mono break-all">Exported to {uri}</span>
            </div>
          )}
        </div>

        <div className="h-12 border-t border-slate-200 flex items-center justify-end gap-2 px-4 bg-slate-50">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded-md text-slate-600 hover:bg-slate-100 cursor-pointer"
          >
            {uri ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleExport}
            disabled={!bucket || busy || loadingBuckets}
            className="text-xs px-4 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-default cursor-pointer flex items-center gap-1.5"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
