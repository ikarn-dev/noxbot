/**
 * scenes/customAmount.js — Custom SOL amount input scene
 * 
 * Entered from buy command "Custom" button.
 */
'use strict';

const { Scenes } = require('telegraf');
const log        = require('../../config/logger').child({ module: 'scene:customAmount' });
const { redis }  = require('../../config/redis');

const scene = new Scenes.WizardScene(
  'customAmount',

  // Step 1: Ask for custom amount
  async (ctx) => {
    const mint = ctx.session.pendingMint;
    if (!mint) {
      await ctx.reply('❌ No token selected. Use /buy <mint> first.');
      return ctx.scene.leave();
    }

    ctx.wizard.state.mint = mint;
    const userMax = ctx.session?.settings?.maxTradeAmountSol
      || process.env.MAX_SNIPE_AMOUNT_SOL || '10';
    await ctx.reply(
      `💰 Enter custom SOL amount for \`${mint.slice(0, 8)}...\`\n\n` +
      `Min: ${process.env.MIN_TRADE_AMOUNT_SOL || '0.01'} SOL\n` +
      `Max: ${userMax} SOL\n\n` +
      `💡 Set your own max: \`/set maxtrade <sol>\``,
      { parse_mode: 'Markdown' }
    );

    return ctx.wizard.next();
  },

  // Step 2: Validate + execute
  async (ctx) => {
    if (!ctx.message?.text) return;

    const amount = parseFloat(ctx.message.text.trim());
    const check = ctx.state.validate.amount(amount);
    if (!check.valid) {
      return ctx.reply(`❌ ${check.reason}\nPlease enter a valid amount:`);
    }

    const mint   = ctx.wizard.state.mint;
    const userId = ctx.from.id;
    const wallet = ctx.state.wallet;

    // Publish buy job
    const job = {
      type:      'manual_buy',
      mint,
      amountSol: amount,
      wallet,
      userId,
      dryRun:    ctx.session?.settings?.dryRun || false,
      slippage:  ctx.session?.settings?.slippage || 300,
      jitoTip:   ctx.session?.settings?.jitoTip || 1_000_000,
      chatId:    ctx.chat.id,
      ts:        Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId, mint, amount }, 'custom buy published');

    await ctx.reply(
      `⏳ Buying ${amount} SOL of \`${mint.slice(0, 8)}...\``,
      { parse_mode: 'Markdown' }
    );

    delete ctx.session.pendingMint;
    return ctx.scene.leave();
  },
);

module.exports = scene;
