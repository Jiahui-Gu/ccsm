import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/cn';
import { useStore } from '../stores/store';
import { DURATION_RAW, EASING } from '../lib/motion';

/**
 * Non-intrusive banner showing the most recent agent-layer diagnostic (F1).
 *
 * Diagnostics originate in `electron/agent/sessions.ts` (init handshake
 * failure, control_request timeout, ...) and arrive through
 * `agent:diagnostic` IPC → store. Only the latest non-dismissed entry
 * renders. Dismissing hides the current one; a newer diagnostic will pop
 * a fresh banner.
 *
 * Visually sibling to ClaudeCliMissingBanner — same slim strip at the top
 * of the right pane, amber for warn, rose for error. Deliberately does NOT
 * block input or overlay the chat; it's a signal, not a modal.
 */
export function AgentDiagnosticBanner() {
  const diagnostics = useStore((s) => s.diagnostics);
  const activeId = useStore((s) => s.activeId);
  const dismiss = useStore((s) => s.dismissDiagnostic);

  // Most recent non-dismissed entry for the active session. Per-session
  // scoping avoids a warn from session A from masking the chat for session B
  // the user just switched to. (We still keep all entries in the store so a
  // future "recent diagnostics" panel could read them.)
  const latest = React.useMemo(() => {
    for (let i = diagnostics.length - 1; i >= 0; i--) {
      const d = diagnostics[i];
      if (!d.dismissed && d.sessionId === activeId) return d;
    }
    return null;
  }, [diagnostics, activeId]);

  return (
    <AnimatePresence initial={false}>
      {latest && (
        <motion.div
          key={latest.id}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: DURATION_RAW.ms150, ease: EASING.enter }}
          className="overflow-hidden"
          data-agent-diagnostic-banner
          data-severity={latest.level}
        >
          <div
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle',
              latest.level === 'error'
                ? 'bg-[oklch(0.3_0.11_25)] text-[oklch(0.95_0.06_25)]'
                : 'bg-[oklch(0.32_0.08_75)] text-[oklch(0.94_0.06_90)]'
            )}
            role="status"
          >
            <AlertTriangle size={13} className="stroke-[2] shrink-0" />
            <span className="flex-1 min-w-0 truncate text-xs font-mono">
              {latest.message}
            </span>
            <button
              type="button"
              onClick={() => dismiss(latest.id)}
              aria-label="Dismiss diagnostic"
              data-agent-diagnostic-dismiss
              className={cn(
                'shrink-0 h-6 w-6 rounded inline-flex items-center justify-center',
                'bg-black/10 hover:bg-black/25 active:bg-black/35 transition-colors duration-150',
                'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]'
              )}
            >
              <X size={13} className="stroke-[2]" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
