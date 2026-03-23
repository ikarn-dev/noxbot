/**
 * commands/copy.js — /copy <wallet_address>
 * 
 * Enable copy-trading a KOL or any Solana wallet.
 * Opens copySetup scene for configuration if no params.
 */
'use strict';

const { Markup }       = require('telegraf');
const log              = require('../../config/logger').child({ module: 'cmd:copy' });
const { redis }        = require('../../config/redis');
const { signCallback } = require('../middleware/callbackVerifier');
const User             = require('../../models/User');

function register(bot) {
  bot.command('copy', async (ctx) => {
    const parts  = ctx.message.text.trim().split(/\s+/);
    const target = parts[1] || null;

    if (!target) {
      // Show current copy targets + setup option
      const user = await User.findOne({ telegramId: ctx.from.id });
      const copies = user?.copyTargets || [];

      if (copies.length === 0) {
        return ctx.reply(
          '📋 *Copy Trading*\n\n' +
          'No copy targets set.\n\n' +
          '`/copy <wallet>` — Start copy trading\n' +
          'Enter a KOL or smart wallet to mirror.',
          { parse_mode: 'Markdown' }
        );
      }

      const list = copies.map((c, i) =>
        `${i + 1}. \`${c.wallet.slice(0, 8)}...\` (${c.multiplier}x, ${c.enabled ? '🟢' : '⭕'})`
      ).join('\n');

      const buttons = copies.map(c => [
        Markup.button.callback(
          `${c.enabled ? '⭕ Disable' : '🟢 Enable'} ${c.wallet.slice(0, 8)}`,
          signCallback('copy_toggle', c.wallet)
        ),
        Markup.button.callback(
          `🗑 Remove ${c.wallet.slice(0, 8)}`,
          signCallback('copy_remove', c.wallet)
        ),
      ]);

      return ctx.reply(
        `📋 *Copy Targets*\n\n${list}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
      );
    }

    // Validate wallet address
    if (!ctx.state.validate.mint(target)) {
      return ctx.reply('❌ Invalid wallet address.');
    }

    // Enter copy setup scene
    ctx.session.pendingCopyTarget = target;
    return ctx.scene.enter('copySetup');
  });
}

module.exports = { register };
