/**
 * Engine Heartbeat System.
 * Writes a heartbeat row per account engine to the `engine_heartbeat` table every 30 seconds.
 * Browser clients query this table to show engine ONLINE/OFFLINE status.
 *
 * Batched: every running engine registers here and ONE shared 30s timer upserts all their
 * rows in a single request (instead of one request per account every 30s). start / stop /
 * flush still write their own row at once.
 */
import { supabase } from './supabase.js';
import { log, logError } from './utils.js';
import { reportDbOk, reportDbFailure, summarizeDbError } from './dbHealth.js';

const HEARTBEAT_MS = 30000;
const registry = new Map(); // engineId → () => row
let batchTimer = null;

// A data / constraint / schema error (22xxx, 23xxx, 42xxx) comes from one bad row — retry the
// rows one by one so it can't take every engine "offline". Timeouts / connection errors
// affect them all anyway, so those are not retried row by row (that would multiply the load).
const isRowError = (e) => /^(22|23|42)/.test(String(e?.code || ''));

async function writeBatch() {
  if (registry.size === 0) return;
  const rows = [...registry.values()].map(build => build());
  // Rows leave out wallet_balance / max_positions / allocation_pct until they are known (so a
  // restart doesn't blank them); a bulk upsert must have one column set, so group by it.
  const groups = new Map();
  for (const r of rows) {
    const k = Object.keys(r).sort().join(',');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const group of groups.values()) {
    try {
      const { error } = await supabase.from('engine_heartbeat').upsert(group);
      if (!error) { reportDbOk(); continue; }
      logError(`Heartbeat batch write error (${group.length} rows):`, summarizeDbError(error));
      reportDbFailure('heartbeat', error);
      if (isRowError(error)) {
        for (const r of group) {
          const { error: e1 } = await supabase.from('engine_heartbeat').upsert(r);
          if (e1) logError(`Heartbeat write error (${r.id}):`, summarizeDbError(e1));
        }
      }
    } catch (e) {
      logError(`Heartbeat batch exception (${group.length} rows):`, e.message);
      reportDbFailure('heartbeat', e);
    }
  }
}
/**
 * Create a heartbeat manager for a specific engine.
 * @param {string} engineId - 'paper_trading'
 */
export function createHeartbeat(engineId) {
  let state = {
    underlying: '',
    expiry: '',
    active_positions: 0,
    ws_status: 'reconnecting',
    spot_price: null,
    status: 'starting',
    wallet_balance: null,
    dry_run: null,
    max_positions: null,
    allocation_pct: null,
  };

  const buildRow = () => ({
    id: engineId,
    last_heartbeat: new Date().toISOString(),
    status: state.status,
    underlying: state.underlying,
    expiry: state.expiry,
    active_positions: state.active_positions,
    ws_status: state.ws_status,
    spot_price: state.spot_price,
    dry_run: state.dry_run,
    // Not yet known right after a (re)start → leave the last published values in place
    // instead of blanking them (the dashboard's wallet balance used to vanish for ~1 min).
    ...(state.wallet_balance != null ? { wallet_balance: state.wallet_balance } : {}),
    ...(state.max_positions != null ? { max_positions: state.max_positions } : {}),
    ...(state.allocation_pct != null ? { allocation_pct: state.allocation_pct } : {}),
  });

  // Single-row write (start / stop / flush); the periodic beat is the shared batch.
  const write = async () => {
    try {
      const { error } = await supabase.from('engine_heartbeat').upsert(buildRow());
      if (error) {
        logError(`Heartbeat write error (${engineId}):`, summarizeDbError(error));
        reportDbFailure('heartbeat', error);
      } else {
        reportDbOk();
      }
    } catch (e) {
      logError(`Heartbeat exception (${engineId}):`, e.message);
      reportDbFailure('heartbeat', e);
    }
  };

  return {
    /** Update heartbeat state fields. Call this whenever engine state changes. */
    update(fields) {
      Object.assign(state, fields);
    },

    /** Write immediately, then join the shared 30s batch. */
    async start() {
      state.status = 'running';
      await write();
      registry.set(engineId, buildRow);
      if (!batchTimer) batchTimer = setInterval(() => { writeBatch().catch(() => {}); }, HEARTBEAT_MS);
      log(`Heartbeat started for ${engineId}`);
    },

    /** Stop the heartbeat timer and mark engine as stopped. */
    async stop(isDeleted = false) {
      registry.delete(engineId);
      if (registry.size === 0 && batchTimer) {
        clearInterval(batchTimer);
        batchTimer = null;
      }
      if (isDeleted) {
        try {
          const { error } = await supabase
            .from('engine_heartbeat')
            .delete()
            .eq('id', engineId);
          if (error) {
            logError(`Heartbeat delete error (${engineId}):`, error.message);
          } else {
            log(`Heartbeat deleted for ${engineId}`);
          }
        } catch (e) {
          logError(`Heartbeat delete exception (${engineId}):`, e.message);
        }
      } else {
        state.status = 'error';
        await write();
        log(`Heartbeat stopped for ${engineId}`);
      }
    },

    /** Force a heartbeat write now. */
    async flush() {
      await write();
    },
  };
}
