# Mobile Remote Shared UI

**Date:** 2026-07-21  
**Status:** Approved  
**Target release:** v0.3.0 after implementation and real-device acceptance

## Goal

Give the phone remote the same visual language, session hierarchy, runtime
status, and terminal workflow as the desktop app while adapting navigation and
input for a narrow touch screen.

The first release covers the high-frequency control path:

- grouped live-session navigation;
- session names, working directories, ordering, and runtime state;
- terminal output, composed text input, and discrete control keys;
- session switching;
- touch-friendly terminal keys;
- explicit connection, reconnect, authentication, version, and empty states.

Creating, moving, renaming, archiving, importing, searching, and configuring
sessions remain desktop-only in this release.

This design supersedes the UI architecture in
`2026-05-30-mobile-polish-design.md`. The visual viewport, orientation, xterm
focus, and PWA requirements from that document still apply.

## Design principles

1. **One product language.** Desktop and phone share tokens, state glyphs,
   navigation presentation, and terminal chrome.
2. **Terminal first on phone.** The terminal receives the full viewport until
   the user asks to navigate.
3. **Shared presentation, separate platform state.** Reusable React components
   consume platform-neutral view models. Electron and relay clients retain
   their own adapters.
4. **Small remote surface.** The phone receives only metadata for currently
   controllable PTY sessions.
5. **Preserve proven infrastructure.** Existing PTY ownership, Zustand
   persistence, Electron IPC, end-to-end encryption, and Cloudflare relay stay
   intact.

## Approaches considered

### Shared React presentation and platform adapters — selected

Convert the phone PWA to React. Extract reusable design tokens and pure
presentation components from the desktop sidebar. Desktop Zustand selectors
and a phone remote store both produce the same navigation view model.

This gives durable visual parity without coupling a browser page to Electron.

### Run the complete desktop app responsively

Replace Electron bridges with remote adapters and render the full desktop app
on the phone. This maximizes apparent reuse but exposes many unavailable
desktop actions, expands the remote API substantially, and couples remote
reliability to desktop-only effects.

### Continue the standalone DOM page

Copy desktop colors and spacing into the current imperative page. This ships
quickly but keeps two component systems and will drift after future desktop
changes.

## Architecture

```text
Desktop renderer                      Phone PWA
----------------                      ---------
Zustand selectors                     MobileRemoteStore
        |                                     |
        +------ SessionNavigatorModel --------+
                       |
        Shared React presentation components

Desktop main process                 Encrypted relay
--------------------                 ---------------
DB metadata + PTY registry  <----->  MobileRemoteStore
+ runtime session state              + xterm adapter
```

Shared modules remain browser-safe and import no Electron or Node-only APIs.
The desktop renderer still communicates exclusively through preload bridges.
The phone app does not load the desktop Zustand store or desktop lifecycle
effects.

The refactor may improve desktop component boundaries where that directly
enables reuse. It does not replace the desktop state layer or terminal
registry.

## Shared view model

The platform-neutral navigation model is:

```ts
type SessionNavigatorModel = {
  groups: Array<{
    id: string;
    name: string;
    order: number;
    collapsed: boolean;
    sessions: Array<{
      id: string;
      name: string;
      cwd: string;
      state: 'active' | 'idle' | 'waiting' | 'exited';
      order: number;
    }>;
  }>;
  activeSessionId: string | null;
};
```

Exact names may follow existing repository types during implementation, but
the model must preserve this information and remain independent of transport
and persistence details.

The desktop main process assembles remote navigation data from persisted group
and session metadata, the live PTY registry, and runtime session state. It
filters out sessions without a controllable PTY before encrypting and sending
the model. The phone cannot request arbitrary database records.

Navigation updates are versioned messages over the existing encrypted
protocol. A full model is sent after authentication and reconnect. Incremental
updates may follow only if measurements show a need; the one-user session list
is small enough for full replacement by default.

## Components

### Shared presentation

- `SessionNavigator` renders groups, ordering, collapse state, session names,
  working directories, selection, and runtime status.
- `SessionStateGlyph` renders the same active, idle, waiting, and exited
  semantics on both platforms.
- shared design tokens provide app, sidebar, active-row, border, foreground,
  muted, success, warning, and error values.
- shared row primitives define density, typography, truncation, and focus
  treatment while accepting platform-specific interaction handlers.

Drag-and-drop, context menus, resize handles, window drag regions, and desktop
action buttons remain desktop wrappers around the shared presentation.

### Phone shell

- a compact top bar shows the menu button, active session name, group and
  working directory, plus a connection signal;
- the terminal fills all remaining space;
- the menu opens a left drawer containing the shared grouped session
  navigator;
- selecting a session closes the drawer and requests its current terminal
  snapshot;
- the bottom controls contain a horizontally scrollable key bar and a persistent
  text composer, with safe-area padding;
- `visualViewport`, orientation refit, and PWA standalone behavior remain
  supported.

