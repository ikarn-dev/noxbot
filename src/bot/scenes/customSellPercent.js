/**
 * scenes/customSellPercent.js — Custom sell percentage input scene
 * 
 * Entered from sell command "Custom %" button.
 */
'use strict';

const { Scenes } = require('telegraf');
const log        = require('../../config/logger').child({ module: 'scene:customSell' });
const { redis }  = require('../../config/redis');

const scene = new Scenes.WizardScene(
  'customSellPercent',

  // Step 1: Ask for custom percentage
  async (ctx) => {
    const mint = ctx.session.pendingSellMint;
    if (!mint) {
      await ctx.reply('❌ No token selected. Use /sell <mint> first.');
      return ctx.scene.leave();
    }

    ctx.wizard.state.mint = mint;
    await ctx.reply(
      `📉 Enter sell percentage for \`${mint.slice(0, 8)}...\`\n\n` +
      'Enter a number from 1 to 100:',
      { parse_mode: 'Markdown' }
    );

    return ctx.wizard.next();
  },

  // Step 2: Validate + execute
  async (ctx) => {
    if (!ctx.message?.text) return;

    const pct   = parseInt(ctx.message.text.trim(), 10);
    const check = ctx.state.validate.percent(pct);
    if (!check.valid) {
      return ctx.reply(`❌ ${check.reason}\nPlease enter a valid percentage (1–100):`);
    }

    const mint   = ctx.wizard.state.mint;
    const userId = ctx.from.id;
    const wallet = ctx.state.wallet;

    // Publish sell job
    const job = {
      type:     'sell',
      mint,
      sellPct:  check.value,
      wallet,
      userId,
      dryRun:   ctx.session?.settings?.dryRun || false,
      slippage: ctx.session?.settings?.slippage || 300,
      jitoTip:  ctx.session?.settings?.jitoTip || 1_000_000,
      chatId:   ctx.chat.id,
      ts:       Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId, mint, pct: check.value }, 'custom sell published');

    await ctx.reply(
      `⏳ Selling ${check.value}% of \`${mint.slice(0, 8)}...\``,
      { parse_mode: 'Markdown' }
    );

    delete ctx.session.pendingSellMint;
    return ctx.scene.leave();
  },
);

module.exports = scene;
