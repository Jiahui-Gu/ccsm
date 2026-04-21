import type { QuestionSpec } from '../types';

// AskUserQuestion tool input shape → question spec list. Shared between the
// stream translator (tool_use path) and lifecycle (can_use_tool path). Returns
// [] on malformed input so callers can decide to fall back to a generic tool
// block / permission prompt.
export function parseQuestions(input: unknown): QuestionSpec[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: QuestionSpec[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const obj = q as Record<string, unknown>;
    const question = typeof obj.question === 'string' ? obj.question : '';
    if (!question) continue;
    const options = Array.isArray(obj.options)
      ? obj.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined
          }))
          .filter((o) => o.label)
      : [];
    if (options.length === 0) continue;
    out.push({
      question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options
    });
  }
  return out;
}
