'use client';

import CodeMirror from '@uiw/react-codemirror';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { keymap, EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { formatSql } from '@/lib/sql-format';
import { useEffect, useMemo, useRef } from 'react';

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  schema: Record<string, string[]>;
  onSelectionChange?: (selectedText: string) => void;
}

export default function SqlEditor({ value, onChange, onRun, schema, onSelectionChange }: SqlEditorProps) {
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
    return () => {
      onSelectionChange?.('');
    };
  }, [onSelectionChange]);

  const extensions = useMemo(() => {
    const run = () => {
      onRunRef.current();
      return true;
    };

    const format = (view: EditorView) => {
      const formatted = formatSql(view.state.doc.toString());
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } });
      return true;
    };

    return [
      sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true }),
      Prec.highest(
        // eslint-disable-next-line react-hooks/refs
        keymap.of([
          { key: 'Mod-Enter', run },
          { key: 'Shift-Enter', run },
          { key: 'Mod-Shift-f', run: format },
        ]),
      ),
      EditorView.lineWrapping,
      // eslint-disable-next-line react-hooks/refs
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const { from, to } = update.state.selection.main;
          onSelectionChangeRef.current?.(update.state.sliceDoc(from, to));
        }
      }),
    ];
  }, [schema]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="100%"
      theme="light"
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        bracketMatching: true,
        highlightActiveLine: true,
        autocompletion: true,
        foldGutter: false,
      }}
      className="text-xs h-full"
    />
  );
}
