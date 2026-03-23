/**
 * commands/buy.js — /b, /buy <mint> <amount_sol>
 * 
 * Manual buy execution through Jupiter swap.
 * Applies threatGate per-handler middleware.
 */
'use strict';

const { Markup }      = require('telegraf');
const { threatGate }  = require('../middleware/threatGate');
const { redis }       = require('../../config/redis');
const log             = require('../../config/logger').child({ module: 'cmd:buy' });
const { signCallback } = require('../middleware/callbackVerifier');
const Trade           = require('../../models/Trade');

/**
 * Parse buy command args: /buy <mint> <amount_sol>
 */
function parseArgs(text) {
  const parts = text.trim().split(/\s+/);
  // parts[0] = /buy or /b
  const mint   = parts[1] || null;
  const amount = parts[2] ? parseFloat(parts[2]) : null;
  return { mint, amount };
}

function register(bot) {
  const handler = async (ctx) => {
    const { text } = ctx.message;
    const { mint, amount } = parseArgs(text);

    if (!mint) {
      return ctx.reply(
        '📖 *Buy Usage*\n\n' +
        '`/buy <mint> <sol_amount>`\n' +
        '`/b <mint> <sol_amount>`\n\n' +
        'Example: `/buy So11...xyz 0.5`',
        { parse_mode: 'Markdown' }
      );
    }

    // Validate mint
    if (!ctx.state.validate.mint(mint)) {
      return ctx.reply('❌ Invalid token address.');
    }

    // Validate amount
    if (amount !== null) {
      const check = ctx.state.validate.amount(amount);
      if (!check.valid) return ctx.reply(`❌ ${check.reason}`);
    }

    // If no amount, show quick-buy buttons (user-configurable)
    if (amount === null) {
      const presets = ctx.session?.settings?.buyPresets || [0.1, 0.25, 0.5, 1];
      const userDefault = ctx.session?.settings?.defaultTradeAmountSol;

      // Build preset buttons (max 4 per row)
      const presetButtons = presets.map((sol) =>
        Markup.button.callback(`${sol} SOL`, signCallback('buy', mint, String(sol)))
      );
      const rows = [];
      for (let i = 0; i < presetButtons.length; i += 3) {
        rows.push(presetButtons.slice(i, i + 3));
      }

      // Bottom row: user default (if set and not already in presets) + Custom
      const bottomRow = [];
      if (userDefault && !presets.includes(userDefault)) {
        bottomRow.push(
          Markup.button.callback(`⭐ ${userDefault} SOL`, signCallback('buy', mint, String(userDefault)))
        );
      }
      bottomRow.push(Markup.button.callback('✏️ Custom', signCallback('custom_buy', mint)));
      rows.push(bottomRow);

      // Fetch token info if available
      const tokenRaw = await redis.get(`token_info:${mint}`);
      const token = tokenRaw ? JSON.parse(tokenRaw) : null;
      const name = token?.name || mint.slice(0, 8) + '...';

      let warnings = '';
      if (ctx.state.threatWarning) warnings += '⚠️ No safety data available\n';
      if (ctx.state.devWarning) warnings += `${ctx.state.devWarning}\n`;
      if (ctx.state.lpWarning) warnings += `${ctx.state.lpWarning}\n`;

      return ctx.reply(
        `🟢 *Buy ${name}*\n${warnings}\nSelect amount:`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(rows),
        }
      );
    }

    // Execute buy
    return executeBuy(ctx, mint, amount);
  };

  // Apply threatGate to extract and validate mint
  const extractMint = (ctx) => parseArgs(ctx.message?.text || '').mint;

  bot.command(['buy', 'b'], threatGate(extractMint), handler);
}

/**
 * Execute buy via snipe engine (queued).
 */
async function executeBuy(ctx, mint, amountSol) {
  const userId   = ctx.from.id;
  const wallet   = ctx.state.wallet;
  const isDryRun = ctx.session?.settings?.dryRun || false;

  const msg = await ctx.reply(
    `⏳ ${isDryRun ? '[DRY RUN] ' : ''}Buying ${amountSol} SOL of \`${mint.slice(0, 8)}...\``,
    { parse_mode: 'Markdown' }
  );

  try {
    // Publish buy job to Redis for snipe-engine
    const job = {
      type:      'manual_buy',
      mint,
      amountSol,
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
    log.info({ userId, mint, amountSol, dryRun: isDryRun }, 'buy job published');

    // Log trade intent
    await Trade.create({
      telegramId:  userId,
      type:        'buy',
      mint,
      amountSol,
      wallet,
      status:      'pending',
      dryRun:      isDryRun,
      source:      'manual',
    });
  } catch (err) {
    log.error({ err: err.message, mint }, 'buy execution failed');
    await ctx.telegram.editMessageText(
      ctx.chat.id, msg.message_id, undefined,
      `❌ Buy failed: ${err.message}`
    ).catch(() => {});
  }
}

module.exports = { register };
