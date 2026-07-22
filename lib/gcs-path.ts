const KNOWN_EXPORT_EXTENSIONS = /\.(csv|parquet|json)$/i;

// Keep a user-edited destination path in sync with the chosen export format:
// swap a known extension, append when missing, leave folder prefixes alone.
export function withFormatExtension(path: string, format: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.endsWith('/')) return trimmed;
  return `${trimmed.replace(KNOWN_EXPORT_EXTENSIONS, '')}.${format}`;
}
