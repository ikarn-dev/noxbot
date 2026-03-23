/**
 * notifications/sellConfirmation.js — Post-sell summary card
 *
 * Handles 'sell_confirmed' events on nox:trade_results.
 * Shows: token, % sold, SOL received, remaining position size, PnL.
 * Called after manual /sell execution completes.
 */
'use strict';

const { Markup }       = require('telegraf');
const log              = require('../../config/logger').child({ module: 'notif:sellconfirm' });
const { signCallback } = require('../middleware/callbackVerifier');

/**
 * Handle a sell confirmation event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleSellConfirmation(bot, data) {
  const {
    userId, chatId, messageId, mint, tokenName,
    sellPct, solReceived, remainingTokens, remainingValueSol,
    pnlSol, pnlPct, txSig,
  } = data;

  if (!chatId) return;

  const tokenStr     = tokenName || (mint ? mint.slice(0, 8) + '...' : 'unknown');
  const txLink       = txSig ? `https://solscan.io/tx/${txSig}` : null;
  const pnlSign      = (pnlSol || 0) >= 0 ? '+' : '';
  const hasRemaining = remainingTokens != null && remainingTokens > 0;

  const text =
    `🔴 *Sell Confirmed*\n\n` +
    `Token: \`${tokenStr}\`\n` +
    `Sold: ${sellPct || 100}%\n` +
    `Received: ${Number(solReceived || 0).toFixed(4)}◎\n` +
    (pnlSol != null ? `PnL: ${pnlSign}${Number(pnlSol).toFixed(4)}◎ (${pnlSign}${Number(pnlPct || 0).toFixed(1)}%)\n` : '') +
    (hasRemaining
      ? `Remaining: ~${Number(remainingValueSol).toFixed(4)}◎\n`
      : `Position: *CLOSED*\n`) +
    (txLink ? `\n[View TX](${txLink})` : '');

  const buttons = hasRemaining
    ? Markup.inlineKeyboard([
        [
          Markup.button.callback('🔴 Sell Rest', signCallback('sell', mint, '100')),
          Markup.button.callback('📊 PnL', signCallback('pnl', mint)),
        ],
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback('📊 Full PnL', signCallback('pnl', mint))],
      ]);

  try {
    if (messageId) {
      // Edit the original "Selling..." message
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...buttons,
      });
    } else {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...buttons,
      });
    }
  } catch (err) {
    log.warn({ userId, err: err.message }, 'sell confirmation push failed');
  }

  log.info({ mint: mint?.slice(0, 8), sellPct, solReceived, userId }, 'sell confirmation sent');
}

module.exports = { handleSellConfirmation };
