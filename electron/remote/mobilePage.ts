export function renderMobilePage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CCSM Mobile Remote</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0b1020; color: #e5e7eb; font: 14px system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 10px 12px; background: #111827; border-bottom: 1px solid #263042; }
    #sessions { display: flex; gap: 8px; overflow-x: auto; padding: 8px 12px; background: #0f172a; border-bottom: 1px solid #1f2937; }
    #sessions button { flex: 0 0 auto; border: 1px solid #374151; border-radius: 10px; background: #1f2937; color: #e5e7eb; padding: 8px 12px; font: inherit; }
    #sessions button.active { border-color: #60a5fa; background: #1e3a8a; }
    #terminal { flex: 1; min-height: 0; background: #000; padding: 6px; overflow: auto; }
    #terminal .xterm { height: 100% !important; }
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
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    const statusEl = document.getElementById('status');
    const sessionsEl = document.getElementById('sessions');
    const terminalEl = document.getElementById('terminal');
    const term = new window.Terminal({
      convertEol: false,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#000000' },
      scrollback: 5000,
      cols: 120,
      rows: 30,
    });
    term.open(terminalEl);
    term.onData((data) => {
      if (!activeSid) return;
      send({ type: 'session.input', sid: activeSid, data });
    });

    let activeSid = '';
    let sessions = [];
    let lastCols = 0;
    let lastRows = 0;
    const wsUrl = new URL('/ws', location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', token);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { statusEl.textContent = ' · Connected'; };
    ws.onclose = () => { statusEl.textContent = ' · Disconnected'; };
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
        applySize(msg.cols, msg.rows);
        term.reset();
        term.write(msg.snapshot || '');
        return;
      }
      if (msg.type === 'pty.data' && msg.sid === activeSid) {
        term.write(msg.chunk || '');
        return;
      }
    };

    function applySize(cols, rows) {
      const c = Number.isInteger(cols) && cols > 0 ? cols : lastCols || 120;
      const r = Number.isInteger(rows) && rows > 0 ? rows : lastRows || 30;
      if (c === lastCols && r === lastRows) return;
      lastCols = c;
      lastRows = r;
      try { term.resize(c, r); } catch {}
    }

    function send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }
    function selectSession(sid) {
      activeSid = sid;
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
        btn.textContent = session.sid.slice(0, 8);
        btn.className = session.sid === activeSid ? 'active' : '';
        btn.onclick = () => selectSession(session.sid);
        sessionsEl.appendChild(btn);
      }
    }
  </script>
</body>
</html>`;
}
