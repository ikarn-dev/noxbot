/**
 * scenes/copySetup.js — Configure copy trade parameters
 * 
 * Steps:
 *   1. Confirm target wallet
 *   2. Set SOL multiplier (0.1x–2x)
 *   3. Set max SOL per trade
 *   4. Confirm and save
 */
'use strict';

const { Scenes, Markup } = require('telegraf');
const log                = require('../../config/logger').child({ module: 'scene:copySetup' });
const User               = require('../../models/User');

const scene = new Scenes.WizardScene(
  'copySetup',

  // Step 1: Confirm target
  async (ctx) => {
    const target = ctx.session.pendingCopyTarget;
    if (!target) {
      await ctx.reply('❌ No target wallet. Use `/copy <wallet>` first.', { parse_mode: 'Markdown' });
      return ctx.scene.leave();
    }

    ctx.wizard.state.target = target;

    await ctx.reply(
      `📋 *Copy Trade Setup*\n\n` +
      `Target: \`${target.slice(0, 8)}...${target.slice(-4)}\`\n\n` +
      'Select position multiplier:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('0.1x', 'copy_mult_0.1'),
            Markup.button.callback('0.25x', 'copy_mult_0.25'),
            Markup.button.callback('0.5x', 'copy_mult_0.5'),
          ],
          [
            Markup.button.callback('1x (same size)', 'copy_mult_1'),
            Markup.button.callback('2x', 'copy_mult_2'),
          ],
        ]),
      }
    );

    return ctx.wizard.next();
  },

  // Step 2: Set max SOL
  async (ctx) => {
    if (ctx.message?.text) {
      const maxSol = parseFloat(ctx.message.text);
      if (isNaN(maxSol) || maxSol < 0.01 || maxSol > 10) {
        return ctx.reply('❌ Enter a valid max SOL amount (0.01–10):');
      }
      ctx.wizard.state.maxSol = maxSol;
      return finishCopySetup(ctx);
    }
  },
);

// Multiplier buttons
['0.1', '0.25', '0.5', '1', '2'].forEach(mult => {
  scene.action(`copy_mult_${mult}`, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.wizard.state.multiplier = parseFloat(mult);

    await ctx.reply(
      `✅ Multiplier: *${mult}x*\n\n` +
      'Now enter *max SOL per trade* (0.01–10):',
      { parse_mode: 'Markdown' }
    );
  });
});

async function finishCopySetup(ctx) {
  const { target, multiplier, maxSol } = ctx.wizard.state;

  const copyTarget = {
    wallet:     target,
    multiplier: multiplier || 1,
    maxSol:     maxSol || 1,
    enabled:    true,
    createdAt:  new Date(),
  };

  try {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $push: { copyTargets: copyTarget } }
    );

    log.info({ userId: ctx.from.id, target, multiplier, maxSol }, 'copy target added');

    await ctx.reply(
      `✅ *Copy Trading Enabled*\n\n` +
      `Target: \`${target.slice(0, 8)}...\`\n` +
      `Multiplier: ${copyTarget.multiplier}x\n` +
      `Max SOL: ${copyTarget.maxSol}◎\n\n` +
      'You\'ll be notified when this wallet trades.',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    log.error({ err: err.message }, 'copy setup save failed');
    await ctx.reply('❌ Failed to save copy target.');
  }

  delete ctx.session.pendingCopyTarget;
  return ctx.scene.leave();
}

module.exports = scene;
