// Sentence-aware truncation for toast body lines.
//
// Order of operations:
//   1. Strip markdown chrome (backticks, square brackets around link text,
//      leading blockquote markers).
//   2. Collapse all whitespace runs (newlines included) to a single space.
//   3. If the cleaned text fits in maxChars, return as-is.
//   4. Otherwise prefer a sentence boundary inside the budget. Fall back to
//      hard char count + ellipsis.
//
// Char counts use code-point length (`[...str].length`) so a single emoji
// counts as 1, matching what the user perceives in the toast UI.

export interface TruncateResult {
  text: string;
  wasTruncated: boolean;
}

const SENTENCE_BOUNDARIES = ['. ', '。', '! ', '? ', '！', '？'];
const ELLIPSIS = '…';

/** Public char-count helper — code points, not UTF-16 units. */
export function codePointLength(s: string): number {
  return [...s].length;
}

function stripMarkdownChrome(input: string): string {
  let s = input;
  // Drop leading blockquote markers and surrounding whitespace per line.
  s = s.replace(/^[ \t]*>+[ \t]?/gm, '');
  // Strip backticks (inline code or code fences) — keep the inner text.
  s = s.replace(/`+/g, '');
  // Markdown links: [label](url) -> label
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Bare bracket pairs around plain text: [foo] -> foo
  s = s.replace(/\[([^\]]+)\]/g, '$1');
  return s;
}

function collapseWhitespace(s: string): string {
  // Includes newlines, tabs, and runs of regular spaces.
  return s.replace(/\s+/g, ' ').trim();
}

/** Slice a string by code-point count (not UTF-16 units). */
function sliceCodePoints(s: string, maxChars: number): string {
  const points = [...s];
  if (points.length <= maxChars) return s;
  return points.slice(0, maxChars).join('');
}

/**
 * Truncate `text` to fit within `maxChars` code points. Prefers sentence
 * boundaries; falls back to char count + ellipsis. The returned text is
 * guaranteed to be at most `maxChars` code points.
 */
export function truncate(text: string, maxChars: number): TruncateResult {
  if (maxChars <= 0) {
    return { text: '', wasTruncated: text.length > 0 };
  }
  const cleaned = collapseWhitespace(stripMarkdownChrome(text));
  const cleanedLen = codePointLength(cleaned);

  if (cleanedLen <= maxChars) {
    return { text: cleaned, wasTruncated: false };
  }

  // Find the latest sentence boundary that ends within the budget. Reserve
  // no extra room for an ellipsis when ending at a real sentence — the
  // boundary itself is a clean stopping point.
  let bestEnd = -1;
  for (const sep of SENTENCE_BOUNDARIES) {
    // Search for boundaries whose punctuation char fits inside maxChars.
    // We walk through every occurrence to find the latest valid one.
    let from = 0;
    while (from < cleaned.length) {
      const idx = cleaned.indexOf(sep, from);
      if (idx === -1) break;
      // The boundary includes the punctuation char; cut after it.
      const cutEnd = idx + sep.trimEnd().length;
      const slice = cleaned.slice(0, cutEnd);
      if (codePointLength(slice) <= maxChars) {
        if (cutEnd > bestEnd) bestEnd = cutEnd;
      } else {
        break;
      }
      from = idx + sep.length;
    }
  }

  if (bestEnd > 0) {
    return { text: cleaned.slice(0, bestEnd), wasTruncated: true };
  }

  // Hard fallback: code-point slice with ellipsis. Reserve 1 code point for
  // the ellipsis itself.
  const budget = Math.max(0, maxChars - 1);
  const head = sliceCodePoints(cleaned, budget);
  return { text: head + ELLIPSIS, wasTruncated: true };
}
