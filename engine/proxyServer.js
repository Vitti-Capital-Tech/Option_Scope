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
import { log, logWarn, logError } from './lib/utils.js';

const DELTA_BASE = 'https://api.india.delta.exchange';

// Headers that are meaningful to Delta / the signature. We forward only these to
// avoid leaking browser hop-by-hop headers (host, origin, cookie, etc.).
const FORWARD_HEADERS = ['api-key', 'signature', 'timestamp', 'content-type', 'user-agent'];

export function startDeltaProxy() {
  const port = parseInt(process.env.DELTA_PROXY_PORT || '', 10);
  if (!Number.isInteger(port) || port <= 0) return null; // opt-in

  // CORS origin allowed to call this proxy directly from the browser.
  // Default '*' works but pin it to your site for tighter security.
  const allowOrigin = process.env.DELTA_PROXY_ALLOW_ORIGIN || '*';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'api-key,signature,timestamp,content-type,user-agent',
    'Access-Control-Max-Age': '86400',
  };

  const server = http.createServer(async (req, res) => {
    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
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

  server.on('error', (e) => logError('Delta proxy server error:', e));
  server.listen(port, () => {
    log(`Delta proxy listening on :${port} → ${DELTA_BASE} (CORS origin: ${allowOrigin})`);
  });

  return server;
}
