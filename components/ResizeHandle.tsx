'use client';

import { PanelResizeHandle } from 'react-resizable-panels';

interface ResizeHandleProps {
  // 'vertical' = a vertical bar between horizontal panels (drag left/right).
  // 'horizontal' = a horizontal bar between vertical panels (drag up/down).
  orientation: 'vertical' | 'horizontal';
}

export default function ResizeHandle({ orientation }: ResizeHandleProps) {
  const sizing = orientation === 'vertical' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize';
  return (
    <PanelResizeHandle
      className={`${sizing} bg-transparent hover:bg-blue-200 data-[resize-handle-state=drag]:bg-blue-300 transition-colors`}
    />
  );
}
