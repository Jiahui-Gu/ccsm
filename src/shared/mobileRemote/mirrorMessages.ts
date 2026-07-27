export const MIRROR_TEXT_MAX_LENGTH = 32_768;

export const MIRROR_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Ctrl+C',
] as const;

export type MirrorKey = (typeof MIRROR_KEYS)[number];

export type MirrorClientMessage =
  | { type: 'mirror.start' }
  | { type: 'mirror.stop' }
  | { type: 'mirror.tap'; x: number; y: number }
  | { type: 'mirror.text'; text: string }
  | { type: 'mirror.key'; key: MirrorKey }
  | { type: 'mirror.scroll'; deltaY: number };

export type MirrorServerMessage =
  | {
      type: 'mirror.frame';
      jpegBase64: string;
      width: number;
      height: number;
    }
  | { type: 'mirror.error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseMirrorClientMessage(raw: string): MirrorClientMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'mirror.start' || value.type === 'mirror.stop') {
    return hasOnlyKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'mirror.tap') {
    if (
      !hasOnlyKeys(value, ['type', 'x', 'y']) ||
      typeof value.x !== 'number' ||
      typeof value.y !== 'number' ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1
    ) {
      return null;
    }
    return { type: value.type, x: value.x, y: value.y };
  }
  if (value.type === 'mirror.text') {
    if (
      !hasOnlyKeys(value, ['type', 'text']) ||
      typeof value.text !== 'string' ||
      value.text.length > MIRROR_TEXT_MAX_LENGTH
    ) {
      return null;
    }
    return { type: value.type, text: value.text };
  }
  if (value.type === 'mirror.key') {
    if (
      !hasOnlyKeys(value, ['type', 'key']) ||
      typeof value.key !== 'string' ||
      !(MIRROR_KEYS as readonly string[]).includes(value.key)
    ) {
      return null;
    }
    return { type: value.type, key: value.key as MirrorKey };
  }
  if (value.type === 'mirror.scroll') {
    if (
      !hasOnlyKeys(value, ['type', 'deltaY']) ||
      typeof value.deltaY !== 'number' ||
      !Number.isFinite(value.deltaY)
    ) {
      return null;
    }
    return { type: value.type, deltaY: Math.max(-800, Math.min(800, value.deltaY)) };
  }
  return null;
}

export function parseMirrorServerMessage(raw: string): MirrorServerMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'mirror.frame') {
    if (
      !hasOnlyKeys(value, ['type', 'jpegBase64', 'width', 'height']) ||
      typeof value.jpegBase64 !== 'string' ||
      !Number.isInteger(value.width) ||
      !Number.isInteger(value.height) ||
      (value.width as number) < 1 ||
      (value.height as number) < 1
    ) {
      return null;
    }
    return {
      type: value.type,
      jpegBase64: value.jpegBase64,
      width: value.width as number,
      height: value.height as number,
    };
  }
  if (
    value.type === 'mirror.error' &&
    hasOnlyKeys(value, ['type', 'message']) &&
    typeof value.message === 'string'
  ) {
    return { type: value.type, message: value.message };
  }
  return null;
}
