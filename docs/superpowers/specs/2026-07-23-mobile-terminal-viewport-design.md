# Mobile Terminal Independent Viewport

**Date:** 2026-07-23
**Status:** Approved
**Scope:** Terminal geometry, synchronization, and phone viewport behavior only.
The separately tracked mobile Send fix is out of scope.

## Goal

Keep one shared Claude PTY at the desktop's useful width while making its
canonical terminal grid readable and navigable on a phone. Desktop and phone
must render the same ordered PTY byte history at the same logical dimensions,
without allowing phone layout changes to resize the PTY.

## Canonical geometry

Each live session has one canonical logical `cols x rows` owned by the main
process:

- the currently visible desktop terminal is the sole resize authority;
- continuous desktop window or pane dragging is debounced for approximately
  120-150 ms before a canonical resize is committed;
- hidden desktop shells, the phone, and the relay cannot request a canonical
  resize;
- when no desktop terminal is mounted, the main process retains the session's
  last canonical dimensions; a newly spawned session uses the existing
  defaults until a visible desktop terminal commits a size;
- phone `visualViewport` changes, software-keyboard appearance, orientation,
  container measurements, and xterm fit calculations affect only the physical
  phone viewport.

The main-process PTY entry and its headless xterm mirror remain the geometry
source of truth. Desktop renderer measurements continue to cross the typed
preload bridge before main validates and commits them. Code under `src/`
continues to access main-process behavior only through `window.ccsm`; it never
imports from `electron/`.

## Data flow

```text
Visible desktop terminal
  measure -> debounce -> preload IPC
                         |
                         v
Main PTY session: canonical cols/rows + geometry epoch + PTY sequence
  | resize node-pty and headless xterm
  | create ordered snapshot barrier
  |
  +---- desktop renderer: canonical snapshot/live bytes
  |
  +---- encrypted relay: opaque ordered messages
                           |
                           v
Phone terminal sync: resize to canonical grid -> reset/snapshot -> live tail
                           |
                           v
Phone viewport: independent horizontal pan + vertical scroll controls
```

The relay continues to carry strict, ordered raw PTY chunks and serialized
snapshots. It does not interpret ANSI output or create a second terminal model.
Session synchronization and snapshots additionally carry the canonical
dimensions and enough geometry-revision information to associate every chunk
with the dimensions under which it was produced.

Exact field names may follow existing shared types. The protocol contract must
represent:

- canonical columns and rows on authoritative session state and snapshots;
- a monotonic per-session geometry epoch or equivalent barrier identity;
- the existing monotonic PTY byte sequence;
- an authoritative resize snapshot barrier identified by
  `(canonical dimensions, geometry epoch, snapshot sequence)`;
- the geometry epoch associated with live chunks, so stale or future-geometry
  chunks cannot be applied to the wrong grid.

These additions belong in browser-safe shared protocol types. Existing message
validation, encryption, frame bounds, and version compatibility rules continue
to apply.

## Ordered desktop resize barrier

A committed desktop dimension change is an authoritative snapshot barrier, not
an ordinary best-effort resize notification. The per-session terminal
synchronization coordinator serializes the transition:

1. Finish publishing all already-sequenced old-geometry chunks.
2. Increment the session geometry epoch and pause publication of subsequent
   live chunks for that session.
3. Resize node-pty and the authoritative headless xterm to the committed
   `cols x rows`.
4. Capture one headless snapshot and the PTY sequence represented by it. Bytes
   emitted during the resize and redraw are either represented by that snapshot
   or remain in the strictly sequenced tail.
5. Publish the authoritative barrier before releasing newer live chunks.
6. Resume ordered live publication for the new epoch.

Only one resize barrier may be in progress per session. A later debounced
desktop measurement is processed after the current barrier, and a no-op
measurement matching the canonical size creates no epoch or snapshot.
Snapshot requests from session selection, reconnect, or gap recovery use the
same coordinator. If a resize barrier is active, the response waits for that
barrier or returns a later complete epoch; it can never pair pre-resize content
with post-resize dimensions.

On receipt of a barrier, the phone uses the existing strict terminal
synchronization state machine:

1. Pause live application and buffer racing chunks by sequence under the
   existing bounded-buffer rules.
2. Reject stale epochs, stale snapshots, duplicate sequences, and chunks for a
   different session.
3. Resize the phone xterm exactly once to the barrier's canonical dimensions.
4. Apply exactly one `reset()` plus authoritative snapshot at the barrier
   sequence.
5. Discard buffered chunks covered by the snapshot, then drain the newer
   contiguous tail in sequence order.
6. Resume live application only after the tail is contiguous for the installed
   epoch.

