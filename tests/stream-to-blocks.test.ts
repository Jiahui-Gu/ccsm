import { describe, it, expect } from 'vitest';
import {
  PartialAssistantStreamer,
  streamEventToTranslation,
  extractPartialBashCommand
} from '../src/agent/stream-to-blocks';

const asEvent = <T>(x: T) => x as unknown as Parameters<typeof streamEventToTranslation>[0];
const asPartial = <T>(x: T) => x as unknown as Parameters<PartialAssistantStreamer['consume']>[0];

describe('streamEventToTranslation', () => {
  it('drops user echoes (avoids dup with InputBar local echo)', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's1',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      })
    );
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([]);
  });

  it('drops system init frames (no banner)', () => {
    const out = streamEventToTranslation(
      asEvent({ type: 'system', subtype: 'init', session_id: 's1' })
    );
    expect(out).toEqual({ append: [], toolResults: [] });
  });

  it('compact_boundary system message becomes an info status banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'sys-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 124000, post_tokens: 18000, duration_ms: 950 }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; tone: string; title: string; detail?: string };
    expect(b.kind).toBe('status');
    expect(b.tone).toBe('info');
    expect(b.title).toMatch(/auto-compacted/i);
    expect(b.detail).toContain('124,000');
    expect(b.detail).toContain('18,000');
  });

  it('api_retry system message becomes a warn status banner with attempt + delay', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'system',
        subtype: 'api_retry',
        uuid: 'sys-2',
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 4000,
        error_status: 503
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { tone: string; title: string; detail?: string };
    expect(b.tone).toBe('warn');
    expect(b.title).toContain('2/5');
    expect(b.detail).toContain('4s');
    expect(b.detail).toContain('503');
  });

  it('translates assistant text into one assistant block', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-1',
        message: { id: 'm-id-1', role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] }
      })
    );
    expect(out.append).toEqual([{ kind: 'assistant', id: 'm-id-1:c0', text: 'Sure.' }]);
  });

  it('assistant message with rate_limit error appends a rate-limit warn banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'asst-1',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        error: 'rate_limit'
      })
    );
    expect(out.append).toHaveLength(2);
    expect(out.append[1]).toMatchObject({ kind: 'status', tone: 'warn', title: 'Rate limit hit' });
  });

  it('assistant message with arbitrary error code emits a generic error banner', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'asst-2',
        message: { id: 'm', role: 'assistant', content: [] },
        error: 'authentication_failed'
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({
      kind: 'status',
      tone: 'warn',
      title: 'Authentication failed'
    });
  });

  it('translates tool_use into a tool block carrying toolUseId, name, brief', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-2',
        message: {
          id: 'm-id-2',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: '/a/b/c.ts' } }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({
      kind: 'tool',
      toolUseId: 'toolu_001',
      name: 'Read',
      brief: '/a/b/c.ts',
      expanded: false
    });
  });

  it('AskUserQuestion tool_use is suppressed (the can_use_tool path renders the question)', () => {
    // Bug A+B fix (2026-04-23): every tool — including AskUserQuestion — is
    // intercepted by the can_use_tool control RPC, which drives the
    // permission/question render via lifecycle.permissionRequestToWaitingBlock.
    // If we ALSO emitted a question block from the assistant tool_use, two
    // cards would render for one logical question and the second card's
    // submit would bypass agentResolvePermission, hanging claude.exe.
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-q',
        message: {
          id: 'm-q',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-q1',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Pick a stack',
                    header: 'Stack',
                    multiSelect: false,
                    options: [
                      { label: 'TypeScript', description: 'types first' },
                      { label: 'Rust' }
                    ]
                  }
                ]
              }
            }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(0);
  });

  it('AskUserQuestion with malformed input falls back to a generic tool block', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-q2',
        message: {
          id: 'm-q2',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-q2',
              name: 'AskUserQuestion',
              input: { questions: 'not an array' }
            }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; name?: string };
    expect(b.kind).toBe('tool');
    expect(b.name).toBe('AskUserQuestion');
  });

  it('TodoWrite tool_use becomes a todo block (not generic tool)', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-todo',
        message: {
          id: 'm-todo',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Write tests', status: 'completed' },
                  { content: 'Implement', status: 'in_progress', activeForm: 'Implementing' }
                ]
              }
            }
          ]
        }
      })
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; todos?: Array<{ status: string; activeForm?: string }> };
    expect(b.kind).toBe('todo');
    expect(b.todos).toHaveLength(2);
    expect(b.todos![1].activeForm).toBe('Implementing');
  });

  it('extracts tool_result patches from user messages without appending blocks', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_001',
              content: [{ type: 'text', text: 'file contents here' }]
            }
          ]
        }
      })
    );
    expect(out.append).toEqual([]);
    expect(out.toolResults).toEqual([
      { toolUseId: 'toolu_001', result: 'file contents here', isError: false }
    ]);
  });

  it('flags is_error on tool_result patches with plain string content', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_002',
              content: 'permission denied',
              is_error: true
            }
          ]
        }
      })
    );
    expect(out.toolResults).toEqual([
      { toolUseId: 'toolu_002', result: 'permission denied', isError: true }
    ]);
  });

  it('joins multi-part text tool_result content', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_003',
              content: [
                { type: 'text', text: 'line one' },
                { type: 'text', text: 'line two' }
              ]
            }
          ]
        }
      })
    );
    expect(out.toolResults[0].result).toBe('line one\nline two');
  });

  it('successful result emits no blocks (done banner suppressed)', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        uuid: 'res-1',
        num_turns: 3,
        duration_ms: 12500,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 4500, output_tokens: 1200, cache_read_input_tokens: 8000 }
      })
    );
    expect(out.append).toHaveLength(0);
    expect(out.toolResults).toHaveLength(0);
  });

  it('failed (abnormal end) result emits an error block', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        session_id: 's',
        uuid: 'res-err'
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({ kind: 'error' });
  });

  it('error_during_execution with interrupted context becomes a neutral Interrupted status', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 's',
        uuid: 'res-int'
      }),
      { interrupted: true }
    );
    expect(out.append).toHaveLength(1);
    const b = out.append[0] as { kind: string; tone?: string; title?: string };
    expect(b.kind).toBe('status');
    expect(b.tone).toBe('info');
    expect(b.title).toBe('Interrupted');
  });

  it('error_during_execution without interrupt context still renders as error', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 's',
        uuid: 'res-err2'
      })
    );
    expect(out.append).toHaveLength(1);
    expect(out.append[0]).toMatchObject({ kind: 'error' });
  });

  it('successful result ignores interrupted context (no demotion path taken)', () => {
    // Post-#71: per-turn "Done" status banner is intentionally suppressed.
    // The interrupted context must not change that — successful results
    // still emit no banner regardless of the interrupted flag.
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        uuid: 'res-ok',
        num_turns: 1,
        duration_ms: 500
      }),
      { interrupted: true }
    );
    expect(out.append).toHaveLength(0);
  });

  it('returns empty translation for unknown frame types', () => {
    const out = streamEventToTranslation(asEvent({ type: 'agent_metadata', agent_id: 'a' }));
    expect(out).toEqual({ append: [], toolResults: [] });
  });
});

