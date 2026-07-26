/**
 * Inline-markdown tokenizer for PDF-extracted text.
 *
 * The content is attacker-influenced — it comes from whatever PDF the user
 * was sent. A regex is not safe here even with bounded character classes:
 * `[^\]]*` still backtracks character-by-character whenever its terminator
 * never appears, and text like `![x![x![x...` (no `]` anywhere) creates one
 * failed, full-length backtrack at every one of its ~n restart points — an
 * O(n^2) blowup that froze the tab just like the original nested-lazy
 * pattern did.
 *
 * This is a hand-written, single-pass scanner instead. The only lookups it
 * needs — "where is the next `]`, `)`, `*`, or backtick from here?" — are
 * answered from tables built once up front (`buildNextIndexTable`), so every
 * step of the scan is O(1) and nothing is ever rescanned. That makes the
 * whole tokenizer O(n) regardless of input shape, provably: there is no
 * regex engine underneath to backtrack.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'image'; alt: string; src: string }
  | { kind: 'strong'; value: string }
  | { kind: 'em'; value: string }
  | { kind: 'code'; value: string };

/**
 * `table[i]` is the index of the next occurrence of `char` at or after
 * position `i`, or -1 if `char` does not appear again. Built once in O(n);
 * every later lookup is then O(1), which is what keeps the scanner linear —
 * repeating `text.indexOf(char, i)` at every candidate position would redo
 * the same scan-to-the-end work at each one, reintroducing the O(n^2) this
 * replaces.
 */
function buildNextIndexTable(text: string, char: string): Int32Array {
  const table = new Int32Array(text.length + 1);
  table[text.length] = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    table[i] = text[i] === char ? i : table[i + 1];
  }
  return table;
}

export function tokenizeInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const nextBracket = buildNextIndexTable(text, ']');
  const nextParen = buildNextIndexTable(text, ')');
  const nextStar = buildNextIndexTable(text, '*');
  const nextBacktick = buildNextIndexTable(text, '`');

  let cursor = 0;
  let i = 0;

  const flushTextBefore = (end: number) => {
    if (end > cursor) tokens.push({ kind: 'text', value: text.slice(cursor, end) });
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '!' && text[i + 1] === '[') {
      const altStart = i + 2;
      const bracketAt = nextBracket[altStart];
      if (bracketAt !== -1 && text[bracketAt + 1] === '(') {
        const srcStart = bracketAt + 2;
        const parenAt = nextParen[srcStart];
        if (parenAt !== -1) {
          flushTextBefore(i);
          tokens.push({ kind: 'image', alt: text.slice(altStart, bracketAt), src: text.slice(srcStart, parenAt) });
          cursor = parenAt + 1;
          i = cursor;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (ch === '*' && text[i + 1] === '*') {
      const contentStart = i + 2;
      const starAt = nextStar[contentStart];
      if (starAt !== -1 && starAt > contentStart && text[starAt + 1] === '*') {
        flushTextBefore(i);
        tokens.push({ kind: 'strong', value: text.slice(contentStart, starAt) });
        cursor = starAt + 2;
        i = cursor;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '*') {
      const contentStart = i + 1;
      const starAt = nextStar[contentStart];
      if (starAt !== -1 && starAt > contentStart) {
        flushTextBefore(i);
        tokens.push({ kind: 'em', value: text.slice(contentStart, starAt) });
        cursor = starAt + 1;
        i = cursor;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '`') {
      const contentStart = i + 1;
      const backtickAt = nextBacktick[contentStart];
      if (backtickAt !== -1 && backtickAt > contentStart) {
        flushTextBefore(i);
        tokens.push({ kind: 'code', value: text.slice(contentStart, backtickAt) });
        cursor = backtickAt + 1;
        i = cursor;
        continue;
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  flushTextBefore(text.length);
  return tokens;
}
