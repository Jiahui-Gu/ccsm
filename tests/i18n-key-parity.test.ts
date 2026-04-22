// en/zh catalog key parity. The English catalog is the source of truth;
// every nested key path that exists in en MUST exist in zh, and vice
// versa. If this test fails, the diff in the assertion message tells
// you exactly which keys are missing on which side — fix the catalog
// before merging.
import { describe, it, expect } from 'vitest';
import en from '../src/i18n/locales/en';
import zh from '../src/i18n/locales/zh';

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatten(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('i18n catalog parity', () => {
  it('en and zh expose the same key set', () => {
    const enKeys = flatten(en);
    const zhKeys = flatten(zh);
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    expect({ missingInZh, missingInEn }).toEqual({ missingInZh: [], missingInEn: [] });
  });

  it('every leaf value is a non-empty string', () => {
    for (const [name, catalog] of [['en', en] as const, ['zh', zh] as const]) {
      const walk = (node: unknown, path: string): void => {
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            walk(v, path ? `${path}.${k}` : k);
          }
          return;
        }
        if (typeof node !== 'string' || node.length === 0) {
          throw new Error(`[${name}] empty or non-string at ${path}: ${String(node)}`);
        }
      };
      walk(catalog, '');
    }
  });
});
