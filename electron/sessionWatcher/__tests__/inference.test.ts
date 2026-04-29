// Pure inference tests. No fs/process — just JSONL strings → classified state.
import { describe, it, expect } from 'vitest';
import {
  classifyJsonlText,
  classifyFrames,
  countUserFrames,
  classifyAndCount,
  type WatcherState,
} from '../inference';

// Helper: build a minimal assistant frame.
function assistantFrame(opts: {
  stopReason: string | null;
  toolUseIds?: string[];
  text?: string;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  for (const id of opts.toolUseIds ?? []) {
    content.push({ type: 'tool_use', id, name: 'Bash', input: {} });
  }
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content,
      stop_reason: opts.stopReason,
      stop_sequence: null,
    },
  };
}

function userTextFrame(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function userToolResultFrame(toolUseId: string): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  };
}

function permissionModeFrame(mode = 'plan'): Record<string, unknown> {
  return { type: 'permission-mode', mode };
}

function toJsonl(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
}

describe('sessionWatcher inference', () => {
  it('classifies end_turn assistant frame as idle', () => {
    const text = toJsonl([
      userTextFrame('hi'),
      assistantFrame({ stopReason: 'end_turn', text: 'hello' }),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('idle');
  });

  it('classifies stop_sequence assistant frame as idle', () => {
    const text = toJsonl([
      assistantFrame({ stopReason: 'stop_sequence', text: 'done' }),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('idle');
  });

  it('classifies unmatched tool_use as running', () => {
    // Assistant emitted a tool_use but the tool_result hasn't landed yet.
    const text = toJsonl([
      userTextFrame('run a thing'),
      assistantFrame({
        stopReason: 'tool_use',
        toolUseIds: ['tool_a'],
        text: 'calling',
      }),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('running');
  });

  it('classifies tool_use followed by matching tool_result + end_turn as idle', () => {
    const text = toJsonl([
      userTextFrame('run a thing'),
      assistantFrame({
        stopReason: 'tool_use',
        toolUseIds: ['tool_a'],
      }),
      userToolResultFrame('tool_a'),
      assistantFrame({ stopReason: 'end_turn', text: 'all done' }),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('idle');
  });

  it('classifies trailing user text frame (typed input, no assistant yet) as running', () => {
    const text = toJsonl([
      assistantFrame({ stopReason: 'end_turn', text: 'previous turn' }),
      userTextFrame('new question'),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('running');
  });

  it('classifies trailing permission-mode frame as requires_action', () => {
    const text = toJsonl([
      userTextFrame('do dangerous thing'),
      assistantFrame({
        stopReason: 'tool_use',
        toolUseIds: ['tool_b'],
      }),
      permissionModeFrame('plan'),
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('requires_action');
  });

  it('tolerates a mid-line garbage trailing line', () => {
    // Simulates fs.watch firing before the writer flushed the trailing
    // newline — last "frame" is half a JSON object.
    const goodPart = toJsonl([
      userTextFrame('hi'),
      assistantFrame({ stopReason: 'end_turn', text: 'hello' }),
    ]);
    const broken = goodPart + '{"type":"assist'; // no newline, partial
    expect(classifyJsonlText(broken)).toBe<WatcherState>('idle');
  });

  it('returns running for empty input (file exists but no frames yet)', () => {
    expect(classifyJsonlText('')).toBe<WatcherState>('running');
    expect(classifyFrames([])).toBe<WatcherState>('running');
  });

  it('handles multiple unmatched tool_use blocks (still running)', () => {
    const text = toJsonl([
      assistantFrame({
        stopReason: 'tool_use',
        toolUseIds: ['t1', 't2', 't3'],
      }),
      userToolResultFrame('t1'),
      // t2 and t3 still outstanding
    ]);
    expect(classifyJsonlText(text)).toBe<WatcherState>('running');
  });
});

describe('countUserFrames (notify arm-gate)', () => {
  it('counts a single user(text) frame', () => {
    const c = countUserFrames([userTextFrame('hi')]);
    expect(c.userTextFrames).toBe(1);
    expect(c.userToolResultFrames).toBe(0);
  });

  it('counts multiple user(text) frames', () => {
    const c = countUserFrames([
      userTextFrame('one'),
      assistantFrame({ stopReason: 'end_turn', text: 'a' }),
      userTextFrame('two'),
      assistantFrame({ stopReason: 'end_turn', text: 'b' }),
      userTextFrame('three'),
    ]);
    expect(c.userTextFrames).toBe(3);
    expect(c.userToolResultFrames).toBe(0);
  });

  it('counts user(tool_result) frames separately from text', () => {
    const c = countUserFrames([
      userTextFrame('do thing'),
      assistantFrame({ stopReason: 'tool_use', toolUseIds: ['t1'] }),
      userToolResultFrame('t1'),
    ]);
    expect(c.userTextFrames).toBe(1);
    expect(c.userToolResultFrames).toBe(1);
  });

  it('returns zeros for an empty / non-array input', () => {
    expect(countUserFrames([])).toEqual({ userTextFrames: 0, userToolResultFrames: 0 });
    // @ts-expect-error — defensive runtime guard
    expect(countUserFrames(null)).toEqual({ userTextFrames: 0, userToolResultFrames: 0 });
  });

  it('mixed transcript: assistant + user(text) + user(tool_result)', () => {
    const c = countUserFrames([
      userTextFrame('hi'),
      assistantFrame({ stopReason: 'tool_use', toolUseIds: ['t1', 't2'] }),
      userToolResultFrame('t1'),
      userToolResultFrame('t2'),
      assistantFrame({ stopReason: 'end_turn', text: 'done' }),
      userTextFrame('again'),
    ]);
    expect(c.userTextFrames).toBe(2);
    expect(c.userToolResultFrames).toBe(2);
  });

  it('classifyAndCount returns combined state + counts in one pass', () => {
    const text = toJsonl([
      userTextFrame('hi'),
      assistantFrame({ stopReason: 'end_turn', text: 'hello' }),
    ]);
    const r = classifyAndCount(text);
    expect(r.state).toBe<WatcherState>('idle');
    expect(r.userTextFrames).toBe(1);
    expect(r.userToolResultFrames).toBe(0);
  });
});
