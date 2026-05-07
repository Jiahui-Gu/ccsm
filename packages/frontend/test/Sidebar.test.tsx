import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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

  it('clicking a session row whose ws is already open calls store.setActive directly (no resume POST)', () => {
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
    expect(String(calledUrl)).toBe('/api/sessions');
    expect((calledInit as RequestInit).method).toBe('POST');

    const state = useStore.getState();
    expect(state.sessions.map((s) => s.sid)).toEqual(['new-sid-xyz']);
    expect(state.activeSid).toBe('new-sid-xyz');
  });

  // ---- T11 / #671: lazy resume on row click ----

  it('clicking an idle session row POSTs /resume then setActive', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('/api/sessions/bbbb2222/resume');
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
