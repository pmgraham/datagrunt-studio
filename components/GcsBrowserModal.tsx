'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, AlertCircle, Folder, FileText, ChevronRight, Cloud } from 'lucide-react';
import { listGcsBuckets, listGcsObjects, listGcsProjects, type GcsObjectEntry, type GcsObjectKind, type GcsProject } from '@/lib/api';

interface GcsBrowserModalProps {
  onClose: () => void;
  // Parent performs the import (and closes the modal on success); a rejection
  // is shown inline here so the user can retry or change selection.
  onImport: (bucket: string, objects: string[]) => Promise<void>;
  // What the browser lists and imports; also selects hint copy and button label.
  kind?: GcsObjectKind;
  // 'single' replaces the selection on each click instead of accumulating.
  selectMode?: 'multi' | 'single';
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function GcsBrowserModal({
  onClose,
  onImport,
  kind = 'datasets',
  selectMode = 'multi',
}: GcsBrowserModalProps) {
  const [projects, setProjects] = useState<GcsProject[] | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [files, setFiles] = useState<GcsObjectEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading state synchronously for the new fetch
    setLoading(true);
    setError(null);
    listGcsProjects()
      .then((found) => { if (!cancelled) setProjects(found); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading state synchronously for the new fetch
    setLoading(true);
    setError(null);
    listGcsBuckets(project)
      .then((names) => { if (!cancelled) setBuckets(names); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
    if (!bucket) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading state synchronously for the new fetch
    setLoading(true);
    setError(null);
    listGcsObjects(bucket, prefix, kind)
      .then((listing) => {
        if (cancelled) return;
        setFolders(listing.folders);
        setFiles(listing.files);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bucket, prefix, kind]);

  const toggleFile = (name: string) => {
    setSelected((prev) => {
      if (selectMode === 'single') {
        return prev.has(name) ? new Set<string>() : new Set([name]);
      }
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const openProject = (id: string) => {
    setProject(id);
    setBuckets(null);
    setBucket(null);
    setPrefix('');
    setSelected(new Set());
  };

  const openBucket = (name: string) => {
    setBucket(name);
    setPrefix('');
    setFolders([]);
    setFiles([]);
    setSelected(new Set());
  };

  // Selected files are keyed by full object name, so a selection made in one
  // folder would silently survive navigation; clear it whenever the view moves.
  const openPrefix = (nextPrefix: string) => {
    setPrefix(nextPrefix);
    setSelected(new Set());
  };

  const handleImport = async () => {
    if (!bucket || selected.size === 0 || importing) return;
    setImporting(true);
    setError(null);
    try {
      await onImport(bucket, Array.from(selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(false);
    }
  };

  // Breadcrumb segments for the current prefix: "raw/2026/" -> ["raw", "2026"]
  const crumbs = prefix.split('/').filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-2xl h-[70vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-slate-200 flex items-center justify-between px-4 bg-slate-50 shrink-0">
          <span className="text-xs font-semibold text-slate-800 flex items-center gap-2">
            <Cloud className="w-3.5 h-3.5 text-blue-600" />
            Import from Google Cloud Storage
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 cursor-pointer" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="h-9 border-b border-slate-100 flex items-center gap-1 px-4 text-[11px] text-slate-600 shrink-0 overflow-x-auto">
          <button
            className="hover:text-blue-600 cursor-pointer font-medium shrink-0"
            onClick={() => { setProject(null); setBuckets(null); setBucket(null); setPrefix(''); setSelected(new Set()); }}
          >
            Projects
          </button>
          {project && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />
              <button
                className="hover:text-blue-600 cursor-pointer font-mono shrink-0"
                onClick={() => { setBucket(null); setPrefix(''); setSelected(new Set()); }}
              >
                {project}
              </button>
            </>
          )}
          {bucket && (
            <>
              <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />
              <button className="hover:text-blue-600 cursor-pointer font-mono shrink-0" onClick={() => openPrefix('')}>
                {bucket}
              </button>
            </>
          )}
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3 h-3 text-slate-300" />
              <button
                className="hover:text-blue-600 cursor-pointer font-mono"
                onClick={() => openPrefix(crumbs.slice(0, i + 1).join('/') + '/')}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
          {loading ? (
            <div className="h-full flex items-center justify-center text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : project === null ? (
            <ul className="py-1">
              {(projects ?? []).map((p) => (
                <li key={p.id}>
                  <button
                    className="w-full text-left px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                    onClick={() => openProject(p.id)}
                  >
                    <Cloud className="w-3.5 h-3.5 text-blue-500" />
                    <span className="font-mono">{p.id}</span>
                    {p.name !== p.id && <span className="text-slate-400 truncate">{p.name}</span>}
                  </button>
                </li>
              ))}
              {projects !== null && projects.length === 0 && !error && (
                <li className="px-4 py-6 text-xs text-slate-400 text-center">No accessible projects found.</li>
              )}
            </ul>
          ) : bucket === null ? (
            <ul className="py-1">
              {(buckets ?? []).map((name) => (
                <li key={name}>
                  <button
                    className="w-full text-left px-4 py-2 text-xs font-mono text-slate-700 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                    onClick={() => openBucket(name)}
                  >
                    <Folder className="w-3.5 h-3.5 text-amber-500" />
                    {name}
                  </button>
                </li>
              ))}
              {buckets !== null && buckets.length === 0 && !error && (
                <li className="px-4 py-6 text-xs text-slate-400 text-center">No buckets found in this project.</li>
              )}
            </ul>
          ) : (
            <ul className="py-1">
              {folders.map((folder) => (
                <li key={folder}>
                  <button
                    className="w-full text-left px-4 py-2 text-xs font-mono text-slate-700 hover:bg-slate-50 hover:text-blue-600 flex items-center gap-2 cursor-pointer"
                    onClick={() => openPrefix(folder)}
                  >
                    <Folder className="w-3.5 h-3.5 text-amber-500" />
                    {folder.slice(prefix.length).replace(/\/$/, '')}
                  </button>
                </li>
              ))}
              {files.map((file) => (
                <li key={file.name}>
                  <label className="w-full px-4 py-2 text-xs font-mono text-slate-700 hover:bg-slate-50 flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(file.name)}
                      onChange={() => toggleFile(file.name)}
                      className="accent-blue-600"
                    />
                    <FileText className="w-3.5 h-3.5 text-slate-400" />
                    <span className="flex-1 truncate">{file.name.slice(prefix.length)}</span>
                    <span className="text-slate-400 text-[10px] shrink-0">{formatSize(file.size)}</span>
                  </label>
                </li>
              ))}
              {folders.length === 0 && files.length === 0 && !error && (
                <li className="px-4 py-6 text-xs text-slate-400 text-center">
                  {kind === 'pdf' ? 'No PDF files here.' : 'No importable files here (.csv, .parquet, .json, .xlsx, .xls).'}
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="h-12 border-t border-slate-200 flex items-center justify-between px-4 bg-slate-50 shrink-0">
          <span className="text-[11px] text-slate-500">
            {selected.size > 0 ? `${selected.size} file${selected.size === 1 ? '' : 's'} selected` : 'Select files to import'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="text-xs px-4 py-1.5 rounded-md bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-default cursor-pointer flex items-center gap-1.5"
            >
              {importing && <Loader2 className="w-3 h-3 animate-spin" />}
              {importing ? 'Importing…' : selectMode === 'single' ? 'Import PDF' : 'Import Selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
