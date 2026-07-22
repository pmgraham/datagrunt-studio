'use client';

import { useState } from 'react';
import type { GridSort } from '@/hooks/use-paged-rows';
import { filterRows } from '@/lib/row-search';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { PAGE_SIZES, pageCount } from '@/lib/pagination';
import dynamic from 'next/dynamic';
import { isJsonBlobResult, buildJsonDocument } from '@/lib/json-result';

const CodeViewer = dynamic(() => import('@/components/CodeViewer'), { ssr: false });

export interface GridPagination {
  pageIdx: number;
  pageSize: number;
  total: number | null;
  loading: boolean;
  error: string | null;
  onPageChange: (pageIdx: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

interface ResultsGridProps {
  columns: string[];
  rows: unknown[][];
  getColumnType: (colName: string) => string;
  title?: string;
  truncatedNote?: string | null;
  toolbar?: React.ReactNode;
  searchPlaceholder?: string;
  emptyMessage?: string;
  pagination?: GridPagination | null;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  sort?: GridSort | null;
  onSortChange?: (sort: GridSort | null) => void;
}

export default function ResultsGrid({
  columns,
  rows,
  getColumnType,
  title = 'Table Output',
  truncatedNote = null,
  toolbar = null,
  searchPlaceholder = 'Search all columns...',
  emptyMessage = 'No rows match your query/filters.',
  pagination = null,
  searchValue,
  onSearchChange,
  sort = null,
  onSortChange,
}: ResultsGridProps) {
  const [localSearch, setLocalSearch] = useState('');
  const serverSearch = searchValue !== undefined && onSearchChange !== undefined;
  const search = serverSearch ? searchValue : localSearch;
  const filteredRows = serverSearch ? rows : filterRows(rows, localSearch);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  // Reset to the table whenever a new result (different column set) arrives.
  // Rows alone changing (paging) must NOT reset — the JSON view survives paging.
  const columnSignature = columns.join('|');
  const [prevColumnSignature, setPrevColumnSignature] = useState(columnSignature);
  if (columnSignature !== prevColumnSignature) {
    setPrevColumnSignature(columnSignature);
    setViewMode('table');
  }
  const jsonEligible = isJsonBlobResult(columns, filteredRows);
  const showJsonView = viewMode === 'json' && jsonEligible;
  const rowOffset = pagination ? pagination.pageIdx * pagination.pageSize : 0;

  const sortable = onSortChange !== undefined;
  const cycleSort = (column: string) => {
    if (!onSortChange) return;
    if (!sort || sort.column !== column) onSortChange({ column, direction: 'asc' });
    else if (sort.direction === 'asc') onSortChange({ column, direction: 'desc' });
    else onSortChange(null);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* CONTROLS BAR */}
      <div className="relative z-20 h-12 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50/80 backdrop-blur-md shrink-0">
        <div className="flex items-center space-x-6 h-full">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-800">{title}</span>
          <span className="text-[10px] bg-blue-50 text-blue-600 border border-blue-100 px-2 py-0.5 rounded-full font-medium font-mono">
            {filteredRows.length} rows {search ? '(Filtered)' : ''}
          </span>
          {truncatedNote && (
            <span className="text-[10px] text-slate-500 font-mono italic">{truncatedNote}</span>
          )}
        </div>
        <div className="flex items-center space-x-3">
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => (serverSearch ? onSearchChange(e.target.value) : setLocalSearch(e.target.value))}
            className="border border-slate-200 bg-white rounded-md px-3 py-1 text-xs text-slate-800 placeholder-slate-405 focus:outline-none focus:border-blue-500/50 outline-none transition-all w-48 md:w-64"
          />
          {jsonEligible && (
            <button
              type="button"
              onClick={() => setViewMode(showJsonView ? 'table' : 'json')}
              className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-600 transition-colors cursor-pointer whitespace-nowrap"
            >
              {showJsonView ? 'View as table' : 'View as JSON'}
            </button>
          )}
          {toolbar}
        </div>
      </div>

      {pagination?.error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs shrink-0 truncate">
          Failed to load page: {pagination.error}
        </div>
      )}

