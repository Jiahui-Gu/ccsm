// R-57 (Task #181): RuntimeProvider must accept hostConfig=null and expose
// a stub api that rejects every call with "daemon not ready". This is the
// architectural backbone of the SPA-renders-without-daemon-ready fix.
//
// Why a dedicated suite (not folded into PhaseSwitch.test): RuntimeProvider
// is shared with frontend-web, so the null-handling contract must be
// asserted at the @ccsm/ui layer, independent of any shell.

import { describe, it, expect } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import {
  DAEMON_NOT_READY_ERROR,
  RuntimeProvider,
  useApi,
  useGetToken,
  useHostReady,
} from '../src/runtime-context';
import type { HostConfig } from '../src/types';

// A probe component that reports hostReady, the token, and the resolution of
// a listSessions() call out to the DOM so the test can assert from outside.
function Probe() {
  const ready = useHostReady();
  const api = useApi();
  const getToken = useGetToken();
  const [result, setResult] = useState<string>('pending');
  useEffect(() => {
    let cancelled = false;
    api
      .listSessions('tok')
      .then((r) => {
        if (!cancelled)
          setResult(`ok:${JSON.stringify(r).slice(0, 30)}`);
      })
      .catch((err) => {
        if (!cancelled)
          setResult(
            `err:${err instanceof Error ? err.message : String(err)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [api]);
  return (
    <div
      data-testid="probe"
      data-host-ready={ready ? 'true' : 'false'}
      data-token={getToken() ?? ''}
      data-result={result}
    />
  );
}

describe('RuntimeProvider — null hostConfig (R-57 / Task #181)', () => {
  afterEachCleanup();

  it('exposes hostReady=false and getToken returning null', async () => {
    render(
      <RuntimeProvider hostConfig={null}>
        <Probe />
      </RuntimeProvider>,
    );
    // Flush the Probe's useEffect setState so the act() warning doesn't fire
    // on the assertions below.
    await flushMicrotasks();
    const probe = screen.getByTestId('probe');
    expect(probe.getAttribute('data-host-ready')).toBe('false');
    expect(probe.getAttribute('data-token')).toBe('');
  });

  it('rejects listSessions with "daemon not ready" when hostConfig is null', async () => {
    render(
      <RuntimeProvider hostConfig={null}>
        <Probe />
      </RuntimeProvider>,
    );
    await flushMicrotasks();
    const probe = screen.getByTestId('probe');
    expect(probe.getAttribute('data-result')).toBe(
      `err:${DAEMON_NOT_READY_ERROR}`,
    );
  });

  it('switches to ready+real-token when hostConfig prop transitions from null to a value', async () => {
    const hostConfig: HostConfig = {
      httpBase: 'http://example.invalid',
      getToken: () => 'tok-live',
    };
    const { rerender } = render(
      <RuntimeProvider hostConfig={null}>
        <Probe />
      </RuntimeProvider>,
    );
    await flushMicrotasks();
    expect(
      screen.getByTestId('probe').getAttribute('data-host-ready'),
    ).toBe('false');

    // Flip to a real config — RuntimeProvider's useMemo should mint a fresh
    // runtime + bind a real api wrapper. The probe re-renders with the new
    // values.
    //
    // We don't actually wait on the listSessions call here (it would hit
    // example.invalid and depend on jsdom fetch behaviour). The contract
    // under test is the *hook surface* — hostReady + getToken — flipping.
    rerender(
      <RuntimeProvider hostConfig={hostConfig}>
        <Probe />
      </RuntimeProvider>,
    );
    const probe = screen.getByTestId('probe');
    expect(probe.getAttribute('data-host-ready')).toBe('true');
    expect(probe.getAttribute('data-token')).toBe('tok-live');
  });

  it('exposes DAEMON_NOT_READY_ERROR as a stable string for callers to match on', () => {
    // Stability matters because Sidebar / useBootstrap / future error UI may
    // want to distinguish "daemon not ready" from real network failures
    // without instanceof-checking a class.
    expect(DAEMON_NOT_READY_ERROR).toBe('daemon not ready');
  });
});

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function afterEachCleanup(): void {
  // Vitest's globals API exposes afterEach as a global; using it directly
  // keeps the helper colocated with the describe block above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const afterEach = (globalThis as any).afterEach as (
    fn: () => void,
  ) => void;
  afterEach(() => cleanup());
}
