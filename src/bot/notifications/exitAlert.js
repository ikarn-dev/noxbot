/**
 * notifications/exitAlert.js — Auto-exit PnL notifications
 *
 * Handles events from nox:trade_results channel when type === 'auto_exit':
 *   - tp_exit    → take-profit auto-sold
 *   - sl_exit    → stop-loss auto-sold
 *   - threat_exit → exited due to threat escalation (rug detected, honeypot)
 *   - kol_exit   → exited because tracked KOLs dumped
 *
 * Shows: token, entry/exit price, PnL%, SOL returned, reason.
 */
'use strict';

const { Markup }       = require('telegraf');
const log              = require('../../config/logger').child({ module: 'notif:exit' });
const { signCallback } = require('../middleware/callbackVerifier');

const EXIT_EMOJI = {
  tp_exit:     '🎯',
  sl_exit:     '🛑',
  threat_exit: '🚨',
  kol_exit:    '👋',
};

const EXIT_LABEL = {
  tp_exit:     'Take-Profit Hit',
  sl_exit:     'Stop-Loss Hit',
  threat_exit: 'Threat Auto-Exit',
  kol_exit:    'KOL Exit Detected',
};

/**
 * Handle an auto-exit notification.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleExitAlert(bot, data) {
  const {
    userId, chatId, reason, mint, tokenName,
    entryPriceSol, exitPriceSol, pnlSol, pnlPct,
    solReturned, txSig,
  } = data;

  if (!chatId) return;

  const emoji    = EXIT_EMOJI[reason] || '📤';
  const label    = EXIT_LABEL[reason] || 'Auto-Exit';
  const tokenStr = tokenName || (mint ? mint.slice(0, 8) + '...' : 'unknown');
  const txLink   = txSig ? `https://solscan.io/tx/${txSig}` : null;
  const pnlSign  = (pnlSol || 0) >= 0 ? '+' : '';

  const text =
    `${emoji} *${label}*\n\n` +
    `Token: \`${tokenStr}\`\n` +
    (entryPriceSol != null ? `Entry: ${Number(entryPriceSol).toFixed(6)}◎\n` : '') +
    (exitPriceSol  != null ? `Exit: ${Number(exitPriceSol).toFixed(6)}◎\n` : '') +
    (pnlSol != null ? `PnL: ${pnlSign}${Number(pnlSol).toFixed(4)}◎ (${pnlSign}${Number(pnlPct || 0).toFixed(1)}%)\n` : '') +
    (solReturned   != null ? `Returned: ${Number(solReturned).toFixed(4)}◎\n` : '') +
    (txLink ? `[View TX](${txLink})` : '');

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Re-enter', signCallback('buy', mint, '0.1')),
      Markup.button.callback('📊 PnL', signCallback('pnl', mint)),
    ],
  ]);

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...buttons,
    });
  } catch (err) {
    log.warn({ userId, err: err.message }, 'exit alert push failed');
  }

  log.info({ reason, mint: mint?.slice(0, 8), pnlSol, userId }, 'exit alert sent');
}

module.exports = { handleExitAlert };
