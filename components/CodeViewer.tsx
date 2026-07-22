'use client';

import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';

interface CodeViewerProps {
  value: string;
  language: 'sql' | 'python' | 'json';
}

export default function CodeViewer({ value, language }: CodeViewerProps) {
  const extensions = [];
  if (language === 'python') {
    extensions.push(python());
  } else if (language === 'sql') {
    extensions.push(sql({ dialect: PostgreSQL }));
  } else if (language === 'json') {
    extensions.push(json());
  }

  return (
    <CodeMirror
      value={value}
      readOnly
      theme="light"
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        bracketMatching: true,
        highlightActiveLine: false,
        autocompletion: false,
        foldGutter: language === 'json',
      }}
      className="text-xs h-full"
    />
  );
}
