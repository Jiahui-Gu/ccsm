import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Task #673 / Wave-2 T6: Sidebar reads runtime + api from RuntimeProvider
// context (was a module singleton pre-T6). Mock the context module so unit
// tests can assert the attach/detach contract + intercept fetch through
// our own bound api stub, without standing up a real <RuntimeProvider>.
const HttpErrorMock = vi.hoisted(() => {
  return class HttpErrorMock extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'HttpError';
    }
  };
});

// fetchUrl + apiStub + runtimeStub are referenced from the vi.mock factory
// below; vi.mock hoists to top of file so all referenced values must be
// declared via vi.hoisted() to be evaluated first.
const fetchUrl = vi.hoisted(() => (path: string) => {
  const base =
    typeof window !== 'undefined' && window.location
      ? window.location.origin
      : '';
  return `${base}${path}`;
});

const apiStub = vi.hoisted(() => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listSessions: vi.fn(),
  resumeSession: vi.fn(),
}));

const runtimeStub = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  has: vi.fn(() => false),
  get: vi.fn<
    (sid: string) =>
      | { reconnectAttempts: number; hasEverAttached: boolean }
      | undefined
  >(() => undefined),
  sendInput: vi.fn(),
  sendResize: vi.fn(),
  notePendingWrite: vi.fn(),
  noteWriteFlushed: vi.fn(),
  subscribeOutput: vi.fn(() => () => {}),
}));

// Aliases for tests that already reference these names.
const runtimeAttach = runtimeStub.attach;
const runtimeDetach = runtimeStub.detach;
const runtimeGet = runtimeStub.get;

vi.mock('../src/runtime-context', () => ({
  useRuntime: () => runtimeStub,
  useApi: () => apiStub,
  useGetToken: () => () => 'test-token',
  HttpError: HttpErrorMock,
}));

import { Sidebar } from '../src/components/Sidebar';
import { useStore } from '../src/store';

// Reset zustand store between tests so session list bleed-through doesn't
// false-positive the multi-session assertions. zustand has no built-in
// reset, so we re-set the slices we care about explicitly.
function resetStore(): void {
  useStore.setState({
    token: 'test-token',
    sessions: [],
    activeSid: null,
    status: 'idle',
    sessionStatuses: {},
  });
}

