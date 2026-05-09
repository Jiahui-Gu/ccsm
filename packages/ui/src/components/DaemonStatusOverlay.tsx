// Task #112-T3: minimal pre-Ready overlay. Renders while the daemon has not
// reached `Ready` yet so the user sees something instead of a black screen.
// T4 owns the polished visuals; this stub only proves the wiring.

import type { ReactNode } from 'react';

export type DaemonStatusVariant = 'info' | 'error' | 'auth';

// Loose phase shape: this component is rendered by the Tauri shell for any
// non-Ready phase. We only read `.phase` (the discriminator) and a couple of
// optional fields, so we keep the type minimal here to avoid pulling shell
// types into @ccsm/ui.
export interface DaemonStatusPhase {
  phase: string;
  reason?: string;
  verificationUri?: string;
  userCode?: string;
}

export interface DaemonStatusOverlayProps {
  phase: DaemonStatusPhase;
  variant?: DaemonStatusVariant;
}

const COLORS: Record<DaemonStatusVariant, { bg: string; fg: string }> = {
  info: { bg: '#1e1e1e', fg: '#e6e6e6' },
  error: { bg: '#3a1f1f', fg: '#f5d0d0' },
  auth: { bg: '#1f2a3a', fg: '#d0e0f5' },
};

function describe(phase: DaemonStatusPhase): ReactNode {
  switch (phase.phase) {
    case 'spawnFailed':
      return `Failed to start daemon: ${phase.reason ?? 'unknown'}`;
    case 'authFailed':
      return `Authentication failed: ${phase.reason ?? 'unknown'}`;
    case 'exited':
      return `Daemon exited: ${phase.reason ?? 'unknown'}`;
    case 'awaitingAuth':
      return `Awaiting authentication. Visit ${phase.verificationUri ?? ''} and enter ${phase.userCode ?? ''}.`;
    default:
      return `Phase: ${phase.phase}`;
  }
}

export function DaemonStatusOverlay({
  phase,
  variant = 'info',
}: DaemonStatusOverlayProps) {
  const { bg, fg } = COLORS[variant];
  return (
    <div
      data-testid="daemon-status-overlay"
      data-variant={variant}
      data-phase={phase.phase}
      style={{
        position: 'fixed',
        inset: 0,
        background: bg,
        color: fg,
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 20 }}>ccsm</h1>
      <p style={{ margin: 0, fontSize: 14 }}>{describe(phase)}</p>
    </div>
  );
}
