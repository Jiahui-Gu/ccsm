import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useStore } from '../src/stores/store';
import { subscribeAgentEvents } from '../src/agent/lifecycle';

// Covers the renderer-side rule-4 carve-out in `subscribeAgentEvents`:
// when the window is unfocused and a session goes idle, the row MUST flash
// (state='waiting') even if it is the currently active right-view sid. The
// store action's active-session suppression would otherwise silence rule 4.
//
// We don't `vi.resetModules()` because zustand stores are module-singletons
// — a fresh import would write to a different store than the test reads.
// Instead we install a fake bridge once, drive synthetic events through it,
// and rely on the unsubscribe handle to clear the install guard between
// tests.

import type { SessionState } from '../src/shared/sessionState';

type Listener = (e: { sid: string; state: SessionState }) => void;

let fire: Listener = () => undefined;

function installFakeBridge(): void {
  let cb: Listener | null = null;
  (window as unknown as { ccsmSession: unknown }).ccsmSession = {
    onState: (handler: Listener) => {
      cb = handler;
      return () => {
        cb = null;
      };
    },
  };
  fire = (e) => cb?.(e);
}

function setHasFocus(v: boolean): void {
  Object.defineProperty(document, 'hasFocus', {
    value: () => v,
    configurable: true,
  });
}

function seedActive(sid: string) {
  useStore.setState({
    sessions: [
      { id: sid, name: 'x', cwd: '', state: 'idle', agentType: 'claude-code', groupId: 'g' } as never,
    ],
    activeId: sid,
  });
}

describe('subscribeAgentEvents — rule-4 unfocused-active bypass', () => {
  let off: (() => void) | null = null;

  beforeEach(() => {
    installFakeBridge();
    off = subscribeAgentEvents();
  });

  afterEach(() => {
    off?.();
    off = null;
  });

  it('foreground + active sid + idle → suppressed (state stays idle)', () => {
    setHasFocus(true);
    seedActive('s-active');
    fire({ sid: 's-active', state: 'idle' });
    expect(useStore.getState().sessions[0].state).toBe('idle');
  });

  it('foreground + non-active sid + idle → goes to waiting (rule 3)', () => {
    setHasFocus(true);
    useStore.setState({
      sessions: [
        { id: 's-bystander', name: 'b', cwd: '', state: 'idle', agentType: 'claude-code', groupId: 'g' } as never,
      ],
      activeId: 's-other',
    });
    fire({ sid: 's-bystander', state: 'idle' });
    expect(useStore.getState().sessions[0].state).toBe('waiting');
  });

  it('unfocused + active sid + idle → goes to waiting (rule 4 carve-out)', () => {
    setHasFocus(false);
    seedActive('s-active');
    fire({ sid: 's-active', state: 'idle' });
    expect(useStore.getState().sessions[0].state).toBe('waiting');
  });

  it('unfocused + active sid + running → stays idle (running is not attention)', () => {
    setHasFocus(false);
    seedActive('s-active');
    fire({ sid: 's-active', state: 'running' });
    expect(useStore.getState().sessions[0].state).toBe('idle');
  });

  it('unfocused + active sid + requires_action → goes to waiting', () => {
    setHasFocus(false);
    seedActive('s-active');
    fire({ sid: 's-active', state: 'requires_action' });
    expect(useStore.getState().sessions[0].state).toBe('waiting');
  });

  it('multi-sid: each sid flashes independently when unfocused', () => {
    setHasFocus(false);
    useStore.setState({
      sessions: [
        { id: 's-A', name: 'a', cwd: '', state: 'idle', agentType: 'claude-code', groupId: 'g' } as never,
        { id: 's-B', name: 'b', cwd: '', state: 'idle', agentType: 'claude-code', groupId: 'g' } as never,
      ],
      activeId: 's-A',
    });
    fire({ sid: 's-A', state: 'idle' });
    fire({ sid: 's-B', state: 'idle' });
    const sess = useStore.getState().sessions;
    expect(sess.find((s) => s.id === 's-A')?.state).toBe('waiting');
    expect(sess.find((s) => s.id === 's-B')?.state).toBe('waiting');
  });
});
