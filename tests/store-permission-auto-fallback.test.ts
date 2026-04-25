// `auto` mode is research-preview and gated on the user's account/model.
// When the SDK rejects (`{ ok: false }`), the store must roll the picker
// back to `default` and surface a toast — not silently leave the UI in a
// broken state. This test pins the fallback contract.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...initial, startedSessions: {} }, true);
  // Reset window globals between tests so a previous case can't leak the
  // toast double or the IPC stub into the next one.
  delete (window as unknown as { ccsm?: unknown }).ccsm;
  delete (window as unknown as { __ccsmToast?: unknown }).__ccsmToast;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setStartedSession(id: string) {
  useStore.setState({ startedSessions: { [id]: true } });
}

describe('setPermission(auto) fallback', () => {
  it('falls back to default and pushes an error toast when the SDK returns ok:false', async () => {
    const setPermissionMode = vi.fn().mockResolvedValue({ ok: false, error: 'unsupported_mode' });
    (window as unknown as { ccsm: { agentSetPermissionMode: typeof setPermissionMode } }).ccsm = {
      agentSetPermissionMode: setPermissionMode,
    } as never;
    const push = vi.fn();
    (window as unknown as { __ccsmToast: { push: typeof push } }).__ccsmToast = { push };

    setStartedSession('s1');
    useStore.getState().setPermission('auto');
    // Optimistic UI: the picker flips to `auto` immediately.
    expect(useStore.getState().permission).toBe('auto');
    // Wait for the IPC promise to resolve and the fallback to land.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().permission).toBe('default');
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].kind).toBe('error');
  });

  it('keeps auto when the SDK accepts (ok:true)', async () => {
    const setPermissionMode = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { ccsm: { agentSetPermissionMode: typeof setPermissionMode } }).ccsm = {
      agentSetPermissionMode: setPermissionMode,
    } as never;
    const push = vi.fn();
    (window as unknown as { __ccsmToast: { push: typeof push } }).__ccsmToast = { push };

    setStartedSession('s1');
    useStore.getState().setPermission('auto');
    expect(useStore.getState().permission).toBe('auto');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().permission).toBe('auto');
    expect(push).not.toHaveBeenCalled();
  });

  it('non-auto modes use the legacy fire-and-forget path (no awaiting, no toast)', async () => {
    const setPermissionMode = vi.fn().mockResolvedValue({ ok: false, error: 'whatever' });
    (window as unknown as { ccsm: { agentSetPermissionMode: typeof setPermissionMode } }).ccsm = {
      agentSetPermissionMode: setPermissionMode,
    } as never;
    const push = vi.fn();
    (window as unknown as { __ccsmToast: { push: typeof push } }).__ccsmToast = { push };

    setStartedSession('s1');
    useStore.getState().setPermission('plan');
    await new Promise((r) => setTimeout(r, 0));
    expect(useStore.getState().permission).toBe('plan');
    expect(push).not.toHaveBeenCalled();
    // IPC was still invoked exactly once for the started session.
    expect(setPermissionMode).toHaveBeenCalledWith('s1', 'plan');
  });
});
