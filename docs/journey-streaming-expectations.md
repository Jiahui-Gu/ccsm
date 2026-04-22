# Journey: streaming + interrupt + cross-session switch — expectations

Written BEFORE looking at `src/agent/lifecycle.ts`, `electron/agent/control-rpc.ts`,
`electron/agent/sessions.ts`, or any of the streaming render path. These are the
behaviors a user expects from the product, asserted later by probes that drive
the store/UI directly via the existing IPC + store surface.

Mocking strategy: probes inject streaming "frames" by calling the same store
mutators (`streamAssistantText`, `appendBlocks`, `setRunning`, `markInterrupted`,
`enqueueMessage`) that the lifecycle layer drives in production. We never spawn
`claude.exe`; tests are isolated under `mkdtemp` userData dirs.

## Journey 1: stream survives a session switch and back

User has Session A streaming a long reply (30 chunks). Mid-stream (after chunk
10), the user clicks Session B in the sidebar to check on it. After a few
seconds they switch back to A.

Expectations:
- The active view changes to B's chat when the user clicks B (no part of A's
  partial stream leaks into B's chat).
- While the user is on B, A's stream **continues to advance in the background**
  (it must NOT pause or be tied to the active view's mount lifecycle).
- When the user switches back to A, they see the full reply that arrived in
  the meantime — chunks 11..30 are present, not lost or replayed from chunk 10.
- The assistant block in A is a single contiguous block (id stable across all
  chunks) — no torn / duplicated blocks from the switch.
- After the final chunk and the synthetic finalize, the streaming caret is
  gone in A (block.streaming === false).

## Journey 2: Esc interrupts a streaming reply cleanly

While Session A is streaming and the composer is focused (or anywhere in
the renderer), user presses Esc.

Expectations:
- Stream halts: no further deltas land on the in-flight assistant block once
  the lifecycle layer translates the result frame.
- A neutral status block titled "Interrupted" is rendered in chat
  (`role="status"`, NOT `role="alert"`, NOT red-toned).
- The streaming caret on the in-flight assistant block disappears (block
  `streaming` flag false).
- Composer focus returns to the textarea so the user can type immediately.
- Stop button is replaced by the Send affordance (running flips to false).

## Journey 3: Esc clears the message queue

While Session A is running, user pastes/types and Enters 3 follow-up messages
(they are queued, the chip shows "+3 queued"). User then presses Esc.

Expectations:
- The running turn is interrupted (per Journey 2).
- The queue is **emptied** — chip vanishes, `messageQueues[sid]` length 0.
- Esc does NOT just stop the running turn while leaving the 3 queued items to
  drain into a fresh turn (that would feel surprising and contradicts the CLI
  Ctrl+C parity already established in `probe-e2e-esc-interrupt.mjs`).

## Journey 4: parallel streams stay isolated per session

User starts a turn on A, switches to B, starts another turn on B. Both are
streaming concurrently from their respective backend processes.

Expectations:
- Frames addressed to A's session id only mutate A's `messagesBySession[A]`.
- Frames addressed to B's session id only mutate B's `messagesBySession[B]`.
- No assistant chunks bleed across sessions.
- After both finalize, each session's chat contains exactly its own complete
  reply. Length(A) does not equal length(B) when the deltas are different,
  proving no merge.
- Both streams' caret pulses turn off independently after their respective
  finalize.

## Journey 5: streaming caret lifecycle (visible during, gone after, gone on interrupt)

Expectations:
- During streaming: at least one `span.animate-pulse` is rendered inside the
  in-flight assistant block.
- After finalize (terminal `appendBlocks` with the same block id and
  `streaming` cleared): the caret disappears for that block.
- After Esc-interrupt while streaming: the caret on the in-flight block also
  disappears (it is wrong for a half-finished block to keep pulsing forever
  after the user told it to stop).

## Boundary breakers (deliberately stress, not just happy path)

- Switch sessions DURING the delta burst (not just between bursts) — drift
  between active session id and frame routing is a real bug class.
- Queue 3 messages, NOT 1, before Esc — covers the "clear all" vs "drop head
  only" regression.
- Two parallel streams with deltas interleaved (A,B,A,B,A,A,B,…) so any
  shared mutable cursor in the streaming reducer would corrupt one of them.
- Interrupt while caret is still pulsing — finalize-by-interrupt path must
  clear streaming flag, not just stop appending.
