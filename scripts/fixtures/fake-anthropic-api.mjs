// Fake Anthropic Messages API server for CI.
//
// Why this exists:
//   `scripts/harness-real-cli-ci.mjs` runs a subset of the real-CLI harness
//   against the real `claude` binary in CI. We can't fake the binary (the
//   harness reads claude's TUI byte-for-byte), but we MUST fake the network
//   so CI doesn't need Anthropic credentials.
//
//   The CI subset is curated to AVOID assertions on LLM-generated content
//   (so we don't depend on the fake's reply quality), but `claude` may
//   still hit the API for auth probes, model availability, or stray chat
//   requests when the harness types Enter into the TUI. This server
//   handles all of those:
//
//   - POST /v1/messages           : streaming SSE chat completion. Content
//                                   chosen from the prompt: if the user's
//                                   last message asks for "ALPHA" we reply
//                                   ALPHA; for "PONG" we reply PONG; for
//                                   "ack" we reply ack; otherwise "ok".
//   - GET  /v1/models             : minimal models list (some claude code
//                                   builds probe this to enumerate available
//                                   models on cold start).
//   - any other path              : 200 OK + empty JSON, logged to stderr
//                                   so a future case extension knows what
//                                   to add.
//
// Wire format reference:
//   https://docs.anthropic.com/en/api/messages-streaming
//   Events: message_start, content_block_start, content_block_delta
//           (text_delta), content_block_stop, message_delta, message_stop.
//   Each event is `event: <name>\ndata: <json>\n\n`.
//
// Usage (standalone, e.g. for local repro):
//   node scripts/fixtures/fake-anthropic-api.mjs --port=11434
//   ANTHROPIC_BASE_URL=http://127.0.0.1:11434 \
//     ANTHROPIC_API_KEY=fake-ci-key claude
//
// Usage (programmatic — used by harness-real-cli-ci.mjs):
//   import { startFakeAnthropicApi } from './fixtures/fake-anthropic-api.mjs';
//   const { url, port, stop } = await startFakeAnthropicApi({ port: 0 });
//
// Implementation notes:
//   - Node stdlib only (`http`, `crypto`). No new deps.
//   - Binds 127.0.0.1, never 0.0.0.0 — safer on CI hosts.
//   - Port 0 = OS-assigned (use the returned `port`); fixed port is for
//     the standalone mode only.
//   - All responses log to stderr with a `[fake-anthropic]` prefix so they
//     don't contaminate harness stdout.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Pick a reply text from the last user message. Content-aware so the
 * harness can assert on specific tokens without us needing to extend the
 * server every time a new probe asks for a new word. The matchers are
 * case-insensitive and look at the LAST user message (which is what
 * claude code sends — earlier turns are history).
 */
function chooseReply(messages) {
  const last = Array.isArray(messages)
    ? [...messages].reverse().find((m) => m && m.role === 'user')
    : null;
  const raw = last
    ? (typeof last.content === 'string'
        ? last.content
        : Array.isArray(last.content)
          ? last.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ')
          : '')
    : '';
  const text = raw.toLowerCase();
  // Order matters: longer / more specific tokens first.
  if (text.includes('alpha')) return 'ALPHA';
  if (text.includes('pong')) return 'PONG';
  if (text.includes('pineapple')) return 'PROBE_IMPORT_PINEAPPLE acknowledged';
  if (/\back\b/.test(text) || text.includes('reply with: ack')) return 'ack';
  if (text.includes('beta')) return 'BETA';
  if (text.includes('omega')) return 'OMEGA';
  return 'ok';
}