function startEvent(messageId: string) {
  return asPartial({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: messageId } }
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

describe('extractPartialBashCommand (#336)', () => {
  it('returns null when no command key is present yet', () => {
    expect(extractPartialBashCommand('{"description":"x"')).toBeNull();
  });
  it('returns the in-flight command string mid-stream', () => {
    expect(extractPartialBashCommand('{"command":"npm ru')).toBe('npm ru');
  });
  it('handles description-then-command order', () => {
    expect(extractPartialBashCommand('{"description":"y","command":"ls -la')).toBe('ls -la');
  });
  it('decodes common JSON escapes (\\" and \\n)', () => {
    expect(extractPartialBashCommand('{"command":"echo \\"hi\\"')).toBe('echo "hi"');
    expect(extractPartialBashCommand('{"command":"a\\nb')).toBe('a\nb');
  });
  it('stops at the closing quote of the command string', () => {
    expect(extractPartialBashCommand('{"command":"ls","x":1}')).toBe('ls');
  });
});

describe('PartialAssistantStreamer (stream-json)', () => {
  it('emits one patch per text_delta keyed by message.id + content index', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(s.consume(deltaEvent(0, 'Hel'))).toEqual({
      kind: 'text',
      blockId: 'msg-X:c0',
      appendText: 'Hel',
      done: false
    });
    expect(s.consume(deltaEvent(0, 'lo'))).toEqual({
      kind: 'text',
      blockId: 'msg-X:c0',
      appendText: 'lo',
      done: false
    });
  });

  it('marks done on content_block_stop', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    expect(s.consume(stopBlock(0))).toEqual({
      kind: 'text',
      blockId: 'msg-X:c0',
      appendText: '',
      done: true
    });
  });

  it('returns null for deltas before message_start', () => {
    const s = new PartialAssistantStreamer();
    expect(s.consume(deltaEvent(0, 'leak'))).toBeNull();
  });

  it('clears state on message_stop and ignores subsequent deltas', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-X'));
    s.consume(asPartial({ type: 'stream_event', event: { type: 'message_stop' } }));
    expect(s.consume(deltaEvent(0, 'leak'))).toBeNull();
  });

  it('streamed block id matches the finalized assistant block id (so they coalesce)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-Z'));
    const partial = s.consume(deltaEvent(0, 'Hi'));
    const final = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'sdk-uuid-Z',
        message: { id: 'msg-Z', role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] }
      })
    );
    expect(partial?.kind).toBe('text');
    expect(partial?.kind === 'text' && partial.blockId).toBe(
      (final.append[0] as { id: string }).id
    );
  });

  it('ignores input_json_delta when no tool_use content block has started', () => {
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

  // (#336) Bash input streaming: progressively surface the `command` arg as
  // the model types the tool_use input JSON.
  it('streams Bash command preview from input_json_delta chunks', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-B'));
    s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu-bash-1', name: 'Bash' }
        }
      })
    );
    const inputDelta = (chunk: string) =>
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: chunk }
        }
      });
    expect(s.consume(inputDelta('{"command":"npm '))).toEqual({
      kind: 'bash-input',
      toolBlockId: 'msg-B:tu-bash-1',
      toolUseId: 'tu-bash-1',
      bashPartialCommand: 'npm ',
      done: false
    });
    expect(s.consume(inputDelta('run '))).toEqual({
      kind: 'bash-input',
      toolBlockId: 'msg-B:tu-bash-1',
      toolUseId: 'tu-bash-1',
      bashPartialCommand: 'npm run ',
      done: false
    });
    expect(s.consume(inputDelta('build"}'))).toEqual({
      kind: 'bash-input',
      toolBlockId: 'msg-B:tu-bash-1',
      toolUseId: 'tu-bash-1',
      bashPartialCommand: 'npm run build',
      done: false
    });
    // content_block_stop emits a final done patch so the renderer can flip
    // the typing flag off pre-emptively.
    expect(s.consume(stopBlock(1))).toEqual({
      kind: 'bash-input',
      toolBlockId: 'msg-B:tu-bash-1',
      toolUseId: 'tu-bash-1',
      bashPartialCommand: 'npm run build',
      done: true
    });
  });

  it('Bash placeholder id matches the finalized tool block id (coalesces in store)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-B2'));
    s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu-x', name: 'Bash' }
        }
      })
    );
    const partial = s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' }
        }
      })
    );
    const final = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'u',
        message: {
          id: 'msg-B2',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-x', name: 'Bash', input: { command: 'ls' } }]
        }
      })
    );
    expect(partial?.kind).toBe('bash-input');
    expect(partial?.kind === 'bash-input' && partial.toolBlockId).toBe(
      (final.append[0] as { id: string }).id
    );
  });

  it('does not stream input for non-Bash tools (Read, Edit, etc.)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-R'));
    s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu-r', name: 'Read' }
        }
      })
    );
    const out = s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/x"' }
        }
      })
    );
    expect(out).toBeNull();
  });

  it('dedupes no-op Bash input deltas (description typed before command)', () => {
    const s = new PartialAssistantStreamer();
    s.consume(startEvent('msg-D'));
    s.consume(
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu-d', name: 'Bash' }
        }
      })
    );
    const inputDelta = (chunk: string) =>
      asPartial({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: chunk }
        }
      });
    // Description streams first; no `command` field yet.
    expect(s.consume(inputDelta('{"description":"in'))).toBeNull();
    expect(s.consume(inputDelta('stall"'))).toBeNull();
    // Now command starts.
    expect(s.consume(inputDelta(',"command":"ls"}'))?.kind).toBe('bash-input');
  });
});

