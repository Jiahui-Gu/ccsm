import { describe, it, expect } from 'vitest';
import { PartialAssistantStreamer, sdkMessageToTranslation } from '../src/agent/sdk-to-blocks';

const asPartial = <T>(x: T) => x as unknown as Parameters<PartialAssistantStreamer['consume']>[0];

function startEvent(messageId: string) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: messageId } }
  });
}
function startBlock(index: number) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }
  });
}
function deltaEvent(index: number, text: string) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }
  });
}
function stopBlock(index: number) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'content_block_stop', index }
  });
}

describe('PartialAssistantStreamer', () => {
  it('returns null until message_start arrives', () => {
    const s = new PartialAssistantStreamer();
    // A delta arriving before message_start has no message id to anchor to.
    expect(s.consume(deltaEvent(0, 'Hi'))).toBeNull();
  });

  it('emits one patch per text_delta keyed by message.id + content index', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    s.consume(startBlock(0));
    expect(s.consume(deltaEvent(0, 'Hel'))).toEqual({
      blockId: 'msg-X:c0',
      appendText: 'Hel',
      done: false
    });
    expect(s.consume(deltaEvent(0, 'lo'))).toEqual({
      blockId: 'msg-X:c0',
      appendText: 'lo',
      done: false
    });
  });

  it('marks done on content_block_stop', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    s.consume(startBlock(0));
    s.consume(deltaEvent(0, 'Hi'));
    expect(s.consume(stopBlock(0))).toEqual({
      blockId: 'msg-X:c0',
      appendText: '',
      done: true
    });
  });

  it('ignores non-text deltas (input_json, thinking, signature)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(
      s.consume(
        asPartial({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"x"' }
          }
        })
      )
    ).toBeNull();
  });

  it('uses content index, not text-only index, so tool_use at index 0 still puts text at index 1', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-Y'));
    // index 0 is a tool_use (no text deltas); text appears at index 1
    s.consume(startBlock(1));
    const patch = s.consume(deltaEvent(1, 'Reply'));
    expect(patch?.blockId).toBe('msg-Y:c1');
  });

  it('clears state on message_stop and refuses subsequent deltas', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    s.consume({ type: 'stream_event', event: { type: 'message_stop' } } as never);
    expect(s.consume(deltaEvent(0, 'leak'))).toBeNull();
  });

  it('finalized assistant message id matches the streamed block id (so they coalesce)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-Z'));
    const partial = s.consume(deltaEvent(0, 'Hi'));
    const final = sdkMessageToTranslation({
      type: 'assistant',
      uuid: 'sdk-uuid-Z',
      message: { id: 'msg-Z', content: [{ type: 'text', text: 'Hi there' }] }
    } as never);
    expect(partial?.blockId).toBe(
      (final.append[0] as { id: string }).id,
      'streaming block id and finalized assistant block id must match'
    );
  });
});
