// Tiny line-level diff renderer for Edit/Write/MultiEdit tool calls.
// Not a real Myers diff — for the typical small edits the CLI does, this
// "split into removed lines + added lines + render side-by-side" view is
// good enough and matches what people expect to see in the chat.

export interface DiffSpec {
  filePath: string;
  hunks: Array<{
    removed: string[];
    added: string[];
  }>;
}

export function diffFromEditInput(input: unknown): DiffSpec | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const filePath = typeof o.file_path === 'string' ? o.file_path : '';
  const oldStr = typeof o.old_string === 'string' ? o.old_string : '';
  const newStr = typeof o.new_string === 'string' ? o.new_string : '';
  if (!filePath || (!oldStr && !newStr)) return null;
  return {
    filePath,
    hunks: [
      {
        removed: oldStr ? oldStr.split('\n') : [],
        added: newStr ? newStr.split('\n') : []
      }
    ]
  };
}

export function diffFromWriteInput(input: unknown): DiffSpec | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const filePath = typeof o.file_path === 'string' ? o.file_path : '';
  const content = typeof o.content === 'string' ? o.content : '';
  if (!filePath) return null;
  return {
    filePath,
    hunks: [
      {
        removed: [],
        added: content ? content.split('\n') : []
      }
    ]
  };
}

export function diffFromMultiEditInput(input: unknown): DiffSpec | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const filePath = typeof o.file_path === 'string' ? o.file_path : '';
  const edits = Array.isArray(o.edits) ? o.edits : [];
  if (!filePath || edits.length === 0) return null;
  const hunks: DiffSpec['hunks'] = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    const er = e as Record<string, unknown>;
    const oldStr = typeof er.old_string === 'string' ? er.old_string : '';
    const newStr = typeof er.new_string === 'string' ? er.new_string : '';
    hunks.push({
      removed: oldStr ? oldStr.split('\n') : [],
      added: newStr ? newStr.split('\n') : []
    });
  }
  return { filePath, hunks };
}

export function diffFromToolInput(name: string, input: unknown): DiffSpec | null {
  switch (name) {
    case 'Edit':
      return diffFromEditInput(input);
    case 'Write':
      return diffFromWriteInput(input);
    case 'MultiEdit':
      return diffFromMultiEditInput(input);
    default:
      return null;
  }
}
