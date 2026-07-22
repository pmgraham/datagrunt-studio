export interface SchemaDataset {
  table?: string;
  name: string;
  columns: { name: string }[];
}

// Build the CodeMirror SQL autocomplete schema (DuckDB table name -> column names)
// from the loaded datasets. Datasets without a backing table are skipped.
export function datasetsToSchema(datasets: SchemaDataset[]): Record<string, string[]> {
  const schema: Record<string, string[]> = {};
  for (const ds of datasets) {
    if (!ds.table) continue;
    schema[ds.table] = ds.columns.map((c) => c.name);
  }
  return schema;
}
