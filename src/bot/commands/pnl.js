/**
 * commands/pnl.js — /pnl [period]
 * 
 * Shows realised PnL summary.
 */
'use strict';

const Trade = require('../../models/Trade');
const log   = require('../../config/logger').child({ module: 'cmd:pnl' });

const PERIODS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d':  7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': null,
};

function register(bot) {
  bot.command('pnl', async (ctx) => {
    const parts  = ctx.message.text.trim().split(/\s+/);
    const period = parts[1] || '7d';

    if (!PERIODS.hasOwnProperty(period)) {
      return ctx.reply(`📖 Usage: \`/pnl [24h|7d|30d|all]\``, { parse_mode: 'Markdown' });
    }

    try {
      const query = {
        telegramId: ctx.from.id,
        status:     'filled',
        type:       'sell',
      };

      const ms = PERIODS[period];
      if (ms) {
        query.createdAt = { $gte: new Date(Date.now() - ms) };
      }

      const trades = await Trade.find(query).lean();

      if (trades.length === 0) {
        return ctx.reply(`📊 No completed trades in ${period}.`);
      }

      let totalPnl = 0;
      let wins = 0;
      let losses = 0;

      for (const t of trades) {
        const pnl = t.realisedPnlSol || 0;
        totalPnl += pnl;
        if (pnl > 0) wins++;
        else losses++;
      }

      const winRate = trades.length > 0 
        ? ((wins / trades.length) * 100).toFixed(1)
        : '0.0';

      const emoji = totalPnl >= 0 ? '🟢' : '🔴';
      const sign  = totalPnl >= 0 ? '+' : '';

      return ctx.reply(
        `📊 *PnL Summary (${period})*\n\n` +
        `${emoji} Total PnL: ${sign}${totalPnl.toFixed(4)} SOL\n` +
        `📈 Win Rate: ${winRate}%\n` +
        `✅ Wins: ${wins} | ❌ Losses: ${losses}\n` +
        `📝 Trades: ${trades.length}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      log.error({ err: err.message }, 'pnl command failed');
      return ctx.reply('⚠️ Could not calculate PnL.');
    }
  });
}

module.exports = { register };
