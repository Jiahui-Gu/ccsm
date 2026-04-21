import { describe, it, expect } from 'vitest';
import {
  buildFileTree,
  countNodes,
  parseFileToolResult,
  parseGlobResult,
  parseLsResult
} from '../src/utils/file-tree';

describe('parseGlobResult', () => {
  it('splits newline-separated paths and trims blanks', () => {
    const text = '/a/b/c.ts\n/a/b/d.ts\n\n/a/e.ts\n';
    expect(parseGlobResult(text)).toEqual(['/a/b/c.ts', '/a/b/d.ts', '/a/e.ts']);
  });

  it('drops NOTE banner lines', () => {
    const text = 'NOTE: showing first 100 results\n/x/y.ts';
    expect(parseGlobResult(text)).toEqual(['/x/y.ts']);
  });
});

describe('parseLsResult', () => {
  it('parses indented ASCII tree into absolute paths', () => {
    const text = [
      '- /root/proj/',
      '  - file.ts',
      '  - sub/',
      '    - inner.ts'
    ].join('\n');
    const out = parseLsResult(text);
    expect(out).toContain('/root/proj');
    expect(out).toContain('/root/proj/file.ts');
    expect(out).toContain('/root/proj/sub');
    expect(out).toContain('/root/proj/sub/inner.ts');
  });
});

describe('parseFileToolResult', () => {
  it('detects LS-style input', () => {
    expect(parseFileToolResult('- /r/\n  - a.ts')).toEqual(['/r', '/r/a.ts']);
  });
  it('detects Glob-style input', () => {
    expect(parseFileToolResult('/a.ts\n/b.ts')).toEqual(['/a.ts', '/b.ts']);
  });
  it('returns empty for empty', () => {
    expect(parseFileToolResult('')).toEqual([]);
  });
});

describe('buildFileTree', () => {
  it('nests files under shared parents', () => {
    const tree = buildFileTree(['/a/b/c.ts', '/a/b/d.ts', '/a/e.ts']);
    expect(tree).toHaveLength(1);
    const a = tree[0];
    expect(a.name).toBe('a');
    expect(a.isDir).toBe(true);
    expect(a.children).toHaveLength(2);
    // dir b sorts before file e
    expect(a.children[0].name).toBe('b');
    expect(a.children[0].isDir).toBe(true);
    expect(a.children[1].name).toBe('e.ts');
    expect(a.children[1].isDir).toBe(false);
    expect(a.children[0].children.map((c) => c.name)).toEqual(['c.ts', 'd.ts']);
  });

  it('handles Windows-style paths', () => {
    const tree = buildFileTree(['C:\\proj\\src\\a.ts', 'C:\\proj\\src\\b.ts']);
    // top-level should be the drive segment, then proj, then src
    const drive = tree[0];
    expect(drive.name).toBe('C:');
    expect(drive.children[0].name).toBe('proj');
    expect(drive.children[0].children[0].name).toBe('src');
    expect(drive.children[0].children[0].children.map((c) => c.name)).toEqual([
      'a.ts',
      'b.ts'
    ]);
  });

  it('sorts directories before files alphabetically', () => {
    const tree = buildFileTree(['/r/zfile.ts', '/r/afile.ts', '/r/zdir/x.ts']);
    const r = tree[0];
    expect(r.children.map((c) => c.name)).toEqual(['zdir', 'afile.ts', 'zfile.ts']);
  });

  it('treats trailing-slash paths as directories', () => {
    const tree = buildFileTree(['/r/empty/', '/r/file.ts']);
    const r = tree[0];
    const empty = r.children.find((c) => c.name === 'empty');
    expect(empty?.isDir).toBe(true);
  });

  it('returns empty forest for empty input', () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe('countNodes', () => {
  it('counts every node recursively', () => {
    const tree = buildFileTree(['/a/b.ts', '/a/c.ts']);
    // a (dir) + b.ts + c.ts = 3
    expect(countNodes(tree)).toBe(3);
  });
});
