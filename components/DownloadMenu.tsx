'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ExportFormat } from '@/lib/api';

interface DownloadMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (format: ExportFormat) => void;
  trigger: ReactNode;
  triggerClassName: string;
  triggerTitle?: string;
  disabled?: boolean;
  align?: 'left' | 'right';
  onPickGcs?: () => void;
}

// Shared CSV/Parquet format picker for every download affordance.
// Controlled: the parent owns open state so it can coordinate multiple
// instances (e.g. one menu per sidebar dataset row).
export function DownloadMenu({
  open,
  onOpenChange,
  onPick,
  trigger,
  triggerClassName,
  triggerTitle,
  disabled,
  align = 'right',
  onPickGcs,
}: DownloadMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        title={triggerTitle}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} z-50 bg-white border border-slate-200 rounded-md shadow-lg py-1 min-w-[130px]`}
        >
          {(['csv', 'parquet'] as const).map((format) => (
            <button
              key={format}
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenChange(false);
                onPick(format);
              }}
              className="w-full text-left px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-blue-600 cursor-pointer"
            >
              {format === 'csv' ? 'CSV (.csv)' : 'Parquet (.parquet)'}
            </button>
          ))}
          {onPickGcs && (
            <>
              <div className="my-1 border-t border-slate-100" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenChange(false);
                  onPickGcs();
                }}
                className="w-full text-left px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-blue-600 cursor-pointer"
              >
                Export to GCS…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
