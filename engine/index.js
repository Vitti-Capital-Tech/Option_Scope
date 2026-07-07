/**
 * OptionScope Trading Engine — Main Entry Point
 *
 * Runs the Paper Trading engine.
 * Handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Usage:
 *   node index.js
 */
import 'dotenv/config';
import dns from 'node:dns';
// Force outbound connections to prefer IPv4 so Delta sees the box's whitelisted
// IPv4 (Node/undici otherwise prefers IPv6 when available, which egresses from a
// different, non-whitelisted address). No-op on IPv4-only hosts.
dns.setDefaultResultOrder('ipv4first');
import { startPaperTradingEngine } from './paperTradingEngine.js';
import { startDeltaProxy } from './proxyServer.js';
import { log, logError } from './lib/utils.js';

log('╔═══════════════════════════════════════════════════╗');
log('║   OptionScope Server-Side Trading Engine          ║');
log('║   Running 24/7 — No browser required              ║');
log('╚═══════════════════════════════════════════════════╝');
log('');

let paperEngine = null;
let deltaProxy = null;

async function start() {
  try {
    // Optional Delta forwarding proxy (opt-in via DELTA_PROXY_PORT) so the
    // browser Verify call egresses from this server's whitelisted IP.
    deltaProxy = startDeltaProxy();

    paperEngine = await startPaperTradingEngine();

    log('');
    log('Paper Trading engine started successfully. Press Ctrl+C to stop.');
  } catch (e) {
    logError('Fatal startup error:', e);
    process.exit(1);
  }
}

async function shutdown() {
  log('');
  log('Graceful shutdown initiated...');

  try {
    if (paperEngine) await paperEngine.stop();
    if (deltaProxy) deltaProxy.close();
  } catch (e) {
    logError('Error during shutdown:', e);
  }

  log('Shutdown complete. Goodbye.');
  process.exit(0);
}

// Graceful shutdown handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  logError('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection:', reason);
  process.exit(1);
});

start();
