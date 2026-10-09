// PM2 ecosystem file for production deployment
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'optionscope-engine',
    script: 'index.js',
    cwd: __dirname,
    node_args: '--experimental-modules',
    // SINGLE INSTANCE ONLY. The engine must never run more than once against the
    // same Supabase: two evaluators double-book every exit (see the deterministic
    // trade_id / upsert guards in paperTradingEngine.js — those are the DB-level
    // backstop; this is the process-level guarantee). Fork mode + instances:1
    // prevents PM2 from ever cluster-spawning a second copy.
    exec_mode: 'fork',
    instances: 1,
    env: {
      NODE_ENV: 'production',
    },
    // Give the old process time to run its graceful SIGTERM shutdown (stop timers,
    // close WS, flush heartbeat) before PM2 force-kills — avoids a brief overlap
    // window where a restarting engine and the outgoing one both evaluate.
    kill_timeout: 10000,
    // Auto-restart on crash with 5-second delay
    restart_delay: 5000,
    max_restarts: 50,
    autorestart: true,
    // Log formatting
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Memory limit — restart if exceeded. Was 500M: the engine (22 accounts) peaks at
    // ~550–680 MB on busy minutes and right after a start, so PM2 kept restarting it
    // (8 Oct 05:27, 9 Oct 04:03 / 04:05 / 04:31 UTC) — each restart reloads every account
    // at once and was what overloaded Supabase. The Lightsail box has 1.9 GB RAM with ~1 GB
    // free; 900M leaves headroom for the OS + pm2-logrotate. Watch `pm2 status` memory: a
    // steady climb over days (not just peaks) would mean a leak to fix, not a limit to raise.
    max_memory_restart: '900M',
    // Merge stdout and stderr into one log
    merge_logs: true,
  }]
};
