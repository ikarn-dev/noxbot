/**
 * commands/positions.js — /pos, /positions
 * 
 * Shows open token positions with current PnL.
 */
'use strict';

const { Markup }       = require('telegraf');
const Trade            = require('../../models/Trade');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'cmd:pos' });
const { signCallback } = require('../middleware/callbackVerifier');

function register(bot) {
  bot.command(['pos', 'positions'], async (ctx) => {
    try {
      const positions = await Trade.find({
        telegramId: ctx.from.id,
        status:     'filled',
        type:       'buy',
        closedAt:   { $exists: false },
      }).sort({ createdAt: -1 }).limit(20).lean();

      if (positions.length === 0) {
        return ctx.reply('📭 No open positions.\n\nUse /buy or /snipe to open one.');
      }

      const header = '📊 *Open Positions*\n\n';
      const rows = [];

      for (const p of positions) {
        const mint = p.mint.slice(0, 8) + '...';
        const entry = p.amountSol?.toFixed(4) || '?';
        
        // Try to get current price from Redis
        const priceRaw = await redis.get(`price:${p.mint}`);
        const currentPrice = priceRaw ? parseFloat(priceRaw) : null;
        
        let pnlStr = 'N/A';
        let emoji = '⚪';
        if (currentPrice && p.entryPrice) {
          const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice * 100);
          emoji = pnlPct >= 0 ? '🟢' : '🔴';
          pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
        }

        rows.push(`${emoji} \`${mint}\` — ${entry}◎ → ${pnlStr}`);
      }

      const buttons = positions.slice(0, 5).map(p => [
        Markup.button.callback(
          `Sell ${p.mint.slice(0, 6)}...`,
          signCallback('quick_sell', p.mint, '100')
        ),
      ]);

      return ctx.reply(
        header + rows.join('\n'),
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
      );
    } catch (err) {
      log.error({ err: err.message }, 'positions command failed');
      return ctx.reply('⚠️ Could not load positions.');
    }
  });
}

module.exports = { register };
