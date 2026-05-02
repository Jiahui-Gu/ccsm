// tests/electron/ipc/rendererErrorForwarder.scrub.test.ts
//
// Task #60 — renderer-surface crash-scrub coverage. The renderer error
// forwarder receives an untrusted RendererErrorReport from the renderer and
// hands it to the phase-1 collector. Per frag-6-7 §6.6.3 the secret redact
// must happen BEFORE the report reaches the collector, so a compromised /
// out-of-date renderer can never bypass the scrubber.
import { describe, it, expect, vi } from 'vitest';
import {
  handleRendererErrorReport,
  createRendererErrorRateLimiter,
  type RendererErrorReport,
} from '../../../electron/ipc/rendererErrorForwarder';
import type { CrashCollector, IncidentInput } from '../../../electron/crash/collector';

function makeCollectorSpy(): { collector: CrashCollector; calls: IncidentInput[] } {
  const calls: IncidentInput[] = [];
  const collector: CrashCollector = {
    recordIncident: (input: IncidentInput): string => {
      calls.push(input);
      return '/tmp/fake-incident';
    },
    flush: vi.fn(async () => {}),
    pruneRetention: vi.fn(),
  };
  return { collector, calls };
}

describe('rendererErrorForwarder secret redaction (Task #60)', () => {
  function runWith(report: RendererErrorReport): IncidentInput {
    const { collector, calls } = makeCollectorSpy();
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 100 });
    const res = handleRendererErrorReport(report, { collector, limiter, processId: 1 });
    expect(res.accepted).toBe(true);
    expect(calls.length).toBe(1);
    return calls[0]!;
  }

  it('(a) redacts Authorization: Bearer in error.stack', () => {
    const incident = runWith({
      source: 'window.onerror',
      error: {
        message: 'fetch failed',
        stack: 'Error: fetch failed\n  at fetch (Authorization: Bearer sk-ant-zzz)',
        name: 'Error',
      },
    });
    expect(incident.error?.stack).toContain('Authorization: <REDACTED>');
    expect(incident.error?.stack).not.toContain('sk-ant-zzz');
  });

  it('(b) redacts ANTHROPIC_API_KEY=sk-xxx in error.message', () => {
    const incident = runWith({
      source: 'window.onerror',
      error: {
        message: 'env leaked: ANTHROPIC_API_KEY=sk-ant-leak-9 boot failed',
        name: 'Error',
      },
    });
    expect(incident.error?.message).toContain('ANTHROPIC_API_KEY=<REDACTED>');
    expect(incident.error?.message).not.toContain('sk-ant-leak-9');
  });

  it('(c) redacts daemonSecret-style property in JSON-shaped error message', () => {
    const incident = runWith({
      source: 'window.onunhandledrejection',
      error: {
        message: 'rejection: {"daemonSecret":"super-sekret","other":"ok"}',
        name: 'Error',
      },
    });
    expect(incident.error?.message).toContain('"daemonSecret":"<REDACTED>"');
    expect(incident.error?.message).not.toContain('super-sekret');
    expect(incident.error?.message).toContain('"other":"ok"');
  });

  it('also redacts breadcrumbs (stderrTail) when url contains a secret', () => {
    const incident = runWith({
      source: 'window.onerror',
      url: 'https://api.example.com/?ANTHROPIC_API_KEY=sk-ant-uuu',
      error: { message: 'oops', name: 'Error' },
    });
    const tail = (incident.stderrTail ?? []).join('\n');
    expect(tail).not.toContain('sk-ant-uuu');
    expect(tail).toContain('ANTHROPIC_API_KEY=<REDACTED>');
  });
});