A gap, future epoch without its barrier, invalid geometry, buffer overflow, or
snapshot/live mismatch requests one fresh authoritative snapshot and remains in
syncing state. The last valid frame stays visible until replacement succeeds.
This extends the current strict snapshot/live recovery path; it must not create
a parallel resize state machine.

The visible result of a desktop resize is one content reflow or Claude/Ink TUI
redraw and a changed horizontal extent on the phone. Users must not see
mixed-geometry chunks, duplicated or missing output, cursor corruption, font
scaling, composer movement, or a keyboard-focus change.

## Phone viewport

The phone xterm always interprets bytes at the canonical dimensions. Its grid
uses a readable normal font size and retains the calculated pixel width of all
canonical columns. A separate physical viewport clips that grid and provides
native horizontal panning when the grid is wider than the phone.

Phone layout changes update the physical viewport and safe-area/keyboard
placement only. Any local fit measurement is advisory for viewport metrics and
must not resize xterm to phone dimensions or emit `session.resize`.

Native touch behavior remains available on the terminal surface:

- horizontal and vertical touch scrolling;
- text selection and copy;
- no terminal tap, pan, selection, scrollbar action, snapshot, resize,
  reconnect, or session switch focuses xterm's helper textarea;
- the composer remains the only software-keyboard entry surface.

### Persistent vertical scrollbar

The phone shows a persistent custom scrollbar at the right edge:

- the touch rail is approximately 24 CSS pixels wide;
- the thumb is at least 44 CSS pixels tall;
- dragging the thumb uses pointer capture and maps directly to xterm's logical
  `viewportY`;
- clicking or tapping the track jumps to the corresponding logical scroll
  position;
- scrollbar pointer handling never calls terminal or helper-textarea focus and
  never summons the software keyboard;
- with no scrollback, the rail remains visible with a disabled full-height
  thumb.

The xterm buffer is the scroll truth:

```text
maximumTop = buffer.active.baseY
currentTop = buffer.active.viewportY
visibleRows = terminal.rows
totalRows = maximumTop + visibleRows
```

Thumb geometry is a pure projection of those values and the measured track
height, with clamping for zero scrollback and the minimum thumb size. Drag and
track-click calculations map back to a clamped logical line and call xterm's
public scroll APIs. The scrollbar does not synchronize through DOM
`scrollTop`.

### Output-follow and history anchor

Before a snapshot barrier, reconnect, or session switch, the phone records a
logical anchor:

- if the terminal is at bottom, it remains in follow-output mode;
- if it is scrolled up, record its distance from the bottom in logical lines.

After resize, snapshot replacement, and contiguous-tail drain, follow-output
scrolls to the new bottom. History mode restores the nearest available position
with the same distance from bottom, clamped when older history is unavailable.
New live output follows only in follow-output mode. A per-session anchor is
recomputed on session switch and reconnect; a session with no saved anchor
starts at bottom.

Horizontal pan is physical viewport state. Preserve it when the canonical width
is unchanged, and clamp it to the new horizontal extent after a resize,
snapshot, reconnect, orientation change, keyboard change, or session switch.

## Component boundaries

- **`electron/ptyHost/`** owns per-session canonical dimensions, desktop resize
  validation, the PTY/headless resize, geometry epoch, and authoritative
  snapshot barrier creation.
- **`electron/remote/`** forwards barrier snapshots and ordered raw chunks
  through the current peer/fanout path. Phone resize commands are removed or
  rejected and never reach `resizePtySession`.
- **Desktop `src/terminal/`** measures only the visible desktop terminal,
  debounces continuous drag, and invokes the existing typed preload resize
  surface.
- **Shared browser-safe protocol types** describe canonical geometry, epoch,
  sequence, and barrier semantics without importing Electron or Node APIs.
- **`src/mobile/terminalSync.ts`** extends the existing bounded, exactly-once
  snapshot/live reducer with geometry epochs and barrier effects.
- **`src/mobile/mobileTerminalAdapter.ts`** applies canonical xterm resize,
  reset/write effects, exposes logical scroll metrics/actions, and treats
  `visualViewport` and orientation as physical viewport concerns.
- **`src/mobile/components/MobileTerminal.tsx`** owns the clipped/pannable
  viewport and composes the persistent scrollbar. React does not render
  terminal rows or remount xterm during synchronization.

## State and error handling

- A live PTY retains its in-memory canonical dimensions while no desktop is
  mounted; a new PTY initializes from the existing PTY defaults.
- Desktop unmount or disconnect freezes the current canonical dimensions.
- A stale barrier or chunk is ignored; a future epoch or sequence gap triggers
  the existing single-snapshot recovery path.
