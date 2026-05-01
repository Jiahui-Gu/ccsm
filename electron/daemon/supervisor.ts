// electron/daemon/supervisor.ts
//
// Phase 1 crash observability supervisor hooks (spec §5.3, plan Task 4).
// This module ships only the crash-capture wiring; broader v0.3 daemon
// supervision (spawn, healthz, restart) extends the same DaemonChildHandle
// shape in later PRs.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { RingBuffer } from '../crash/ring-buffer';
import type { CrashCollector } from '../crash/collector';

export interface DaemonChildHandle {
  child: ChildProcess;
  bootNonce?: string;
  lastTraceId?: string;
  runtimeRoot: string;
  /** invoked after recordIncident; supervisor uses this to send the renderer IPC */
  onCrash?: (incidentDir: string, payload: { exitCode: number | null; signal: string | null; bootNonce?: string; markerPresent: boolean; incidentId: string }) => void;
  ringStdout?: RingBuffer<string>;
  ringStderr?: RingBuffer<string>;
  lastHealthzAt?: number;
}

export function attachCrashCapture(handle: DaemonChildHandle, collector: CrashCollector): void {
  const ringStderr = handle.ringStderr ?? new RingBuffer<string>(200);
  const ringStdout = handle.ringStdout ?? new RingBuffer<string>(200);
  handle.ringStderr = ringStderr;
  handle.ringStdout = ringStdout;

  if (handle.child.stderr) {
    readline.createInterface({ input: handle.child.stderr }).on('line', (l) => ringStderr.push(l));
  }
  if (handle.child.stdout) {
    readline.createInterface({ input: handle.child.stdout }).on('line', (l) => ringStdout.push(l));
  }

  handle.child.on('exit', (code, signal) => {
    const markerPath = handle.bootNonce
      ? path.join(handle.runtimeRoot, 'crash', `${handle.bootNonce}.json`)
      : undefined;
    const lastHealthzAgoMs = handle.lastHealthzAt ? Date.now() - handle.lastHealthzAt : null;
    const dir = collector.recordIncident({
      surface: ringStderr.length === 0 && ringStdout.length === 0 && !markerPath ? 'daemon-boot-crash' : 'daemon-exit',
      exitCode: code,
      signal,
      stderrTail: ringStderr.snapshot(),
      stdoutTail: ringStdout.snapshot(),
      lastTraceId: handle.lastTraceId,
      bootNonce: handle.bootNonce,
      lastHealthzAgoMs,
      markerPath,
    });
    const incidentId = path.basename(dir).split('-').pop()!;
    // markerPresent: true means the daemon-marker.json file exists in the
    // incident dir (i.e. collector successfully adopted the marker file
    // produced by daemon's installCrashHandlers). Read it back from
    // meta.json so the wire payload cannot disagree with what was written
    // to disk.
    let markerPresent = false;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      markerPresent = !!meta?.backend?.markerPresent;
    } catch { /* meta unreadable — leave markerPresent = false */ }
    handle.onCrash?.(dir, {
      exitCode: code, signal, bootNonce: handle.bootNonce,
      markerPresent,
      incidentId,
    });
  });
}