The drawer is temporary in portrait mode. A later tablet breakpoint may pin it
open, but v0.3.0 does not require a tablet-specific split view.

## Phone input model

The terminal is a read, scroll, select, and copy surface. Tapping it never
focuses xterm's hidden textarea and never opens the software keyboard. The
composer textarea is the phone's only software-keyboard entry point:

- focusing the composer allows the operating system to show the keyboard;
- blurring the composer or dismissing the keyboard allows it to close;
- session output, connection changes, permission prompts, and
  `AskUserQuestion` never call `focus()` or `blur()`;
- Return inserts a local newline and the explicit Send button submits the
  complete draft;
- a successful submission clears the draft; a rejected submission preserves
  it with a visible error;
- changing sessions and transient disconnects preserve a separate local draft
  for each session;
- reconnect never submits or replays a draft automatically.

The key bar sends discrete PTY control input without focusing the composer. It
provides Esc, Tab, Up, Down, Left, Right, Space, digits 1 through 4, Ctrl+C, and
Enter. These keys cover Claude's native permission and question selectors while
keeping the underlying terminal UI visible.

`AskUserQuestion` remains Claude's native PTY interface in v0.3.0. The user
selects an option with the key bar. When an option requests free text, the user
enters that text in the same composer and sends it. The phone does not parse
terminal output, infer question state, create a separate form, or change
keyboard focus automatically.

Text submission uses a complete-draft protocol message rather than streaming
IME composition events. The desktop validates the target session, normalizes
CRLF to LF, applies the PTY's bracketed-paste mode when active, writes the
complete draft, and then writes Enter. An empty draft is not submitted. The
message is not recoverable or replayable by the relay, matching existing
`session.input` safety semantics.

Live slash-command and `@`-file completion, shell history search, Vim-style
editing, and arbitrary raw-key streaming are deferred. Complete slash commands
such as `/status` remain supported through the composer.

## Connection and error states

The phone keeps the last terminal frame visible during transient disconnects.
It disables Send and the key bar, preserves per-session drafts, and shows a
non-modal reconnect banner. Successful reconnect performs these steps in order:

1. authenticate the encrypted peer;
2. fetch the latest navigation model;
3. retain the active session when it is still live, otherwise select the first
   live session;
4. fetch an authoritative terminal snapshot and sequence;
5. resume input and live PTY frames.

The UI distinguishes:

- connecting and authenticating;
- reconnecting with automatic retry;
- desktop offline or remote control paused;
- pairing rejected or rotated;
- protocol update required;
- no live sessions;
- selected session exited;
- unrecoverable relay connection error with a manual Retry action.

Errors never clear the last terminal output. Pairing and version errors stop
automatic retries until the user rescans or updates.

## Accessibility and touch behavior

- interactive targets are at least 44 CSS pixels on phone;
- the drawer traps focus while open and closes with Escape, backdrop tap, or
  session selection;
- status is conveyed through text and glyph shape in addition to color;
- session rows expose selected and expanded states to assistive technology;
- focus rings use the shared desktop token;
- terminal controls and the composer account for bottom safe-area insets and
  the visible viewport above the software keyboard;
- terminal selection and copy remain available without opening the keyboard;
- the composer has an accessible label, and key-bar buttons expose their PTY
  action rather than only their displayed symbol.

## Testing and acceptance

### Automated

- unit tests for shared selectors, view models, presentation components, and
  phone state transitions;
- protocol contract tests for navigation messages and malformed metadata;
- desktop regression tests for grouped navigation, selection, and runtime
  glyphs after extraction;
- phone component tests for drawer behavior, session switching, per-session
  drafts, explicit submission, reconnect input gating, empty states, and
  keyboard controls;
- input contract tests for multiline and CJK IME drafts, CRLF normalization,
  bracketed paste, successful clearing, failed-send preservation, and no replay
  after reconnect;
- visual snapshots at representative portrait, landscape, and narrow desktop
  sizes;
- public-relay Playwright E2E that scans/imports pairing, runs `/status` from
  the phone composer, copies terminal output without opening the keyboard,
  answers selection and free-text `AskUserQuestion` paths, switches sessions,
  interrupts input, rotates orientation, disconnects and reconnects with a
  preserved unsent draft, and re-pairs in an existing tab.

### Release gate

v0.3.0 is created only after:

1. typecheck, lint, unit/integration tests, production builds, and required CI
   checks pass;
2. the public Cloudflare deployment passes the real desktop + real Claude CLI
   E2E;
3. a physical phone confirms readable navigation, terminal selection without
   keyboard activation, reliable CJK and multiline composition, native
   `AskUserQuestion` selection and free-text answers, no composer or key-bar
   occlusion, session switching, and reconnect recovery without input replay;
4. the desktop UI has no navigation or terminal regression.

## Rollout

The shared UI lands as a separate feature PR after the encrypted relay
foundation is merged. The project version remains `0.2.20` during
implementation. The first release containing the redesigned phone experience
is `v0.3.0`.
