'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import ResultsGrid from '@/components/ResultsGrid';
import { usePagedRows, type GridSort } from '@/hooks/use-paged-rows';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination';

interface DataPreviewModalProps {
  datasetId: string;
  datasetName: string;
  getColumnType: (colName: string) => string;
  onClose: () => void;
}

export default function DataPreviewModal({ datasetId, datasetName, getColumnType, onClose }: DataPreviewModalProps) {
  const [pageIdx, setPageIdx] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<GridSort | null>(null);
  const debouncedSearch = useDebouncedValue(search, 300);
  const paged = usePagedRows({ datasetId }, { columns: [], rows: [] }, {
    pageIdx,
    pageSize,
    search: debouncedSearch,
    sort,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const initialLoading = paged.total === null && paged.loading;
  const initialError = paged.total === null && paged.error;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-[96rem] h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-11 border-b border-slate-200 flex items-center justify-between px-4 bg-slate-50 shrink-0">
          <span title={datasetName} className="text-xs font-semibold text-slate-800 font-mono truncate">{datasetName}</span>
          <button
            title="Close preview"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-slate-800 transition-all cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {initialError ? (
            <div className="h-full flex items-center justify-center">
              <div className="max-w-md text-center bg-white border border-red-200 p-5 rounded-lg shadow-sm">
                <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
                <p className="text-xs text-red-700 font-mono">{paged.error}</p>
              </div>
            </div>
          ) : initialLoading ? (
            <div className="h-full flex items-center justify-center text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : (
            <ResultsGrid
              columns={paged.columns}
              rows={paged.rows}
              getColumnType={getColumnType}
              title="Data Preview"
              searchValue={search}
              onSearchChange={(value: string) => { setSearch(value); setPageIdx(0); }}
              sort={sort}
              onSortChange={(next: GridSort | null) => { setSort(next); setPageIdx(0); }}
              pagination={{
                pageIdx,
                pageSize,
                total: paged.total,
                loading: paged.loading,
                error: paged.error,
                onPageChange: setPageIdx,
                onPageSizeChange: (size: number) => { setPageSize(size); setPageIdx(0); },
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
