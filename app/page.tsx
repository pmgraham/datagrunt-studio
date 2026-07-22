'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { listDatasets, uploadDatasets, resetSession, runQuery, castColumn, duckTypeToLabel, deleteDataset, moveDatasetSchema, previewUploads, confirmImports, uploadPdf, extractPdf, rationalizePdf, getOllamaModels, getGeminiModels, downloadExport, importFromGcs, importPdfFromGcs, type ApiDataset, type ColumnTypeLabel, type PreviewResponse, type ConfirmImportItem, type QueryRequestBody, type StatementResult, type ExportFormat, type ExportRequestBody, type GcsImportResult } from '@/lib/api';
import { resultExportFilename } from '@/lib/export-filename';
import { DownloadMenu } from '@/components/DownloadMenu';
import { summarizeImport } from '@/lib/import-summary';
import { targetTablePath, toSnakeCase } from '@/lib/table-naming';
import { tableSelectSql } from '@/lib/sql-format';
import dynamic from 'next/dynamic';
import { PanelGroup, Panel, type ImperativePanelHandle } from 'react-resizable-panels';
import ResizeHandle from '@/components/ResizeHandle';
import ResultsGrid from '@/components/ResultsGrid';
import DataPreviewModal from '@/components/DataPreviewModal';
import GcsBrowserModal from '@/components/GcsBrowserModal';
import GcsExportDialog from '@/components/GcsExportDialog';
import { datasetsToSchema } from '@/lib/editor-schema';
import { addColumnToQuery, quoteIdent } from '@/lib/sql-insert-column';
import { motion, AnimatePresence } from 'motion/react';
import { usePagedRows, type GridSort } from '@/hooks/use-paged-rows';
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { ImportPreviewPanel } from '@/components/ImportPreviewPanel';
import { seedReadOptions, confirmOptionFields, sanitizeSkipRows, type SheetReadOptions } from '@/lib/import-read-options';

const SqlEditor = dynamic(() => import('@/components/SqlEditor'), {
  ssr: false,
});

