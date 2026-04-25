import { describe, it, expect, vi } from 'vitest';
import { translateSdkMessage, type SdkMessageLike } from '../sdk-message-translator';

describe('agent-sdk/sdk-message-translator', () => {
  it('passes through system init', () => {
    const msg: SdkMessageLike = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
      cwd: '/x',
      tools: [],
      mcp_servers: [],
      model: 'claude-x',
      permissionMode: 'default',
      apiKeySource: 'env',
    };
    const out = translateSdkMessage(msg);
    expect(out).toBeTruthy();
    expect((out as { type?: string }).type).toBe('system');
    expect((out as { subtype?: string }).subtype).toBe('init');
    expect((out as { session_id?: string }).session_id).toBe('abc-123');
  });

  it('passes through compact_boundary', () => {
    const msg: SdkMessageLike = { type: 'system', subtype: 'compact_boundary', session_id: 's' };
    expect(translateSdkMessage(msg)).toBeTruthy();
  });

  it('passes through api_retry', () => {
    const msg: SdkMessageLike = { type: 'system', subtype: 'api_retry', session_id: 's' };
    expect(translateSdkMessage(msg)).toBeTruthy();
  });

  it('passes through assistant', () => {
    const msg: SdkMessageLike = {
      type: 'assistant',
      session_id: 's',
      message: { role: 'assistant', content: [] },
    };
    expect((translateSdkMessage(msg) as { type?: string }).type).toBe('assistant');
  });

  it('passes through user', () => {
    const msg: SdkMessageLike = {
      type: 'user',
      session_id: 's',
      message: { role: 'user', content: 'hi' },
    };
    expect((translateSdkMessage(msg) as { type?: string }).type).toBe('user');
  });

  it('passes through result', () => {
    const msg: SdkMessageLike = {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      duration_ms: 1,
    };
    expect((translateSdkMessage(msg) as { type?: string }).type).toBe('result');
  });

  it('passes through stream_event partial frames', () => {
    const msg: SdkMessageLike = {
      type: 'stream_event',
      session_id: 's',
      event: { type: 'content_block_delta' },
    };
    expect(translateSdkMessage(msg)).not.toBeNull();
  });

  it('drops unknown system subtypes silently', () => {
    const msg: SdkMessageLike = { type: 'system', subtype: 'status', session_id: 's' };
    expect(translateSdkMessage(msg)).toBeNull();
  });

  it.each([
    'status',
    'hook_started',
    'hook_progress',
    'hook_response',
    'tool_progress',
    'tool_use_summary',
    'auth_status',
    'memory_recall',
    'rate_limit',
    'elicitation_complete',
    'prompt_suggestion',
    'plugin_install',
    'mirror_error',
    'files_persisted',
    'session_state_changed',
    'notification',
    'local_command_output',
  ])('drops SDK-only message %s', (type) => {
    expect(translateSdkMessage({ type })).toBeNull();
  });

  it('drops unknown types and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(translateSdkMessage({ type: 'totally_made_up' })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
