// PM2 ecosystem file for production deployment
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'option-scope-engine',
    script: 'index.js',
    cwd: __dirname,
    node_args: '--experimental-modules',
    env: {
      NODE_ENV: 'production',
    },
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
