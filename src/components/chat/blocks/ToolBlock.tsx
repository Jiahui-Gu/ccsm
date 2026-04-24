import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, AlertCircle } from 'lucide-react';
import { useTranslation } from '../../../i18n/useTranslation';
import { diffFromToolInput } from '../../../utils/diff';
import { FileTree } from '../../FileTree';
import { Terminal } from '../../Terminal';
import { PrettyInput } from '../PrettyInput';
import { DiffView } from '../DiffView';
import { LongOutputView } from '../LongOutputView';
import {
  FILE_TREE_TOOLS,
  SHELL_OUTPUT_TOOLS,
  STALL_HINT_AFTER_MS,
  STALL_ESCALATE_AFTER_MS
} from '../constants';
import { formatElapsed } from '../utils';

export function ToolBlock({
  name,
  brief,
  result,
  isError,
  input,
  now,
  sessionId,
  toolUseId,
  permissionPending,
  bashPartialCommand,
  streamingInput
}: {
  name: string;
  brief: string;
  result?: string;
  isError?: boolean;
  input?: unknown;
  // Ticking wall-clock from ChatStream. A single interval at the parent
  // drives elapsed/stall display for every tool block so we don't spawn N
  // timers on busy sessions. `undefined` (or stale) = block renders as-is
  // without a counter; safe fallback for tests and non-running blocks.
  now?: number;
  // (#239) sessionId + toolUseId let the in-block Cancel link route a
  // cancellation IPC back to main. Both are optional so legacy call-sites
  // and snapshot tests that don't care about cancel keep rendering; when
  // either is missing the Cancel link still appears (UX consistency) but
  // the click falls back to the old console.warn stub.
  sessionId?: string;
  toolUseId?: string;
  // Bug #248-1: when a permission gate is intercepting this tool's
  // execution, the wall-clock elapsed counter is misleading — we haven't
  // started running yet, the user is just thinking about whether to
  // allow it. ChatStream sets this to true when a sibling waiting/permission
  // block is targeting this tool's name. While true:
  //   - we DON'T capture startedAtRef (it stays null; deferred to gate clear)
  //   - the elapsed chip / stall hint / escalation banner / Cancel link are
  //     all suppressed (no chip → no stall → no Cancel)
  // The "…" in-flight ellipsis (in the truncating name span above) keeps
  // signaling that the block is alive. Once the user resolves the prompt
  // (allow/deny), this flips false; first render after that captures the
  // real execution-begin moment in startedAtRef.
  permissionPending?: boolean;
  // (#336) Live Bash command preview. Only set on placeholder blocks
  // created from `input_json_delta` stream events while the assistant
  // tool_use is still being typed by the model. While `streamingInput`
  // is true we render the partial string with `.bash-typing-caret` and
  // suppress the elapsed/stall chrome (the tool hasn't started running).
  bashPartialCommand?: string;
  streamingInput?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<boolean>(!!isError);
  const [cancelling, setCancelling] = useState(false);
  // Auto-expand precedence (#304): on transition into error or stall-escalation
  // we open the block automatically so the user doesn't have to hunt for the
  // chevron to see what failed / why it stalled. Once the user toggles the
  // block themselves (collapse OR expand), we lock in their choice via this
  // ref so subsequent auto-expand triggers don't override them.
  const userToggledRef = useRef<boolean>(false);
  const prevIsErrorRef = useRef<boolean>(!!isError);
  // Track whether we've already auto-expanded in response to an
  // error/escalation transition so re-renders (timer ticks, parent updates)
  // don't keep slamming `open` back to true after the user collapses.
  const autoExpandedForErrorRef = useRef<boolean>(!!isError);
  const autoExpandedForEscalatedRef = useRef<boolean>(false);
  const handleToggle = () => {
    userToggledRef.current = true;
    setOpen((prev) => !prev);
  };
  const hasResult = typeof result === 'string';
  // Dropped-tool surface (A2-NEW-6). When the tool_result was recorded as
  // an explicit empty string (Bug L historically; possible future drops)
  // OR when `brief` is missing/empty, render a muted "(no result)" marker
  // so the block isn't silent empty space. We only treat this as "dropped"
  // when a result did arrive — a still-in-flight block (no result yet) is
  // not dropped, it's just waiting.
  const emptyResult = hasResult && result === '';
  const emptyBrief = !brief || brief.length === 0;
  const isDropped = (emptyResult || (hasResult && emptyBrief)) && !isError;
  // Elapsed-time tracking (A2-NEW-5). We capture startedAt on the first
  // render where `result` is still undefined AND no permission gate is
  // currently pending — the latter half (#248-1) is what makes "elapsed"
  // mean "execution time" instead of "request time". Refs keep the value
  // stable across re-renders without triggering re-render cycles of
  // their own.
  const initialStartedAt = hasResult || permissionPending || streamingInput ? null : Date.now();
  const startedAtRef = useRef<number | null>(initialStartedAt);
  const endedAtRef = useRef<number | null>(hasResult ? Date.now() : null);
  if (!hasResult && !permissionPending && !streamingInput && startedAtRef.current === null) {
    startedAtRef.current = Date.now();
    endedAtRef.current = null;
  }
  if (hasResult && endedAtRef.current === null) {
    endedAtRef.current = Date.now();
  }
  const running = !hasResult && !isError && !permissionPending && !streamingInput;
  const elapsedMs =
    running && startedAtRef.current !== null
      ? Math.max(0, (now ?? Date.now()) - startedAtRef.current)
      : null;
  // Stall hint (A2-NEW-7 / #181). Cancel-in-block would need new IPC so we
  // surface text only at 30s; the Stop button in StatusBar still works.
  const stalled = elapsedMs !== null && elapsedMs >= STALL_HINT_AFTER_MS;
  // Escalation tier (#208). At 90s we get louder: the elapsed chip flips to
  // warning color and a Cancel link appears. See STALL_ESCALATE_AFTER_MS
  // banner comment for why the link is currently a console.warn stub.
  const escalated = elapsedMs !== null && elapsedMs >= STALL_ESCALATE_AFTER_MS;
  // Auto-expand on transitions (#304). We only flip `open` to true on the
  // *transition* into the error/escalated state, not on every render — and
  // never if the user has already toggled the block themselves. This keeps
  // the affordance helpful (you don't have to click to see what failed)
  // without fighting users who deliberately collapse the block.
  useEffect(() => {
    if (userToggledRef.current) return;
    // Error transition (false -> true). Initial-mount-with-error is handled
    // by useState's initializer; this branch only fires when a previously
    // healthy tool block flips to error mid-stream.
    if (isError && !prevIsErrorRef.current && !autoExpandedForErrorRef.current) {
      autoExpandedForErrorRef.current = true;
      setOpen(true);
    }
    prevIsErrorRef.current = !!isError;
  }, [isError]);
  useEffect(() => {
    if (userToggledRef.current) return;
    if (escalated && !autoExpandedForEscalatedRef.current) {
      autoExpandedForEscalatedRef.current = true;
      setOpen(true);
    }
  }, [escalated]);
  const onCancelStalled = () => {
    if (cancelling) return;
    // (#239) Per-tool cancel IPC. The renderer can't reach the in-flight
    // tool directly — the SDK / claude.exe spawn protocol exposes only a
    // turn-level `interrupt` control_request, not a per-tool-use cancel.
    // We send `{sessionId, toolUseId}` anyway so main can log/metric the
    // intent and a future SDK upgrade can implement scoped cancel without
    // a renderer change. Today the handler in main routes through
    // SessionRunner.cancelToolUse which falls back to interrupt(); see
    // electron/agent/sessions.ts for the WHY comment on that fallback.
    setCancelling(true);
    const api = typeof window !== 'undefined' ? window.ccsm : undefined;
    if (api && typeof api.agentCancelToolUse === 'function' && sessionId && toolUseId) {
      void api
        .agentCancelToolUse({ sessionId, toolUseId })
        .catch((err: unknown) => {
          console.warn('[tool-cancel] IPC failed', err);
        });
      return;
    }
    // No bridge or missing identifiers — keep the legacy stub so dev mode
    // / tests without a preload bridge don't crash silently.
    console.warn(`[stall-escalation] user clicked Cancel on stalled tool: ${name}`);
  };
  const diff = diffFromToolInput(name, input);
  const isFileTree = FILE_TREE_TOOLS.has(name) && hasResult && !isError;
  const isShellTool = SHELL_OUTPUT_TOOLS.has(name);
  return (
    <div
      className={
        'font-mono text-chrome ' +
        (isError
          ? 'relative rounded-sm border border-state-error/40 bg-state-error-soft/50 pl-3 pr-2 py-1 my-0.5'
          : '')
      }
      role={isError ? 'alert' : undefined}
    >
      {isError && (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[2px] bg-state-error rounded-l-sm" />
      )}
      <button
        onClick={handleToggle}
        aria-expanded={open}
        className="group flex items-baseline gap-3 w-full text-left text-fg-tertiary hover:text-fg-secondary transition-colors duration-150 ease-out outline-none rounded-sm focus-ring"
      >
        <span className="w-3 shrink-0 flex items-center">
          <motion.span
            initial={false}
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="inline-flex"
          >
            <ChevronRight
              size={11}
              className={'stroke-[1.75] -ml-px ' + (isError ? 'text-state-error' : '')}
            />
          </motion.span>
        </span>
        <span
          className="min-w-0 truncate flex items-baseline gap-1.5"
          title={brief ? `${name} (${brief})` : name}
        >
          {isError && (
            <AlertCircle
              size={12}
              className="text-state-error self-center shrink-0"
              aria-label={t('chat.toolFailedAria')}
            />
          )}
          <span
            data-type-scale-role="tool-name"
            className={
              isError
                ? 'text-state-error group-hover:text-state-error transition-colors duration-150 ease-out font-semibold'
                : 'text-fg-secondary group-hover:text-fg-primary transition-colors duration-150 ease-out'
            }
          >
            {name}
          </span>
          <span className={isError ? 'text-state-error/80 text-meta' : 'text-fg-tertiary text-meta'}>
            ({streamingInput && typeof bashPartialCommand === 'string' ? bashPartialCommand : brief}
            {streamingInput && (
              <span
                data-testid="bash-typing-caret"
                aria-hidden
                className="bash-typing-caret"
              >
                {'\u258B'}
              </span>
            )}
            )
          </span>
          {isError && <span className="text-state-error/80 text-meta ml-1 uppercase tracking-wider">{t('chat.toolFailedTag')}</span>}
          {isDropped && (
            <span
              data-testid="tool-no-result"
              // a11y (audit TB6): solid text-fg-tertiary (no /80 alpha) so the
              // 11px "(no result)" marker clears WCAG AA (4.5:1) on bg-panel
              // in both themes — fg-tertiary/80 measured 3.08:1 in light mode.
              // The "dropped" visual cue is carried by the italic modifier and
              // the parenthetical tone, not by extra dimming.
              className="text-fg-tertiary text-meta italic ml-1"
            >
              {t('chat.toolNoResult')}
            </span>
          )}
          {!hasResult && !isError && <span className="text-fg-tertiary text-meta ml-2">…</span>}
        </span>
        {/* Right-aligned cluster: elapsed counter (A2-NEW-5) + stall hint
            (A2-NEW-7) + escalation tier (#208). Lives outside the truncating
            name+brief span so it stays visible even when the brief is long.
            Only renders for still-running blocks; freezes/clears once result
            lands. At the 90s escalation threshold the chip flips to
            warning color so it visually pops out from the rest of the row. */}
        {elapsedMs !== null && (
          <span
            data-testid="tool-elapsed"
            data-escalated={escalated ? 'true' : undefined}
            className={
              'ml-auto pl-3 font-mono text-mono-xs tabular-nums shrink-0 transition-colors duration-150 ease-out ' +
              (escalated ? 'text-state-warning-text font-semibold' : 'text-state-running/90')
            }
            aria-label={`elapsed ${formatElapsed(elapsedMs)}`}
          >
            {formatElapsed(elapsedMs)}
          </span>
        )}
        {stalled && !escalated && (
          <span
            data-testid="tool-stalled"
            className={
              'font-mono text-mono-xs text-state-waiting/90 italic shrink-0 ' +
              (elapsedMs !== null ? 'ml-2' : 'ml-auto pl-3')
            }
          >
            {t('chat.toolTakingLonger')}
          </span>
        )}
        {escalated && (
          <span
            data-testid="tool-stall-escalated"
            className={
              'font-mono text-mono-xs text-state-warning-text shrink-0 ' +
              (elapsedMs !== null ? 'ml-2' : 'ml-auto pl-3')
            }
          >
            {t('chat.toolStallEscalated')}
          </span>
        )}
        {escalated && (
          // Inline span used as a button because the parent collapse-row is
          // already a <button>; nesting <button> would be invalid HTML and
          // trigger a React hydration warning. role=button + Enter/Space
          // handler keeps keyboard parity. stopPropagation prevents the row
          // from collapsing/expanding when the user clicks Cancel.
          // After click we flip to a disabled "Cancelling…" state until the
          // next tool event lands (result/error) and React unmounts the
          // escalated branch entirely. aria-disabled keeps assistive tech in
          // the loop without losing the focus target.
          <span
            data-testid="tool-stall-cancel"
            role="button"
            tabIndex={cancelling ? -1 : 0}
            aria-disabled={cancelling || undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (cancelling) return;
              onCancelStalled();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                if (cancelling) return;
                onCancelStalled();
              }
            }}
            className={
              'ml-2 font-mono text-mono-xs underline-offset-2 focus-ring rounded-sm px-1 shrink-0 transition-colors duration-150 ease-out ' +
              (cancelling
                ? 'text-fg-tertiary italic cursor-default'
                : 'text-state-warning-text hover:underline cursor-pointer')
            }
            aria-label={t('chat.toolStallCancelAria')}
          >
            {cancelling ? t('chat.toolStallCancelling') : t('chat.toolStallCancel')}
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0, 0, 0.2, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {input !== undefined && input !== null && !diff && <PrettyInput input={input} />}
            {diff ? (
              <DiffView diff={diff} />
            ) : isFileTree ? (
              <FileTree source={result as string} />
            ) : isShellTool ? (
              <Terminal data={hasResult ? (result ?? '') : ''} running={!hasResult} />
            ) : hasResult ? (
              <LongOutputView text={result as string} isError={!!isError} toolName={name} />
            ) : (
              <pre
                className={`mt-1 ml-6 pl-3 border-l text-meta whitespace-pre-wrap font-mono ${
                  isError ? 'border-state-error/40 text-state-error-fg' : 'border-border-subtle text-fg-tertiary'
                }`}
              >
                {t('chat.runningEllipsis')}
              </pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
