import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import {
  applyServerMessage,
  controlInput,
  emptyPhoneState,
  selectSession,
  type MobileClientMessage,
  type PhoneState,
} from './phoneApp';
import type { PhoneConnectionStatus, RelayClient } from './relayClient';
import type { TerminalSyncEffect } from './terminalSync';

const HARD_KEYS = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl', ctrl: true },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '←', data: '\x1b[D' },
  { label: '→', data: '\x1b[C' },
  { label: '^C', data: '\x03' },
  { label: 'Enter', data: '\r' },
] as const;

const STATUS_COPY: Record<PhoneConnectionStatus, string> = {
  connecting: 'Connecting…',
  authenticating: 'Securing connection…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  update_required: 'Update required',
  authentication_failed: 'Pairing failed',
  connection_error: 'Connection error',
  closed: 'Disconnected',
};

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || path;
}

export function renderMissingPairing(root: HTMLElement): void {
  root.innerHTML =
    '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Scan the pairing QR code in CCSM to connect.</p></main>';
}

export function createPhonePage(root: HTMLElement, client: RelayClient): () => void {
  root.innerHTML = `
    <div class="phone-shell">
      <header><strong>CCSM Mobile Remote</strong><span id="status" data-remote-status>Connecting…</span></header>
      <nav id="sessions" aria-label="Terminal sessions"><span class="muted">Loading sessions…</span></nav>
      <main id="terminal" aria-label="Terminal"></main>
      <nav id="keybar" aria-label="Terminal keys"></nav>
    </div>`;
  const statusElement = root.querySelector<HTMLElement>('#status')!;
  const sessionsElement = root.querySelector<HTMLElement>('#sessions')!;
  const terminalElement = root.querySelector<HTMLElement>('#terminal')!;
  const keybarElement = root.querySelector<HTMLElement>('#keybar')!;
  const terminal = new Terminal({
    convertEol: false,
    disableStdin: false,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: '#000000' },
    scrollback: 5000,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement);

  let state: PhoneState = emptyPhoneState();
  let ctrlSticky = false;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;
  let orientationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSentCols = 0;
  let lastSentRows = 0;

  function send(message: MobileClientMessage): void {
    void client.send(message).catch(() => undefined);
  }

  function applyTerminalEffects(effects: TerminalSyncEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'reset') terminal.reset();
      else if (effect.type === 'write') terminal.write(effect.data);
      // requestSnapshot carries no direct terminal action; the matching
      // session.snapshot command is already queued by the reducer.
    }
  }

  function renderSessions(): void {
    sessionsElement.textContent = '';
    if (state.sessions.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = 'No live PTY sessions. Open a CCSM session on desktop first.';
      sessionsElement.append(empty);
      return;
    }
    for (const session of state.sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = basename(session.cwd) || session.sid.slice(0, 8);
      button.classList.toggle('active', session.sid === state.activeSid);
      button.addEventListener('click', () => {
        const selection = selectSession(state, session.sid);
        state = selection.state;
        lastSentCols = 0;
        lastSentRows = 0;
        terminal.reset();
        renderSessions();
        for (const command of selection.commands) send(command);
      });
      sessionsElement.append(button);
    }
  }

  function renderKeybar(): void {
    keybarElement.textContent = '';
    for (const key of HARD_KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = key.label;
      if ('ctrl' in key && key.ctrl && ctrlSticky) button.classList.add('sticky');
      button.addEventListener('click', () => {
        if ('ctrl' in key && key.ctrl) {
          ctrlSticky = !ctrlSticky;
          renderKeybar();
          return;
        }
        if (!state.activeSid || !('data' in key)) return;
        send({ type: 'session.input', sid: state.activeSid, data: key.data });
      });
      keybarElement.append(button);
    }
  }

  function fit(): void {
    let dimensions: { cols: number; rows: number } | undefined;
    try {
      dimensions = fitAddon.proposeDimensions();
    } catch {
      return;
    }
    if (
      !dimensions ||
      !Number.isFinite(dimensions.cols) ||
      !Number.isFinite(dimensions.rows) ||
      dimensions.cols < 1 ||
      dimensions.rows < 1
    ) {
      return;
    }
    terminal.resize(dimensions.cols, dimensions.rows);
    if (
      !state.activeSid ||
      (dimensions.cols === lastSentCols && dimensions.rows === lastSentRows)
    ) {
      return;
    }
    lastSentCols = dimensions.cols;
    lastSentRows = dimensions.rows;
    send({
      type: 'session.resize',
      sid: state.activeSid,
      cols: dimensions.cols,
      rows: dimensions.rows,
    });
  }

  function scheduleFit(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(fit, 120);
  }

  function syncViewportHeight(): void {
    if (!window.visualViewport) return;
    document.documentElement.style.setProperty(
      '--app-height',
      `${window.visualViewport.height}px`,
    );
    scheduleFit();
  }

  function focusTerminal(): void {
    terminal.focus();
  }

  const dataDisposable = terminal.onData((rawData) => {
    if (!state.activeSid) return;
    const input = controlInput(rawData, ctrlSticky);
    ctrlSticky = input.ctrlSticky;
    renderKeybar();
    send({ type: 'session.input', sid: state.activeSid, data: input.data });
  });
  const removeMessageHandler = client.onMessage((message) => {
    const previousSid = state.activeSid;
    const transition = applyServerMessage(state, message);
    state = transition.state;
    applyTerminalEffects(transition.terminalEffects);
    for (const command of transition.commands) send(command);
    if (message.type === 'sessions.list') {
      renderSessions();
      if (!previousSid && state.sessions.length > 0) {
        const selection = selectSession(state, state.sessions[0]!.sid);
        state = selection.state;
        renderSessions();
        terminal.reset();
        for (const command of selection.commands) send(command);
      }
      return;
    }
    if (message.type === 'session.snapshot') scheduleFit();
  });
  const removeStatusHandler = client.onStatus((status) => {
    statusElement.textContent = STATUS_COPY[status];
    statusElement.dataset.status = status;
    if (status === 'connected') {
      send({ type: 'sessions.list' });
      if (state.activeSid) {
        const selection = selectSession(state, state.activeSid);
        state = selection.state;
        terminal.reset();
        for (const command of selection.commands) send(command);
      }
    }
  });
  const handleOrientation = () => {
    scheduleFit();
    if (orientationTimer) clearTimeout(orientationTimer);
    orientationTimer = setTimeout(scheduleFit, 250);
  };

  window.addEventListener('resize', scheduleFit);
  window.addEventListener('orientationchange', handleOrientation);
  window.visualViewport?.addEventListener('resize', syncViewportHeight);
  window.visualViewport?.addEventListener('scroll', syncViewportHeight);
  terminalElement.addEventListener('touchend', focusTerminal);
  terminalElement.addEventListener('click', focusTerminal);
  renderKeybar();
  syncViewportHeight();

  return () => {
    removeMessageHandler();
    removeStatusHandler();
    dataDisposable.dispose();
    terminal.dispose();
    if (fitTimer) clearTimeout(fitTimer);
    if (orientationTimer) clearTimeout(orientationTimer);
    window.removeEventListener('resize', scheduleFit);
    window.removeEventListener('orientationchange', handleOrientation);
    window.visualViewport?.removeEventListener('resize', syncViewportHeight);
    window.visualViewport?.removeEventListener('scroll', syncViewportHeight);
    terminalElement.removeEventListener('touchend', focusTerminal);
    terminalElement.removeEventListener('click', focusTerminal);
  };
}
