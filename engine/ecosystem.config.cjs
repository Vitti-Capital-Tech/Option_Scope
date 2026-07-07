// PM2 ecosystem file for production deployment
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'option-scope-engine',
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
    // Memory limit — restart if exceeded
    max_memory_restart: '500M',
    // Merge stdout and stderr into one log
    merge_logs: true,
  }]
};
