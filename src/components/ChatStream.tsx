import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
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
import type { MessageBlock } from '../types';

// Virtuoso's Scroller is the actual overflow:auto element. We forward our
// long-standing `data-chat-stream` + ARIA contract attributes onto it so the
// existing notification scroll-to-bottom helper, harness probes, and a11y
// snapshots keep working unchanged after the virtualization rewrite.
const VirtuosoScroller = forwardRef<HTMLDivElement, React.HTMLProps<HTMLDivElement>>(
  function VirtuosoScroller(props, ref) {
    return (
      <div
        {...props}
        ref={ref}
        data-chat-stream
        // a11y: announce streaming additions to assistive tech. We set this
        // on the scroll container (not per-block) so SRs read newly appended
        // message blocks rather than re-announcing every chunk inside a
        // single message. We deliberately use `additions` only (NOT
        // `additions text`): the `text` token causes SRs to re-announce on
        // every text mutation inside existing nodes, which at ~30ms streaming
        // chunk rate overwhelms screen readers.
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        role="log"
      />
    );
  }
);

// Virtuoso's List wrapper holds the rendered range. We re-apply the original
// flex column + gap + max-width so block spacing matches the pre-virtualization
// layout exactly.
const VirtuosoList = forwardRef<HTMLDivElement, React.HTMLProps<HTMLDivElement>>(
  function VirtuosoList(props, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className="px-4 py-3 flex flex-col gap-2 max-w-[1100px]"
      />
    );
  }
);

// Footer context shape passed through Virtuoso's `context` prop. Hoisting
// Footer to module scope (rather than defining it inside ChatStream) keeps
// its component identity stable across renders so Virtuoso doesn't remount
// the subtree on every store tick — that remount restarts the thinking-dots
// motion.div animation cycle and makes streaming look broken (#407).
type FooterContext = {
  loadError: string | undefined;
  showThinkingDots: boolean;
  activeId: string;
  onRetryLoad: () => void;
  thinkingLabel: string;
};