describe('streamEventToTranslation — Skill provenance (#318)', () => {
  it('Skill tool_use sets nextActiveSkill so the next assistant text block is tagged', () => {
    // First event: assistant invokes the Skill tool. There is no text in the
    // same event yet — the skill output lands in a SUBSEQUENT assistant
    // event after the tool_result echoes back.
    const skillEvt = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-skill',
        message: {
          id: 'm-skill',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-skill', name: 'Skill', input: { skill: 'using-superpowers' } }
          ]
        }
      })
    );
    expect(skillEvt.nextActiveSkill).toEqual({
      name: 'using-superpowers',
      path: '~/.claude/skills/using-superpowers/SKILL.md'
    });
    // The Skill tool_use itself should still render as a tool block — the
    // user can see the invocation. The badge is purely about the text turn
    // that FOLLOWS the skill.
    expect(skillEvt.append.find((b) => b.kind === 'tool' && b.name === 'Skill')).toBeTruthy();

    // Second event: assistant text generated WHILE the skill is active.
    // Caller (lifecycle.ts) threads activeSkill from the first event into
    // the ctx for the second.
    const textEvt = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-after',
        message: {
          id: 'm-after',
          role: 'assistant',
          content: [{ type: 'text', text: 'Doing the skill thing.' }]
        }
      }),
      { activeSkill: skillEvt.nextActiveSkill ?? null }
    );
    expect(textEvt.append).toHaveLength(1);
    const a = textEvt.append[0] as { kind: string; viaSkill?: { name: string; path?: string } };
    expect(a.kind).toBe('assistant');
    expect(a.viaSkill).toEqual({
      name: 'using-superpowers',
      path: '~/.claude/skills/using-superpowers/SKILL.md'
    });
  });

  it('plugin-namespaced skill name produces a plugins/<plugin>/skills path', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-plug',
        message: {
          id: 'm-plug',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-p', name: 'Skill', input: { skill: 'pua:p7' } }
          ]
        }
      })
    );
    expect(out.nextActiveSkill).toEqual({
      name: 'pua:p7',
      path: '~/.claude/plugins/pua/skills/p7/SKILL.md'
    });
  });

  it('result frame clears the active skill so the next turn does not inherit it', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        uuid: 'r1'
      }),
      { activeSkill: { name: 'using-superpowers' } }
    );
    expect(out.nextActiveSkill).toBeNull();
  });

  it('assistant text without an active skill is not stamped', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-plain',
        message: {
          id: 'm-plain',
          role: 'assistant',
          content: [{ type: 'text', text: 'Plain reply.' }]
        }
      })
    );
    const a = out.append[0] as { kind: string; viaSkill?: unknown };
    expect(a.kind).toBe('assistant');
    expect(a.viaSkill).toBeUndefined();
  });

  it('Skill tool_use with malformed input (no string `skill`) does not set provenance', () => {
    const out = streamEventToTranslation(
      asEvent({
        type: 'assistant',
        session_id: 's',
        uuid: 'msg-bad-skill',
        message: {
          id: 'm-bs',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-bs', name: 'Skill', input: { not_skill: true } }
          ]
        }
      })
    );
    expect(out.nextActiveSkill).toBeUndefined();
  });
});
