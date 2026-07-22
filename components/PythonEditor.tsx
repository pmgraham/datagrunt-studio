'use client';

import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';

interface PythonEditorProps {
  value: string;
}

export default function PythonEditor({ value }: PythonEditorProps) {
  return (
    <CodeMirror
      value={value}
      readOnly
      theme="light"
      extensions={[python()]}
      basicSetup={{
        lineNumbers: true,
        bracketMatching: true,
        highlightActiveLine: false,
        autocompletion: false,
        foldGutter: false,
      }}
      className="text-xs h-full"
    />
  );
}