- A superseded snapshot cannot replace a newer installed epoch.
- Invalid, non-integral, or unsafe dimensions fail protocol validation and do
  not mutate PTY, headless xterm, or phone xterm.
- Bounded-buffer overflow is observable in diagnostics and forces snapshot
  recovery; it cannot silently drop into live mode.
- Reconnect keeps the last valid frame visible, then installs one current
  canonical snapshot before enabling live application.
- Session exit keeps the last frame and disables input using the existing
  session state; it does not reset geometry to the phone size.
- Terminal synchronization errors do not clear drafts, move the composer,
  focus the terminal, or replay input.

## Accessibility

- The scrollbar exposes `role="scrollbar"`, orientation, minimum, maximum, and
  current logical positions, and names the terminal it controls.
- Keyboard operation supports arrows, Page Up/Down, Home, and End without
  transferring focus to xterm.
- The edge rail remains high contrast in forced-colors mode; status and disabled
  state do not rely on color alone.
- The thumb's minimum height is 44 CSS pixels, and drag remains usable under
  browser zoom and device pixel scaling.
- Terminal text keeps a readable normal font size and can be selected and copied
  without opening the software keyboard.
- Horizontal overflow has a discoverable visual affordance and does not trap
  keyboard focus.

## Rejected alternatives

- **Phone-owned PTY dimensions:** reproduced the desktop's narrow layout and
  allows keyboard/orientation changes to disrupt Claude.
- **Fixed global PTY dimensions:** avoids ownership races but wastes available
  desktop area.
- **Independent local terminal dimensions over one raw stream:** ANSI cursor
  movement, wrapping, and Claude/Ink redraws diverge and corrupt the display.
- **Two Claude PTYs for one session:** creates input, transcript, permission,
  and lifecycle races.
- **Semantic JSONL phone UI:** requires a large future redesign and cannot
  preserve the current live TUI behavior.

## Testing and acceptance

### Automated contracts

- desktop-only resize authority, including hidden/unmounted desktop shells;
- phone viewport, keyboard, orientation, and fit changes emit no PTY resize;
- canonical dimensions and geometry epoch propagate through session state,
  snapshots, and ordered chunks;
- active output during resize, including snapshot/live overlap, produces one
  barrier, one reset, and one contiguous tail with no duplicates or gaps;
- continuous desktop drag produces debounced barriers around 120-150 ms rather
  than one barrier per measurement;
- stale, duplicate, future-epoch, malformed, overflow, and superseded-barrier
  recovery;
- reconnect and session switching recompute canonical geometry, horizontal
  extent, and per-session scroll anchors;
- horizontal pan across a grid wider than portrait and landscape viewports;
- custom scrollbar geometry, minimum thumb, disabled empty-scrollback state,
  drag mapping, pointer capture, and track-click jump;
- at-bottom output following and distance-from-bottom history restoration across
  live output, barriers, reconnect, and session switches;
- terminal text selection and copy remain native, and terminal/scrollbar actions
  never focus the helper textarea or open the keyboard;
- portrait, landscape, software-keyboard open/close, browser zoom, and safe-area
  layouts leave canonical PTY dimensions unchanged;
- serialized phone and authoritative headless buffers reach exact byte/ANSI
  parity after every recovery scenario.

### End-to-end and physical phone

The deterministic PTY fixture must combine long lines, wraps, cursor movement,
progress redraws, clear-screen sequences, alternate-screen transitions, and
continuous output while desktop resize barriers, delayed snapshots, duplicated
chunks, gaps, reconnects, and session switches are injected. Final phone xterm
serialization must exactly match the authoritative headless buffer at the same
canonical dimensions and sequence.

A real Claude session must demonstrate one visible redraw per debounced desktop
resize, stable composer placement, unchanged keyboard focus, readable terminal
text, horizontal pan, vertical thumb drag and track jump, history preservation,
selection/copy, rotation, keyboard open/close, reconnect, and session switch.

Final acceptance requires a physical phone on the public relay. Two separately
tracked physical bugs must pass together in the final retest:

1. Send must not require an extra Enter.
2. Connecting or resizing the phone must not shrink the desktop terminal.

This design addresses the desktop-shrink geometry bug. It does not design or
implement the Send fix.

## Success criteria

- The visible desktop terminal alone determines each shared PTY's logical size.
- Phone layout changes never mutate PTY geometry.
- Desktop resize produces one ordered authoritative snapshot barrier and no
  mixed-geometry rendering.
- Phone output preserves exact ordered parity with the main headless terminal.
- Phone users can read, pan, scroll, select, and copy the canonical grid without
  accidental keyboard activation.
- Both tracked physical bugs pass together before release.
