import { describe, expect, it } from 'vitest';

import {
  MOBILE_REMOTE_PROTOCOL_VERSION,
  parseMirrorClientMessage,
  parseMirrorServerMessage,
} from '../../src/shared/mobileRemote';

describe('mobile mirror protocol', () => {
  it('uses protocol version 3', () => {
    expect(MOBILE_REMOTE_PROTOCOL_VERSION).toBe(3);
  });

  it('accepts the small mirror command set', () => {
    expect(parseMirrorClientMessage('{"type":"mirror.start"}')).toEqual({
      type: 'mirror.start',
    });
    expect(parseMirrorClientMessage('{"type":"mirror.stop"}')).toEqual({
      type: 'mirror.stop',
    });
    expect(parseMirrorClientMessage('{"type":"mirror.tap","x":0.25,"y":1}')).toEqual({
      type: 'mirror.tap',
      x: 0.25,
      y: 1,
    });
    expect(parseMirrorClientMessage('{"type":"mirror.text","text":"hello"}')).toEqual({
      type: 'mirror.text',
      text: 'hello',
    });
    expect(parseMirrorClientMessage('{"type":"mirror.key","key":"Ctrl+C"}')).toEqual({
      type: 'mirror.key',
      key: 'Ctrl+C',
    });
    expect(parseMirrorClientMessage('{"type":"mirror.scroll","deltaY":900}')).toEqual({
      type: 'mirror.scroll',
      deltaY: 800,
    });
  });

  it('rejects malformed and out-of-range commands', () => {
    expect(parseMirrorClientMessage('not json')).toBeNull();
    expect(parseMirrorClientMessage('{"type":"mirror.tap","x":-0.1,"y":0.5}')).toBeNull();
    expect(parseMirrorClientMessage('{"type":"mirror.tap","x":0.5,"y":1.1}')).toBeNull();
    expect(
      parseMirrorClientMessage(
        JSON.stringify({ type: 'mirror.text', text: 'x'.repeat(32_769) }),
      ),
    ).toBeNull();
    expect(parseMirrorClientMessage('{"type":"mirror.key","key":"Delete"}')).toBeNull();
    expect(parseMirrorClientMessage('{"type":"sessions.list"}')).toBeNull();
  });

  it('validates mirror frames and errors', () => {
    expect(
      parseMirrorServerMessage(
        '{"type":"mirror.frame","jpegBase64":"abc","width":1152,"height":720}',
      ),
    ).toEqual({
      type: 'mirror.frame',
      jpegBase64: 'abc',
      width: 1152,
      height: 720,
    });
    expect(parseMirrorServerMessage('{"type":"mirror.error","message":"frame_too_large"}')).toEqual({
      type: 'mirror.error',
      message: 'frame_too_large',
    });
    expect(
      parseMirrorServerMessage(
        '{"type":"mirror.frame","jpegBase64":"abc","width":0,"height":720}',
      ),
    ).toBeNull();
  });
});
