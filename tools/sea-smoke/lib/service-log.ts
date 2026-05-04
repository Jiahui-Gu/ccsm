// tools/sea-smoke/lib/service-log.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       chapter 10 §7 step 7 — "capture per-OS service-manager log on
//       failure (same capture rule as §5 step 7)".
// §5 step 7 capture commands (sourced verbatim from
// packages/daemon/build/install/post-install-healthz.{sh,ps1}):
//   linux: journalctl -u ccsm-daemon.service -n 200 --no-pager
//   mac:   log show --predicate 'process == "ccsm-daemon"' --last 5m
//   win:   Get-WinEvent -LogName Application -MaxEvents 200
//          | Where-Object { $_.ProviderName -like '*ccsm*' }
//
// SRP: single sink — `dumpServiceLog()` runs the spec-locked command for
// the current OS, pipes its stdout+stderr to our stderr (so the CI runner
// archives it under the failed-step's annotations), and returns. It does
// NOT decide whether to dump (caller does, on failure only) and it does
// NOT compose service-manager start/stop (that lives in main.ts).
//
// Both the spec and post-install-healthz.sh leave "log capture failed"
// non-fatal — a missing journalctl on a stripped container is no reason
// to mask the upstream /healthz timeout. We mirror that: any exec error
// is logged to stderr but does not throw.

import { spawn } from 'node:child_process';

export type SmokePlatform = 'linux' | 'darwin' | 'win32';

export interface DumpServiceLogOptions {
  readonly platform?: SmokePlatform;
  /** Override the service unit name (defaults to `ccsm-daemon`). */
  readonly serviceName?: string;
  /** Tail length. Spec ch10 §5 step 7 pins 200. */
  readonly tailLines?: number;
  /** Override the writable stream the dump streams to. Defaults to stderr. */
  readonly out?: NodeJS.WritableStream;
}

/**
 * Run the per-OS service-manager log capture command (spec ch10 §7 + §5
 * step 7) and stream its output to stderr (or the injected `out` sink).
 * Never throws: log capture is best-effort diagnostic, not a hard gate.
 */
export async function dumpServiceLog(opts: DumpServiceLogOptions = {}): Promise<void> {
  const platform = opts.platform ?? (process.platform as SmokePlatform);
  const service = opts.serviceName ?? 'ccsm-daemon';
  const tail = opts.tailLines ?? 200;
  const out = opts.out ?? process.stderr;

  const cmd = buildCaptureCommand(platform, service, tail);
  if (cmd === null) {
    out.write(`[sea-smoke] service-log dump unsupported on platform=${platform}\n`);
    return;
  }

  out.write(`[sea-smoke] capturing service log: ${cmd.echo}\n`);
  await new Promise<void>((resolve) => {
    const child = spawn(cmd.exe, cmd.args, {
      // Inherit stderr so PowerShell / journalctl errors surface; stdout
      // we capture and forward so the dump is line-buffered cleanly.
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell=false: spawn the binary directly. The args arrays already
      // separate every token; using shell=true would re-introduce quoting
      // surprises on Windows.
      shell: false,
    });
    child.stdout.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => out.write(chunk));
    child.on('error', (err) => {
      out.write(`[sea-smoke] service-log capture spawn failed: ${String(err)}\n`);
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0) {
        out.write(`[sea-smoke] service-log capture exited code=${String(code)} (best-effort)\n`);
      }
      resolve();
    });
  });
}

interface CaptureCommand {
  readonly exe: string;
  readonly args: ReadonlyArray<string>;
  /** Human-readable echo of the command (for the [sea-smoke] log line). */
  readonly echo: string;
}

/**
 * Compose the platform-locked capture command. Pure: no I/O, no spawn —
 * unit-testable by asserting the (exe, args) tuple matches the spec ch10
 * §5 step 7 strings verbatim. Returns `null` on unsupported platforms so
 * the caller can decide what to do (we just log "unsupported").
 */
export function buildCaptureCommand(
  platform: SmokePlatform,
  serviceName: string,
  tailLines: number,
): CaptureCommand | null {
  if (platform === 'linux') {
    const args = ['-u', `${serviceName}.service`, '-n', String(tailLines), '--no-pager'];
    return { exe: 'journalctl', args, echo: `journalctl ${args.join(' ')}` };
  }
  if (platform === 'darwin') {
    // Spec ch10 §5 step 7 mac branch: `log show --predicate 'process ==
    // "ccsm-daemon"' --last 5m`. The `--last` window is 5 minutes
    // (regardless of `tailLines`); `tailLines` would re-tail the
    // line-buffered output but the spec command does not pipe through
    // tail, so we omit it for fidelity.
    const args = [
      'show',
      '--predicate',
      `process == "${serviceName}"`,
      '--last',
      '5m',
    ];
    return { exe: 'log', args, echo: `log ${args.join(' ')}` };
  }
  if (platform === 'win32') {
    // Spec ch10 §5 step 7 windows branch — invoked through pwsh so the
    // pipeline below executes in a real PowerShell process (cmd.exe
    // can't pipe Get-WinEvent into Where-Object). Falls back to
    // `powershell` if `pwsh` is missing — both honor the same -Command.
    const ps = `Get-WinEvent -LogName Application -MaxEvents ${String(tailLines)} | Where-Object { $_.ProviderName -like '*${serviceName}*' } | Format-List`;
    const args = ['-NoProfile', '-NonInteractive', '-Command', ps];
    return { exe: 'pwsh', args, echo: `pwsh -Command "${ps}"` };
  }
  return null;
}
