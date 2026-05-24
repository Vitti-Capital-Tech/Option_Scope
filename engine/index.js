/**
 * OptionScope Trading Engine — Main Entry Point
 *
 * Runs both Paper Trading and ATM Exit engines in parallel.
 * Handles graceful shutdown on SIGINT/SIGTERM.
 *
 * Usage:
 *   node index.js           # Run both engines
 *   node index.js paper     # Run only Paper Trading engine
 *   node index.js atm       # Run only ATM Exit engine
 */
import 'dotenv/config';
import { startPaperTradingEngine } from './paperTradingEngine.js';
import { startAtmExitEngine } from './atmExitEngine.js';
import { log, logError } from './lib/utils.js';

const mode = process.argv[2] || 'both';

log('╔═══════════════════════════════════════════════════╗');
log('║   OptionScope Server-Side Trading Engine          ║');
log('║   Running 24/7 — No browser required              ║');
log(`║   Mode: ${mode.toUpperCase().padEnd(42)}║`);
log('╚═══════════════════════════════════════════════════╝');
log('');

let paperEngine = null;
let atmEngine = null;

async function start() {
  try {
    if (mode === 'both' || mode === 'paper') {
      paperEngine = await startPaperTradingEngine();
    }

    if (mode === 'both' || mode === 'atm') {
      atmEngine = await startAtmExitEngine();
    }

    log('');
    log('All engines started successfully. Press Ctrl+C to stop.');
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
    if (atmEngine) await atmEngine.stop();
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
  // Don't exit — let the engine continue running
});
process.on('unhandledRejection', (reason) => {
  logError('Unhandled rejection:', reason);
  // Don't exit — let the engine continue running
});

start();
