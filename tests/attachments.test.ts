/**
 * Unit tests for the attachments plumbing — size / MIME filtering + Anthropic
 * content-block assembly. DB round-trip is covered indirectly via db.test.ts
 * (which stringifies whatever MessageBlock it's handed).
 */

import { describe, expect, it } from 'vitest';
import {
  buildUserContentBlocks,
  intakeFile,
  intakeFiles,
  isSupportedImageType,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  type FileLike
} from '../src/lib/attachments';

function fakeFile(opts: {
  name?: string;
  size?: number;
  type?: string;
  bytes?: Uint8Array;
}): FileLike {
  const bytes = opts.bytes ?? new Uint8Array(opts.size ?? 4);
  return {
    name: opts.name ?? 'test.png',
    size: opts.size ?? bytes.byteLength,
    type: opts.type ?? 'image/png',
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      )
  };
}

describe('isSupportedImageType', () => {
  it('accepts all four Anthropic media types', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isSupportedImageType(t)).toBe(true);
    }
  });
  it('rejects others', () => {
    for (const t of ['image/bmp', 'image/svg+xml', 'application/pdf', 'text/plain', '']) {
      expect(isSupportedImageType(t)).toBe(false);
    }
  });
});

describe('intakeFile', () => {
  it('rejects unsupported MIME with a helpful message', async () => {
    const r = await intakeFile(fakeFile({ type: 'image/bmp', name: 'x.bmp' }));
    expect('kind' in r && r.kind).toBe('unsupported-type');
  });

  it('rejects oversize files', async () => {
    const r = await intakeFile(fakeFile({ size: MAX_IMAGE_BYTES + 1, type: 'image/png' }));
    expect('kind' in r && r.kind).toBe('too-large');
  });

  it('base64-encodes accepted files and strips the data-URL prefix', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
    const r = await intakeFile(fakeFile({ bytes, size: 4, type: 'image/png', name: 'p.png' }));
    expect('kind' in r).toBe(false);
    if ('kind' in r) return;
    expect(r.mediaType).toBe('image/png');
    expect(r.size).toBe(4);
    expect(r.name).toBe('p.png');
    // Plain base64, no "data:...;base64," prefix:
    expect(r.data.startsWith('data:')).toBe(false);
    // And it should decode back to the original bytes via atob (available in
    // vitest's jsdom env).
    const decoded = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([137, 80, 78, 71]);
  });
});

describe('intakeFiles', () => {
  it('enforces MAX_IMAGES_PER_MESSAGE across existing + batch', async () => {
    const files = Array.from({ length: 3 }, (_, i) =>
      fakeFile({ name: `f${i}.png`, bytes: new Uint8Array([1, 2, 3]) })
    );
    const { accepted, rejected } = await intakeFiles(files, MAX_IMAGES_PER_MESSAGE - 1);
    expect(accepted.length).toBe(1); // only 1 slot left
    expect(rejected.length).toBe(2);
    expect(rejected.every((r) => r.kind === 'over-limit')).toBe(true);
  });

  it('partitions accepted / rejected independently', async () => {
    const files = [
      fakeFile({ name: 'ok.png', type: 'image/png' }),
      fakeFile({ name: 'bad.bmp', type: 'image/bmp' })
    ];
    const { accepted, rejected } = await intakeFiles(files, 0);
    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].kind).toBe('unsupported-type');
  });
});

describe('buildUserContentBlocks', () => {
  const img = {
    id: 'a1',
    name: 'x.png',
    mediaType: 'image/png' as const,
    data: 'AAAA',
    size: 3
  };

  it('builds image-then-text blocks when both are present', () => {
    const blocks = buildUserContentBlocks('describe this', [img]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
    });
    expect(blocks[1]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('allows image-only turns (no text)', () => {
    const blocks = buildUserContentBlocks('', [img]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image' });
  });

  it('allows text-only (returns one text block, no empty image block)', () => {
    const blocks = buildUserContentBlocks('hello', []);
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('trims text but preserves internal whitespace', () => {
    const blocks = buildUserContentBlocks('  hello  world  ', []);
    expect(blocks).toEqual([{ type: 'text', text: 'hello  world' }]);
  });

  it('drops pure-whitespace text to empty array when no images', () => {
    const blocks = buildUserContentBlocks('   \n  ', []);
    expect(blocks).toEqual([]);
  });

  it('preserves ordering across multiple images', () => {
    const img2 = { ...img, id: 'a2', data: 'BBBB' };
    const blocks = buildUserContentBlocks('two', [img, img2]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ source: { data: 'AAAA' } });
    expect(blocks[1]).toMatchObject({ source: { data: 'BBBB' } });
    expect(blocks[2]).toEqual({ type: 'text', text: 'two' });
  });
});

describe('DB JSON round-trip (via JSON.stringify/parse)', () => {
  it('preserves image attachments through serialize/deserialize', () => {
    const block = {
      kind: 'user' as const,
      id: 'u1',
      text: 'whats this?',
      images: [
        { id: 'a1', name: 'p.png', mediaType: 'image/png' as const, data: 'AAAA', size: 3 }
      ]
    };
    const round = JSON.parse(JSON.stringify(block));
    expect(round).toEqual(block);
  });
});