describe('Sidebar', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetStore();
    runtimeAttach.mockClear();
    runtimeDetach.mockClear();
    runtimeGet.mockReset();
    runtimeGet.mockReturnValue(undefined);
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    // Default fetch mock — individual tests override as needed.
    globalThis.fetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ sid: 'unused' }),
        text: async () => '',
      }) as unknown as Response,
    ) as unknown as typeof fetch;
    // Wire api stubs to call globalThis.fetch with the same URL shape the
    // real @ccsm/core wrappers produce (baseUrl prefix is the jsdom origin;
    // tests assert with toContain so the prefix is harmless).
    apiStub.createSession.mockReset();
    apiStub.createSession.mockImplementation(async (token: string) => {
      const res = await globalThis.fetch(fetchUrl('/api/sessions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new HttpErrorMock(res.status, 'create failed');
      return res.json();
    });
    apiStub.deleteSession.mockReset();
    apiStub.deleteSession.mockImplementation(
      async (token: string, sid: string) => {
        const res = await globalThis.fetch(
          fetchUrl(`/api/sessions/${sid}`),
          {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (res.status === 404) return { ok: true };
        if (!res.ok) throw new HttpErrorMock(res.status, 'delete failed');
        return res.json();
      },
    );
    apiStub.listSessions.mockReset();
    apiStub.listSessions.mockImplementation(async (token: string) => {
      const res = await globalThis.fetch(fetchUrl('/api/sessions'), {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new HttpErrorMock(res.status, 'list failed');
      return res.json();
    });
    apiStub.resumeSession.mockReset();
    apiStub.resumeSession.mockImplementation(
      async (token: string, sid: string) => {
        const res = await globalThis.fetch(
          fetchUrl(`/api/sessions/${sid}/resume`),
          {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) throw new HttpErrorMock(res.status, 'resume failed');
        return { ok: true };
      },
    );
  });

  afterEach(() => {
    alertSpy.mockRestore();
    cleanup();
  });

  it('renders all six placeholder testids', () => {
    render(<Sidebar />);
    for (const id of [
      'sidebar-new-session',
      'sidebar-search',
      'sidebar-groups',
      'sidebar-archived',
      'sidebar-settings',
      'sidebar-import',
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
  });

  // Task #28 / R-12 / R-16: smoke spec (s3-happy-path) probes
  // data-testid="session-list" BEFORE creating any session, so the testid
  // must live on a stable wrapper that exists in BOTH empty and populated
  // states. R-12 originally put the testid on the <ul>, which only renders
  // when sessions.length > 0 — that broke smoke (Task #41 root cause).
  // Lock the contract so this can't regress silently.
  it('exposes data-testid="session-list" on a stable wrapper when sessions are populated', () => {
    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
    });
    render(<Sidebar />);
    const wrapper = screen.getByTestId('session-list');
    expect(wrapper).toBeDefined();
    // The <ul> with the actual session rows must be inside the wrapper.
    expect(wrapper.querySelector('ul.sidebar__session-list')).not.toBeNull();
  });

  it('exposes data-testid="session-list" even when sessions is empty (R-16 contract)', () => {
    // Default store state has sessions=[] — must still find the testid.
    render(<Sidebar />);
    const wrapper = screen.getByTestId('session-list');
    expect(wrapper).toBeDefined();
    // Empty-state hint lives inside the wrapper.
    expect(wrapper.textContent).toMatch(/No sessions yet/);
  });

  it('shows the empty-state hint inside the GROUPS zone when sessions is empty', () => {
    render(<Sidebar />);
    expect(
      screen.getByText(/No sessions yet — click \+ New Session above/),
    ).toBeDefined();
  });

  it('placeholder buttons (search/settings/import + GROUPS [+]) still surface alert and do not crash', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-search'));
    fireEvent.click(screen.getByTestId('sidebar-settings'));
    fireEvent.click(screen.getByTestId('sidebar-import'));
    // GROUPS [+] is the unnamed second button in the groups header — find by
    // aria-label to avoid coupling to DOM structure.
    fireEvent.click(screen.getByLabelText('Add group'));
    expect(alertSpy).toHaveBeenCalled();
  });

  it('toggles archived expanded state', () => {
    render(<Sidebar />);
    const toggle = screen.getByTestId('sidebar-archived');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/no archived groups/)).toBeDefined();
  });

  // ---- T9 additions ----

  it('renders one row per session under the default group, with the active row marked *', () => {
    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: new Date(2026, 0, 1, 10, 31).getTime(), alive: true },
        { sid: 'bbbb2222', createdAt: new Date(2026, 0, 1, 10, 42).getTime(), alive: true },
      ],
      activeSid: 'bbbb2222',
    });

    render(<Sidebar />);

    // Both rows present
    expect(screen.getByTestId('sidebar-session-aaaa1111')).toBeDefined();
    expect(screen.getByTestId('sidebar-session-bbbb2222')).toBeDefined();

    // Active marker
    const activeRow = screen.getByTestId('sidebar-session-bbbb2222');
    expect(activeRow.getAttribute('data-active')).toBe('true');
    const inactiveRow = screen.getByTestId('sidebar-session-aaaa1111');
    expect(inactiveRow.getAttribute('data-active')).toBe('false');

    // Short sid + HH:MM formatting visible
    expect(activeRow.textContent).toContain('bbbb');
    expect(activeRow.textContent).toContain('10:42');
    expect(inactiveRow.textContent).toContain('aaaa');
    expect(inactiveRow.textContent).toContain('10:31');
  });

  it('clicking a session row whose ws is already attached calls store.setActive directly (no resume POST)', () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached', bbbb2222: 'attached' },
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    expect(useStore.getState().activeSid).toBe('bbbb2222');
    expect(fetchMock).not.toHaveBeenCalled();
    // Fast path must NOT touch the runtime — there's a live entry already.
    expect(runtimeAttach).not.toHaveBeenCalled();
    expect(runtimeDetach).not.toHaveBeenCalled();
  });

  // Task #673: a stale `connecting` status (ws bouncing off close(1008)
  // after a daemon restart on a previously-attached entry, evidenced by
  // hasEverAttached=true) MUST NOT take the fast path. The user click has
  // to drive a /resume so the daemon re-spawns.
  it('clicking a session row whose entry hasEverAttached=true but status=connecting (truly stale across daemon restart) POSTs /resume + detach+attach', async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    runtimeGet.mockImplementation((sid: string) =>
      sid === 'bbbb2222'
        ? { reconnectAttempts: 2, hasEverAttached: true }
        : undefined,
    );
    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached', bbbb2222: 'connecting' },
    });

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/api/sessions/bbbb2222/resume',
    );
    // detach must precede attach so a stale entry can't shortcut openWs.
    expect(runtimeDetach).toHaveBeenCalledWith('bbbb2222');
    expect(runtimeAttach).toHaveBeenCalledWith('bbbb2222', 'test-token');
    const detachOrder = runtimeDetach.mock.invocationCallOrder[0]!;
    const attachOrder = runtimeAttach.mock.invocationCallOrder[0]!;
    expect(detachOrder).toBeLessThan(attachOrder);
    expect(useStore.getState().activeSid).toBe('bbbb2222');
  });

  // Task #673 P0 regression: an entry that has never been attached
  // (hasEverAttached=false), regardless of reconnectAttempts (which can
  // already be > 0 because ws.onclose increments it synchronously before
  // the retry timer fires, e.g. mock daemon refusing ws upgrade), MUST
  // take the fast path. Otherwise immediately clicking a row right after
  // createSession 200 would issue an extraneous /resume that the backend
  // may not handle, and the click never lands.
  it('clicking a session row whose entry hasEverAttached=false (fresh, never confirmed live) takes fast path even if reconnectAttempts>0', () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    runtimeGet.mockImplementation((sid: string) =>
      sid === 'bbbb2222'
        ? { reconnectAttempts: 1, hasEverAttached: false }
        : undefined,
    );
    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached', bbbb2222: 'connecting' },
    });

    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));

    expect(useStore.getState().activeSid).toBe('bbbb2222');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtimeAttach).not.toHaveBeenCalled();
    expect(runtimeDetach).not.toHaveBeenCalled();
  });

  // Task #673 P1 #2: double-click on the same sid while a resume is in
  // flight must not issue a second /resume + open a second ws.
  it('double-click on the same sid while resume is in flight only fires one /resume', async () => {
    let resolveFirst!: (r: Response) => void;
    const firstResp = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    const fetchMock = vi.fn(() => firstResp);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached' /* bbbb2222: undefined */ },
    });

    render(<Sidebar />);
    // First click — starts the resume; pendingResumeRef = 'bbbb2222'.
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    // Second click on the same sid while resume is still in flight.
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the in-flight resume resolve to drain the act() bookkeeping.
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Only one detach+attach pair, even though we clicked twice.
    expect(runtimeDetach).toHaveBeenCalledTimes(1);
    expect(runtimeAttach).toHaveBeenCalledTimes(1);
  });

  it('clicking the × close button issues DELETE then prunes the row', async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
    });

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-close-aaaa1111'));
    });
    // Flush the fetch promise chain.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/api/sessions/aaaa1111');
    expect((calledInit as RequestInit).method).toBe('DELETE');

    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['bbbb2222']);
    // Active sid rotated to the surviving row (closeSession contract).
    expect(state.activeSid).toBe('bbbb2222');
  });

  it('+ New Session button POSTs /api/sessions and adds the returned sid as active', async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ sid: 'new-sid-xyz', createdAt: 1700000000000 }),
        text: async () => '',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-new-session'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toMatch(/\/api\/sessions$/);
    expect((calledInit as RequestInit).method).toBe('POST');

    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['new-sid-xyz']);
    expect(state.activeSid).toBe('new-sid-xyz');
    // Task #673: attach must fire AFTER createSession 200 so the ws upgrade
    // finds a daemon RuntimeRegistry entry (no close(1008) race).
    expect(runtimeAttach).toHaveBeenCalledWith('new-sid-xyz', 'test-token');
  });

  // ---- T11 / #671: lazy resume on row click ----

  it('clicking an idle session row POSTs /resume then setActive', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain('/api/sessions/bbbb2222/resume');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer test-token');
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached' },
    });

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().activeSid).toBe('bbbb2222');
    // Task #673: idempotent attach can't reopen a stale entry, so we must
    // detach BEFORE attach to force a fresh ws against the freshly-spawned
    // daemon-side PTY.
    expect(runtimeDetach).toHaveBeenCalledWith('bbbb2222');
    expect(runtimeAttach).toHaveBeenCalledWith('bbbb2222', 'test-token');
    const detachOrder = runtimeDetach.mock.invocationCallOrder[0]!;
    const attachOrder = runtimeAttach.mock.invocationCallOrder[0]!;
    expect(detachOrder).toBeLessThan(attachOrder);
  });

  it('resume returning 404 prunes the row from the store and does not setActive', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not_found' }),
        text: async () => '{"error":"not_found"}',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached' },
    });

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['aaaa1111']);
    expect(state.activeSid).toBe('aaaa1111');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('resume returning 500 leaves the store untouched (user can retry)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'pty_spawn_failed' }),
        text: async () => 'boom',
      }) as unknown as Response,
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached' },
    });

    render(<Sidebar />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(state.activeSid).toBe('aaaa1111');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a later click supersedes an in-flight resume — earlier resolution does not setActive', async () => {
    // Two resume calls in flight. We resolve them in REVERSE click order
    // so we can prove the late-arriving "winner" of the first click does
    // not yank focus away from the second click that already resolved.
    let resolveFirst!: (r: Response) => void;
    const firstResp = new Promise<Response>((r) => {
      resolveFirst = r;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => firstResp)
      .mockImplementationOnce(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
            text: async () => '',
          }) as unknown as Response,
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    useStore.setState({
      sessions: [
        { sid: 'aaaa1111', createdAt: 0, alive: true },
        { sid: 'bbbb2222', createdAt: 0, alive: true },
        { sid: 'cccc3333', createdAt: 0, alive: true },
      ],
      activeSid: 'aaaa1111',
      sessionStatuses: { aaaa1111: 'attached' },
    });

    render(<Sidebar />);
    // Click B (in-flight), then C (resolves immediately).
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-bbbb2222'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sidebar-session-row-cccc3333'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().activeSid).toBe('cccc3333');

    // Now let B's resume resolve. It MUST NOT clobber the active sid.
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().activeSid).toBe('cccc3333');
  });
});