function Footer({ context }: { context?: FooterContext }) {
  if (!context) return null;
  const { loadError, showThinkingDots, onRetryLoad, thinkingLabel } = context;
  return (
    <>
      {loadError && (
        <LoadHistoryErrorBlock message={loadError} onRetry={onRetryLoad} />
      )}
      {showThinkingDots && (
        <motion.div
          key="thinking-dots"
          data-testid="chat-thinking-dots"
          aria-label={thinkingLabel}
          className="font-mono text-mono-sm text-state-running select-none tracking-[0.2em] leading-none px-4 pb-3"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          {'· · ·'}
        </motion.div>
      )}
    </>
  );
}

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
  // not "waiting for tokens").
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
  // shuts down, so idle sessions don't pay any CPU cost.
  const hasInflightTool = blocks.some(
    (b) => b.kind === 'tool' && typeof b.result !== 'string' && !b.isError
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasInflightTool) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [hasInflightTool]);

  // Virtuoso handle drives "jump to latest" + initial-mount scroll-to-bottom.
  // `atBottom` mirrors the previous followingRef behavior — we surface the
  // jump pill whenever the user has scrolled away from the tail.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Belt-and-suspenders: selectSession already triggers a load, but hot-reload
  // and other edge paths can change activeId without going through it.
  useEffect(() => {
    if (!activeId) return;
    const state = useStore.getState();
    if (!(activeId in state.messagesBySession)) void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // Reset to bottom when the active session changes. Virtuoso treats
  // `initialTopMostItemIndex` as a mount-only prop, so we explicitly snap
  // via the imperative handle on each switch.
  useEffect(() => {
    setAtBottom(true);
    // requestAnimationFrame so Virtuoso has remounted/measured the new list
    // before we ask it to scroll.
    const raf = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'auto'
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  // Precompute permission-context indices once per render so itemContent
  // is a pure (index, block) → ReactNode mapping with no per-row scans.
  // permissionPendingToolIds: in-flight tool blocks whose toolName matches a
  // SUBSEQUENT pending permission block. ToolBlock suppresses elapsed chip
  // + stall banners for these so the counter doesn't tick during a gate.
  // Bug #248-1 context kept verbatim.
  const { permissionPendingToolIds, lastPermIdx } = useMemo(() => {
    const ids = new Set<string>();
    let lastIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'waiting' && b.intent === 'permission') {
        lastIdx = i;
        break;
      }
    }
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
          ids.add(b.toolUseId);
          break;
        }
      }
    }
    return { permissionPendingToolIds: ids, lastPermIdx: lastIdx };
  }, [blocks]);

  function jumpToLatest() {
    virtuosoRef.current?.scrollToIndex({
      index: 'LAST',
      align: 'end',
      behavior: 'smooth'
    });
    setAtBottom(true);
  }

  // Footer: load-error banner (rare) + thinking dots (frequent). Rendered
  // as Virtuoso's footer so they live inside the scroll container at the
  // tail and don't get virtualized away. The Footer component itself is
  // hoisted to module scope (see top of file); dynamic state flows through
  // Virtuoso's `context` prop so the Footer subtree never remounts on store
  // ticks — preserving the thinking-dots animation cycle (#407).
  const onRetryLoad = useMemo(
    () => () => {
      useStore.setState((s) => {
        const nextMsgs = { ...s.messagesBySession };
        delete nextMsgs[activeId];
        const nextErrs = { ...s.loadMessageErrors };
        delete nextErrs[activeId];
        return { messagesBySession: nextMsgs, loadMessageErrors: nextErrs };
      });
      void loadMessages(activeId);
    },
    [activeId, loadMessages]
  );
  const thinkingLabel = t('chat.thinking', { defaultValue: 'Agent is thinking' });
  const footerContext = useMemo<FooterContext>(
    () => ({ loadError, showThinkingDots, activeId, onRetryLoad, thinkingLabel }),
    [loadError, showThinkingDots, activeId, onRetryLoad, thinkingLabel]
  );

  function itemContent(index: number, m: MessageBlock) {
    return (
      <div key={m.id}>
        {renderBlock(m, activeId, resolvePermission, bumpComposerFocus, addAllowAlways, {
          permissionAutoFocus: index === lastPermIdx,
          now,
          permissionPendingToolIds,
          resolvePermissionPartial
        })}
      </div>
    );
  }

  const isEmpty = blocks.length === 0 && !showThinkingDots && !loadError;

  return (
    <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
      {isEmpty ? (
        <div
          data-chat-stream
          aria-live="polite"
          aria-relevant="additions"
          aria-atomic="false"
          role="log"
          className="flex-1 overflow-y-auto min-w-0"
        >
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
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          // Virtualizes the rendered range so a 13k-block transcript only
          // pays for the on-screen window (~10-30 nodes) instead of mounting
          // the whole history at once. Replaced the previous `blocks.map`
          // which mounted N <motion.div> children and caused 1-2s import
          // jank on large sessions.
          data={blocks}
          itemContent={itemContent}
          // followOutput="auto" sticks to the tail while streaming new
          // blocks IF the user is already at the bottom; otherwise it
          // respects the user's manual scroll position — same intent as
          // the old followingRef gate.
          followOutput="auto"
          atBottomStateChange={setAtBottom}
          atBottomThreshold={FOLLOW_THRESHOLD_PX}
          // initialTopMostItemIndex pins the very first render to the tail
          // so importing or re-opening a long session lands at the most
          // recent block, matching pre-virtualization behavior.
          initialTopMostItemIndex={Math.max(blocks.length - 1, 0)}
          components={{ Scroller: VirtuosoScroller, List: VirtuosoList, Footer }}
          context={footerContext}
          className="flex-1 min-w-0"
          style={{ height: '100%' }}
          increaseViewportBy={{ top: 600, bottom: 600 }}
        />
      )}
      <AnimatePresence>
        {!atBottom && !isEmpty && (
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
