module.exports = {
  apps: [{
    name: 'website-qa-bot',
    script: 'bot.js',
    cwd: '/root/bots/website-qa-bot',
    watch: false,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    max_memory_restart: '700M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/root/bots/website-qa-bot/data/pm2-error.log',
    out_file: '/root/bots/website-qa-bot/data/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
