import React from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/cn';
import type { AgentType, SessionState } from '../types';

type Size = 'sm' | 'md';

const SIZE_PX: Record<Size, number> = { sm: 16, md: 20 };
const GLYPH_PX: Record<Size, number> = { sm: 11, md: 14 };

// Official Claude Code wordmark (lobehub/lobe-icons), Anthropic orange.
function ClaudeAsterisk({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="#D97757"
      aria-hidden
    >
      <path
        clipRule="evenodd"
        fillRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  );
}

// Two-state attention model: `waiting` = agent is asking for input, breathes
// an amber halo to call the user; everything else is `idle` (neutral). The
// halo is the *only* attention signal — no corner badge — because at sidebar
// scale a single, large pulsing element is more perceivable than a 9px dot.
//
// `flashing` (#689) is the transient flash signal from the new notify
// pipeline's flash sink. ORed with `state === 'waiting'` so Rule 2
// (foreground active short task → flash, no toast) still pulses the halo
// even though the row's persistent state stays at `idle`. Sourced from the
// renderer store's `flashStates: Record<sid, boolean>` (see App.tsx).
//
// audit #876 cluster 2.3: crashed wins over waiting/flashing for visual
// focus. When `crashed` is true the SessionRow already paints a red dot in
// its rail; pulsing the halo at the same time creates two competing
// attention signals racing for the user's eye. We collapse to a single
// signal (red dot only) by suppressing the halo. The crashed visual is
// owned by SessionRow, not AgentIcon — this prop only gates the halo.
//
// Priority order (highest → lowest):
//   1. crashed       → no halo (red dot in SessionRow is the signal)
//   2. waiting/flash → amber breathing halo
//   3. idle          → neutral
const ATTENTION_PRIORITY = ['crashed', 'waiting-or-flashing', 'idle'] as const;

export function AgentIcon({
  agentType,
  state,
  flashing = false,
  crashed = false,
  size = 'sm'
}: {
  agentType: AgentType;
  state: SessionState;
  flashing?: boolean;
  crashed?: boolean;
  size?: Size;
}) {
  const px = SIZE_PX[size];
  const glyph = GLYPH_PX[size];
  // Explicit priority resolution — see ATTENTION_PRIORITY above. crashed
  // short-circuits the halo even if state==='waiting' or flashing===true.
  const isWaiting = !crashed && (state === 'waiting' || flashing);
  // Resolved attention bucket — exposed as `data-attention` so visual /
  // unit tests can pin the priority contract without measuring animation.
  const attention: (typeof ATTENTION_PRIORITY)[number] = crashed
    ? 'crashed'
    : state === 'waiting' || flashing
      ? 'waiting-or-flashing'
      : 'idle';
  const inner = agentType === 'claude-code' ? <ClaudeAsterisk size={glyph} /> : null;
  return (
    <motion.span
      data-agent-icon-state={state}
      data-attention={attention}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-md',
        'bg-bg-elevated border border-border-default text-fg-primary'
      )}
      style={{ width: px, height: px }}
      animate={
        isWaiting
          ? {
              boxShadow: [
                '0 0 0px 0px oklch(0.78 0.10 75 / 0)',
                '0 0 10px 3px oklch(0.78 0.10 75 / 0.7)',
                '0 0 0px 0px oklch(0.78 0.10 75 / 0)'
              ]
            }
          : { boxShadow: '0 0 0px 0px oklch(0.78 0.10 75 / 0)' }
      }
      transition={
        isWaiting
          ? { duration: 1.6, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0 }
      }
    >
      {inner}
    </motion.span>
  );
}
