/**
 * Engine Heartbeat System.
 * Writes a heartbeat row to `engine_heartbeat` table every 30 seconds.
 * Browser clients query this table to show engine ONLINE/OFFLINE status.
 */
import { supabase } from './supabase.js';
import { log, logError } from './utils.js';

/**
 * Create a heartbeat manager for a specific engine.
 * @param {string} engineId - 'paper_trading' or 'atm_exit'
 */
export function createHeartbeat(engineId) {
  let intervalTimer = null;
  let state = {
    underlying: '',
    expiry: '',
    active_positions: 0,
    ws_status: 'reconnecting',
    spot_price: null,
    status: 'starting',
  };

  const write = async () => {
    try {
      const { error } = await supabase.from('engine_heartbeat').upsert({
        id: engineId,
        last_heartbeat: new Date().toISOString(),
        status: state.status,
        underlying: state.underlying,
        expiry: state.expiry,
        active_positions: state.active_positions,
        ws_status: state.ws_status,
        spot_price: state.spot_price,
      });
      if (error) {
        logError(`Heartbeat write error (${engineId}):`, error.message);
      }
    } catch (e) {
      logError(`Heartbeat exception (${engineId}):`, e.message);
    }
  };

  return {
    /** Update heartbeat state fields. Call this whenever engine state changes. */
    update(fields) {
      Object.assign(state, fields);
    },

    /** Start the heartbeat timer. Writes immediately, then every 30 seconds. */
    async start() {
      state.status = 'running';
      await write();
      intervalTimer = setInterval(write, 30000);
      log(`Heartbeat started for ${engineId}`);
    },

    /** Stop the heartbeat timer and mark engine as stopped. */
    async stop() {
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
      state.status = 'error';
      await write();
      log(`Heartbeat stopped for ${engineId}`);
    },

    /** Force a heartbeat write now. */
    async flush() {
      await write();
    },
  };
}
