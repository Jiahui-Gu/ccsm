import React from 'react';
import { AlertOctagon, RotateCw, Settings } from 'lucide-react';
import { cn } from '../lib/cn';
import { useStore } from '../stores/store';
import { startSessionAndReconcile } from '../agent/startSession';
import { TopBanner, TopBannerPresence } from './chrome/TopBanner';

/**
 * Banner shown at the top of the right pane when `agent:start` failed for the
 * active session with an error code that doesn't have bespoke UX elsewhere
 * (F7). CLAUDE_NOT_FOUND → CLI wizard; CWD_MISSING → inline error + StatusBar
 * cwd chip; every OTHER failure lands here so the session isn't stranded on
 * "starting…" with no explanation.
 *
 * Two actions:
 *   - Retry: re-runs `agent:start` via the shared helper. On success the
 *     session starts streaming normally; on failure the banner just re-renders
 *     with the (possibly new) error.
 *   - Reconfigure: fires the `onRequestReconfigure` prop. App.tsx wires this
 *     to `setSettingsOpen(true)` so the Settings dialog surfaces the
 *     user-configurable bits (CLI binary path, endpoint, etc).
 *
 * Layout, motion, and a11y are delegated to the shared `<TopBanner />`
 * (#237 — banner trio unification). Only copy + CTAs live here.
 */
export function AgentInitFailedBanner({
  onRequestReconfigure,
}: {
  onRequestReconfigure: () => void;
}) {
  const activeId = useStore((s) => s.activeId);
  const failure = useStore((s) => (activeId ? s.sessionInitFailures[activeId] : undefined));
  const clearFailure = useStore((s) => s.clearSessionInitFailure);
  const setRunning = useStore((s) => s.setRunning);
  const [retrying, setRetrying] = React.useState(false);

  const onRetry = React.useCallback(async () => {
    if (!activeId) return;
    setRetrying(true);
    try {
      // Re-running startSessionAndReconcile clears the failure flag on
      // success; on failure it overwrites the entry with the new error. The
      // running flag is flipped on optimistically so the caret disappears
      // cleanly — the next user Send will drive it further.
      setRunning(activeId, false);
      await startSessionAndReconcile(activeId);
    } finally {
      setRetrying(false);
    }
  }, [activeId, setRunning]);

  const onDismiss = React.useCallback(() => {
    if (!activeId) return;
    clearFailure(activeId);
  }, [activeId, clearFailure]);

  return (
    <TopBannerPresence>
      {failure && (
        <TopBanner
          variant="error"
          presenceKey={activeId ?? 'agent-init-failed'}
          testId="agent-init-failed-banner"
          icon={<AlertOctagon size={14} className="stroke-[2]" />}
          title="Agent failed to start"
          body={failure.error}
          onDismiss={onDismiss}
          actions={
            <>
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                data-agent-init-failed-retry
                className={cn(
                  'shrink-0 h-7 px-2.5 rounded text-meta font-medium inline-flex items-center gap-1.5',
                  'bg-black/25 hover:bg-black/35 active:bg-black/45 transition-colors duration-150',
                  'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]',
                  'disabled:opacity-60 disabled:cursor-not-allowed'
                )}
              >
                <RotateCw size={12} className={cn('stroke-[2]', retrying && 'animate-spin')} />
                <span>{retrying ? 'Retrying…' : 'Retry'}</span>
              </button>
              <button
                type="button"
                onClick={onRequestReconfigure}
                data-agent-init-failed-reconfigure
                className={cn(
                  'shrink-0 h-7 px-2.5 rounded text-meta font-medium inline-flex items-center gap-1.5',
                  'bg-black/10 hover:bg-black/25 active:bg-black/35 transition-colors duration-150',
                  'outline-none focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.18)]'
                )}
              >
                <Settings size={12} className="stroke-[2]" />
                <span>Reconfigure</span>
              </button>
            </>
          }
        />
      )}
    </TopBannerPresence>
  );
}
