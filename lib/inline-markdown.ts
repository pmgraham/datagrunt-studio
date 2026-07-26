/**
 * Inline-markdown tokenizer for PDF-extracted text.
 *
 * The content is attacker-influenced — it comes from whatever PDF the user
 * was sent — so every pattern here is bounded by character classes that
 * cannot cross their own delimiter. The previous `.*?` pairs made input like
 * `![](](](…` quadratic, which froze the tab and took the unsaved editor
 * buffer with it.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'strong'; value: string }
  | { kind: 'em'; value: string }
  | { kind: 'code'; value: string };

const PATTERN = /!\[([^\]]*)\]\(([^)]*)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(text); m !== null; m = PATTERN.exec(text)) {
    if (m.index > cursor) {
      tokens.push({ kind: 'text', value: text.slice(cursor, m.index) });
    }

    const [, alt, src, strong, em, code] = m;
    if (src !== undefined) tokens.push({ kind: 'image', alt: alt ?? '', src });
    else if (strong !== undefined) tokens.push({ kind: 'strong', value: strong });
    else if (em !== undefined) tokens.push({ kind: 'em', value: em });
    else tokens.push({ kind: 'code', value: code });

    cursor = m.index + m[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: 'text', value: text.slice(cursor) });
  }
  return tokens;
}
