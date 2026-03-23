/**
 * commands/kols.js — /kols
 * 
 * Display KOL leaderboard from MongoDB.
 */
'use strict';

const KOL = require('../../models/KOL');
const log = require('../../config/logger').child({ module: 'cmd:kols' });

function register(bot) {
  bot.command('kols', async (ctx) => {
    try {
      const kols = await KOL.find({ tier: { $in: ['S', 'A'] } })
        .sort({ 'performance.winRate': -1 })
        .limit(15)
        .lean();

      if (kols.length === 0) {
        return ctx.reply('📊 No KOL data available yet. Scanning in progress...');
      }

      const header = '🏆 *KOL Leaderboard*\n\n';
      const rows = kols.map((k, i) => {
        const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
        const wr = ((k.performance?.winRate || 0) * 100).toFixed(0);
        const trades = k.performance?.totalTrades || 0;
        const pnl = (k.performance?.totalPnlSol || 0).toFixed(2);
        const addr = k.wallet.slice(0, 6) + '...' + k.wallet.slice(-4);
        return `${medal} \`${addr}\` [${k.tier}] WR:${wr}% Trades:${trades} PnL:${pnl}◎`;
      });

      return ctx.reply(header + rows.join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      log.error({ err: err.message }, 'kols command failed');
      return ctx.reply('⚠️ Could not load KOL leaderboard.');
    }
  });
}

module.exports = { register };
