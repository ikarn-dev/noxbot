/**
 * commands/snipe.js — /s, /snipe <mint> [amount_sol]
 * 
 * Prioritised snipe execution — skips Jupiter, uses Jito bundles.
 * Applies threatGate middleware.
 */
'use strict';

const { Markup }       = require('telegraf');
const { threatGate }   = require('../middleware/threatGate');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'cmd:snipe' });
const { signCallback } = require('../middleware/callbackVerifier');
const Trade            = require('../../models/Trade');

function parseArgs(text) {
  const parts  = text.trim().split(/\s+/);
  const mint   = parts[1] || null;
  const amount = parts[2] ? parseFloat(parts[2]) : null;
  return { mint, amount };
}

function register(bot) {
  const handler = async (ctx) => {
    const { mint, amount } = parseArgs(ctx.message.text);

    if (!mint) {
      return ctx.reply(
        '📖 *Snipe Usage*\n\n' +
        '`/snipe <mint> [sol_amount]`\n' +
        '`/s <mint> [sol_amount]`\n\n' +
        'Uses Jito bundle for priority execution.\n' +
        'Default amount: your configured snipe amount.',
        { parse_mode: 'Markdown' }
      );
    }

    if (!ctx.state.validate.mint(mint)) {
      return ctx.reply('❌ Invalid token address.');
    }

    const snipeAmount = amount || ctx.session?.settings?.snipeAmount || 0.1;
    const check = ctx.state.validate.amount(snipeAmount);
    if (!check.valid) return ctx.reply(`❌ ${check.reason}`);

    return executeSnipe(ctx, mint, snipeAmount);
  };

  const extractMint = (ctx) => parseArgs(ctx.message?.text || '').mint;
  bot.command(['snipe', 's'], threatGate(extractMint), handler);
}

async function executeSnipe(ctx, mint, amountSol) {
  const userId   = ctx.from.id;
  const wallet   = ctx.state.wallet;
  const isDryRun = ctx.session?.settings?.dryRun || false;

  const msg = await ctx.reply(
    `🎯 ${isDryRun ? '[DRY RUN] ' : ''}Sniping ${amountSol} SOL → \`${mint.slice(0, 8)}...\``,
    { parse_mode: 'Markdown' }
  );

  try {
    const job = {
      type:         'snipe',
      mint,
      amountSol,
      wallet,
      userId,
      dryRun:       isDryRun,
      slippage:     ctx.session?.settings?.slippage || 300,
      jitoTip:      ctx.session?.settings?.jitoTip || 1_000_000,
      priority:     'high', // Jito bundle priority
      messageId:    msg.message_id,
      chatId:       ctx.chat.id,
      ts:           Date.now(),
    };

    await redis.publish('nox:jobs', JSON.stringify(job));
    log.info({ userId, mint, amountSol, dryRun: isDryRun }, 'snipe job published');

    await Trade.create({
      telegramId: userId,
      type:       'snipe',
      mint,
      amountSol,
      wallet,
      status:     'pending',
      dryRun:     isDryRun,
      source:     'manual',
    });
  } catch (err) {
    log.error({ err: err.message, mint }, 'snipe execution failed');
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Snipe failed: ${err.message}`
    ).catch(() => {});
  }
}

module.exports = { register };