function sseLine(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSSEResponse(res, replyText, model) {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const usage = { input_tokens: 1, output_tokens: Math.max(1, replyText.length) };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(sseLine('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: model || 'claude-sonnet-4-5-20250929',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
    },
  }));
  res.write(sseLine('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }));
  // Single-chunk delta is the minimum viable streaming output. claude code's
  // SSE parser handles single-chunk OR multi-chunk deltas identically; we
  // pick single-chunk for determinism.
  res.write(sseLine('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: replyText },
  }));
  res.write(sseLine('content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  }));
  res.write(sseLine('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  }));
  res.write(sseLine('message_stop', { type: 'message_stop' }));
  res.end();
}

function jsonResponse(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      // Sanity cap so a misbehaving client can't OOM the server.
      if (total > 4 * 1024 * 1024) {
        req.destroy(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Start the fake server. Returns { url, port, stop }.
 *
 * @param {object} [opts]
 * @param {number} [opts.port=0]    Port to bind (0 = OS-assigned).
 * @param {string} [opts.host='127.0.0.1']
 * @param {boolean} [opts.verbose=false]  Log every request.
 */
export async function startFakeAnthropicApi(opts = {}) {
  const { port = 0, host = '127.0.0.1', verbose = false } = opts;

  const server = createServer(async (req, res) => {
    const reqUrl = req.url || '/';
    // Strip query string for routing — `?beta=...` etc.
    const pathname = reqUrl.split('?')[0];
    const method = req.method || 'GET';
    if (verbose) {
      process.stderr.write(`[fake-anthropic] ${method} ${reqUrl}\n`);
    }

    try {
      // Streaming chat completion.
      if (method === 'POST' && pathname === '/v1/messages') {
        const body = await readBody(req).catch(() => ({}));
        const stream = body && body.stream !== false; // claude code always streams
        const reply = chooseReply(body && body.messages);
        const model = body && typeof body.model === 'string' ? body.model : null;
        if (verbose) {
          process.stderr.write(`[fake-anthropic]   reply=${JSON.stringify(reply)}\n`);
        }
        if (stream) {
          writeSSEResponse(res, reply, model);
        } else {
          // Non-streaming fallback. Matches the Anthropic non-stream shape.
          jsonResponse(res, 200, {
            id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'message',
            role: 'assistant',
            model: model || 'claude-sonnet-4-5-20250929',
            content: [{ type: 'text', text: reply }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: reply.length },
          });
        }
        return;
      }

      // Minimal models list. Some claude code builds enumerate models on
      // first launch; returning an empty data array is enough to satisfy
      // the parser without us guessing the full per-model shape.
      if (method === 'GET' && pathname === '/v1/models') {
        jsonResponse(res, 200, { data: [], has_more: false, first_id: null, last_id: null });
        return;
      }

      // Default catch-all: 200 + {} so the CLI never crashes on an unknown
      // probe path. Log so a future case extension can grep the CI logs
      // and add a real handler. NOT 404 because some clients treat 404 as
      // fatal even when the body is well-formed.
      process.stderr.write(`[fake-anthropic] UNKNOWN ${method} ${reqUrl} -> 200 {}\n`);
      jsonResponse(res, 200, {});
    } catch (err) {
      process.stderr.write(`[fake-anthropic] error handling ${method} ${reqUrl}: ${err?.stack || err}\n`);
      try {
        jsonResponse(res, 500, { type: 'error', error: { type: 'fake_internal', message: String(err) } });
      } catch (_) { /* socket may already be dead */ }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  let stopped = false;
  const stop = () => {
    if (stopped) return Promise.resolve();
    stopped = true;
    return new Promise((resolve) => {
      try {
        server.closeAllConnections?.();
      } catch (_) { /* node <18.2 */ }
      server.close(() => resolve());
    });
  };

  process.stderr.write(`[fake-anthropic] listening at ${url}\n`);
  return { url, port: actualPort, stop, server };
}

// Standalone entry point: `node scripts/fixtures/fake-anthropic-api.mjs --port=11434 --verbose`
// Only auto-run if argv[1] is present AND resolves to this file. When the
// module is imported (e.g. by `harness-real-cli-ci.mjs`) argv[1] is the
// importer's path, not ours, so the standalone block stays dormant.
const _entry = process.argv[1];
const _isMain = !!_entry && (() => {
  try {
    return new URL(`file://${_entry.replace(/\\/g, '/')}`).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (_isMain) {
  const args = process.argv.slice(2);
  let port = 11434;
  let verbose = false;
  for (const a of args) {
    if (a.startsWith('--port=')) port = Number(a.slice('--port='.length));
    else if (a === '--verbose') verbose = true;
  }
  startFakeAnthropicApi({ port, verbose }).then(({ url, stop }) => {
    process.stderr.write(`[fake-anthropic] ready at ${url}\n`);
    const onSignal = async (sig) => {
      process.stderr.write(`[fake-anthropic] received ${sig}, shutting down\n`);
      await stop();
      process.exit(0);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }).catch((err) => {
    process.stderr.write(`[fake-anthropic] failed to start: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
