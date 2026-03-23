/**
 * callbacks/refreshCallback.js — Refresh position data / price
 * 
 * Routes: refresh:*
 */
'use strict';

const { verifyCallback } = require('../middleware/callbackVerifier');
const { redis }          = require('../../config/redis');
const log                = require('../../config/logger').child({ module: 'cb:refresh' });

function register(bot) {
  // Refresh price / position info
  bot.action(/^refresh:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery('Refreshing...');

    const parts = ctx.state.callbackPayload;
    const mint  = parts[1];

    try {
      const priceRaw = await redis.get(`price:${mint}`);
      const tokenRaw = await redis.get(`token_info:${mint}`);

      const price = priceRaw ? parseFloat(priceRaw) : null;
      const token = tokenRaw ? JSON.parse(tokenRaw) : null;
      const name  = token?.name || mint.slice(0, 8) + '...';

      let text = `🔄 *${name}*\n\n`;

      if (price) {
        text += `💰 Price: $${price.toFixed(8)}\n`;
      }

      if (token) {
        if (token.marketCap) text += `📊 MC: $${formatNum(token.marketCap)}\n`;
        if (token.liquidity) text += `💧 Liq: $${formatNum(token.liquidity)}\n`;
        if (token.volume24h) text += `📈 24h Vol: $${formatNum(token.volume24h)}\n`;
      }

      text += `\n🕐 ${new Date().toLocaleTimeString()}`;

      await ctx.editMessageText(text, { parse_mode: 'Markdown' });
    } catch (err) {
      log.error({ err: err.message, mint }, 'refresh failed');
      await ctx.answerCbQuery('⚠️ Refresh failed', { show_alert: true });
    }
  });
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(2);
}

module.exports = { register };
