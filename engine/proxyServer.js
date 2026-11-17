/**
 * Delta Exchange forwarding proxy (runs on the AWS box).
 *
 * Purpose: make the browser's in-UI "Verify Connection" call egress from the
 * server's WHITELISTED IP instead of Vercel's dynamic egress. The browser signs
 * the request (HMAC over method+timestamp+path+query+body) and sends it here; we
 * forward it verbatim to Delta and relay the response. Because we change nothing
 * about the signed material — only the network hop — the signature stays valid.
 *
 * This is NOT an open proxy: every request is forwarded to a single fixed host
 * (api.india.delta.exchange), never an arbitrary destination.
 *
 * Enabled only when DELTA_PROXY_PORT is set. Put TLS + a stable hostname in front
 * (nginx/Caddy on the Elastic IP) so the browser can reach it over https.
 */
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { unpack } from 'msgpackr';
import { log, logWarn, logError } from './lib/utils.js';
import { COSMIC_BASE } from './lib/cosmicApi.js';

// Cosmic Trade relay (Cosmic Paper tab). Cosmic answers 403 to any request carrying a browser
// Origin, so the dashboard reaches it through here. Read-only public market data only:
//   GET /cosmic/api/v1/{contracts | orderbook/:sym | charts/:sym/(klines|mark-klines|index-klines)}
//   WS  /cosmic/feeds — relayed from wss://cosmic.trade/feeds with the Origin stripped; the
//       upstream msgpack frames are decoded and sent on as JSON text (no msgpack in the browser).
const COSMIC_REST_RE = /^\/cosmic\/api\/v1\/(contracts|orderbook\/[A-Za-z0-9-]+|charts\/[A-Za-z0-9-]+\/(klines|mark-klines|index-klines))(\?|$)/;
const COSMIC_WS_URL = 'wss://cosmic.trade/feeds';
const MAX_COSMIC_CLIENTS = 50;

const DELTA_BASE = 'https://api.india.delta.exchange';

// Headers that are meaningful to Delta / the signature. We forward only these to
// avoid leaking browser hop-by-hop headers (host, origin, cookie, etc.).
const FORWARD_HEADERS = ['api-key', 'signature', 'timestamp', 'content-type', 'user-agent'];

export function startDeltaProxy() {
  const port = parseInt(process.env.DELTA_PROXY_PORT || '', 10);
  if (!Number.isInteger(port) || port <= 0) return null; // opt-in

  // CORS origin(s) allowed to call this proxy from the browser — comma-separated, e.g.
  // "https://ratiospread.vitticapital.ai,https://vitticapital.ai". Default '*' works but pin
  // it to your site(s) for tighter security. The matching request Origin is echoed back.
  const allowOrigin = process.env.DELTA_PROXY_ALLOW_ORIGIN || '*';
  const allowList = allowOrigin.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const originAllowed = (o) => allowList.includes('*') || (!!o && allowList.includes(o));
  const corsFor = (req) => ({
    'Access-Control-Allow-Origin': allowList.includes('*') ? '*'
      : (originAllowed(req.headers.origin) ? req.headers.origin : allowList[0]),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'api-key,signature,timestamp,content-type,user-agent',
    'Access-Control-Max-Age': '86400',
  });

  const server = http.createServer(async (req, res) => {
    const corsHeaders = corsFor(req);
    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Cosmic public market data (GET only, fixed host, allow-listed paths).
    if (req.url.startsWith('/cosmic/')) {
      if (req.method !== 'GET' || !COSMIC_REST_RE.test(req.url)) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'proxy_bad_path' }));
        return;
      }
      try {
        const upstream = await fetch(COSMIC_BASE + req.url.slice('/cosmic'.length), { headers: { 'User-Agent': 'optionscope-proxy' } });
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', ...corsHeaders });
        res.end(text);
      } catch (e) {
        logError('Cosmic proxy forward error:', e);
        res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'proxy_upstream_error', message: e.message }));
      }
      return;
    }

    // Only relay Delta v2 API paths.
    if (!req.url.startsWith('/v2/')) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ success: false, error: { code: 'proxy_bad_path' } }));
      return;
    }

    try {
      // Collect body (if any).
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? Buffer.concat(chunks) : null;

      const headers = {};
      for (const h of FORWARD_HEADERS) {
        const v = req.headers[h];
        if (v) headers[h] = v;
      }

      const target = DELTA_BASE + req.url; // req.url preserves path + query verbatim
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
      });

      const text = await upstream.text();
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        ...corsHeaders,
      });
      res.end(text);
    } catch (e) {
      logError('Delta proxy forward error:', e);
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ success: false, error: { code: 'proxy_upstream_error', message: e.message } }));
    }
  });

  // ── Cosmic WebSocket relay: one upstream socket per browser client ──
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const okOrigin = originAllowed(req.headers.origin);
    if (!req.url.startsWith('/cosmic/feeds') || !okOrigin || wss.clients.size >= MAX_COSMIC_CLIENTS) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(COSMIC_WS_URL); // no Origin header
      const pending = [];
      upstream.on('open', () => { for (const m of pending.splice(0)) upstream.send(m); });
      upstream.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        try {
          const msg = isBinary ? unpack(data) : JSON.parse(data.toString());
          client.send(JSON.stringify(msg, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
        } catch { /* drop undecodable frame */ }
      });
      // Client → upstream: only subscribe / unsubscribe frames, JSON text.
      client.on('message', (data) => {
        let f;
        try { f = JSON.parse(data.toString()); } catch { return; }
        if (!f || (f.action !== 'subscribe' && f.action !== 'unsubscribe') || !Array.isArray(f.symbols)) return;
        const frame = JSON.stringify({ action: f.action, symbols: f.symbols.slice(0, 400).map(String) });
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame); else pending.push(frame);
      });
      const closeBoth = () => { try { upstream.close(); } catch { /* noop */ } try { client.close(); } catch { /* noop */ } };
      upstream.on('close', closeBoth);
      upstream.on('error', (e) => { logWarn(`Cosmic WS relay upstream error: ${e.message}`); closeBoth(); });
      client.on('close', closeBoth);
      client.on('error', closeBoth);
    });
  });

  server.on('error', (e) => logError('Delta proxy server error:', e));
  server.listen(port, () => {
    log(`Delta proxy listening on :${port} → ${DELTA_BASE} (CORS origin: ${allowOrigin})`);
  });

  return server;
}
