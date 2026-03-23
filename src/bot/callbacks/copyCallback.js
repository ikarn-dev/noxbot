/**
 * callbacks/copyCallback.js — Handle copy trading toggle/remove buttons
 * 
 * Routes: copy_toggle:*, copy_remove:*
 */
'use strict';

const { verifyCallback } = require('../middleware/callbackVerifier');
const log                = require('../../config/logger').child({ module: 'cb:copy' });
const User               = require('../../models/User');

function register(bot) {
  // Toggle copy target on/off
  bot.action(/^copy_toggle:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery();

    const parts  = ctx.state.callbackPayload;
    const target = parts[1];

    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user) return;

    const copy = user.copyTargets?.find(c => c.wallet === target);
    if (!copy) {
      return ctx.editMessageText('❌ Copy target not found.');
    }

    copy.enabled = !copy.enabled;
    await user.save();

    log.info({ userId: ctx.from.id, target, enabled: copy.enabled }, 'copy target toggled');

    await ctx.editMessageText(
      `${copy.enabled ? '🟢' : '⭕'} Copy target \`${target.slice(0, 8)}...\` is now *${copy.enabled ? 'ENABLED' : 'DISABLED'}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // Remove copy target
  bot.action(/^copy_remove:/, verifyCallback(), async (ctx) => {
    await ctx.answerCbQuery();

    const parts  = ctx.state.callbackPayload;
    const target = parts[1];

    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      { $pull: { copyTargets: { wallet: target } } }
    );

    log.info({ userId: ctx.from.id, target }, 'copy target removed');

    await ctx.editMessageText(
      `🗑 Removed copy target \`${target.slice(0, 8)}...\``,
      { parse_mode: 'Markdown' }
    );
  });
}

module.exports = { register };
