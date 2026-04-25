import { useMemo } from 'react';
import { useStore } from '../stores/store';
import { QuestionBlock } from './QuestionBlock';
import type { MessageBlock } from '../types';

/**
 * Sticky host for the AskUserQuestion widget.
 *
 * Rendered between `<ChatStream />` and `<InputBar />` in `App.tsx`.
 * Picks the FIRST unanswered `kind: 'question'` block in the active
 * session and renders it via `<QuestionBlock />`. Only one card is shown
 * even if multiple `question` blocks have queued (cross-turn queue —
 * each card drains in order as the user submits / rejects).
 *
 * Rationale: this matches the upstream Claude VS Code extension layout
 * (webview/index.js around line 2043 — `permissionsContainer` lives in
 * the input/composer region, not in the messages list, and only the
 * first request in `permissionRequests.value` is rendered). Sticky
 * placement also means the prompt never scrolls away when the agent
 * keeps streaming text BELOW it (which can happen between the AskUser
 * tool_use frame and the model's awaiting-answer pause).
 */
export function QuestionStickyHost({ sessionId }: { sessionId: string }) {
  const blocks = useStore((s) => s.messagesBySession[sessionId]);
  const markQuestionAnswered = useStore((s) => s.markQuestionAnswered);
  const bumpComposerFocus = useStore((s) => s.bumpComposerFocus);

  // First UNANSWERED question block is the only one we expose. If the
  // user clears the queue mid-flight or the session changes between
  // renders this becomes undefined and the host renders nothing.
  const pending = useMemo(() => {
    if (!blocks) return undefined;
    for (const b of blocks) {
      if (b.kind === 'question' && !b.answered) return b;
    }
    return undefined;
  }, [blocks]);

  if (!pending) return null;
  const block = pending as Extract<MessageBlock, { kind: 'question' }>;

  return (
    <QuestionBlock
      key={block.id}
      questions={block.questions}
      onSubmit={(answersByQuestion) => {
        const api = window.ccsm;
        if (!api) return;
        // Two flows land here:
        //  1. can_use_tool path (current claude.exe spawn): the question
        //     block carries `requestId`. We deny the pending permission
        //     promise on the main side so claude.exe stops blocking on
        //     it, then send the answers as a fresh user turn so the
        //     model receives them. This is intentionally lossy in the
        //     CLI sense (we don't write back to the AskUserQuestion
        //     tool_result), but it matches what the user actually wants
        //     and unblocks the turn cleanly. Mirrors upstream's submit
        //     path semantics — see PermissionPromptBlock for the
        //     analogous wiring.
        //  2. tool_use-only path (no requestId): the bogus tool_result
        //     has already landed via the dedicated AskUserQuestion
        //     handler; just send the user's answers as the next turn.
        if (block.requestId) {
          void api.agentResolvePermission(sessionId, block.requestId, 'deny');
        }
        // Serialize the per-question Q→A map into a single user-message
        // body. Keeps the wire format simple (one agentSend call) and
        // produces a chat history that reads naturally if the user
        // scrolls back. We use upstream's "\n " separator to split
        // multi-select answers inside a single question's value; here
        // we pre-split each value back to per-line answers under the Q
        // for the prompt body.
        const lines: string[] = [];
        for (const q of block.questions) {
          const a = answersByQuestion[q.question];
          if (!a) continue;
          lines.push(`Q: ${q.question}`);
          // Each "\n " in `a` already implies a separate line in the
          // outgoing prompt — emit them as `A: <first>` then bare lines.
          const parts = a.split(/\n\s*/);
          lines.push(`A: ${parts[0]}`);
          for (let i = 1; i < parts.length; i++) lines.push(`   ${parts[i]}`);
        }
        const text = lines.join('\n');
        void api.agentSend(sessionId, text);
        markQuestionAnswered(sessionId, block.id, {
          answers: answersByQuestion,
          rejected: false
        });
        bumpComposerFocus();
      }}
      onReject={() => {
        const api = window.ccsm;
        // Reject path: only the can_use_tool flow has a requestId we can
        // settle. For the tool_use-only path there's nothing on the main
        // side to deny — we just drop the card from the sticky and leave
        // the bogus tool_result already in the timeline. Either way the
        // timeline keeps a "rejected" trace row.
        if (api && block.requestId) {
          void api.agentResolvePermission(sessionId, block.requestId, 'deny');
        }
        markQuestionAnswered(sessionId, block.id, {
          answers: {},
          rejected: true
        });
        bumpComposerFocus();
      }}
    />
  );
}
