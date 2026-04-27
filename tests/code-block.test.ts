import { describe, it, expect } from 'vitest';
import { languageFromPath } from '../src/components/CodeBlock';

describe('languageFromPath', () => {
  it('maps common extensions via alias table', () => {
    expect(languageFromPath('src/foo.ts')).toBe('tsx');
    expect(languageFromPath('src/foo.tsx')).toBe('tsx');
    expect(languageFromPath('a/b.js')).toBe('jsx');
    expect(languageFromPath('script.py')).toBe('python');
    expect(languageFromPath('Cargo.toml')).toBe('toml');
    expect(languageFromPath('run.sh')).toBe('bash');
  });

  it('falls back to text when no extension', () => {
    expect(languageFromPath('Makefile')).toBe('text');
    expect(languageFromPath('README')).toBe('text');
  });

  it('handles windows paths', () => {
    expect(languageFromPath('C:\\a\\b\\c.rs')).toBe('rust');
  });
});
