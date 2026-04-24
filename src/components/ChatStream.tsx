import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { useStore } from '../stores/store';
import {
  MOTION_SESSION_SWITCH_DURATION,
  MOTION_STANDARD_EASING
} from '../lib/motion';
import { useTranslation } from '../i18n/useTranslation';
import { EMPTY_BLOCKS, FOLLOW_THRESHOLD_PX } from './chat/constants';
import { EmptyState } from './chat/EmptyState';
import { LoadHistoryErrorBlock } from './chat/blocks/LoadHistoryErrorBlock';
import { renderBlock } from './chat/renderBlock';

export function ChatStream() {
  const { t } = useTranslation();
  const activeId = useStore((s) => s.activeId);
  const blocks = useStore((s) => s.messagesBySession[activeId] ?? EMPTY_BLOCKS);
  const running = useStore((s) => !!s.runningSessions[activeId]);
  const resolvePermission = useStore((s) => s.resolvePermission);
  const resolvePermissionPartial = useStore((s) => s.resolvePermissionPartial);
  const bumpComposerFocus = useStore((s) => s.bumpComposerFocus);
  const addAllowAlways = useStore((s) => s.addAllowAlways);
  const loadMessages = useStore((s) => s.loadMessages);
  const loadError = useStore((s) => s.loadMessageErrors[activeId]);

  // In-progress dots: show when the agent has accepted the turn but has not
  // yet emitted its first assistant token (i.e. last block is the user's
  // message, or there are no blocks yet for this session). Suppressed once
  // the assistant block starts streaming, and suppressed while a permission
  // prompt is awaiting user input (different intent — "waiting for you",
  // not "waiting for tokens"). Visual: monospace center-dots with a slow
  // opacity pulse, anchored at the bottom of the message list at the same
  // left padding as assistant blocks so the first token visually "lands"
  // in the same column.
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  const hasPendingPermission = blocks.some(
    (b) => b.kind === 'waiting' && b.intent === 'permission'
  );
  const showThinkingDots =
    running &&
    !hasPendingPermission &&
    (lastBlock === null || lastBlock.kind === 'user');

  // Single wall-clock tick for all in-flight tool blocks. We bump `now`
  // every 100ms only while at least one tool block is still waiting for
  // its result (or a completed one is within the stall-hint window so the
  // hint can appear retroactively). When no tool is in-flight the interval
  // shuts down, so idle sessions don't pay any CPU cost. Per block cost
  // is a single prop read — no per-block setInterval.
  const hasInflightTool = blocks.some(
    (b) => b.kind === 'tool' && typeof b.result !== 'string' && !b.isError
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasInflightTool) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [hasInflightTool]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Belt-and-suspenders: selectSession already triggers a load, but hot-reload
  // and other edge paths can change activeId without going through it.
  useEffect(() => {
    if (!activeId) return;
    const state = useStore.getState();
    if (!(activeId in state.messagesBySession)) void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // Reset follow state when the active session changes.
  useEffect(() => {
    followingRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  // After every render that adds blocks, if we're still in follow mode, snap
  // to bottom synchronously to avoid the user briefly seeing the mid-stream
  // before the scroll catches up.
  useLayoutEffect(() => {
    if (!followingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, showThinkingDots]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    followingRef.current = atBottom;
    setShowJump(!atBottom && el.scrollHeight > el.clientHeight);
  }

  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    followingRef.current = true;
    setShowJump(false);
  }

  return (
    <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-chat-stream
        // a11y: announce streaming additions to assistive tech. We set this
        // on the OUTER scroll container (not per-block) so SRs read newly
        // appended message blocks rather than re-announcing every chunk inside
        // a single message. We deliberately use `additions` only (NOT
        // `additions text`): the `text` token causes SRs to re-announce on
        // every text mutation inside existing nodes, which at ~30ms streaming
        // chunk rate overwhelms screen readers. With `additions`, each newly
        // appended assistant/tool block is announced once when it lands;
        // partial chunks within an existing block stay silent until the
        // message settles into a new sibling node.
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        role="log"
        className="flex-1 overflow-y-auto min-w-0"
      >
        {blocks.length === 0 && !showThinkingDots && !loadError ? (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              // Key includes activeId so switching sessions (sidebar click)
              // re-mounts and crossfades the right pane in sync with the
              // sidebar selection-ring animation -- see src/lib/motion.ts.
              key={`empty:${activeId}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: MOTION_SESSION_SWITCH_DURATION,
                ease: MOTION_STANDARD_EASING
              }}
              className="h-full"
            >
              <EmptyState />
            </motion.div>
          </AnimatePresence>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              // Same coordination as the empty branch above: key on activeId
              // so a session switch crossfades the content pane alongside
              // the sidebar selection ring (shared timing in src/lib/motion).
              key={`blocks:${activeId}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: MOTION_SESSION_SWITCH_DURATION,
                ease: MOTION_STANDARD_EASING
              }}
              className="px-4 py-3 flex flex-col gap-1.5 max-w-[1100px]"
            >
              {loadError && (
                <LoadHistoryErrorBlock
                  message={loadError}
                  onRetry={() => {
                    // Clear the sentinel/error so the load effect fires a
                    // fresh fetch; loadMessages also clears the error entry
                    // on entry, but clearing here first keeps the UI honest
                    // if the retry races with an unrelated state update.
                    useStore.setState((s) => {
                      const nextMsgs = { ...s.messagesBySession };
                      delete nextMsgs[activeId];
                      const nextErrs = { ...s.loadMessageErrors };
                      delete nextErrs[activeId];
                      return { messagesBySession: nextMsgs, loadMessageErrors: nextErrs };
                    });
                    void loadMessages(activeId);
                  }}
                />
              )}
              {(() => {
                // Only the LAST pending permission block gets auto-focus. Older
                // ones (unlikely but possible) stay put so we don't rip focus
                // off the user mid-interaction.
                let lastPermIdx = -1;
                for (let i = blocks.length - 1; i >= 0; i--) {
                  const b = blocks[i];
                  if (b.kind === 'waiting' && b.intent === 'permission') {
                    lastPermIdx = i;
                    break;
                  }
                }
                // Bug #248-1: the bash elapsed counter starts at REQUEST time
                // (assistant's tool_use lands → ToolBlock first-render captures
                // Date.now()), not at EXECUTION time. When a permission gate
                // intercepts, the user can spend 90s+ deciding while the
                // counter ticks and the stall / "still no result" escalation
                // banners fire — misleading, since the tool hasn't even
                // started running. We mark each in-flight tool block whose
                // toolName matches a SUBSEQUENT pending permission block as
                // permission-pending; ToolBlock then suppresses the elapsed
                // chip + stall banners and defers `startedAtRef` capture
                // until the gate clears. Matching by toolName-after-this-tool
                // is enough in practice because claude.exe serializes
                // permission prompts; the waiting block doesn't carry a
                // toolUseId we could match more precisely.
                const permissionPendingToolIds = new Set<string>();
                for (let i = 0; i < blocks.length; i++) {
                  const b = blocks[i];
                  if (b.kind !== 'tool' || typeof b.result === 'string' || b.isError) continue;
                  if (!b.toolUseId) continue;
                  for (let j = i + 1; j < blocks.length; j++) {
                    const w = blocks[j];
                    if (
                      w.kind === 'waiting' &&
                      w.intent === 'permission' &&
                      w.toolName === b.name
                    ) {
                      permissionPendingToolIds.add(b.toolUseId);
                      break;
                    }
                  }
                }
                return blocks.map((m, i) => (
                  <div key={m.id}>
                    {renderBlock(m, activeId, resolvePermission, bumpComposerFocus, addAllowAlways, {
                      permissionAutoFocus: i === lastPermIdx,
                      now,
                      permissionPendingToolIds,
                      resolvePermissionPartial
                    })}
                  </div>
                ));
              })()}
              {showThinkingDots && (
                <motion.div
                  key="thinking-dots"
                  data-testid="chat-thinking-dots"
                  aria-label={t('chat.thinking', { defaultValue: 'Agent is thinking' })}
                  className="font-mono text-mono-sm text-state-running select-none tracking-[0.2em] leading-none"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
                >
                  {'\u00B7 \u00B7 \u00B7'}
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      <AnimatePresence>
        {showJump && (
          <motion.button
            key="jump"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            onClick={jumpToLatest}
            className="focus-ring absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-elevated border border-border-strong text-chrome text-fg-primary shadow-md hover:bg-bg-hover transition-colors duration-150 ease-out"
            aria-label={t('chat.jumpToLatest')}
          >
            <ArrowDown size={14} />
            <span>{t('chat.jumpToLatest')}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