      {/* DATA TABLE */}
      {showJsonView ? (
        <div className={`flex-1 overflow-auto bg-white ${pagination?.loading ? 'opacity-50 pointer-events-none' : ''}`}>
          <CodeViewer value={buildJsonDocument(filteredRows)} language="json" />
        </div>
      ) : (
      <div className={`flex-1 overflow-auto bg-white ${pagination?.loading ? 'opacity-50 pointer-events-none' : ''}`}>
        <table className="w-full text-left border-collapse font-mono text-[11px] text-slate-700 relative">
          <thead className="sticky top-0 bg-slate-50/95 shadow-sm z-10 border-b border-slate-200">
            <tr>
              <th className="w-12 px-4 py-2.5 bg-slate-50/95 text-center text-slate-500 border-r border-slate-200/60 font-normal">#</th>
              {columns.map((col, idx) => {
                const type = getColumnType(col);
                return (
                  <th key={idx} aria-sort={sort?.column === col ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined} className={`px-5 py-2.5 bg-slate-50/95 text-[10px] font-semibold text-slate-650 tracking-wide whitespace-nowrap border-r border-slate-200/60 last:border-none ${sortable ? 'cursor-pointer select-none hover:bg-slate-100/80 transition-colors focus:outline-blue-400' : ''}`} tabIndex={sortable ? 0 : undefined} onKeyDown={sortable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      cycleSort(col);
                    }
                  } : undefined} onClick={sortable ? () => cycleSort(col) : undefined}>
                    <div className="flex flex-col gap-1">
                      <span className="text-slate-800 font-mono flex items-center gap-1">
                        {col}
                        {sort?.column === col && (
                          <span className="text-blue-600 text-[9px]">{sort.direction === 'asc' ? '▲' : '▼'}</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[8px] px-1.5 py-0.2 border rounded uppercase font-mono tracking-wider font-semibold ${
                          type === 'integer' || type === 'decimal'
                            ? 'border-indigo-200 text-indigo-700 bg-indigo-50/80'
                            : type === 'boolean'
                            ? 'border-emerald-200 text-emerald-700 bg-emerald-50/80'
                            : type === 'date' || type === 'timestamp'
                            ? 'border-amber-200 text-amber-700 bg-amber-50/80'
                            : 'border-slate-200 text-slate-500 bg-slate-100/50'
                        }`}>
                          {type}
                        </span>
                        <div className="w-10 h-1 bg-slate-200 rounded-full overflow-hidden" title="Data Populated Metric">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: '100%' }}></div>
                        </div>
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length > 0 ? (
              filteredRows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-blue-50/30 border-b border-slate-100 last:border-none transition-colors">
                  <td className="px-4 py-2 text-center text-slate-550 border-r border-slate-200/60">{rowOffset + rIdx + 1}</td>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-5 py-2.5 whitespace-nowrap truncate max-w-[220px] border-r border-slate-100/60 last:border-none">
                      {cell === null || cell === undefined ? (
                        <span className="text-slate-300 italic">null</span>
                      ) : typeof cell === 'object' ? (
                        <span className="text-slate-500 font-mono text-[9px] truncate" title={JSON.stringify(cell)}>
                          {JSON.stringify(cell)}
                        </span>
                      ) : typeof cell === 'number' ? (
                        <span className="text-blue-600 font-medium">{cell.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</span>
                      ) : (
                        String(cell)
                      )}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length + 1} className="p-8 text-center text-slate-500 italic">
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {pagination && (
        <div className="h-10 border-t border-slate-200 bg-slate-50/80 flex items-center justify-between px-4 shrink-0 text-[11px] text-slate-600">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => pagination.onPageSizeChange(Number(e.target.value))}
              className="border border-slate-200 bg-white rounded px-1.5 py-0.5 text-[11px] cursor-pointer focus:outline-none focus:border-blue-500/50"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
            <span className="text-slate-400">·</span>
            <span>{pagination.total === null ? '— rows' : `${pagination.total.toLocaleString()} rows`}</span>
            {pagination.loading && <Loader2 className="w-3 h-3 animate-spin text-blue-500" />}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pagination.loading || pagination.pageIdx <= 0}
              onClick={() => pagination.onPageChange(pagination.pageIdx - 1)}
              className="px-2 py-1 rounded border border-slate-200 bg-white hover:border-blue-300 hover:text-blue-600 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center gap-1"
            >
              <ChevronLeft className="w-3 h-3" />
              Prev
            </button>
            <span>
              Page {pagination.pageIdx + 1}
              {pagination.total !== null ? ` of ${pageCount(pagination.total, pagination.pageSize)}` : ''}
            </span>
            <button
              type="button"
              disabled={pagination.loading || (pagination.total !== null && pagination.pageIdx >= pageCount(pagination.total, pagination.pageSize) - 1)}
              onClick={() => pagination.onPageChange(pagination.pageIdx + 1)}
              className="px-2 py-1 rounded border border-slate-200 bg-white hover:border-blue-300 hover:text-blue-600 disabled:opacity-40 disabled:cursor-default cursor-pointer flex items-center gap-1"
            >
              Next
              <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
