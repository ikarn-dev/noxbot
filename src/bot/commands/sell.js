/**
 * commands/sell.js — /sell <mint> <pct>
 * 
 * Sells a percentage of held tokens via Jupiter swap.
 */
'use strict';

const { Markup }       = require('telegraf');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'cmd:sell' });
const { signCallback } = require('../middleware/callbackVerifier');
const Trade            = require('../../models/Trade');

function parseArgs(text) {
  const parts = text.trim().split(/\s+/);
  const mint  = parts[1] || null;
  const pct   = parts[2] ? parseInt(parts[2], 10) : null;
  return { mint, pct };
}

function register(bot) {
  bot.command('sell', async (ctx) => {
    const { mint, pct } = parseArgs(ctx.message.text);

    if (!mint) {
      return ctx.reply(
        '📖 *Sell Usage*\n\n' +
        '`/sell <mint> <percent>`\n\n' +
        'Example: `/sell So11...xyz 50`\n' +
        'Quick sell: `/sell <mint> 100` (sell all)',
        { parse_mode: 'Markdown' }
      );
    }

    if (!ctx.state.validate.mint(mint)) {
      return ctx.reply('❌ Invalid token address.');
    }

    // If no percentage, show quick-sell buttons
    if (pct === null) {
      const buttons = [
        [
          Markup.button.callback('25%', signCallback('sell', mint, '25')),
          Markup.button.callback('50%', signCallback('sell', mint, '50')),
          Markup.button.callback('75%', signCallback('sell', mint, '75')),
          Markup.button.callback('100%', signCallback('sell', mint, '100')),
        ],
        [
          Markup.button.callback('Custom %', signCallback('custom_sell', mint)),
        ],
      ];
      return ctx.reply(
        `🔴 *Sell* \`${mint.slice(0, 8)}...\`\n\nSelect percentage:`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
      );
    }

    // Validate percent
    const check = ctx.state.validate.percent(pct);
    if (!check.valid) return ctx.reply(`❌ ${check.reason}`);

    return executeSell(ctx, mint, check.value);
  });
}

async function executeSell(ctx, mint, pct) {
  const userId   = ctx.from.id;
  const wallet   = ctx.state.wallet;
  const isDryRun = ctx.session?.settings?.dryRun || false;

  const msg = await ctx.reply(
    `⏳ ${isDryRun ? '[DRY RUN] ' : ''}Selling ${pct}% of \`${mint.slice(0, 8)}...\``,
    { parse_mode: 'Markdown' }
  );

  try {
    const job = {
      type:      'sell',
      mint,
      sellPct:   pct,
      wallet,
      userId,
      dryRun:    isDryRun,
      slippage:  ctx.session?.settings?.slippage || 300,
      jitoTip:   ctx.session?.settings?.jitoTip || 1_000_000,
      messageId: msg.message_id,
      chatId:    ctx.chat.id,
      ts:        Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId, mint, pct, dryRun: isDryRun }, 'sell job published');

    await Trade.create({
      telegramId: userId,
      type:       'sell',
      mint,
      sellPct:    pct,
      wallet,
      status:     'pending',
      dryRun:     isDryRun,
      source:     'manual',
    });
  } catch (err) {
    log.error({ err: err.message, mint }, 'sell execution failed');
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Sell failed: ${err.message}`
    ).catch(() => {});
  }
}

module.exports = { register };
