export function renderMobilePage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#0b1020" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>CCSM Mobile Remote</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0b1020; color: #e5e7eb; font: 14px system-ui, sans-serif; }
    /* --app-height tracks window.visualViewport.height so the soft keyboard
       (which overlays rather than shrinks the layout viewport on iOS Safari)
       cannot hide the terminal/keybar behind it. Falls back to 100% when
       visualViewport is unavailable (desktop / old browsers). */
    body { display: flex; flex-direction: column; overflow: hidden; height: var(--app-height, 100%); }
    header { padding: 10px 12px; background: #111827; border-bottom: 1px solid #263042; flex: 0 0 auto; }
    #sessions { display: flex; gap: 8px; overflow-x: auto; padding: 8px 12px; background: #0f172a; border-bottom: 1px solid #1f2937; flex: 0 0 auto; }
    #sessions button { flex: 0 0 auto; border: 1px solid #374151; border-radius: 10px; background: #1f2937; color: #e5e7eb; padding: 8px 12px; font: inherit; white-space: nowrap; }
    #sessions button.active { border-color: #60a5fa; background: #1e3a8a; }
    #terminal { flex: 1 1 auto; min-height: 0; background: #000; padding: 6px; overflow: hidden; }
    #terminal .xterm { height: 100% !important; }
    #keybar { display: flex; gap: 6px; overflow-x: auto; padding: 8px 10px; background: #0f172a; border-top: 1px solid #1f2937; flex: 0 0 auto; }
    #keybar button { flex: 0 0 auto; min-width: 44px; border: 1px solid #374151; border-radius: 8px; background: #1f2937; color: #e5e7eb; padding: 10px 12px; font: 13px ui-monospace, Menlo, Consolas, monospace; }
    #keybar button:active { background: #334155; }
    #keybar button.sticky { border-color: #f59e0b; background: #78350f; }
    .muted { color: #9ca3af; }
  </style>
</head>
<body>
  <header>
    <strong>CCSM Mobile Remote</strong>
    <span id="status" class="muted"> · Connecting...</span>
  </header>
  <div id="sessions"><span class="muted">Loading sessions...</span></div>
  <div id="terminal"></div>
  <div id="keybar"></div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';

    // Inject the manifest link carrying the current token so an installed
    // (add-to-home-screen) icon reconnects authenticated. Done from script
    // because the token is per-session and not known at static-HTML time.
    if (token) {
      const manifestLink = document.createElement('link');
      manifestLink.rel = 'manifest';
      manifestLink.href = '/manifest.webmanifest?token=' + encodeURIComponent(token);
      document.head.appendChild(manifestLink);
    }
    const statusEl = document.getElementById('status');
    const sessionsEl = document.getElementById('sessions');
    const terminalEl = document.getElementById('terminal');
    const keybarEl = document.getElementById('keybar');

    const term = new window.Terminal({
      convertEol: false,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#000000' },
      scrollback: 5000,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalEl);

    let activeSid = '';
    let sessions = [];
    // snapSeq is the chunk seq carried by the latest session.snapshot. Live
    // pty.data chunks with seq <= snapSeq are already baked into the snapshot,
    // so we drop them to avoid double-painting. -1 = no snapshot applied yet.
    let snapSeq = -1;
    let ctrlSticky = false;
    let manualClose = false;
    let ws = null;
    let reconnectDelay = 500;
    let lastSentCols = 0;
    let lastSentRows = 0;

    function basename(p) {
      if (!p) return '';
      const parts = String(p).replace(/[\\\\/]+$/, '').split(/[\\\\/]/);
      return parts[parts.length - 1] || p;
    }

    term.onData((data) => {
      if (!activeSid) return;
      if (ctrlSticky) {
        ctrlSticky = false;
        renderKeybar();
        const code = data.charCodeAt(0);
        // Map a-z / A-Z to their control byte (^A = 0x01 ...). Non-letters
        // pass through unchanged so a stuck Ctrl never corrupts other input.
        if (code >= 97 && code <= 122) data = String.fromCharCode(code - 96);
        else if (code >= 65 && code <= 90) data = String.fromCharCode(code - 64);
      }
      send({ type: 'session.input', sid: activeSid, data });
    });

    let fitTimer = null;
    function scheduleFit() {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(doFit, 120);
    }
    function doFit() {
      let dims = null;
      try { dims = fitAddon.proposeDimensions(); } catch {}
      if (!dims || !dims.cols || !dims.rows) return;
      if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      try { term.resize(dims.cols, dims.rows); } catch {}
      if (!activeSid) return;
      if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
      lastSentCols = dims.cols;
      lastSentRows = dims.rows;
      send({ type: 'session.resize', sid: activeSid, cols: dims.cols, rows: dims.rows });
    }
    window.addEventListener('resize', scheduleFit);

    // Keep the layout column exactly as tall as the *visible* viewport. On iOS
    // Safari the soft keyboard overlays the layout viewport (window.innerHeight
    // stays full), so without this the keybar and terminal bottom slide under
    // the keyboard. visualViewport.height excludes the keyboard, so binding the
    // column height to it pins the keybar just above the keyboard.
    const vv = window.visualViewport;
    function syncViewportHeight() {
      if (!vv) return;
      document.body.style.setProperty('--app-height', vv.height + 'px');
      scheduleFit();
    }
    if (vv) {
      vv.addEventListener('resize', syncViewportHeight);
      vv.addEventListener('scroll', syncViewportHeight);
      syncViewportHeight();
    }

    // orientationchange can fire before the new geometry settles, so refit
    // again on a longer delay to read settled dimensions. Idempotent — the
    // cols/rows dedupe in doFit() drops it if nothing actually changed.
    window.addEventListener('orientationchange', () => {
      scheduleFit();
      setTimeout(scheduleFit, 250);
    });

    // Tapping the terminal focuses xterm's hidden textarea, which is what
    // raises the soft keyboard on touch devices.
    terminalEl.addEventListener('touchend', () => term.focus());
    terminalEl.addEventListener('click', () => term.focus());

    function send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    function selectSession(sid) {
      activeSid = sid;
      snapSeq = -1;
      lastSentCols = 0;
      lastSentRows = 0;
      renderSessions();
      term.reset();
      send({ type: 'session.snapshot', sid });
    }

    function renderSessions() {
      sessionsEl.textContent = '';
      if (!sessions.length) {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = 'No live PTY sessions. Open a CCSM session on desktop first.';
        sessionsEl.appendChild(span);
        return;
      }
      for (const session of sessions) {
        const btn = document.createElement('button');
        const label = basename(session.cwd) || session.sid.slice(0, 8);
        btn.textContent = label;
        btn.className = session.sid === activeSid ? 'active' : '';
        btn.onclick = () => selectSession(session.sid);
        sessionsEl.appendChild(btn);
      }
    }

    const KEYS = [
      { label: 'Esc', data: '\\x1b' },
      { label: 'Tab', data: '\\t' },
      { label: 'Ctrl', ctrl: true },
      { label: '↑', data: '\\x1b[A' },
      { label: '↓', data: '\\x1b[B' },
      { label: '←', data: '\\x1b[D' },
      { label: '→', data: '\\x1b[C' },
      { label: '^C', data: '\\x03' },
      { label: 'Enter', data: '\\r' },
    ];
    function renderKeybar() {
      keybarEl.textContent = '';
      for (const key of KEYS) {
        const btn = document.createElement('button');
        btn.textContent = key.label;
        if (key.ctrl && ctrlSticky) btn.className = 'sticky';
        btn.onclick = () => {
          if (key.ctrl) {
            ctrlSticky = !ctrlSticky;
            renderKeybar();
            return;
          }
          if (!activeSid) return;
          send({ type: 'session.input', sid: activeSid, data: key.data });
        };
        keybarEl.appendChild(btn);
      }
    }
    renderKeybar();

    function connect() {
      const wsUrl = new URL('/ws', location.href);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.searchParams.set('token', token);
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        statusEl.textContent = ' · Connected';
        reconnectDelay = 500;
        // Re-subscribe and re-snapshot the active session after a reconnect so
        // the terminal repaints from the authoritative buffer.
        if (activeSid) {
          snapSeq = -1;
          term.reset();
          send({ type: 'session.snapshot', sid: activeSid });
        }
      };
      ws.onclose = () => {
        if (manualClose) return;
        statusEl.textContent = ' · Reconnecting...';
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      };
      ws.onerror = () => { statusEl.textContent = ' · Connection error'; };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sessions.list') {
          sessions = msg.sessions || [];
          renderSessions();
          if (!activeSid && sessions.length) selectSession(sessions[0].sid);
          return;
        }
        if (msg.type === 'session.snapshot' && msg.sid === activeSid) {
          term.reset();
          term.write(msg.snapshot || '');
          snapSeq = Number.isInteger(msg.seq) ? msg.seq : -1;
          scheduleFit();
          return;
        }
        if (msg.type === 'pty.data' && msg.sid === activeSid) {
          // Drop chunks already contained in the snapshot we just painted.
          if (Number.isInteger(msg.seq) && msg.seq <= snapSeq) return;
          term.write(msg.chunk || '');
          return;
        }
      };
    }

    window.addEventListener('beforeunload', () => {
      manualClose = true;
      if (ws) try { ws.close(); } catch {}
    });

    connect();
  </script>
</body>
</html>`;
}