const CodeViewer = dynamic(() => import('@/components/CodeViewer'), {
  ssr: false,
});
import { 
  FileSpreadsheet,
  Database,
  Play,
  Plus,
  Settings2,
  Table2,
  ChevronRight,
  ChevronDown,
  Wand2,
  TerminalSquare,
  Download,
  Trash2,
  RefreshCw,
  Check,
  AlertCircle,
  Upload,
  Layers,
  ListChecks,
  FileText,
  Eye,
  Cloud,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';

// --- TYPES ---
interface CleanStep {
  id: string;
  datasetId?: string;
  op: 'drop_null' | 'fill_null' | 'rename' | 'cast' | 'dedup';
  column?: string;
  value?: string;
  newName?: string;
  castType?: string;
}

interface Column {
  name: string;
  type: 'text' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp';
}

interface Dataset {
  id: string;
  name: string;
  type: 'csv' | 'excel' | 'json' | 'cleaned' | 'pdf' | 'pdf_rationalized';
  columns: Column[];
  rows: any[][];
  table?: string;
  schema_name: string;
}

function toUiDataset(api: ApiDataset): Dataset {
  return {
    id: api.id,
    name: api.name,
    type: (api.type as Dataset['type']) || 'csv',
    columns: api.columns.map((c) => ({ name: c.name, type: duckTypeToLabel(c.type) })),
    rows: [],
    table: api.table,
    schema_name: api.schema_name,
  };
}

function quoteTableIdent(table: string): string {
  if (table.includes('.')) {
    return table.split('.').map(quoteIdent).join('.');
  }
  return quoteIdent(table);
}

function parseInlineMarkdown(text: string, docId?: string): React.ReactNode {
  const regex = /(\!\[.*?\]\(.*?\)|Reference:\s*.*?|\*\*.*?\*\*|\*.*?\*|`.*?`)/g;
  const splitParts = text.split(regex);
  
  return splitParts.map((part, index) => {
    if (part.startsWith('![') && part.includes('](')) {
      const match = part.match(/^\!\[(.*?)\]\((.*?)\)$/);
      if (match) {
        const alt = match[1];
        const src = match[2];
        const filename = src.split('/').pop() || src;
        if (docId) {
          return (
            <span key={index} className="block my-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img 
                src={`/api/pdf/image/${docId}/${filename}`} 
                alt={alt} 
                className="max-w-[400px] max-h-[300px] object-contain rounded-lg border border-slate-200/80 shadow-sm hover:scale-102 transition-transform duration-200" 
              />
              {alt && <span className="block text-[10px] text-slate-400 mt-1 italic text-center max-w-[400px]">{alt}</span>}
            </span>
          );
        }
      }
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={index} className="italic text-slate-800">{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="bg-slate-100 px-1 py-0.5 rounded text-[10px] font-mono text-red-600 font-semibold">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function renderMarkdown(md: string, docId: string) {
  if (!md) return <p className="text-slate-400 italic p-6">No markdown content available.</p>;

  const lines = md.split('\n');
  const elements: React.ReactNode[] = [];
  
  let inList = false;
  let listItems: string[] = [];
  
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];

  const flushList = (key: string) => {
    if (listItems.length > 0) {
      elements.push(
        <ul key={key} className="list-disc pl-5 my-2 space-y-1 text-slate-700">
          {listItems.map((item, i) => (
            <li key={i}>{parseInlineMarkdown(item, docId)}</li>
          ))}
        </ul>
      );
      listItems = [];
      inList = false;
    }
  };

  const flushTable = (key: string) => {
    if (tableHeaders.length > 0 || tableRows.length > 0) {
      elements.push(
        <div key={key} className="overflow-x-auto my-3 border border-slate-200 rounded-lg shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-[11px]">
            <thead className="bg-slate-50">
              <tr>
                {tableHeaders.map((header, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold text-slate-700 uppercase tracking-wider">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {tableRows.map((row, rIdx) => (
                <tr key={rIdx} className="hover:bg-slate-50/50">
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 text-slate-600 font-mono">{parseInlineMarkdown(cell, docId)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      tableHeaders = [];
      tableRows = [];
      inTable = false;
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    
    // Table parser
    if (line.startsWith('|')) {
      flushList(`list-${idx}`);
      inTable = true;
      const parts = line.split('|').map(p => p.trim()).filter((p, i, arr) => i > 0 && i < arr.length - 1);
      
      const isDivider = parts.every(p => p.match(/^:?-+:?$/));
      if (isDivider) {
        continue;
      }
      
      if (tableHeaders.length === 0) {
        tableHeaders = parts;
      } else {
        tableRows.push(parts);
      }
      continue;
    } else {
      if (inTable) {
        flushTable(`table-${idx}`);
      }
    }

    // List item parser
    if (line.startsWith('- ') || line.startsWith('* ')) {
      inList = true;
      listItems.push(line.substring(2));
      continue;
    } else {
      if (inList) {
        flushList(`list-${idx}`);
      }
    }

    // Headings
    if (line.startsWith('#')) {
      const match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const level = match[1].length;
        const text = match[2];
        const headingClasses = 
          level === 1 ? "text-lg font-bold text-slate-900 mt-4 mb-2 border-b pb-1" :
          level === 2 ? "text-base font-semibold text-slate-800 mt-3 mb-1.5" :
          "text-xs font-semibold text-slate-700 mt-2 mb-1";
        const HeadingTag = `h${level}` as React.ElementType;
        elements.push(
          <HeadingTag key={`h-${idx}`} className={headingClasses}>
            {parseInlineMarkdown(text, docId)}
          </HeadingTag>
        );
        continue;
      }
    }

    // Paragraph
    if (line !== '') {
      elements.push(
        <p key={`p-${idx}`} className="my-2 leading-relaxed text-slate-700">
          {parseInlineMarkdown(line, docId)}
        </p>
      );
    }
  }

  flushList('list-end');
  flushTable('table-end');

  return <div className="prose prose-slate text-xs max-w-none p-6 overflow-auto h-full bg-white">{elements}</div>;
}


const DEFAULT_QUERY = `SELECT
  id,
  sku_name,
  price_unit,
  region_name
FROM raw_sales_data
JOIN region_master
  ON raw_sales_data.region_id = region_master.region_id
ORDER BY id;`;

export default function DatagruntStudio() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeTab, setActiveTab] = useState<'sql' | 'clean' | 'pdf'>('sql');
  const [expandedDatasets, setExpandedDatasets] = useState<Set<string>>(new Set<string>());
  const [attachedDbExpanded, setAttachedDbExpanded] = useState<boolean>(true);
  const [localDbExpanded, setLocalDbExpanded] = useState<boolean>(true);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set<string>(['imported']));

  // Collapsible left sidebar (datasets/tables). The Panel is `collapsible`;
  // we drive it imperatively so a toggle button can hide/show it, and mirror
  // the state so the "show" affordance can live outside the collapsed panel.
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  // Import Staging & Normalization Preview Modal State
  const [stagedPreview, setStagedPreview] = useState<PreviewResponse | null>(null);
  const [importingStaged, setImportingStaged] = useState<boolean>(false);
  const [normalizeConfig, setNormalizeConfig] = useState<Record<string, boolean>>({});
  const [importSchemaConfig, setImportSchemaConfig] = useState<Record<string, string>>({});
  const [stagedNewSchemas, setStagedNewSchemas] = useState<string[]>([]);
  const [bulkImportSchema, setBulkImportSchema] = useState<string>('');
  const [importReadOptions, setImportReadOptions] = useState<Record<string, SheetReadOptions>>({});
  // Keyed by readOptionsKey (staged_id + sheet) so one broken Excel sheet
  // keeps blocking Confirm while the user views a healthy sibling sheet.
  const [stagedPreviewErrors, setStagedPreviewErrors] = useState<Record<string, boolean>>({});
  const [bulkSkipRows, setBulkSkipRows] = useState<number>(0);
  const [bulkHasHeader, setBulkHasHeader] = useState<boolean>(true);
  
  // Multi-select and bulk actions states
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<Set<string>>(new Set<string>());
  const [bulkSchemaName, setBulkSchemaName] = useState<string>('');
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState<boolean>(false);
  
  // SQL Editor State
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [selectedSql, setSelectedSql] = useState('');

  // Results Display State
  const [resultSets, setResultSets] = useState<StatementResult[]>([]);
  const [activeResultIdx, setActiveResultIdx] = useState(0);
  const [openDownloadMenu, setOpenDownloadMenu] = useState<string | null>(null);
  const [gcsBrowserOpen, setGcsBrowserOpen] = useState(false);
  const [gcsExportSource, setGcsExportSource] = useState<{
    source: { datasetId?: string; sql?: string };
    baseName: string;
  } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [hasRun, setHasRun] = useState<boolean>(false);
  const [resultPageState, setResultPageState] = useState<Record<number, { pageIdx: number; pageSize: number; search: string; sort: GridSort | null }>>({});
  const [runCounter, setRunCounter] = useState(0);
  const activeResult = resultSets[activeResultIdx];
  const activePage = resultPageState[activeResultIdx] ?? { pageIdx: 0, pageSize: DEFAULT_PAGE_SIZE, search: '', sort: null };
  const debouncedResultSearch = useDebouncedValue(activePage.search, 300, `${runCounter}:${activeResultIdx}`);
  const resultsSource =
    activeResult && !activeResult.error && activeResult.has_result_set && activeResult.statement.trim()
      ? { sql: activeResult.statement }
      : null;
  const pagedResults = usePagedRows(resultsSource, {
    columns: activeResult?.columns ?? [],
    rows: activeResult?.rows ?? [],
  }, {
    pageIdx: activePage.pageIdx,
    pageSize: activePage.pageSize,
    refreshKey: `${runCounter}:${activeResultIdx}`,
    search: debouncedResultSearch,
    sort: activePage.sort,
  });

  // Helper for callers that only ever produce a single result set (e.g. the
  // visual Cleanse tool), so they can reuse the tabbed results state.
  const showSingleResult = (columns: string[], rows: any[][], truncated: boolean, statement = '') => {
    setResultSets([{ columns, rows, truncated, statement, has_result_set: true }]);
    setActiveResultIdx(0);
    setResultPageState({});
    setRunCounter((c) => c + 1);
  };

  // Cleanse Tool State
  const [cleanDatasetId, setCleanDatasetId] = useState<string>('');
  const [cleanSteps, setCleanSteps] = useState<CleanStep[]>([]);
  const [activeCleanMenu, setActiveCleanMenu] = useState<{ column: string; mode: 'options' | 'fill' | 'rename' } | null>(null);
  const [cleanInputVal, setCleanInputVal] = useState<string>('');
  const [cleanSaveAsName, setCleanSaveAsName] = useState<string>('');
  const [cleanPreviewColumns, setCleanPreviewColumns] = useState<string[]>([]);
  const [cleanPreviewRows, setCleanPreviewRows] = useState<any[][]>([]);
  const [cleanPreviewLoading, setCleanPreviewLoading] = useState<boolean>(false);
  const [cleanPreviewError, setCleanPreviewError] = useState<string | null>(null);

  // PDF Extractor State
  const [pdfDocId, setPdfDocId] = useState<string>('');
  const [pdfFilename, setPdfFilename] = useState<string>('');
  const [pdfExtracting, setPdfExtracting] = useState<boolean>(false);
  const [pdfExtractedText, setPdfExtractedText] = useState<string>('');
  const [pdfExtractedMarkdown, setPdfExtractedMarkdown] = useState<string>('');
  const [pdfOutputTab, setPdfOutputTab] = useState<'json' | 'markdown'>('json');
  const [pdfMarkdownMode, setPdfMarkdownMode] = useState<'raw' | 'rendered'>('raw');
  const [pdfImagesList, setPdfImagesList] = useState<string[]>([]);
  const [pdfPageImagesList, setPdfPageImagesList] = useState<string[]>([]);
  const [pdfUsePageImages, setPdfUsePageImages] = useState<boolean>(false);
  const [pdfRationalizing, setPdfRationalizing] = useState<boolean>(false);
  const [pdfPrompt, setPdfPrompt] = useState<string>(
    "Extract and structure the key information from this document into clean JSON.\n\n" +
    "Examples of instructions you can write here:\n" +
    "- \"Extract the main items table, using fields: [item_code, quantity, price, total].\"\n" +
    "- \"Convert the invoice details, including a list of line items and order totals.\"\n" +
    "- \"Organize customer names, contact info, and addresses into structured objects.\"\n\n" +
    "Guidelines:\n" +
    "- Use clear, lowercase snake_case keys.\n" +
    "- Infer data types (numbers, booleans, dates) and extract units where applicable.\n" +
    "- Exclude all document layout, page structure, and bounding-box coordinates."
  );
  const [pdfUseLocal, setPdfUseLocal] = useState<boolean>(false); // default to cloud LLM (Gemini)
  const [pdfLocalModel, setPdfLocalModel] = useState<string>('llama3');
  const [pdfCloudModel, setPdfCloudModel] = useState<string>('gemini-3.5-flash');
  const [pdfRationalizedSchema, setPdfRationalizedSchema] = useState<string>('');
  const [pdfSavedTable, setPdfSavedTable] = useState<string | null>(null);
  const [pdfSaveError, setPdfSaveError] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfGcsBrowserOpen, setPdfGcsBrowserOpen] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaActive, setOllamaActive] = useState<boolean>(true);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [overwriteConfig, setOverwriteConfig] = useState<Record<string, boolean>>({});
  const [pdfOverwrite, setPdfOverwrite] = useState<boolean>(true);
  const [pdfImageTab, setPdfImageTab] = useState<'layout' | 'pages'>('pages');
  const [pdfPreviewImage, setPdfPreviewImage] = useState<{ src: string; alt: string } | null>(null);

  const [activeCode, setActiveCode] = useState<string>(
    `import datagrunt as dg\n\n# Datagrunt loads and parses the file (delimiter / sheet inference)\nreader = dg.CSVReader('raw_sales_data.csv')\nreader.write_parquet('raw_sales_data.parquet')  # bridge to the Studio's DuckDB session`
  );
  const [activeSql, setActiveSql] = useState<string>(
    'SELECT * FROM session.imported.raw_sales_data LIMIT 10;'
  );
  const [resultsTab, setResultsTab] = useState<'table' | 'sql' | 'code'>('table');

  const getColumnType = (colName: string) => {
    for (const ds of datasets) {
      const found = ds.columns.find(c => c.name.toLowerCase() === colName.toLowerCase());
      if (found) return found.type;
    }
    return 'text';
  };

  // dataset_id -> { column, failingCount, example, type } awaiting a "convert anyway" decision
  const [castPrompt, setCastPrompt] = useState<{ datasetId: string; column: string; type: ColumnTypeLabel; failingCount: number; example: string | null } | null>(null);
  const [castNotice, setCastNotice] = useState<{ datasetId: string; message: string } | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [previewDatasetTarget, setPreviewDatasetTarget] = useState<{ id: string; name: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const editorSchema = useMemo(() => datasetsToSchema(datasets), [datasets]);

  // Column names that appear in more than one loaded dataset. A clicked column
  // with an ambiguous name is qualified as table.column so the generated SQL
  // stays unambiguous across joins.
  const ambiguousColumns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ds of datasets) {
      for (const col of ds.columns) {
        const key = col.name.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name));
  }, [datasets]);

  const activePdfImageTab = useMemo(() => {
    if (pdfImageTab === 'pages' && pdfPageImagesList.length > 0) return 'pages';
    if (pdfImagesList.length > 0) return 'layout';
    if (pdfPageImagesList.length > 0) return 'pages';
    return null;
  }, [pdfImageTab, pdfImagesList, pdfPageImagesList]);

  // Clicking a column in the sidebar adds it to the SQL editor. Ingested
  // datasets only (a column needs a real table to reference); switches to the
  // SQL tab so the edit is visible.
  const handleAddColumn = (ds: Dataset, col: Column) => {
    if (!ds.table) return;
    const isAmbiguous = ambiguousColumns.has(col.name.toLowerCase());
    const columnExpr = isAmbiguous
      ? `${quoteTableIdent(ds.table)}.${quoteIdent(col.name)}`
      : quoteIdent(col.name);
    if (activeTab !== 'sql') setActiveTab('sql');
    setQuery((current) => addColumnToQuery(current, columnExpr, ds.table!));
  };

  // Seed Clean selectors from the first real loaded datasets.
  // Called after initial load and after session reset so selectors always
  // point to a valid dataset ID (real UUIDs, not stale mock IDs).
  const applyDatasetDefaults = (ds: Dataset[]) => {
    if (ds[0]) {
      setCleanDatasetId(ds[0].id);
      setCleanSaveAsName(ds[0].name.replace(/\.[^/.]+$/, ''));
    }
  };

  // Load datasets from backend on mount
  useEffect(() => {
    listDatasets()
      .then((apiDatasets) => {
        const mapped = apiDatasets.map(toUiDataset);
        setDatasets(mapped);
        applyDatasetDefaults(mapped);
      })
      .catch((e) => setResultError(String(e)));
  // applyDatasetDefaults is stable (defined in render scope) — no dep needed
  }, []);


  // Run user typed SQL query
  const handleRunSQL = async () => {
    setIsRunning(true);
    setResultError(null);
    setExportError(null);
    try {
      const sqlToRun = selectedSql.trim() ? selectedSql : query;
      const result = await runQuery({ mode: 'sql', sql: sqlToRun });
      setResultPageState({});
      setRunCounter((c) => c + 1);
      if (result.error) {
        setResultError(result.detail || result.error);
        setResultSets([]);
        setActiveResultIdx(0);
      } else {
        setResultSets(result.results ?? []);
        setActiveResultIdx(0);
        if (result.code) setActiveCode(result.code);
        if (result.sql) setActiveSql(result.sql);
        setHasRun(true);
      }
    } catch (e) {
      setResultError(String(e));
    } finally {
      setIsRunning(false);
    }
  };


  const toggleDataset = (id: string) => {
    const next = new Set(expandedDatasets);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedDatasets(next);
  };


  // Execute manual visual cleanse
  const handleExecuteCleanse = async () => {
    if (!cleanDatasetId) return;
    setIsRunning(true);
    setResultError(null);
    try {
      const ds = datasets.find((d) => d.id === cleanDatasetId);
      if (!ds) return;
      
      const targetTable = cleanSaveAsName.trim() || ds.name.replace(/\.[^/.]+$/, '');
      
      const body: QueryRequestBody = {
        mode: 'clean',
        saveAs: targetTable,
        clean_pipeline: cleanSteps.map((step) => ({
          datasetId: cleanDatasetId,
          op: step.op,
          column: step.column,
          value: step.value,
          newName: step.newName,
          castType: step.castType,
        })),
      };

      const result = await runQuery(body);
      if (result.error) {
        setResultError(result.detail || result.error);
      } else {
        const apiDatasets = await listDatasets();
        const mapped = apiDatasets.map(toUiDataset);
        setDatasets(mapped);
        
        const createdDs = mapped.find(d => d.name === targetTable || d.table?.endsWith(targetTable));
        if (createdDs) {
          const selectQuery = `SELECT * FROM ${createdDs.table} LIMIT 10;`;
          setQuery(selectQuery);
          setActiveSql(selectQuery);
          if (result.code) setActiveCode(result.code);
          setActiveTab('sql');
          showSingleResult(
            result.columns || [], result.rows || [], result.truncated ?? false,
            createdDs.table ? `SELECT * FROM ${quoteTableIdent(createdDs.table)}` : '',
          );
          setHasRun(true);
        }
        
        setCleanSteps([]);
      }
    } catch (e) {
      setResultError(String(e));
    } finally {
      setIsRunning(false);
    }
  };

  const fetchCleanPreview = async (targetId: string, steps: CleanStep[]) => {
    if (!targetId) return;
    setTimeout(() => {
      setCleanPreviewLoading(true);
      setCleanPreviewError(null);
    }, 0);
    try {
      const ds = datasets.find((d) => d.id === targetId);
      if (!ds) return;
      
      const validSteps = steps.filter((step) => !step.datasetId || step.datasetId === targetId);
      
      let result;
      if (validSteps.length === 0) {
        result = await runQuery({
          mode: 'sql',
          sql: `SELECT * FROM ${ds.table} LIMIT 20;`,
        });
      } else {
        result = await runQuery({
          mode: 'clean',
          clean_pipeline: validSteps.map((step) => ({
            datasetId: targetId,
            op: step.op,
            column: step.column,
            value: step.value,
            newName: step.newName,
            castType: step.castType,
          })),
        });
      }

      if (result.error) {
        setCleanPreviewError(result.detail || result.error);
        setCleanPreviewColumns([]);
        setCleanPreviewRows([]);
      } else {
        setCleanPreviewColumns(result.columns || []);
        setCleanPreviewRows(result.rows || []);
      }
    } catch (err) {
      setCleanPreviewError(String(err));
    } finally {
      setCleanPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'clean') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchCleanPreview(cleanDatasetId, cleanSteps);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanDatasetId, cleanSteps, activeTab]);

  useEffect(() => {
    const fetchOllamaModels = async () => {
      try {
        const res = await getOllamaModels();
        setOllamaModels(res.models);
        setOllamaActive(res.active);
        if (res.models && res.models.length > 0) {
          if (!res.models.includes('llama3') && !res.models.includes('llama3:latest')) {
            setPdfLocalModel(res.models[0]);
          }
        }
      } catch (err) {
        console.error("Failed to load local Ollama models:", err);
        setOllamaActive(false);
      }
    };
    fetchOllamaModels();
  }, []);

  useEffect(() => {
    const fetchGeminiModels = async () => {
      try {
        const res = await getGeminiModels();
        setGeminiModels(res.models);
        if (res.models && res.models.length > 0) {
          if (!res.models.includes('gemini-3.5-flash')) {
            setPdfCloudModel(res.models[0]);
          }
        }
      } catch (err) {
        console.error("Failed to load Gemini cloud models:", err);
      }
    };
    fetchGeminiModels();
  }, []);




  // PDF Extraction & Rationalization Handlers

  // Point the PDF tab at a newly landed document (local upload or GCS import)
  // and clear all downstream extract/rationalize state.
  const startPdfDocument = (docId: string, filename: string) => {
    setPdfError(null);
    setPdfDocId(docId);
    setPdfFilename(filename);
    setPdfExtractedText('');
    setPdfExtractedMarkdown('');
    setPdfRationalizedSchema('');
    setPdfSavedTable(null);
    setPdfSaveError(null);
    setPdfImagesList([]);
    setPdfOutputTab('json');
    setPdfMarkdownMode('raw');
  };

  const handlePdfUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPdfError(null);
    try {
      const res = await uploadPdf(file);
      startPdfDocument(res.doc_id, res.filename);
    } catch (err: any) {
      setPdfError(err.message || 'Failed to upload PDF.');
    }
  };

  // Do NOT catch errors here — GcsBrowserModal shows the rejection inline so
  // the user can retry without the modal closing underneath them.
  const handlePdfGcsImport = async (bucket: string, objects: string[]) => {
    const object = objects[0];
    if (!object) return;
    const res = await importPdfFromGcs(bucket, object);
    startPdfDocument(res.doc_id, res.filename);
    setPdfGcsBrowserOpen(false);
  };

  // Refresh the sidebar dataset list after a PDF operation. Kept outside the
  // operation's try block so a refresh-only failure isn't reported as the
  // operation itself failing.
  const refreshDatasetsAfterPdfOp = async (operation: string) => {
    try {
      const apiDatasets = await listDatasets();
      setDatasets(apiDatasets.map(toUiDataset));
    } catch {
      setPdfError(`${operation} succeeded, but refreshing the dataset list failed. Reload the page to see the new table.`);
    }
  };

  const handlePdfExtract = async () => {
    if (!pdfDocId) return;
    setPdfExtracting(true);
    setPdfError(null);
    try {
      const res = await extractPdf(pdfDocId, pdfOverwrite);
      setPdfExtractedText(res.json_text);
      setPdfExtractedMarkdown(res.markdown_text || '');
      setPdfImagesList(res.images);
      setPdfPageImagesList(res.page_images || []);
      // Refresh datasets list to reflect the new DuckDB table in the sidebar
      await refreshDatasetsAfterPdfOp('Extraction');
    } catch (err: any) {
      setPdfError(err.message || 'Failed to extract PDF.');
    } finally {
      setPdfExtracting(false);
    }
  };

  const handlePdfRationalize = async () => {
    if (!pdfDocId) return;
    setPdfRationalizing(true);
    setPdfError(null);
    setPdfSavedTable(null);
    setPdfSaveError(null);
    try {
      const model = pdfUseLocal ? pdfLocalModel : pdfCloudModel;
      const res = await rationalizePdf(pdfDocId, pdfPrompt, pdfUseLocal, model, pdfUsePageImages);
      try {
        const parsed = JSON.parse(res.schema);
        setPdfRationalizedSchema(JSON.stringify(parsed, null, 2));
      } catch {
        setPdfRationalizedSchema(res.schema);
      }
      if (res.saved && res.dataset) {
        setPdfSavedTable(`${res.dataset.schema_name}.${res.dataset.table.split('.').pop()}`);
        // Refresh datasets list to reflect the new DuckDB table in the sidebar
        await refreshDatasetsAfterPdfOp('Rationalization');
      } else {
        setPdfSaveError(res.save_error || 'Output was not saved as a dataset.');
      }
    } catch (err: any) {
      setPdfError(err.message || 'Failed to rationalize schema.');
    } finally {
      setPdfRationalizing(false);
    }
  };

  // Stage a preview response and seed the per-file import config defaults —
  // shared by local uploads and GCS CSV/Excel imports.
  const applyStagedPreview = (preview: PreviewResponse) => {
    setStagedPreview(preview);
    const defaultNorm: Record<string, boolean> = {};
    const defaultSchema: Record<string, string> = {};
    const defaultOverwrite: Record<string, boolean> = {};
    preview.files.forEach((file) => {
      defaultNorm[file.staged_id] = false;
      defaultSchema[file.staged_id] = 'imported';
      defaultOverwrite[file.staged_id] = true;
    });
    setNormalizeConfig(defaultNorm);
    setImportSchemaConfig(defaultSchema);
    setOverwriteConfig(defaultOverwrite);
    setImportReadOptions(seedReadOptions(preview.files));
    setStagedPreviewErrors({});
    setBulkSkipRows(0);
    setBulkHasHeader(true);
  };

  // Handle file upload preview stage
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setResultError(null);
    setImportNotice(null);
    try {
      const preview = await previewUploads(files);
      applyStagedPreview(preview);
    } catch (err) {
      setImportNotice(`Failed to load file preview: ${String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  // Import selected GCS objects. CSV and Excel come back as staged previews
  // and reuse the local-upload configure/confirm modal; parquet/json land
  // immediately.
  const handleGcsImport = async (bucket: string, objects: string[]) => {
    const result: GcsImportResult = await importFromGcs(bucket, objects);
    setGcsBrowserOpen(false);
    try {
      if (result.datasets.length > 0 || result.errors.length > 0) {
        const apiDatasets = await listDatasets();
        setDatasets(apiDatasets.map(toUiDataset));
        setImportNotice(summarizeImport(result.datasets.length, result.errors));
        setExpandedSchemas((prev) => {
          const next = new Set(prev);
          result.datasets.forEach((d) => { if (d.schema_name) next.add(d.schema_name); });
          return next;
        });
      }
      if (result.previews.length > 0) {
        applyStagedPreview({ is_single: result.previews.length === 1, files: result.previews });
      }
    } catch (err) {
      setImportNotice(`Import finished, but refreshing the dataset list failed: ${String(err)}`);
    }
  };

  // Confirm final ingestion from staging modal
  const handleConfirmImport = async () => {
    if (!stagedPreview) return;
    setResultError(null);
    setImportingStaged(true);
    try {
      const importItems: ConfirmImportItem[] = stagedPreview.files.map((file) => ({
        staged_id: file.staged_id,
        filename: file.filename,
        normalize_columns: normalizeConfig[file.staged_id] || false,
        schema_name: importSchemaConfig[file.staged_id] || 'imported',
        overwrite: overwriteConfig[file.staged_id] ?? false,
        ...confirmOptionFields(file, importReadOptions),
      }));

      const { datasets: created, errors } = await confirmImports(importItems);
      const apiDatasets = await listDatasets();
      const mapped = apiDatasets.map(toUiDataset);
      setDatasets(mapped);
      
      const newlyCreatedMapped = created.map(toUiDataset);
      setExpandedDatasets((prev) => {
        const next = new Set(prev);
        newlyCreatedMapped.forEach((d) => next.add(d.id));
        return next;
      });
      
      // Automatically expand schemas
      setExpandedSchemas((prev) => {
        const next = new Set(prev);
        mapped.forEach((d) => {
          if (d.schema_name) next.add(d.schema_name);
        });
        return next;
      });

      if (mapped[0]) setQuery(`SELECT * FROM ${mapped[0].table} LIMIT 5;`);
      setImportNotice(summarizeImport(created.length, errors));
      setStagedNewSchemas([]);
      setBulkImportSchema('');
      setStagedPreview(null);
    } catch (err) {
      setResultError(`Import failed: ${String(err)}`);
    } finally {
      setImportingStaged(false);
    }
  };

  const toggleSelectDataset = (id: string) => {
    setSelectedDatasetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleQueryTable = (ds: Dataset) => {
    if (!ds.table) return;
    const selectSql = tableSelectSql(quoteTableIdent(ds.table));
    setQuery((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return selectSql;
      return `${trimmed}\n\n${selectSql}`;
    });
    if (activeTab !== 'sql') setActiveTab('sql');
  };

  const handleBulkDeleteConfirm = async () => {
    if (selectedDatasetIds.size === 0) return;
    setResultError(null);
    try {
      let remaining: Dataset[] = [];
      for (const id of selectedDatasetIds) {
        const apiDatasets = await deleteDataset(id);
        remaining = apiDatasets.map(toUiDataset);
      }
      setDatasets(remaining);
      setSelectedDatasetIds(new Set());
      setConfirmingBulkDelete(false);
      setExpandedDatasets((prev) => {
        const next = new Set(prev);
        selectedDatasetIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (e) {
      setResultError(`Bulk delete failed: ${String(e)}`);
    }
  };

  const handleBulkMoveSchema = async () => {
    if (selectedDatasetIds.size === 0 || !bulkSchemaName.trim()) return;
    setResultError(null);
    try {
      const newSchema = bulkSchemaName.trim();
      let lastUpdatedDatasets = [...datasets];
      
      for (const id of selectedDatasetIds) {
        const updated = await moveDatasetSchema(id, newSchema);
        lastUpdatedDatasets = lastUpdatedDatasets.map((d) => (d.id === id ? toUiDataset(updated) : d));
      }
      
      setDatasets(lastUpdatedDatasets);
      setBulkSchemaName('');
      setSelectedDatasetIds(new Set());
      
      setExpandedSchemas((prev) => {
        const next = new Set(prev);
        next.add(newSchema);
        return next;
      });
    } catch (e) {
      setResultError(`Bulk schema transfer failed: ${String(e)}`);
    }
  };

  // Server-side export: full result sets / whole tables, CSV or Parquet.
  const runExport = async (body: ExportRequestBody, filename: string) => {
    if (exportBusy) return;
    setExportError(null);
    setExportBusy(true);
    try {
      await downloadExport(body, filename);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportBusy(false);
    }
  };

  // Download the active result tab — the statement re-runs server-side, so
  // the file has every row, not just the 200 shown in the grid.
  const handleDownloadResults = (format: ExportFormat) => {
    const active = resultSets[activeResultIdx];
    if (!active || active.error || !active.has_result_set || !active.statement.trim()) return;
    void runExport(
      { sql: active.statement, format },
      resultExportFilename(activeResultIdx, resultSets.length, format),
    );
  };

  // Download a whole dataset table (all rows, server-side), CSV or Parquet.
  const handleDownloadDataset = (ds: Dataset, format: ExportFormat) => {
    // Last segment of the qualified table name ("session.imported.raw_sales_data"
    // → "raw_sales_data") — matches the backend's download filename.
    const base = (ds.table ?? ds.name).split('.').pop() || 'table';
    void runExport({ datasetId: ds.id, format }, `${base}.${format}`);
  };

  // Reset/Clear user session
  const handleResetSession = async () => {
    try {
      const apiDatasets = await resetSession();
      const mapped = apiDatasets.map(toUiDataset);
      setDatasets(mapped);
      applyDatasetDefaults(mapped);
      setResultSets([]); setActiveResultIdx(0); setResultError(null); setExportError(null); setResultPageState({}); setRunCounter((c) => c + 1); setHasRun(false);
      setActiveCode(`import datagrunt as dg\n\n# Datagrunt loads and parses the file (delimiter / sheet inference)\nreader = dg.CSVReader('raw_sales_data.csv')\nreader.write_parquet('raw_sales_data.parquet')  # bridge to the Studio's DuckDB session`);
      setQuery(DEFAULT_QUERY);
    } catch (e) {
      setResultError(String(e));
    }
  };

  const applyCastResult = (datasetId: string, columns: { name: string; type: string }[]) => {
    setDatasets((prev) => prev.map((d) =>
      d.id === datasetId
        ? { ...d, columns: columns.map((c) => ({ name: c.name, type: duckTypeToLabel(c.type) })) }
        : d,
    ));
  };

  const handleDeleteDataset = async (id: string) => {
    setResultError(null);
    
    // 1. Optimistic UI update: remove the deleted dataset from state immediately
    setDatasets((prev) => {
      const updated = prev.filter((d) => d.id !== id);
      
      // Seed defaults from the remaining datasets if the deleted dataset was active
      if (updated.length === 0) {
        setCleanDatasetId('');
        setCleanSteps([]);
      } else if (cleanDatasetId === id) {
        if (updated[0]) {
          setCleanDatasetId(updated[0].id);
          setCleanSaveAsName(updated[0].name.replace(/\.[^/.]+$/, ''));
          setCleanSteps([]);
        }
      }
      return updated;
    });

    setExpandedDatasets((prev) => { const next = new Set(prev); next.delete(id); return next; });
    if (castPrompt?.datasetId === id) setCastPrompt(null);
    if (castNotice?.datasetId === id) setCastNotice(null);

    try {
      const apiDatasets = await deleteDataset(id);
      const mapped = apiDatasets.map(toUiDataset);
      setDatasets(mapped);
    } catch (e) {
      setResultError(`Delete failed: ${String(e)}`);
      // Re-fetch datasets on failure to restore state sync
      try {
        const apiDatasets = await listDatasets();
        setDatasets(apiDatasets.map(toUiDataset));
      } catch {}
    } finally {
      setConfirmingDeleteId(null);
    }
  };

  const handleCastColumn = async (datasetId: string, column: string, type: ColumnTypeLabel, lenient = false) => {
    setResultError(null);
    setCastNotice(null);
    try {
      const result = await castColumn(datasetId, column, type, lenient);
      if (!result.ok) {
        setCastPrompt({ datasetId, column, type, failingCount: result.failingCount, example: result.example });
        return;
      }
      setCastPrompt(null);
      applyCastResult(datasetId, result.columns);
      if (result.nulledCount > 0) {
        setCastNotice({ datasetId, message: `Converted "${column}" to ${type}; ${result.nulledCount} value(s) set to empty.` });
      }
    } catch (e) {
      setResultError(`Type conversion failed: ${String(e)}`);
    }
  };

  const schemas = useMemo(() => {
    const s = new Set<string>();
    datasets.forEach((d) => {
      if (d.schema_name) s.add(d.schema_name);
    });
    return Array.from(s).sort();
  }, [datasets]);

  const availableSchemas = useMemo(() => {
    const s = new Set<string>(schemas);
    stagedNewSchemas.forEach((ns) => {
      const clean = ns.trim();
      if (clean) s.add(clean);
    });
    return Array.from(s).sort();
  }, [schemas, stagedNewSchemas]);

  const toggleSchema = (schemaName: string) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(schemaName)) {
        next.delete(schemaName);
      } else {
        next.add(schemaName);
      }
      return next;
    });
  };

  return (
    <div className="h-screen w-full bg-slate-50 text-slate-800 overflow-hidden text-sm font-sans selection:bg-blue-100 selection:text-blue-900">
    <PanelGroup direction="horizontal" autoSaveId="studio-shell-h" className="h-full w-full bg-slate-50">
      <Panel
        id="sidebar"
        ref={sidebarPanelRef}
        defaultSize={12}
        minSize={10}
        maxSize={25}
        collapsible={true}
        collapsedSize={0}
        onCollapse={() => setSidebarCollapsed(true)}
        onExpand={() => setSidebarCollapsed(false)}
      >
      
      {/* SIDEBAR */}
      <aside id="sidebar_container" className="h-full border-r border-slate-200/80 bg-white/70 backdrop-blur-md flex flex-col z-10 shadow-sm">
        
        {/* LOGO */}
        <div id="logo_area" className="h-14 flex items-center justify-between px-5 border-b border-slate-200/80">
          <div className="font-semibold text-lg tracking-tight text-slate-800 flex items-center gap-2 min-w-0">
            <span className="text-blue-600 font-bold text-xl drop-shadow-[0_0_8px_rgba(59,130,246,0.3)]">◈</span>
            <span className="bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent truncate">Datagrunt Studio</span>
            <span className="text-[9px] font-mono text-slate-400 border border-slate-200 rounded-md px-1.5 py-0.5 ml-2 font-normal shrink-0">v0.4</span>
          </div>
          <button
            id="btn_collapse_sidebar"
            title="Hide sidebar"
            aria-label="Hide sidebar"
            onClick={() => sidebarPanelRef.current?.collapse()}
            className="ml-2 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all cursor-pointer shrink-0"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* PRIMARY ACTIONS */}
        <div id="sidebar_actions" className="p-4 space-y-2 border-b border-slate-200/60 bg-slate-50/40">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".csv,.txt,.xlsx,.xls"
            multiple
            className="hidden"
          />
          <button 
            id="btn_import_file"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-blue-500/40 hover:bg-slate-50 text-slate-800 px-4 py-2 rounded-md font-medium transition-all shadow-sm cursor-pointer text-xs glow-border"
          >
            <Upload className="w-3.5 h-3.5 text-blue-600" />
            <span>+ Import Files</span>
          </button>

          <button
            id="btn_import_gcs"
            onClick={() => setGcsBrowserOpen(true)}
            className="w-full flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-blue-500/40 hover:bg-slate-50 text-slate-800 px-4 py-2 rounded-md font-medium transition-all shadow-sm cursor-pointer text-xs glow-border"
          >
            <Cloud className="w-3.5 h-3.5 text-blue-600" />
            <span>Import from GCS</span>
          </button>

          <button
            id="btn_reset_session"
            onClick={handleResetSession}
            className="w-full flex items-center justify-center gap-2 bg-transparent hover:bg-red-50 text-slate-500 hover:text-red-600 border border-transparent px-4 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Reset Workspace</span>
          </button>
          {importNotice && (
            <div id="import_notice" className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200/60 rounded px-2.5 py-2 flex items-start justify-between gap-2">
              <span>{importNotice}</span>
              <button className="text-amber-600 hover:text-amber-800 shrink-0 leading-none" onClick={() => setImportNotice(null)} aria-label="Dismiss import notice">×</button>
            </div>
          )}
        </div>

        {/* DATABASE INSTANCE NAVIGATION TREE (MOTHERDUCK STYLE) */}
        <div id="dataset_list_scroller" className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
          
          {/* ATTACHED DATABASES CATEGORY HEADER */}
          <div className="flex items-center justify-between px-2 py-0.5 text-slate-700 select-none">
            <button 
              onClick={() => setAttachedDbExpanded(!attachedDbExpanded)}
              className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 uppercase tracking-wider cursor-pointer"
            >
              {attachedDbExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              )}
              <span>Attached Databases</span>
            </button>
            <button 
              onClick={() => fileInputRef.current?.click()}
              title="Attach/Import Data File"
              className="p-1 hover:bg-slate-100 rounded text-slate-550 hover:text-blue-650 cursor-pointer transition-all"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* HIERARCHY TREE */}
          <AnimatePresence initial={false}>
            {attachedDbExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="space-y-1 pl-1"
              >
                {/* 1. DATABASE NODE: local_db */}
                <div className="flex flex-col">
                  <button
                    onClick={() => setLocalDbExpanded(!localDbExpanded)}
                    className="w-full flex items-center px-1.5 py-1 text-left text-xs text-slate-705 hover:bg-slate-100/50 rounded transition-all group cursor-pointer"
                  >
                    {localDbExpanded ? (
                      <ChevronDown className="w-3 h-3 mr-1 text-slate-400" />
                    ) : (
                      <ChevronRight className="w-3 h-3 mr-1 text-slate-400" />
                    )}
                    <Database className="w-3.5 h-3.5 mr-1.5 text-blue-500 fill-blue-50/10 shrink-0" />
                    <span className="font-semibold font-mono tracking-tight text-[11px]">local_db</span>
                  </button>

                  {localDbExpanded && (
                    <div className="pl-3.5 border-l border-slate-200/60 ml-3 mt-0.5 space-y-1">
                      
                      {/* 2. DYNAMIC SCHEMAS LIST */}
                      {schemas.map((schemaName) => {
                        const isSchemaExpanded = expandedSchemas.has(schemaName);
                        const schemaTables = datasets.filter((d) => d.schema_name === schemaName);
                        
                        return (
                          <div key={schemaName} className="flex flex-col">
                            <button
                              onClick={() => toggleSchema(schemaName)}
                              className="w-full flex items-center px-1.5 py-1 text-left text-xs text-slate-600 hover:bg-slate-100/50 rounded transition-all group cursor-pointer"
                            >
                              {isSchemaExpanded ? (
                                <ChevronDown className="w-3 h-3 mr-1 text-slate-400" />
                              ) : (
                                <ChevronRight className="w-3 h-3 mr-1 text-slate-400" />
                              )}
                              <Layers className="w-3.5 h-3.5 mr-1.5 text-indigo-500 fill-indigo-50/10 shrink-0" />
                              <span className="font-mono text-[11px] text-slate-650">{schemaName}</span>
                              <span className="text-[10px] text-slate-450 ml-1.5 shrink-0">({schemaTables.length})</span>
                            </button>

                            {isSchemaExpanded && (
                              <div className="pl-3.5 border-l border-slate-200/60 ml-3 mt-0.5 space-y-1">
                                {schemaTables.length === 0 ? (
                                  <div className="text-[10px] text-slate-400 italic px-2 py-1 select-none">
                                    No tables loaded.
                                  </div>
                                ) : (
                                  schemaTables.map((ds) => {
                                    const isExpanded = expandedDatasets.has(ds.id);
                                    return (
                                      <div key={ds.id} className="flex flex-col">
                                        <div className={`flex items-center group/row rounded-md hover:bg-slate-100/70 ${isExpanded ? 'bg-slate-50' : ''}`}>
                                          <input
                                            type="checkbox"
                                            checked={selectedDatasetIds.has(ds.id)}
                                            onChange={() => toggleSelectDataset(ds.id)}
                                            className="ml-2 w-3 h-3 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer shrink-0"
                                          />
                                          <button
                                            id={`dataset_toggle_${ds.id}`}
                                            onClick={() => toggleDataset(ds.id)}
                                            className={`flex items-center flex-1 min-w-0 px-1.5 py-1 text-left text-xs group cursor-pointer ${isExpanded ? 'text-blue-600 font-semibold' : 'text-slate-650'}`}
                                          >
                                            {isExpanded ? (
                                              <ChevronDown className="w-3 h-3 mr-1 text-blue-500" />
                                            ) : (
                                              <ChevronRight className="w-3 h-3 mr-1 text-slate-400 group-hover:text-slate-600" />
                                            )}
                                            <Table2 className="w-3.5 h-3.5 mr-1.5 text-emerald-500 shrink-0" />
                                            <span title={ds.name} className="truncate flex-1 font-mono text-[11px]">{ds.name}</span>
                                            <span className={`text-[9px] px-1 border rounded uppercase font-mono tracking-wider ml-1.5 shrink-0 bg-white ${ds.type === 'cleaned' ? 'border-indigo-200 text-indigo-600 bg-indigo-50/20' : 'border-slate-200 text-slate-400'}`}>
                                              {ds.type === 'excel' ? 'xls' : ds.type === 'cleaned' ? 'clean' : ds.type === 'pdf' ? 'pdf' : ds.type === 'pdf_rationalized' ? 'ai' : 'csv'}
                                            </span>
                                          </button>
                                          
                                          {confirmingDeleteId === ds.id ? (
                                            <span className="flex items-center gap-1.5 pr-2 shrink-0 select-none">
                                              <button
                                                title="Confirm drop"
                                                onClick={() => handleDeleteDataset(ds.id)}
                                                className="px-2 py-0.5 bg-red-50 hover:bg-red-100 text-red-600 hover:text-red-700 border border-red-200 rounded text-[9px] font-semibold transition-all cursor-pointer shadow-sm"
                                              >
                                                Drop
                                              </button>
                                              <button
                                                title="Cancel"
                                                onClick={() => setConfirmingDeleteId(null)}
                                                className="px-1.5 py-0.5 bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 rounded text-[9px] font-medium transition-all cursor-pointer"
                                              >
                                                Cancel
                                              </button>
                                            </span>
                                          ) : (
                                            <div className={`${openDownloadMenu === `ds:${ds.id}` ? 'opacity-100' : 'opacity-0'} group-hover/row:opacity-100 transition-opacity flex items-center gap-1 pr-2 shrink-0`}>
                                              <button
                                                type="button"
                                                title="Preview Data"
                                                onClick={() => setPreviewDatasetTarget({ id: ds.id, name: ds.name })}
                                                className="text-slate-450 hover:text-blue-600 transition-colors p-0.5 cursor-pointer"
                                              >
                                                <Eye className="w-3.5 h-3.5" />
                                              </button>
                                              <button
                                                type="button"
                                                title="Query Table (add to SQL Editor)"
                                                onClick={() => handleQueryTable(ds)}
                                                className="text-slate-450 hover:text-blue-600 transition-colors p-0.5 cursor-pointer"
                                              >
                                                <TerminalSquare className="w-3.5 h-3.5" />
                                              </button>
                                              <DownloadMenu
                                                open={openDownloadMenu === `ds:${ds.id}`}
                                                onOpenChange={(o) => setOpenDownloadMenu(o ? `ds:${ds.id}` : null)}
                                                onPick={(format) => handleDownloadDataset(ds, format)}
                                                onPickGcs={() => setGcsExportSource({
                                                  source: { datasetId: ds.id },
                                                  baseName: (ds.table ?? ds.name).split('.').pop() || 'table',
                                                })}
                                                disabled={exportBusy}
                                                triggerTitle="Download Table (CSV or Parquet)"
                                                triggerClassName="text-slate-450 hover:text-blue-600 transition-colors p-0.5 cursor-pointer disabled:opacity-50"
                                                trigger={<Download className="w-3.5 h-3.5" />}
                                              />
                                              <button
                                                type="button"
                                                title="Drop Table"
                                                onClick={() => setConfirmingDeleteId(ds.id)}
                                                className="text-slate-450 hover:text-red-500 transition-colors p-0.5 cursor-pointer"
                                              >
                                                <Trash2 className="w-3.5 h-3.5" />
                                              </button>
                                            </div>
                                          )}
                                        </div>

                                        {/* 4. COLUMNS LIST */}
                                        <AnimatePresence initial={false}>
                                          {isExpanded && (
                                            <motion.div
                                              id={`dataset_cols_${ds.id}`}
                                              initial={{ height: 0, opacity: 0 }}
                                              animate={{ height: 'auto', opacity: 1 }}
                                              exit={{ height: 0, opacity: 0 }}
                                              transition={{ duration: 0.2 }}
                                              className="pl-3.5 border-l border-slate-200/60 ml-3.5 mt-0.5 mb-1.5 space-y-1 py-1 overflow-hidden"
                                            >
                                              {ds.columns.map((col, idx) => (
                                                <div key={idx} className="px-2 py-0.5 text-[11px] text-slate-550 hover:bg-slate-50 rounded transition-all">
                                                  <div className="flex items-center justify-between gap-2">
                                                    <button
                                                      type="button"
                                                      onClick={() => handleAddColumn(ds, col)}
                                                      disabled={!ds.table}
                                                      title={ds.table ? 'Add to SQL' : 'Table not available in SQL'}
                                                      className="font-mono text-[11.5px] text-slate-600 truncate text-left hover:text-blue-600 hover:underline cursor-pointer disabled:cursor-default disabled:hover:text-slate-600 disabled:hover:no-underline"
                                                    >
                                                      {col.name}
                                                    </button>
                                                    <select
                                                      className="text-[10px] bg-white border border-slate-200 hover:border-slate-300 rounded px-1 py-0.5 text-slate-600 outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                                                      value={col.type}
                                                      onChange={(e) => handleCastColumn(ds.id, col.name, e.target.value as ColumnTypeLabel)}
                                                    >
                                                      <option value="text">text</option>
                                                      <option value="integer">integer</option>
                                                      <option value="decimal">decimal</option>
                                                      <option value="boolean">boolean</option>
                                                      <option value="date">date</option>
                                                      <option value="timestamp">timestamp</option>
                                                    </select>
                                                  </div>
                                                  
                                                  {castPrompt && castPrompt.datasetId === ds.id && castPrompt.column === col.name && (
                                                    <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200/60 rounded p-2 flex flex-col gap-1 mt-1 font-sans">
                                                      <span>
                                                        {castPrompt.failingCount} value(s) can&apos;t convert to {castPrompt.type}
                                                        {castPrompt.example ? ` (e.g. "${castPrompt.example}")` : ''}.
                                                      </span>
                                                      <div className="flex gap-2 justify-end">
                                                        <button
                                                          className="underline font-semibold text-blue-600 hover:text-blue-500"
                                                          onClick={() => handleCastColumn(ds.id, col.name, castPrompt.type, true)}
                                                        >
                                                          Convert anyway
                                                        </button>
                                                        <button className="text-slate-505 hover:text-slate-650" onClick={() => { setCastPrompt(null); setCastNotice(null); }}>Dismiss</button>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              ))}
                                              {castNotice && castNotice.datasetId === ds.id && <div className="text-[10px] text-slate-400 px-2 py-0.5 italic">{castNotice.message}</div>}
                                              <div className="px-2 py-1.5 border-t border-slate-100/80 flex items-center justify-between gap-1 text-[10px] text-slate-400 font-mono">
                                                <span>{ds.rows.length} entries</span>
                                                <div className="flex items-center gap-1 shrink-0">
                                                  <span>Move to:</span>
                                                  <select
                                                    value=""
                                                    onChange={async (e) => {
                                                      const targetSchema = e.target.value;
                                                      if (targetSchema === '__new__') {
                                                        const newName = prompt('Enter name of new schema:');
                                                        if (newName && newName.trim()) {
                                                          const s = newName.trim();
                                                          try {
                                                            const updated = await moveDatasetSchema(ds.id, s);
                                                            setDatasets((prev) =>
                                                              prev.map((d) => (d.id === ds.id ? toUiDataset(updated) : d))
                                                            );
                                                            setExpandedSchemas((prev) => {
                                                              const next = new Set(prev);
                                                              next.add(s);
                                                              return next;
                                                            });
                                                          } catch (err) {
                                                            alert(`Failed to move schema: ${String(err)}`);
                                                          }
                                                        }
                                                      } else if (targetSchema) {
                                                        try {
                                                          const updated = await moveDatasetSchema(ds.id, targetSchema);
                                                          setDatasets((prev) =>
                                                            prev.map((d) => (d.id === ds.id ? toUiDataset(updated) : d))
                                                          );
                                                          setExpandedSchemas((prev) => {
                                                            const next = new Set(prev);
                                                            next.add(targetSchema);
                                                            return next;
                                                          });
                                                        } catch (err) {
                                                          alert(`Failed to move schema: ${String(err)}`);
                                                        }
                                                      }
                                                    }}
                                                    className="border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700 font-mono text-[9px] outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                                                  >
                                                    <option value="" disabled hidden>select schema...</option>
                                                    {schemas
                                                      .filter((s) => s !== ds.schema_name)
                                                      .map((s) => (
                                                        <option key={s} value={s}>{s}</option>
                                                      ))}
                                                    <option value="__new__">+ New Schema...</option>
                                                  </select>
                                                </div>
                                              </div>
                                            </motion.div>
                                          )}
                                        </AnimatePresence>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bulk Actions Panel */}
        {selectedDatasetIds.size > 0 && (
          <div className="p-3 bg-slate-100/95 backdrop-blur border-t border-slate-200 flex flex-col gap-2 shrink-0 animate-fade-in">
            {confirmingBulkDelete ? (
              <div className="space-y-2 select-none animate-fade-in">
                <span className="text-[11px] font-semibold text-red-600 block">
                  Drop {selectedDatasetIds.size} table(s) permanently?
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={handleBulkDeleteConfirm}
                    className="flex-1 px-2.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10.5px] font-semibold transition-all cursor-pointer text-center"
                  >
                    Confirm Drop
                  </button>
                  <button
                    onClick={() => setConfirmingBulkDelete(false)}
                    className="flex-1 px-2.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 border border-slate-300 rounded text-[10.5px] font-semibold transition-all cursor-pointer text-center"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-slate-700">{selectedDatasetIds.size} selected</span>
                  <button
                    onClick={() => {
                      setSelectedDatasetIds(new Set());
                      setConfirmingBulkDelete(false);
                    }}
                    className="text-slate-400 hover:text-slate-600 text-[9px] uppercase font-bold tracking-wider cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmingBulkDelete(true)}
                    className="flex-1 px-2.5 py-1 bg-red-50 hover:bg-red-100 text-red-655 hover:text-red-700 border border-red-200 rounded text-[10.5px] font-semibold transition-all cursor-pointer text-center"
                  >
                    Drop
                  </button>
                  <div className="flex-1 flex gap-1 items-center">
                    <input
                      type="text"
                      placeholder="Move to schema..."
                      value={bulkSchemaName}
                      onChange={(e) => setBulkSchemaName(e.target.value)}
                      className="w-full border border-slate-200 rounded px-1.5 py-1 bg-white text-slate-700 font-mono text-[9.5px] outline-none focus:ring-1 focus:ring-blue-500"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleBulkMoveSchema();
                        }
                      }}
                    />
                    <button
                      onClick={handleBulkMoveSchema}
                      disabled={!bulkSchemaName.trim()}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-[9.5px] font-semibold transition-all cursor-pointer disabled:opacity-50"
                    >
                      Go
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* SIDEBAR FOOTER */}
        <div id="sidebar_metadata_footer" className="p-4 border-t border-slate-200/80 bg-slate-50/50">
          <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>ACTIVE SESSION</span>
            <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.3)] animate-pulse"></span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500 font-mono">
            <div>Engine: DuckDB (embedded)</div>
            <div>Datagrunt + DuckDB</div>
          </div>
        </div>
      </aside>
      </Panel>

      <ResizeHandle orientation="vertical" />

      <Panel id="main" defaultSize={82} minSize={50}>
      {/* MAIN VIEW */}
      <main id="main_workspace" className="flex flex-col min-w-0 h-full overflow-hidden bg-slate-50">
        
        {/* HEADER BAR */}
        <header id="workspace_header" className="h-14 border-b border-slate-200/80 bg-white/70 backdrop-blur-md flex items-center justify-between px-6 shrink-0 shadow-sm">

          {/* LEFT HEADER GROUP: show-sidebar affordance + workflow tabs */}
          <div className="flex items-center h-full">
            {/* SHOW SIDEBAR (only when collapsed) */}
            {sidebarCollapsed && (
              <button
                id="btn_show_sidebar"
                title="Show sidebar"
                aria-label="Show sidebar"
                onClick={() => sidebarPanelRef.current?.expand()}
                className="mr-4 -ml-2 p-1.5 rounded text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-all cursor-pointer shrink-0"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            )}

            {/* NAVIGATIONAL TAB TOGGLES */}
            <div id="workflow_tabs" className="flex space-x-6 h-full items-end">
            <button 
              id="tab_sql"
              onClick={() => setActiveTab('sql')}
              className={`pb-3.5 flex items-center space-x-1.5 border-b-2 font-medium text-xs tracking-wide uppercase transition-all cursor-pointer ${activeTab === 'sql' ? 'border-blue-500 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            >
              <TerminalSquare className="w-4 h-4" />
              <span>Query Editor</span>
            </button>
            <button 
              id="tab_clean"
              onClick={() => setActiveTab('clean')}
              className={`pb-3.5 flex items-center space-x-1.5 border-b-2 font-medium text-xs tracking-wide uppercase transition-all cursor-pointer ${activeTab === 'clean' ? 'border-blue-500 text-blue-600 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              <Wand2 className="w-4 h-4" />
              <span>Cleanse</span>
            </button>
            <button 
              id="tab_pdf"
              onClick={() => setActiveTab('pdf')}
              className={`pb-3.5 flex items-center space-x-1.5 border-b-2 font-medium text-xs tracking-wide uppercase transition-all cursor-pointer ${activeTab === 'pdf' ? 'border-blue-500 text-blue-600 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
            >
              <FileText className="w-4 h-4" />
              <span>AI PDF Extractor</span>
            </button>
            </div>
          </div>

          <div id="header_status" className="flex items-center gap-3">
            <span id="session_badge" className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-600 tracking-wide uppercase border border-blue-100">
              Session Active
            </span>
            
            {activeTab === 'sql' && (
              <button 
                id="btn_run_sql"
                onClick={handleRunSQL}
                disabled={isRunning}
                className="flex items-center space-x-1.5 bg-blue-500 hover:bg-blue-600 text-white px-4 py-1.5 rounded-md text-xs font-semibold transition-all shadow-sm cursor-pointer disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{isRunning ? 'Running...' : selectedSql.trim() ? 'Run Selection' : 'Run Query'}</span>
              </button>
            )}
          </div>
        </header>

        {/* WORKSPACE MIDDLE BODY */}
        <PanelGroup direction="vertical" autoSaveId="studio-main-v" className="flex-1 min-h-0 bg-slate-50">
          <Panel id="workarea" defaultSize={58} minSize={20}>
        <div id="workspace_workarea" className="h-full flex flex-col min-h-0 bg-slate-50 overflow-hidden">
          
          <AnimatePresence mode="wait">
            {/* TAB 1: SQL QUERY EDITOR */}
            {activeTab === 'sql' && (
              <motion.div 
                key="sql"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.15 }}
                id="tab_sql_view" 
                className="flex-1 p-6 flex flex-col min-h-0"
              >
                {/* QUERY INPUT PANEL */}
                <div id="sql_editor_card" className="flex-1 min-h-0 bg-white border border-slate-200/80 rounded-lg shadow-sm overflow-hidden flex flex-col">

                  <div className="h-10 bg-slate-50 border-b border-slate-200 flex items-center px-4 justify-between shrink-0">
                    <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">SQL Query Console</span>
                    <div className="text-[11px] text-slate-500 font-mono">⌘/Ctrl+Enter run · ⌘/Ctrl+Shift+F format</div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-auto bg-slate-50/20">
                    <SqlEditor
                      value={query}
                      onChange={setQuery}
                      onRun={handleRunSQL}
                      schema={editorSchema}
                      onSelectionChange={setSelectedSql}
                    />
                  </div>

                  {/* TEMPLATE SUGGESTIONS */}
                  <div className="p-3 border-t border-slate-200 bg-slate-50/50 flex flex-wrap gap-2 items-center text-xs">
                    <span className="text-slate-400 font-medium">Snippets:</span>
                    <button
                      onClick={() => setQuery("SELECT * FROM raw_sales_data WHERE status = 'VALID' LIMIT 10;")}
                      className="px-2.5 py-1 border border-slate-200 hover:border-blue-500/30 bg-white text-slate-600 hover:text-blue-600 font-mono text-[10px] transition-all cursor-pointer"
                    >
                      Filter Valid Sales
                    </button>
                    <button
                      onClick={() => setQuery(DEFAULT_QUERY)}
                      className="px-2.5 py-1 border border-slate-200 hover:border-blue-500/30 bg-white text-slate-600 hover:text-blue-600 font-mono text-[10px] transition-all cursor-pointer"
                    >
                      Join Region Master
                    </button>
                    <button
                      onClick={() => setQuery("SELECT quarter, region_id, projected FROM q4_forecast_forecast ORDER BY region_id;")}
                      className="px-2.5 py-1 border border-slate-200 hover:border-blue-500/30 bg-white text-slate-600 hover:text-blue-600 font-mono text-[10px] transition-all cursor-pointer"
                    >
                      Q4 Forecast
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* TAB 2: VISUAL CLEANSE TOOL */}
            {activeTab === 'clean' && (
              <motion.div 
                key="clean"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.15 }}
                id="tab_clean_view" 
                className="flex-1 p-6 flex flex-col min-h-0 overflow-y-auto"
              >
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                  {/* Left Column: Cleansing Controls & Pipeline */}
                  <div className="lg:col-span-5 space-y-6">
                    {/* CONSOLIDATED CLEANSING PIPELINE CARD */}
                    <div id="cleanse_controls_card" className="bg-white border border-slate-200/80 rounded-lg shadow-sm p-6 space-y-5">
                      <div className="flex items-center justify-between pb-3 border-b border-slate-200/60">
                        <div className="flex items-center gap-2">
                          <Wand2 className="w-5 h-5 text-blue-500" />
                          <h2 className="font-semibold text-slate-900 text-sm">Cleansing Pipeline</h2>
                        </div>
                        <span className="bg-indigo-50 border border-indigo-150 text-indigo-600 font-semibold px-2 py-0.5 rounded text-[10px]">
                          {cleanSteps.length} step{cleanSteps.length !== 1 ? 's' : ''}
                        </span>
                      </div>

                      {/* Dataset Selection */}
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Target Dataset</label>
                        <select
                          value={cleanDatasetId}
                          onChange={(e) => {
                            const newId = e.target.value;
                            setCleanDatasetId(newId);
                            const ds = datasets.find((d) => d.id === newId);
                            if (ds) {
                              setCleanSaveAsName(ds.name.replace(/\.[^/.]+$/, ''));
                            }
                            setCleanSteps([]); // Reset pipeline steps when dataset changes
                          }}
                          className="w-full border border-slate-200 bg-white rounded-md p-2 text-xs text-slate-700 focus:border-blue-500 outline-none font-mono"
                        >
                          {datasets.map(d => (
                            <option key={d.id} value={d.id}>
                              {d.schema_name ? `[${d.schema_name}] ` : ''}{d.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Pipeline steps list */}
                      <div className="space-y-4 pt-1">
                        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                          <div className="flex items-center gap-1.5">
                            <ListChecks className="w-4 h-4 text-indigo-500" />
                            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Pipeline Steps</span>
                          </div>
                          <button
                            onClick={() => {
                              setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'dedup' }]);
                            }}
                            className="px-2.5 py-1 border border-slate-200 hover:bg-slate-50 text-[9.5px] text-slate-600 rounded flex items-center gap-1 font-medium transition-colors cursor-pointer shadow-sm"
                            title="Remove duplicate rows across the entire table"
                          >
                            ➕ De-duplicate Rows
                          </button>
                        </div>

                        {cleanSteps.length === 0 ? (
                          <div className="text-center py-8 text-slate-400 text-xs italic bg-slate-50/50 rounded-lg border border-dashed border-slate-200">
                            No operations in pipeline.<br/>Hover over column headers in the preview table on the right and select &quot;Clean...&quot; to add steps.
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                            {cleanSteps.map((step, idx) => (
                              <div key={step.id} className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200/60 p-2.5 rounded-md hover:bg-slate-100/70 transition-colors">
                                <div className="flex items-start gap-2.5 min-w-0">
                                  <span className="w-4 h-4 bg-indigo-500 text-white rounded-full flex items-center justify-center font-mono text-[9px] shrink-0 mt-0.5">
                                    {idx + 1}
                                  </span>
                                  <div className="text-xs text-slate-700 min-w-0 font-mono">
                                    <div className="font-medium truncate capitalize text-[11px]">
                                      {step.op.replace('_', ' ')}
                                    </div>
                                    <div className="text-[10px] text-slate-400 truncate">
                                      {step.op === 'drop_null' && `Column: ${step.column}`}
                                      {step.op === 'fill_null' && `Replace Nulls in ${step.column} -> "${step.value}"`}
                                      {step.op === 'rename' && `Rename ${step.column} -> "${step.newName}"`}
                                      {step.op === 'cast' && `Cast ${step.column} -> ${step.castType}`}
                                      {step.op === 'dedup' && `Deduplicate rows`}
                                    </div>
                                  </div>
                                </div>
                                <button
                                  onClick={() => {
                                    setCleanSteps((prev) => prev.filter((s) => s.id !== step.id));
                                  }}
                                  className="text-slate-400 hover:text-red-500 cursor-pointer p-0.5 hover:bg-slate-200/50 rounded transition-colors shrink-0"
                                  title="Remove step"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {cleanSteps.length > 0 && (
                        <div className="space-y-3 pt-3 border-t border-slate-100">
                          <div className="flex flex-col gap-1">
                            <label className="text-[9.5px] font-semibold text-slate-500 uppercase tracking-wider">Save Cleansed Table As</label>
                            <input
                              type="text"
                              value={cleanSaveAsName}
                              onChange={(e) => setCleanSaveAsName(e.target.value)}
                              placeholder="Table name..."
                              className="w-full border border-slate-200 bg-white rounded p-1.5 text-xs text-slate-700 font-mono outline-none focus:border-blue-500"
                            />
                          </div>
                          
                          <div className="flex justify-end gap-3 pt-1">
                            <button
                              onClick={() => setCleanSteps([])}
                              className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-655 rounded text-xs transition-all cursor-pointer font-medium"
                            >
                              Clear All
                            </button>
                            <button
                              onClick={handleExecuteCleanse}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded text-xs font-semibold shadow-sm hover:shadow transition-all cursor-pointer flex items-center gap-1.5"
                            >
                              <Wand2 className="w-3.5 h-3.5" />
                              <span>Commit & Save Table</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Live Transformed Output Preview Table */}
                  <div className="lg:col-span-7 bg-white border border-slate-200/80 rounded-lg shadow-sm flex flex-col min-h-[400px] min-w-0">
                    <div className="px-5 py-4 border-b border-slate-200/60 flex items-center justify-between shrink-0">
                      <div className="flex items-center gap-2">
                        <Table2 className="w-4.5 h-4.5 text-blue-500" />
                        <h3 className="font-semibold text-slate-800 text-sm">Transformed Preview</h3>
                      </div>
                      {cleanPreviewLoading && (
                        <span className="text-[10px] text-slate-400 animate-pulse font-mono">Updating preview...</span>
                      )}
                    </div>
                    
                    <div className="flex-1 overflow-auto p-4 min-h-0 bg-slate-50/20">
                      {cleanPreviewError ? (
                        <div className="h-full flex items-center justify-center p-6">
                          <div className="max-w-md text-center text-red-700 bg-red-50 border border-red-200/60 p-4 rounded-lg">
                            <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-2" />
                            <h4 className="font-semibold text-xs mb-1">Cleansing Error</h4>
                            <p className="text-[11px] font-mono text-left">{cleanPreviewError}</p>
                          </div>
                        </div>
                      ) : cleanPreviewLoading && cleanPreviewColumns.length === 0 ? (
                        /* Table Loader */
                        <div className="space-y-3">
                          <div className="h-6 bg-slate-200 rounded animate-pulse w-full"></div>
                          <div className="h-20 bg-slate-100 rounded animate-pulse w-full"></div>
                        </div>
                      ) : cleanPreviewColumns.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-slate-400 text-xs italic">
                          Select a dataset to view preview.
                        </div>
                      ) : (
                        <div className="border border-slate-200 rounded-lg bg-white shadow-sm max-h-[580px] w-full max-w-full overflow-x-auto overflow-y-auto">
                          <table className="w-full min-w-max text-left border-collapse text-[10.5px]">
                            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                              <tr>
                                <th className="w-10 px-3 py-2 text-slate-400 border-r border-slate-200/60 text-center font-mono bg-slate-50 font-normal">#</th>
                                {cleanPreviewColumns.map((colName, colIdx) => {
                                  const type = getColumnType(colName);
                                  return (
                                    <th key={colIdx} className="px-3 py-2 text-slate-700 font-semibold font-mono border-r border-slate-200/60 relative group last:border-none bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors">
                                      <div className="flex flex-col gap-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 min-w-0">
                                          <div className="flex items-center gap-1.5 min-w-0">
                                            <Wand2 className="w-3 h-3 text-slate-400 group-hover:text-blue-500 transition-colors shrink-0" />
                                            <span className="truncate">{colName}</span>
                                          </div>
                                                                         {/* Hover dropdown quick actions */}
                                          <div className="opacity-50 group-hover:opacity-100 transition-opacity shrink-0 relative">
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveCleanMenu({ column: colName, mode: 'options' });
                                                setCleanInputVal('');
                                              }}
                                              className="bg-white hover:bg-slate-50 border border-slate-200 rounded px-1.5 text-[8.5px] py-0.5 text-slate-550 font-sans cursor-pointer outline-none focus:ring-1 focus:ring-blue-500 shrink-0"
                                            >
                                              Clean...
                                            </button>

                                            {activeCleanMenu?.column === colName && (
                                              <>
                                                <div 
                                                  className="fixed inset-0 z-30" 
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setActiveCleanMenu(null);
                                                  }}
                                                />
                                                <div 
                                                  className={`absolute ${colIdx === 0 ? 'left-0' : 'right-0'} top-full mt-1.5 w-44 bg-white border border-slate-200 rounded-lg shadow-lg z-40 p-1 text-[10px] font-sans font-normal text-slate-700 animate-in fade-in slide-in-from-top-1 duration-100`}
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  {activeCleanMenu.mode === 'options' && (
                                                    <div className="space-y-0.5">
                                                      <div className="px-2 py-1 text-[8.5px] font-semibold text-slate-400 uppercase tracking-wider">Clean Options</div>
                                                      <button
                                                        onClick={() => {
                                                          setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'drop_null', column: colName }]);
                                                          setActiveCleanMenu(null);
                                                        }}
                                                        className="w-full text-left px-2 py-1.5 hover:bg-slate-50 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                                      >
                                                        <span>❌</span> Drop Nulls
                                                      </button>
                                                      <button
                                                        onClick={() => {
                                                          setActiveCleanMenu({ column: colName, mode: 'fill' });
                                                          setCleanInputVal('0');
                                                        }}
                                                        className="w-full text-left px-2 py-1.5 hover:bg-slate-50 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                                      >
                                                        <span>📝</span> Fill Nulls...
                                                      </button>
                                                      <button
                                                        onClick={() => {
                                                          setActiveCleanMenu({ column: colName, mode: 'rename' });
                                                          setCleanInputVal(colName);
                                                        }}
                                                        className="w-full text-left px-2 py-1.5 hover:bg-slate-50 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                                      >
                                                        <span>✍️</span> Rename...
                                                      </button>
                                                      <button
                                                        onClick={() => {
                                                          setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'cast', column: colName, castType: 'DOUBLE' }]);
                                                          setActiveCleanMenu(null);
                                                        }}
                                                        className="w-full text-left px-2 py-1.5 hover:bg-slate-50 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                                      >
                                                        <span>🔢</span> Cast to Number
                                                      </button>
                                                      <button
                                                        onClick={() => {
                                                          setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'cast', column: colName, castType: 'VARCHAR' }]);
                                                          setActiveCleanMenu(null);
                                                        }}
                                                        className="w-full text-left px-2 py-1.5 hover:bg-slate-50 rounded flex items-center gap-1.5 transition-colors cursor-pointer"
                                                      >
                                                        <span>🔤</span> Cast to String
                                                      </button>
                                                    </div>
                                                  )}

                                                  {activeCleanMenu.mode === 'fill' && (
                                                    <div className="p-2 space-y-2">
                                                      <div className="font-semibold text-slate-655 text-[8.5px] uppercase">Fill Nulls Replacement</div>
                                                      <input
                                                        type="text"
                                                        value={cleanInputVal}
                                                        onChange={(e) => setCleanInputVal(e.target.value)}
                                                        placeholder="Replacement value..."
                                                        className="w-full border border-slate-200 rounded px-1.5 py-1 text-[9.5px] outline-none focus:border-blue-500 font-mono"
                                                        autoFocus
                                                        onKeyDown={(e) => {
                                                          if (e.key === 'Enter') {
                                                            setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'fill_null', column: colName, value: cleanInputVal }]);
                                                            setActiveCleanMenu(null);
                                                          }
                                                        }}
                                                      />
                                                      <div className="flex justify-end gap-1.5">
                                                        <button
                                                          onClick={() => setActiveCleanMenu({ column: colName, mode: 'options' })}
                                                          className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 text-[9px] cursor-pointer"
                                                        >
                                                          Back
                                                        </button>
                                                        <button
                                                          onClick={() => {
                                                            setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'fill_null', column: colName, value: cleanInputVal }]);
                                                            setActiveCleanMenu(null);
                                                          }}
                                                          className="px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600 font-medium text-[9px] cursor-pointer"
                                                        >
                                                          Fill
                                                        </button>
                                                      </div>
                                                    </div>
                                                  )}

                                                  {activeCleanMenu.mode === 'rename' && (
                                                    <div className="p-2 space-y-2">
                                                      <div className="font-semibold text-slate-655 text-[8.5px] uppercase">Rename Column</div>
                                                      <input
                                                        type="text"
                                                        value={cleanInputVal}
                                                        onChange={(e) => setCleanInputVal(e.target.value)}
                                                        placeholder="New name..."
                                                        className="w-full border border-slate-200 rounded px-1.5 py-1 text-[9.5px] outline-none focus:border-blue-500 font-mono"
                                                        autoFocus
                                                        onKeyDown={(e) => {
                                                          if (e.key === 'Enter') {
                                                            if (cleanInputVal.trim()) {
                                                              setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'rename', column: colName, newName: cleanInputVal.trim() }]);
                                                            }
                                                            setActiveCleanMenu(null);
                                                          }
                                                        }}
                                                      />
                                                      <div className="flex justify-end gap-1.5">
                                                        <button
                                                          onClick={() => setActiveCleanMenu({ column: colName, mode: 'options' })}
                                                          className="px-2 py-0.5 border border-slate-200 rounded hover:bg-slate-50 text-[9px] cursor-pointer"
                                                        >
                                                          Back
                                                        </button>
                                                        <button
                                                          onClick={() => {
                                                            if (cleanInputVal.trim()) {
                                                              setCleanSteps(prev => [...prev, { id: Math.random().toString(36).substring(7), datasetId: cleanDatasetId, op: 'rename', column: colName, newName: cleanInputVal.trim() }]);
                                                            }
                                                            setActiveCleanMenu(null);
                                                          }}
                                                          className="px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600 font-medium text-[9px] cursor-pointer"
                                                        >
                                                          Rename
                                                        </button>
                                                      </div>
                                                    </div>
                                                  )}
                                                </div>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                          <span className={`text-[7.5px] px-1 py-0.1 border rounded uppercase font-mono tracking-wider font-semibold ${
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
                                        </div>
                                      </div>
                                    </th>
                                  );
                                })}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 bg-white">
                              {cleanPreviewRows.map((row, rowIdx) => (
                                <tr key={rowIdx} className="hover:bg-slate-50/50">
                                  <td className="px-3 py-1.5 text-center text-slate-400 border-r border-slate-100 font-mono text-[9.5px] bg-slate-50/30">{rowIdx + 1}</td>
                                  {row.map((cell, cellIdx) => (
                                    <td key={cellIdx} className="px-3 py-1.5 text-slate-600 truncate max-w-[160px] border-r border-slate-100 last:border-none font-mono text-[10px]">
                                      {cell === null || cell === undefined ? (
                                        <span className="text-red-400/80 bg-red-50/30 px-1 py-0.5 rounded text-[8.5px] font-semibold italic">NULL</span>
                                      ) : typeof cell === 'object' ? (
                                        <span className="text-slate-400 text-[9px] truncate" title={JSON.stringify(cell)}>
                                          {JSON.stringify(cell)}
                                        </span>
                                      ) : typeof cell === 'number' ? (
                                        <span className="text-blue-600 font-medium">{cell.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 })}</span>
                                      ) : String(cell)}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* TAB 3: AI PDF EXTRACTOR */}
            {activeTab === 'pdf' && (
              <motion.div 
                key="pdf"
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={{ duration: 0.15 }}
                id="tab_pdf_view" 
                className="flex-1 p-6 flex flex-col min-h-0 overflow-y-auto font-sans"
              >
                {!pdfDocId ? (
                  <div className="flex-1 p-6 flex flex-col justify-center items-center h-[500px]">
                    <div className="max-w-md w-full bg-white border border-slate-200/80 rounded-xl shadow-md p-8 flex flex-col items-center text-center space-y-4">
                      <div className="w-12 h-12 bg-blue-50 rounded-full flex items-center justify-center text-blue-500 shadow-inner">
                        <Upload className="w-6 h-6 animate-pulse" />
                      </div>
                      <h2 className="font-semibold text-lg text-slate-800">Upload PDF for Extraction</h2>
                      <p className="text-xs text-slate-500 font-normal">Upload a single PDF to extract raw structured JSON layout, tables, and images, then rationalize with local or cloud AI models.</p>
                      <div className="flex items-center gap-2">
                        <label className="cursor-pointer bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm">
                          <Upload className="w-3.5 h-3.5" />
                          <span>Choose PDF File</span>
                          <input
                            type="file"
                            accept=".pdf,application/pdf"
                            className="hidden"
                            onChange={handlePdfUpload}
                          />
                        </label>
                        <button
                          onClick={() => setPdfGcsBrowserOpen(true)}
                          className="cursor-pointer bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm"
                        >
                          <Cloud className="w-3.5 h-3.5 text-blue-500" />
                          <span>Import from GCS</span>
                        </button>
                      </div>
                      {pdfError && <div className="text-xs text-red-500 font-medium">{pdfError}</div>}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col min-h-0 space-y-6">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[75vh] shrink-0">
                      {/* Left: PDF Preview */}
                      <div className="bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden flex flex-col">
                        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="w-4 h-4 text-blue-500" />
                            <span className="text-xs font-semibold text-slate-800 truncate">{pdfFilename}</span>
                          </div>
                          <button 
                            onClick={() => { setPdfDocId(''); setPdfFilename(''); setPdfExtractedText(''); setPdfRationalizedSchema(''); setPdfImagesList([]); setPdfPageImagesList([]); setPdfUsePageImages(false); setPdfImageTab('pages'); setPdfPreviewImage(null); }}
                            className="text-slate-400 hover:text-slate-600 transition-colors text-[10px] uppercase font-bold tracking-wider cursor-pointer border-0 bg-transparent outline-none"
                          >
                            Clear File
                          </button>
                        </div>
                        <iframe 
                          src={`/api/pdf/file/${pdfDocId}#navpanes=0&pagemode=none`} 
                          title="PDF preview" 
                          className="flex-1 w-full bg-slate-100 border-0"
                        />
                      </div>

                      {/* Right: Extracted Output */}
                      <div className="bg-white border border-slate-200/80 rounded-xl shadow-sm overflow-hidden flex flex-col">
                        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80 flex items-center justify-between shrink-0">
                          {pdfExtractedText ? (
                            <div className="flex items-center space-x-4">
                              <button
                                onClick={() => setPdfOutputTab('json')}
                                className={`text-xs font-semibold pb-1 border-b-2 transition-all cursor-pointer border-0 bg-transparent outline-none ${
                                  pdfOutputTab === 'json'
                                    ? 'border-blue-500 text-blue-600 font-semibold'
                                    : 'border-transparent text-slate-400 hover:text-slate-500'
                                }`}
                              >
                                JSON
                              </button>
                              <button
                                onClick={() => setPdfOutputTab('markdown')}
                                className={`text-xs font-semibold pb-1 border-b-2 transition-all cursor-pointer border-0 bg-transparent outline-none ${
                                  pdfOutputTab === 'markdown'
                                    ? 'border-blue-500 text-blue-600 font-semibold'
                                    : 'border-transparent text-slate-400 hover:text-slate-500'
                                }`}
                              >
                                Markdown
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Database className="w-4 h-4 text-blue-500" />
                              <span className="text-xs font-semibold text-slate-800">Extracted JSON</span>
                            </div>
                          )}

                          {pdfExtractedText && (
                            <div className="flex items-center space-x-3">
                              {pdfOutputTab === 'markdown' && (
                                <div className="flex items-center space-x-1.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200/80 mr-2">
                                  <button
                                    onClick={() => setPdfMarkdownMode('raw')}
                                    className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-all cursor-pointer border-0 outline-none ${
                                      pdfMarkdownMode === 'raw'
                                        ? 'bg-white text-slate-800 shadow-sm'
                                        : 'text-slate-400 hover:text-slate-600 bg-transparent'
                                    }`}
                                  >
                                    Raw
                                  </button>
                                  <button
                                    onClick={() => setPdfMarkdownMode('rendered')}
                                    className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-all cursor-pointer border-0 outline-none ${
                                      pdfMarkdownMode === 'rendered'
                                        ? 'bg-white text-slate-800 shadow-sm'
                                        : 'text-slate-400 hover:text-slate-600 bg-transparent'
                                    }`}
                                  >
                                    Rendered
                                  </button>
                                </div>
                              )}
                              
                              <button
                                onClick={() => {
                                  const isJson = pdfOutputTab === 'json';
                                  const content = isJson ? pdfExtractedText : pdfExtractedMarkdown;
                                  const ext = isJson ? 'json' : 'md';
                                  const mime = isJson ? 'application/json' : 'text/markdown';
                                  const blob = new Blob([content], { type: mime });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = `${pdfFilename.replace(/\.[^/.]+$/, '')}.extracted.${ext}`;
                                  a.click();
                                }}
                                className="text-slate-500 hover:text-slate-800 transition-colors text-[10px] uppercase font-bold flex items-center gap-1 cursor-pointer border-0 bg-transparent outline-none"
                              >
                                <Download className="w-3 h-3" />
                                <span>Download</span>
                              </button>
                            </div>
                          )}

                          {!pdfExtractedText && !pdfExtracting && (
                            <button
                              onClick={handlePdfExtract}
                              className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-[11px] font-semibold flex items-center gap-1 transition-all cursor-pointer border-0 outline-none"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>Extract</span>
                            </button>
                          )}
                        </div>
                        
                        <div className="flex-1 min-h-0 flex flex-col relative bg-slate-50">
                          {pdfExtracting ? (
                            <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center text-center p-4">
                              <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mb-2" />
                              <p className="text-xs font-semibold text-slate-700">Running Datagrunt Extraction...</p>
                              <p className="text-[10px] text-slate-400">Parsing layout, text, tables, and page images.</p>
                            </div>
                          ) : null}

                          {pdfError ? (
                            <div className="flex-1 flex flex-col justify-center items-center text-center p-6 text-red-500">
                              <AlertCircle className="w-8 h-8 opacity-60 mb-2" />
                              <p className="text-xs font-semibold">Extraction Failed</p>
                              <p className="text-[10px] mt-1">{pdfError}</p>
                            </div>
                          ) : pdfExtractedText ? (
                            <div className="flex-1 flex flex-col min-h-0">
                              <div className="flex-1 overflow-y-auto min-h-0 bg-slate-50">
                                {pdfOutputTab === 'json' ? (
                                  <CodeViewer 
                                    value={pdfExtractedText} 
                                    language="json" 
                                  />
                                ) : pdfMarkdownMode === 'raw' ? (
                                  <CodeViewer 
                                    value={pdfExtractedMarkdown} 
                                    language="json" 
                                  />
                                ) : (
                                  renderMarkdown(pdfExtractedMarkdown, pdfDocId)
                                )}
                              </div>
                              {activePdfImageTab && (
                                <div className="h-32 border-t border-slate-200 bg-slate-50/50 p-3 flex flex-col shrink-0 min-h-0">
                                  {pdfImagesList.length > 0 && pdfPageImagesList.length > 0 ? (
                                    <div className="flex gap-4 mb-2 border-b border-slate-200/60 pb-1 sticky left-0 shrink-0">
                                      <button
                                        onClick={() => setPdfImageTab('layout')}
                                        className={`text-[10px] font-bold uppercase tracking-wider cursor-pointer border-0 bg-transparent outline-none pb-0.5 ${
                                          activePdfImageTab === 'layout' ? 'text-blue-600 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-500'
                                        }`}
                                      >
                                        Detected Figures ({pdfImagesList.length})
                                      </button>
                                      <button
                                        onClick={() => setPdfImageTab('pages')}
                                        className={`text-[10px] font-bold uppercase tracking-wider cursor-pointer border-0 bg-transparent outline-none pb-0.5 ${
                                          activePdfImageTab === 'pages' ? 'text-blue-600 border-b-2 border-blue-500' : 'text-slate-400 hover:text-slate-500'
                                        }`}
                                      >
                                        Full Page Images ({pdfPageImagesList.length})
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="mb-2 sticky left-0 shrink-0">
                                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50/50 pr-2">
                                        {activePdfImageTab === 'layout' ? `Detected Figures (${pdfImagesList.length})` : `Full Page Images (${pdfPageImagesList.length})`}:
                                      </span>
                                    </div>
                                  )}
                                  <div className="flex-1 flex gap-3 items-center overflow-x-auto pb-1 min-h-0 mt-1">
                                    {activePdfImageTab === 'layout'
                                      ? pdfImagesList.map((img, i) => (
                                          <div 
                                            key={i} 
                                            onClick={() => setPdfPreviewImage({
                                              src: `/api/pdf/image/${pdfDocId}/${img}`,
                                              alt: `Figure ${i+1}`
                                            })}
                                            className="h-20 w-20 border border-slate-200 rounded overflow-hidden shrink-0 bg-white shadow-sm flex items-center justify-center hover:scale-105 transition-transform duration-200 cursor-pointer"
                                          >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img 
                                              src={`/api/pdf/image/${pdfDocId}/${img}`} 
                                              alt={`Figure ${i+1}`}
                                              className="max-h-full max-w-full object-contain"
                                            />
                                          </div>
                                        ))
                                      : pdfPageImagesList.map((img, i) => (
                                          <div 
                                            key={i} 
                                            onClick={() => setPdfPreviewImage({
                                              src: `/api/pdf/page-image/${pdfDocId}/${img}`,
                                              alt: `Page ${i+1}`
                                            })}
                                            className="h-20 w-20 border border-slate-200 rounded overflow-hidden shrink-0 bg-white shadow-sm flex items-center justify-center hover:scale-105 transition-transform duration-200 cursor-pointer"
                                          >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img 
                                              src={`/api/pdf/page-image/${pdfDocId}/${img}`} 
                                              alt={`Page ${i+1}`}
                                              className="max-h-full max-w-full object-contain"
                                            />
                                          </div>
                                        ))
                                    }
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (() => {
                            const pdfTargetTablePath = targetTablePath(pdfFilename, null, 'documents');
                            const pdfTableExists = datasets.some((d) => d.table === pdfTargetTablePath);
                            return (
                              <div className="flex-1 flex flex-col justify-center items-center text-center p-6 text-slate-450 space-y-4">
                                <Play className="w-8 h-8 opacity-40" />
                                <p className="text-xs">Click <span className="font-semibold text-slate-750">Extract</span> to run Datagrunt layout extraction on this PDF.</p>
                                
                                {pdfTableExists && (
                                  <div className="max-w-md bg-amber-50 border border-amber-200 rounded-lg p-3 text-left text-xs text-amber-805 space-y-2">
                                    <div className="flex items-center gap-2">
                                      <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                                      <span>Table <code className="bg-amber-100/50 px-1 py-0.5 rounded font-mono font-semibold font-bold">documents.{toSnakeCase(pdfFilename)}</code> already exists.</span>
                                    </div>
                                    <div className="flex flex-col gap-2 pl-6">
                                      <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-655">
                                        <input 
                                          type="radio" 
                                          name="pdf-dup-action" 
                                          checked={pdfOverwrite === true} 
                                          onChange={() => setPdfOverwrite(true)}
                                          className="text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 cursor-pointer"
                                        />
                                        <span>Overwrite existing table</span>
                                      </label>
                                      <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-655">
                                        <input 
                                          type="radio" 
                                          name="pdf-dup-action" 
                                          checked={pdfOverwrite !== true} 
                                          onChange={() => setPdfOverwrite(false)}
                                          className="text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 cursor-pointer"
                                        />
                                        <span>Import as new table with unique name</span>
                                      </label>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Bottom: Rationalize with AI */}
                    {pdfExtractedText && (
                      <div className="bg-white border border-slate-200/80 rounded-xl shadow-sm p-6 space-y-6">
                        <div className="flex items-center gap-2 border-b border-slate-200/60 pb-3">
                          <Wand2 className="w-5 h-5 text-blue-500" />
                          <div>
                            <h3 className="font-semibold text-slate-900 text-sm">Rationalize Schema with AI</h3>
                            <p className="text-[10px] text-slate-505">Describe the target schema and let the LLM rewrite the raw layout JSON to conform.</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                          {/* Controls */}
                          <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                              {/* Local LLM Toggle */}
                              <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input 
                                  type="checkbox" 
                                  checked={pdfUseLocal} 
                                  onChange={(e) => setPdfUseLocal(e.target.checked)}
                                  className="rounded border-slate-300 text-blue-500 focus:ring-blue-400"
                                />
                                <span className="text-xs font-semibold text-slate-700">Use local LLM (Ollama)</span>
                              </label>

                              {/* PDF extraction context selection */}
                              {pdfPageImagesList.length > 0 && (
                                <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg p-1 px-2.5">
                                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Context Source:</span>
                                  <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-slate-700">
                                    <input 
                                      type="radio" 
                                      name="pdf-context-src" 
                                      checked={pdfUsePageImages === false} 
                                      onChange={() => setPdfUsePageImages(false)}
                                      className="text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer"
                                    />
                                    <span>Raw JSON + Detected Images</span>
                                  </label>
                                  <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-slate-700">
                                    <input 
                                      type="radio" 
                                      name="pdf-context-src" 
                                      checked={pdfUsePageImages === true} 
                                      onChange={() => setPdfUsePageImages(true)}
                                      className="text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer"
                                    />
                                    <span>Full Page Images</span>
                                  </label>
                                </div>
                              )}
                            </div>

                            {pdfUseLocal && !ollamaActive && (
                              <div className="flex items-center gap-2.5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-[11px] font-normal leading-normal">
                                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                                <div>
                                  <span className="font-semibold">Ollama service not found.</span> Make sure the Ollama daemon is running locally on your system.
                                </div>
                              </div>
                            )}

                            <div className="flex flex-col gap-1">
                              <label className="text-[11px] font-semibold text-slate-600">Model Selection</label>
                              {pdfUseLocal ? (
                                <div className="flex gap-2">
                                  <select 
                                    value={pdfLocalModel} 
                                    onChange={(e) => setPdfLocalModel(e.target.value)}
                                    className="flex-1 border border-slate-200 bg-white rounded p-1.5 text-xs text-slate-700 focus:border-blue-500 outline-none"
                                  >
                                    {ollamaModels.length > 0 ? (
                                      ollamaModels.map((m) => (
                                        <option key={m} value={m}>{m}</option>
                                      ))
                                    ) : (
                                      <option value="llama3">llama3 (default)</option>
                                    )}
                                    <option value="custom">custom model...</option>
                                  </select>
                                  {pdfLocalModel === 'custom' && (
                                    <input 
                                      type="text"
                                      placeholder="model name (e.g. mistral)"
                                      className="w-1/2 border border-slate-200 rounded p-1.5 text-xs text-slate-700 focus:border-blue-500 outline-none"
                                      onChange={(e) => setPdfLocalModel(e.target.value)}
                                    />
                                  )}
                                </div>
                              ) : (
                                <select 
                                  value={pdfCloudModel} 
                                  onChange={(e) => setPdfCloudModel(e.target.value)}
                                  className="border border-slate-200 bg-white rounded p-1.5 text-xs text-slate-700 focus:border-blue-500 outline-none"
                                >
                                  {geminiModels.length > 0 ? (
                                    geminiModels.map((m) => (
                                      <option key={m} value={m}>{m}</option>
                                    ))
                                  ) : (
                                    <>
                                      <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                                      <option value="gemini-3.1-pro">gemini-3.1-pro</option>
                                      <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                                    </>
                                  )}
                                </select>
                              )}
                            </div>

                            <div className="flex flex-col gap-1">
                              <label className="text-[11px] font-semibold text-slate-600">Prompt Instructions</label>
                              <textarea 
                                rows={8}
                                value={pdfPrompt}
                                onChange={(e) => setPdfPrompt(e.target.value)}
                                className="w-full bg-slate-50 border border-slate-200 rounded p-2 text-xs font-mono text-slate-700 focus:border-blue-500 outline-none resize-y"
                              />
                            </div>

                            {pdfError && <div className="text-xs text-red-500 font-medium">{pdfError}</div>}

                            <div className="flex justify-end">
                              <button 
                                onClick={handlePdfRationalize}
                                disabled={pdfRationalizing}
                                className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2 rounded-lg font-semibold text-xs transition-all shadow-sm cursor-pointer flex items-center gap-1.5 disabled:opacity-50 border-0 outline-none"
                              >
                                <Wand2 className="w-3.5 h-3.5" />
                                <span>{pdfRationalizing ? 'Rationalizing...' : 'Rationalize Schema'}</span>
                              </button>
                            </div>
                          </div>

                          {/* Output */}
                          <div className="border border-slate-200 rounded-xl overflow-hidden flex flex-col h-[320px] bg-slate-50 relative">
                            <div className="px-4 py-2 border-b border-slate-200 bg-slate-100 flex justify-between items-center shrink-0">
                              <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider">Rationalized JSON Output</span>
                              {pdfRationalizedSchema && (
                                <button
                                  onClick={() => {
                                    const blob = new Blob([pdfRationalizedSchema], { type: 'application/json' });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = `${pdfFilename.replace(/\.[^/.]+$/, '')}.schema.json`;
                                    a.click();
                                  }}
                                  className="text-slate-500 hover:text-slate-800 transition-colors text-[10px] uppercase font-bold flex items-center gap-1 cursor-pointer border-0 bg-transparent outline-none"
                                >
                                  <Download className="w-3 h-3" />
                                  <span>Download</span>
                                </button>
                              )}
                            </div>

                            {pdfSavedTable && !pdfRationalizing && (
                              <div className="px-4 py-1.5 bg-emerald-50 border-b border-emerald-200 text-emerald-700 text-[11px] font-medium shrink-0">
                                Saved to <code className="font-mono font-semibold">{pdfSavedTable}</code>
                              </div>
                            )}
                            {pdfSaveError && !pdfRationalizing && (
                              <div className="px-4 py-1.5 bg-amber-50 border-b border-amber-200 text-amber-700 text-[11px] font-medium shrink-0">
                                Not saved as dataset: {pdfSaveError}
                              </div>
                            )}

                            <div className="flex-1 min-h-0 flex flex-col relative bg-slate-50">
                              {pdfRationalizing ? (
                                <div className="absolute inset-0 bg-white/85 backdrop-blur-sm z-10 flex flex-col items-center justify-center text-center p-4">
                                  <RefreshCw className="w-8 h-8 text-blue-500 animate-spin mb-2" />
                                  <p className="text-xs font-semibold text-slate-700">Calling AI Model...</p>
                                  <p className="text-[10px] text-slate-400">Rewriting raw extracted JSON to fit requirements.</p>
                                </div>
                              ) : null}

                              {pdfRationalizedSchema ? (
                                <div className="flex-1 overflow-y-auto min-h-0 bg-slate-50">
                                  <CodeViewer 
                                    value={pdfRationalizedSchema} 
                                    language="json" 
                                  />
                                </div>
                              ) : (
                                <div className="flex-1 flex flex-col justify-center items-center text-center p-6 text-slate-400">
                                  <Wand2 className="w-8 h-8 opacity-40 mb-2" />
                                  <p className="text-xs">Configure the prompt and click <span className="font-semibold text-slate-700">Rationalize Schema</span> to see the structured schema result.</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </motion.div>
            )}

          </AnimatePresence>
        </div>
          </Panel>

          {activeTab !== 'pdf' && <ResizeHandle orientation="horizontal" />}

          {activeTab !== 'pdf' && (
            <Panel id="results" defaultSize={42} minSize={15}>
            {/* ACTIVE OUTPUT TABLE AND PREVIEW PANEL */}
          <section id="results_frame" className="h-full bg-white border-t border-slate-200/80 flex flex-col z-10">

            {exportError && (
              <div id="export_error_banner" className="flex items-center justify-between gap-3 px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs shrink-0">
                <span className="truncate">Export failed: {exportError}</span>
                <button
                  type="button"
                  onClick={() => setExportError(null)}
                  className="text-red-400 hover:text-red-600 font-semibold cursor-pointer shrink-0"
                  aria-label="Dismiss export error"
                >
                  ✕
                </button>
              </div>
            )}

            {!resultError && !isRunning && hasRun && resultSets.length > 0 ? (
              <>
                {resultSets.length > 1 && (
                  <div className="h-9 border-b border-slate-200 bg-slate-50 flex items-end px-4 gap-1 shrink-0">
                    {resultSets.map((rs, idx) => (
                      <button
                        key={idx}
                        onClick={() => setActiveResultIdx(idx)}
                        title={rs.statement}
                        className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider rounded-t-md border border-b-0 transition-all cursor-pointer ${
                          idx === activeResultIdx
                            ? 'bg-white text-blue-600 border-slate-200'
                            : rs.error
                            ? 'bg-red-50 text-red-500 border-transparent hover:border-red-200'
                            : 'bg-transparent text-slate-400 border-transparent hover:text-slate-600'
                        }`}
                      >
                        Result {String.fromCharCode(65 + idx)}{rs.error ? ' !' : ''}
                      </button>
                    ))}
                  </div>
                )}
                {(() => {
                  const active = resultSets[activeResultIdx];
                  if (active.error) {
                    return (
                      <div id="error_boundary" className="p-6 h-full flex items-center justify-center bg-white">
                        <div className="max-w-md text-center text-red-705 bg-white border border-red-200 p-5 rounded-lg shadow-sm">
                          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
                          <h4 className="font-semibold text-sm mb-1.5">SQL Syntax Error</h4>
                          <p className="text-xs whitespace-pre-wrap text-red-650/90 font-mono text-left">{active.detail || active.error}</p>
                          <pre className="text-[10px] text-slate-500 font-mono mt-2 whitespace-pre-wrap">{active.statement}</pre>
                        </div>
                      </div>
                    );
                  }
                  if (!active.has_result_set) {
                    return (
                      <div className="h-full flex items-center justify-center text-slate-500">
                        <div className="text-center p-6">
                          <p className="text-xs font-medium">Statement executed — no result set.</p>
                          <pre className="text-[10px] text-slate-400 font-mono mt-2 whitespace-pre-wrap max-w-lg truncate">{active.statement}</pre>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <ResultsGrid
                      key={activeResultIdx}
                      columns={pagedResults.columns}
                      rows={pagedResults.rows}
                      getColumnType={getColumnType}
                      truncatedNote={!resultsSource && active.truncated ? 'showing first 200 rows' : null}
                      pagination={resultsSource ? {
                        pageIdx: activePage.pageIdx,
                        pageSize: activePage.pageSize,
                        total: pagedResults.total,
                        loading: pagedResults.loading,
                        error: pagedResults.error,
                        onPageChange: (pageIdx: number) =>
                          setResultPageState((prev) => ({ ...prev, [activeResultIdx]: { ...activePage, pageIdx } })),
                        onPageSizeChange: (pageSize: number) =>
                          setResultPageState((prev) => ({ ...prev, [activeResultIdx]: { ...activePage, pageIdx: 0, pageSize } })),
                      } : null}
                      {...(resultsSource ? {
                        searchValue: activePage.search,
                        onSearchChange: (value: string) =>
                          setResultPageState((prev) => ({ ...prev, [activeResultIdx]: { ...activePage, search: value, pageIdx: 0 } })),
                        sort: activePage.sort,
                        onSortChange: (sort: GridSort | null) =>
                          setResultPageState((prev) => ({ ...prev, [activeResultIdx]: { ...activePage, sort, pageIdx: 0 } })),
                      } : {})}
                      toolbar={active.rows.length > 0 && active.statement.trim() !== '' ? (
                        <DownloadMenu
                          open={openDownloadMenu === 'results'}
                          onOpenChange={(o) => setOpenDownloadMenu(o ? 'results' : null)}
                          onPick={handleDownloadResults}
                          onPickGcs={() => {
                            const active = resultSets[activeResultIdx];
                            if (!active || active.error || !active.has_result_set || !active.statement.trim()) return;
                            setGcsExportSource({ source: { sql: active.statement }, baseName: 'results' });
                          }}
                          disabled={exportBusy}
                          triggerTitle="Download results (CSV or Parquet)"
                          triggerClassName="text-xs text-slate-600 hover:text-blue-600 flex items-center space-x-1 px-3 py-1.5 rounded-md hover:bg-white border border-transparent hover:border-slate-200 transition-all cursor-pointer font-medium disabled:opacity-50 disabled:cursor-default"
                          trigger={
                            <>
                              <Download className="w-3.5 h-3.5" />
                              <span>{exportBusy ? 'Exporting…' : 'Download'}</span>
                            </>
                          }
                        />
                      ) : null}
                    />
                  );
                })()}
              </>
            ) : (
              <>
                {/* TABLE CONTROLS BAR */}
                <div id="table_actions_bar" className="relative z-20 h-12 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50/80 backdrop-blur-md shrink-0">

                  <div className="flex items-center space-x-6 h-full">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-800">Table Output</span>
                  </div>

                  <div className="flex items-center space-x-3">
                    {(resultSets[activeResultIdx]?.rows.length ?? 0) > 0 && !resultError && (resultSets[activeResultIdx]?.statement.trim() ?? '') !== '' && (
                      <DownloadMenu
                        open={openDownloadMenu === 'results'}
                        onOpenChange={(o) => setOpenDownloadMenu(o ? 'results' : null)}
                        onPick={handleDownloadResults}
                        onPickGcs={() => {
                          const active = resultSets[activeResultIdx];
                          if (!active || active.error || !active.has_result_set || !active.statement.trim()) return;
                          setGcsExportSource({ source: { sql: active.statement }, baseName: 'results' });
                        }}
                        disabled={exportBusy}
                        triggerTitle="Download results (CSV or Parquet)"
                        triggerClassName="text-xs text-slate-600 hover:text-blue-600 flex items-center space-x-1 px-3 py-1.5 rounded-md hover:bg-white border border-transparent hover:border-slate-200 transition-all cursor-pointer font-medium disabled:opacity-50 disabled:cursor-default"
                        trigger={
                          <>
                            <Download className="w-3.5 h-3.5" />
                            <span>{exportBusy ? 'Exporting…' : 'Download'}</span>
                          </>
                        }
                      />
                    )}
                  </div>
                </div>

                {/* ERROR BOUNDARY OR RESULTS DISPLAY */}
                <div id="table_view_viewport" className="flex-1 overflow-auto bg-white">
                  {resultError ? (
                    <div id="error_boundary" className="p-6 h-full flex items-center justify-center bg-white">
                      <div className="max-w-md text-center text-red-705 bg-white border border-red-200 p-5 rounded-lg shadow-sm">
                        <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
                        <h4 className="font-semibold text-sm mb-1.5">SQL Syntax Error</h4>
                        <p className="text-xs whitespace-pre-wrap text-red-650/90 font-mono text-left">{resultError}</p>
                      </div>
                    </div>
                  ) : isRunning ? (
                    /* LOADING SKELETON DISPLAY */
                    <table className="w-full text-left border-collapse font-mono text-[11px] text-slate-400 relative">
                      <thead className="sticky top-0 bg-slate-50 z-10 border-b border-slate-200">
                        <tr>
                          <th className="w-12 px-4 py-3 bg-slate-50 text-center border-r border-slate-200/60">#</th>
                          {[...Array(resultSets[activeResultIdx]?.columns.length || 4)].map((col, idx) => (
                            <th key={idx} className="px-5 py-3 bg-slate-50 text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap border-r border-slate-200/60 last:border-none">
                              <div className="h-3 w-16 bg-slate-200 rounded animate-pulse"></div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...Array(5)].map((_, rIdx) => (
                          <tr key={rIdx} className="border-b border-slate-100 animate-pulse">
                            <td className="px-4 py-3 text-center border-r border-slate-100/60">
                              <div className="h-3 w-4 bg-slate-200 rounded mx-auto"></div>
                            </td>
                            {[...Array(resultSets[activeResultIdx]?.columns.length || 4)].map((_, cIdx) => (
                              <td key={cIdx} className="px-5 py-3 border-r border-slate-100/60">
                                <div className="h-3 bg-slate-200 rounded" style={{ width: `${Math.random() * 50 + 40}%` }}></div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-400 bg-white">
                      <div className="text-center p-6">
                        <Table2 className="w-8 h-8 mx-auto mb-2 text-slate-300 animate-pulse" />
                        <p className="text-xs">No active process loaded. Write a SQL query or configure a join/cleanse process above.</p>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            </section>
            </Panel>
          )}
        </PanelGroup>
      </main>
      </Panel>
 
    </PanelGroup>

      {/* 5. IMPORT PREVIEW & NORMALIZATION MODAL */}
      <AnimatePresence>
        {stagedPreview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/35 backdrop-blur-sm animate-fade-in">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-5xl bg-white/90 backdrop-blur-xl border border-slate-200/80 rounded-xl shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
            >
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-100/80 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Upload className="w-4 h-4 text-blue-600" />
                  <h3 className="font-semibold text-slate-800">
                    {stagedPreview.is_single ? 'Configure Import & Preview' : 'Import Multiple Files'}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setStagedNewSchemas([]);
                    setBulkImportSchema('');
                    setStagedPreview(null);
                  }}
                  className="text-slate-400 hover:text-slate-650 cursor-pointer"
                  disabled={importingStaged}
                >
                  ✕
                </button>
              </div>

              {/* Body */}
              <div className="p-6 overflow-y-auto space-y-5 flex-1 min-h-0">
                {!stagedPreview.is_single && (
                  <div className="bg-blue-50/40 border border-blue-100 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-700">
                    <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                      <Settings2 className="w-3.5 h-3.5 text-blue-600" />
                      <span>Bulk Settings (Applies to all files)</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 font-medium cursor-pointer text-slate-655">
                        <input
                          type="checkbox"
                          checked={stagedPreview.files.every((file) => normalizeConfig[file.staged_id])}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setNormalizeConfig((prev) => {
                              const updated = { ...prev };
                              stagedPreview.files.forEach((file) => {
                                updated[file.staged_id] = checked;
                              });
                              return updated;
                            });
                          }}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                        />
                        <span>Normalize All Columns</span>
                      </label>

                      <label className="flex items-center gap-1.5 font-medium text-slate-655">
                        <span>Skip Rows (all):</span>
                        <input
                          type="number"
                          min={0}
                          value={bulkSkipRows}
                          onChange={(e) => {
                            const n = sanitizeSkipRows(e.target.value);
                            setBulkSkipRows(n);
                            setImportReadOptions((prev) => {
                              const updated: Record<string, SheetReadOptions> = {};
                              for (const k of Object.keys(prev)) updated[k] = { ...prev[k], skip_rows: n };
                              return updated;
                            });
                          }}
                          className="w-14 border border-slate-200 rounded px-2 py-1 bg-white text-slate-700 font-mono outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </label>
                      <label className="flex items-center gap-2 font-medium cursor-pointer text-slate-655">
                        <input
                          type="checkbox"
                          checked={bulkHasHeader}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setBulkHasHeader(checked);
                            setImportReadOptions((prev) => {
                              const updated: Record<string, SheetReadOptions> = {};
                              for (const k of Object.keys(prev)) updated[k] = { ...prev[k], has_header: checked };
                              return updated;
                            });
                          }}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                        />
                        <span>First Row Is Header (all)</span>
                      </label>

                      <div className="flex items-center gap-1.5 text-slate-655 font-mono">
                        <span>Set Schema for All:</span>
                        <select
                          value={availableSchemas.includes(bulkImportSchema) ? bulkImportSchema : (bulkImportSchema === '' ? '' : '__other__')}
                          onChange={(e) => {
                            const val = e.target.value;
                            setBulkImportSchema(val);
                            if (val !== '__other__' && val !== '') {
                              setImportSchemaConfig((prev) => {
                                const updated = { ...prev };
                                stagedPreview.files.forEach((file) => {
                                  updated[file.staged_id] = val;
                                });
                                return updated;
                              });
                            }
                          }}
                          className="text-xs bg-white border border-slate-200 rounded px-2 py-1 text-slate-700 outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer font-mono"
                        >
                          <option value="" disabled hidden>select...</option>
                          {availableSchemas.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                          <option value="__other__">Create New...</option>
                        </select>
                        {bulkImportSchema === '__other__' && (
                          <input
                            type="text"
                            placeholder="new schema name..."
                            className="w-28 border border-slate-205 rounded px-2 py-1 bg-white text-slate-700 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                            onBlur={(e) => {
                              const val = e.target.value.trim();
                              if (val) {
                                if (!availableSchemas.includes(val)) {
                                  setStagedNewSchemas((prev) => [...prev, val]);
                                }
                                setImportSchemaConfig((prev) => {
                                  const updated = { ...prev };
                                  stagedPreview.files.forEach((file) => {
                                    updated[file.staged_id] = val;
                                  });
                                  return updated;
                                });
                                setBulkImportSchema(val);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {stagedPreview.files.map((file) => {
                  const isExcel = file.sheets !== null;
                  const isNorm = normalizeConfig[file.staged_id] || false;
                  
                  return (
                    <div key={file.staged_id} className="space-y-4 border border-slate-150 rounded-lg p-4 bg-slate-50/40">
                      {/* File details & options */}
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Table2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          <span className="font-mono text-xs font-semibold text-slate-700 truncate">{file.filename}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-3 shrink-0">
                          {/* Excel sheets are always imported in full — one dataset per sheet */}
                          {isExcel && file.sheets && (
                            <div className="text-xs text-slate-600">
                              <span>
                                {file.sheets.length} sheet{file.sheets.length === 1 ? '' : 's'} ({file.sheets.join(', ')}) — {file.sheets.length === 1 ? 'imports as its own dataset' : 'each imports as its own dataset'}
                              </span>
                            </div>
                          )}

                          {/* Normalization Toggle */}
                          <label className="flex items-center gap-2 text-xs text-slate-600 font-medium cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isNorm}
                              onChange={(e) => setNormalizeConfig(prev => ({ ...prev, [file.staged_id]: e.target.checked }))}
                              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                            />
                            <span>Normalize Columns</span>
                          </label>

                          {/* Target Schema Selector */}
                          <div className="flex items-center gap-1.5 text-xs text-slate-600">
                            <span>Target Schema:</span>
                            <select
                              value={availableSchemas.includes(importSchemaConfig[file.staged_id]) ? importSchemaConfig[file.staged_id] : '__other__'}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val !== '__other__') {
                                  setImportSchemaConfig((prev) => ({ ...prev, [file.staged_id]: val }));
                                } else {
                                  setImportSchemaConfig((prev) => ({ ...prev, [file.staged_id]: '' }));
                                }
                              }}
                              className="text-xs bg-white border border-slate-205 rounded px-2 py-1 text-slate-700 outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer font-mono"
                            >
                              {availableSchemas.map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                              <option value="__other__">Create New...</option>
                            </select>
                            {(!availableSchemas.includes(importSchemaConfig[file.staged_id]) || importSchemaConfig[file.staged_id] === '') && (
                              <input
                                type="text"
                                placeholder="new schema..."
                                value={importSchemaConfig[file.staged_id] || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setImportSchemaConfig((prev) => ({ ...prev, [file.staged_id]: val }));
                                }}
                                onBlur={(e) => {
                                  const val = e.target.value.trim();
                                  if (val && !availableSchemas.includes(val)) {
                                    setStagedNewSchemas((prev) => [...prev, val]);
                                  }
                                }}
                                className="w-28 border border-slate-200 rounded px-2 py-1 bg-white text-slate-700 font-mono text-xs outline-none focus:ring-1 focus:ring-blue-500"
                              />
                            )}
                          </div>
                        </div>
                      </div>

                      {(() => {
                        const currentSchema = importSchemaConfig[file.staged_id] || 'imported';
                        const sheetVariants = file.sheets && file.sheets.length > 0 ? file.sheets : [null];
                        const existingTables = sheetVariants
                          .map((sheetName) => targetTablePath(file.filename, sheetName, currentSchema))
                          .filter((tablePath) => datasets.some((d) => d.table === tablePath));
                        if (existingTables.length === 0) return null;
                        return (
                          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-2">
                            <div className="flex items-center gap-2">
                              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                              <span>Table{existingTables.length === 1 ? '' : 's'} <code className="bg-amber-100/50 px-1 py-0.5 rounded font-mono font-semibold font-bold">{existingTables.map((t) => `${currentSchema}.${t.split('.').pop()}`).join(', ')}</code> already exist{existingTables.length === 1 ? 's' : ''}.</span>
                            </div>
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 pl-6">
                              <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-655">
                                <input 
                                  type="radio" 
                                  name={`dup-action-${file.staged_id}`} 
                                  checked={overwriteConfig[file.staged_id] === true} 
                                  onChange={() => setOverwriteConfig(prev => ({ ...prev, [file.staged_id]: true }))}
                                  className="text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 cursor-pointer"
                                />
                                <span>Overwrite existing table</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer font-medium text-slate-655">
                                <input 
                                  type="radio" 
                                  name={`dup-action-${file.staged_id}`} 
                                  checked={overwriteConfig[file.staged_id] !== true} 
                                  onChange={() => setOverwriteConfig(prev => ({ ...prev, [file.staged_id]: false }))}
                                  className="text-amber-600 focus:ring-amber-500 w-3.5 h-3.5 cursor-pointer"
                                />
                                <span>Import as new table with unique name</span>
                              </label>
                            </div>
                          </div>
                        );
                      })()}

                      <ImportPreviewPanel
                        file={file}
                        isSingle={stagedPreview.is_single}
                        isNorm={isNorm}
                        options={importReadOptions}
                        onOptionsChange={(key, opts) =>
                          setImportReadOptions((prev) => ({ ...prev, [key]: opts }))
                        }
                        onErrorChange={(key, hasError) =>
                          setStagedPreviewErrors((prev) =>
                            prev[key] === hasError ? prev : { ...prev, [key]: hasError }
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-3">
                {Object.values(stagedPreviewErrors).some(Boolean) && (
                  <span className="text-xs text-red-600 mr-auto">Fix the preview errors above to import.</span>
                )}
                <button
                  onClick={() => {
                    setStagedNewSchemas([]);
                    setBulkImportSchema('');
                    setStagedPreview(null);
                  }}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                  disabled={importingStaged}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmImport}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md shadow-sm transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                  disabled={importingStaged || Object.values(stagedPreviewErrors).some(Boolean)}
                >
                  {importingStaged ? (
                    <>
                      <svg className="animate-spin h-3 w-3 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Importing...</span>
                    </>
                  ) : (
                    <span>Confirm Import</span>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 6. IMAGE PREVIEW MODAL */}
      <AnimatePresence>
        {pdfPreviewImage && (
          <div 
            onClick={() => setPdfPreviewImage(null)}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm cursor-pointer animate-fade-in"
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={(e) => e.stopPropagation()}
              className="relative max-w-4xl max-h-[90vh] bg-white border border-slate-200/80 rounded-xl shadow-2xl overflow-hidden flex flex-col p-2 cursor-default"
            >
              {/* Close Button */}
              <button
                onClick={() => setPdfPreviewImage(null)}
                className="absolute top-4 right-4 bg-slate-950/40 hover:bg-slate-950/60 text-white rounded-full w-8 h-8 flex items-center justify-center cursor-pointer border-0 outline-none transition-colors z-10 shadow-sm font-semibold"
              >
                ✕
              </button>
              
              <div className="overflow-auto max-h-[85vh] flex items-center justify-center bg-slate-50 rounded-lg">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img 
                  src={pdfPreviewImage.src} 
                  alt={pdfPreviewImage.alt}
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              
              {pdfPreviewImage.alt && (
                <div className="px-3 py-2 text-center text-xs font-semibold text-slate-500">
                  {pdfPreviewImage.alt}
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {previewDatasetTarget && (
        <DataPreviewModal
          datasetId={previewDatasetTarget.id}
          datasetName={previewDatasetTarget.name}
          getColumnType={getColumnType}
          onClose={() => setPreviewDatasetTarget(null)}
        />
      )}

      {gcsBrowserOpen && (
        <GcsBrowserModal
          onClose={() => setGcsBrowserOpen(false)}
          onImport={handleGcsImport}
        />
      )}

      {pdfGcsBrowserOpen && (
        <GcsBrowserModal
          kind="pdf"
          selectMode="single"
          onClose={() => setPdfGcsBrowserOpen(false)}
          onImport={handlePdfGcsImport}
        />
      )}

      {gcsExportSource && (
        <GcsExportDialog
          source={gcsExportSource.source}
          baseName={gcsExportSource.baseName}
          onClose={() => setGcsExportSource(null)}
        />
      )}
    </div>
  );
}
