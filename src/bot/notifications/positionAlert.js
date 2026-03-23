/**
 * notifications/positionAlert.js — TP/SL hit notifications
 *
 * Handles events from nox:position_alerts channel:
 *   - tp_hit  → take-profit threshold reached
 *   - sl_hit  → stop-loss threshold reached
 *   - trail_update → trailing stop moved
 *
 * Pushes formatted messages with inline "Sell Now" buttons.
 */
'use strict';

const { Markup }       = require('telegraf');
const log              = require('../../config/logger').child({ module: 'notif:position' });
const { signCallback } = require('../middleware/callbackVerifier');

/**
 * Handle a position alert event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handlePositionAlert(bot, data) {
  const { type } = data;

  switch (type) {
    case 'tp_hit':
      return handleTPHit(bot, data);
    case 'sl_hit':
      return handleSLHit(bot, data);
    case 'trail_update':
      return handleTrailUpdate(bot, data);
    default:
      log.warn({ type }, 'unknown position alert type');
  }
}

/**
 * Take-profit threshold hit.
 */
async function handleTPHit(bot, data) {
  const {
    userId, mint, tokenName, pnlPct, pnlSol,
    entryPrice, currentPrice, autoSold, txSig,
  } = data;

  if (!userId) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const pnlSign  = pnlPct >= 0 ? '+' : '';

  let text =
    `🎯 *Take Profit Hit!*\n\n` +
    `Token: ${tokenStr}\n` +
    `PnL: ${pnlSign}${(pnlPct || 0).toFixed(1)}% (${pnlSign}${(pnlSol || 0).toFixed(4)}◎)\n`;

  if (entryPrice && currentPrice) {
    text += `Entry → Now: ${entryPrice.toFixed(8)} → ${currentPrice.toFixed(8)}\n`;
  }

  if (autoSold) {
    const txLink = txSig ? `[View TX](https://solscan.io/tx/${txSig})` : '';
    text += `\n✅ *Auto-sold* ${txLink}`;

    try {
      await bot.telegram.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      log.warn({ userId, err: err.message }, 'tp hit push failed');
    }
  } else {
    text += `\n⚡ TP target reached — sell manually?`;

    try {
      await bot.telegram.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 Sell 50%', signCallback('sell', mint, '50')),
            Markup.button.callback('🔴 Sell 100%', signCallback('sell', mint, '100')),
          ],
          [
            Markup.button.callback('📈 Let It Ride', signCallback('skip', mint)),
          ],
        ]),
      });
    } catch (err) {
      log.warn({ userId, err: err.message }, 'tp hit push failed');
    }
  }

  log.info({ userId, mint: mint?.slice(0, 8), pnlPct, autoSold }, 'TP alert sent');
}

/**
 * Stop-loss threshold hit.
 */
async function handleSLHit(bot, data) {
  const {
    userId, mint, tokenName, pnlPct, pnlSol,
    autoSold, txSig,
  } = data;

  if (!userId) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const pnlSign  = pnlPct >= 0 ? '+' : '';

  let text =
    `🛑 *Stop Loss Hit!*\n\n` +
    `Token: ${tokenStr}\n` +
    `PnL: ${pnlSign}${(pnlPct || 0).toFixed(1)}% (${pnlSign}${(pnlSol || 0).toFixed(4)}◎)\n`;

  if (autoSold) {
    const txLink = txSig ? `[View TX](https://solscan.io/tx/${txSig})` : '';
    text += `\n✅ *Auto-sold to limit losses* ${txLink}`;

    try {
      await bot.telegram.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (err) {
      log.warn({ userId, err: err.message }, 'sl hit push failed');
    }
  } else {
    text += `\n⚠️ SL target reached — sell to cut losses?`;

    try {
      await bot.telegram.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 Sell 100%', signCallback('sell', mint, '100')),
            Markup.button.callback('🤞 Hold', signCallback('skip', mint)),
          ],
        ]),
      });
    } catch (err) {
      log.warn({ userId, err: err.message }, 'sl hit push failed');
    }
  }

  log.info({ userId, mint: mint?.slice(0, 8), pnlPct, autoSold }, 'SL alert sent');
}

/**
 * Trailing stop moved (informational).
 */
async function handleTrailUpdate(bot, data) {
  const { userId, mint, tokenName, newStopPct, highPct } = data;

  if (!userId) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const text =
    `📊 *Trailing Stop Updated*\n\n` +
    `Token: ${tokenStr}\n` +
    `Peak PnL: +${(highPct || 0).toFixed(1)}%\n` +
    `New stop: +${(newStopPct || 0).toFixed(1)}%\n\n` +
    `Stop rises with price — locks in profit.`;

  try {
    await bot.telegram.sendMessage(userId, text, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    log.warn({ userId, err: err.message }, 'trail update push failed');
  }
}

module.exports = { handlePositionAlert };
