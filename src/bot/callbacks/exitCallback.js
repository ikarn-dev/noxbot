/**
 * callbacks/exitCallback.js — Handle sell/exit buttons
 * 
 * Routes: sell:*, quick_sell:*, custom_sell:*
 */
'use strict';

const { verifyCallback } = require('../middleware/callbackVerifier');
const { redis }          = require('../../config/redis');
const log                = require('../../config/logger').child({ module: 'cb:exit' });

function register(bot) {
  // Percentage sell buttons (25%, 50%, 75%, 100%)
  bot.action(/^sell:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery('Processing sell...');

    const parts    = ctx.state.callbackPayload;
    const mint     = parts[1];
    const pct      = parseInt(parts[2], 10);
    const wallet   = ctx.state.wallet;
    const isDryRun = ctx.session?.settings?.dryRun || false;

    const job = {
      type:     'sell',
      mint,
      sellPct:  pct,
      wallet,
      userId:   ctx.from.id,
      dryRun:   isDryRun,
      slippage: ctx.session?.settings?.slippage || 300,
      jitoTip:  ctx.session?.settings?.jitoTip || 1_000_000,
      chatId:   ctx.chat.id,
      ts:       Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId: ctx.from.id, mint, pct }, 'sell callback executed');

    await ctx.editMessageText(
      `⏳ ${isDryRun ? '[DRY] ' : ''}Selling ${pct}% of \`${mint.slice(0, 8)}...\``,
      { parse_mode: 'Markdown' }
    );
  });

  // Quick sell from positions view
  bot.action(/^quick_sell:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery('Selling...');

    const parts = ctx.state.callbackPayload;
    const mint  = parts[1];
    const pct   = parseInt(parts[2], 10) || 100;

    const job = {
      type:     'sell',
      mint,
      sellPct:  pct,
      wallet:   ctx.state.wallet,
      userId:   ctx.from.id,
      dryRun:   ctx.session?.settings?.dryRun || false,
      slippage: ctx.session?.settings?.slippage || 300,
      jitoTip:  ctx.session?.settings?.jitoTip || 1_000_000,
      chatId:   ctx.chat.id,
      ts:       Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId: ctx.from.id, mint, pct }, 'quick sell callback');
  });

  // Custom sell → enter scene
  bot.action(/^custom_sell:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery();
    const parts = ctx.state.callbackPayload;
    ctx.session.pendingSellMint = parts[1];
    return ctx.scene.enter('customSellPercent');
  });
}

module.exports = { register };
