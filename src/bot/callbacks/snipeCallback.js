/**
 * callbacks/snipeCallback.js — Handle snipe/buy confirmation buttons
 * 
 * Routes: buy:*, snipe:*, custom_buy:*
 */
'use strict';

const { verifyCallback } = require('../middleware/callbackVerifier');
const { redis }          = require('../../config/redis');
const log                = require('../../config/logger').child({ module: 'cb:snipe' });
const Trade              = require('../../models/Trade');

function register(bot) {
  // Quick buy amounts (0.1, 0.25, 0.5, 1 SOL)
  bot.action(/^buy:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery('Processing buy...');

    const parts    = ctx.state.callbackPayload;
    // payload format: buy:<mint>:<amount>:<sig>
    const mint     = parts[1];
    const amount   = parseFloat(parts[2]);
    const wallet   = ctx.state.wallet;
    const isDryRun = ctx.session?.settings?.dryRun || false;

    const job = {
      type:      'manual_buy',
      mint,
      amountSol: amount,
      wallet,
      userId:    ctx.from.id,
      dryRun:    isDryRun,
      slippage:  ctx.session?.settings?.slippage || 300,
      jitoTip:   ctx.session?.settings?.jitoTip || 1_000_000,
      chatId:    ctx.chat.id,
      ts:        Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId: ctx.from.id, mint, amount }, 'buy callback executed');

    await ctx.editMessageText(
      `⏳ ${isDryRun ? '[DRY] ' : ''}Buying ${amount} SOL → \`${mint.slice(0, 8)}...\``,
      { parse_mode: 'Markdown' }
    );
  });

  // Custom buy → enter scene
  bot.action(/^custom_buy:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery();
    const parts = ctx.state.callbackPayload;
    ctx.session.pendingMint = parts[1];
    return ctx.scene.enter('customAmount');
  });
}

module.exports = { register };
