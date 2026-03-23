/**
 * commands/dryrun.js — /dryrun [on|off]
 * 
 * Toggle dry run mode (simulated trades).
 */
'use strict';

const log = require('../../config/logger').child({ module: 'cmd:dryrun' });

function register(bot) {
  bot.command('dryrun', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const arg   = (parts[1] || '').toLowerCase();

    if (!ctx.session.settings) ctx.session.settings = {};

    if (arg === 'on' || arg === 'true') {
      ctx.session.settings.dryRun = true;
    } else if (arg === 'off' || arg === 'false') {
      ctx.session.settings.dryRun = false;
    } else {
      // Toggle
      ctx.session.settings.dryRun = !ctx.session.settings.dryRun;
    }

    const status = ctx.session.settings.dryRun;
    log.info({ userId: ctx.from.id, dryRun: status }, 'dry run toggled');

    return ctx.reply(
      `🧪 Dry Run: *${status ? 'ON' : 'OFF'}*\n\n` +
      (status
        ? 'All trades will be simulated — no real SOL spent.'
        : 'Trades are now LIVE — real SOL will be used.'),
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { register };
