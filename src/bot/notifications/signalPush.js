/**
 * notifications/signalPush.js — In-process event bus signal subscriber
 * 
 * Subscribes to:
 *   - nox:signals        — KOL activity, new listings, copy trade triggers
 *   - nox:trade_results  — Trade execution confirmations/failures/exits/sells
 *   - nox:kol_alerts     — KOL buy/sell/cluster events (from kol/scanner)
 *   - nox:threat_alerts  — Threat-level changes, dev dumps (from threat modules)
 *   - nox:position_alerts — TP/SL hit events (from position-monitor)
 * 
 * Pushes formatted Telegram messages to subscribed users.
 */
'use strict';

const { Markup }   = require('telegraf');
const eventBus     = require('../../config/event-bus');
const log          = require('../../config/logger').child({ module: 'signals' });
const User         = require('../../models/User');
const { signCallback } = require('../middleware/callbackVerifier');

// Phase 4 notification handlers
const { handleKolAlert }          = require('./kolAlert');
const { handleThreatAlert }       = require('./threatAlert');
const { handlePositionAlert }     = require('./positionAlert');
const { handleListingAlert }      = require('./listingAlert');
const { handleExitAlert }         = require('./exitAlert');
const { handleSellConfirmation }  = require('./sellConfirmation');
const { handleDevAlert }          = require('./devAlert');

/**
 * Start listening for signals and pushing to users.
 * @param {import('telegraf').Telegraf} bot
 */
function startSignalSubscriber(bot) {
  const channels = [
    'nox:signals',
    'nox:trade_results',
    'nox:kol_alerts',
    'nox:threat_alerts',
    'nox:position_alerts',
  ];

  for (const channel of channels) {
    eventBus.subscribe(channel, async (_ch, message) => {
      try {
        const data = JSON.parse(message);

        switch (channel) {
          case 'nox:signals':
            await handleSignal(bot, data);
            break;
          case 'nox:trade_results':
            await handleTradeResult(bot, data);
            break;
          case 'nox:kol_alerts':
            await handleKolAlert(bot, data);
            break;
          case 'nox:threat_alerts':
            await handleThreatAlert(bot, data);
            break;
          case 'nox:position_alerts':
            await handlePositionAlert(bot, data);
            break;
        }
      } catch (err) {
        log.error({ err: err.message, channel }, 'signal processing error');
      }
    });
  }

  log.info({ channels: channels.length }, 'signal subscriber active (event-bus)');
}

/**
 * Handle KOL/copy trade signals.
 */
async function handleSignal(bot, data) {
  const { type, mint, wallet, amountSol, name } = data;

  switch (type) {
    case 'kol_buy': {
      // Find users who copy this wallet
      const users = await User.find({
        'copyTargets.wallet': wallet,
        'copyTargets.enabled': true,
      }).lean();

      if (users.length === 0) return;

      const tokenName = name || mint?.slice(0, 8) + '...';
      const addr = wallet.slice(0, 8) + '...';

      for (const user of users) {
        const copy = user.copyTargets.find(c => c.wallet === wallet);
        const copyAmount = Math.min(
          (amountSol || 0.1) * (copy?.multiplier || 1),
          copy?.maxSol || 1
        );

        try {
          await bot.telegram.sendMessage(
            user.telegramId,
            `🔔 *KOL Trade Detected*\n\n` +
            `Wallet: \`${addr}\`\n` +
            `Token: ${tokenName}\n` +
            `Amount: ${amountSol}◎\n` +
            `Your copy: ${copyAmount.toFixed(4)}◎`,
            {
              parse_mode: 'Markdown',
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('✅ Copy', signCallback('buy', mint, String(copyAmount))),
                  Markup.button.callback('❌ Skip', signCallback('skip', mint)),
                ],
              ]),
            }
          );
        } catch (err) {
          log.warn({ userId: user.telegramId, err: err.message }, 'signal push failed');
        }
      }
      break;
    }

    case 'new_listing': {
      await handleListingAlert(bot, data);
      break;
    }
  }
}

/**
 * Handle trade execution results from snipe-engine.
 */
async function handleTradeResult(bot, data) {
  const { userId, chatId, messageId, status, mint, txSig, error, pnl, type } = data;

  if (!chatId || !userId) return;

  // Route auto-exit events to exitAlert
  if (type === 'auto_exit' || ['tp_exit', 'sl_exit', 'threat_exit', 'kol_exit'].includes(data.reason)) {
    return handleExitAlert(bot, data);
  }

  // Route sell confirmations to sellConfirmation
  if (type === 'sell' && status === 'success' && data.sellPct != null) {
    return handleSellConfirmation(bot, data);
  }

  const tokenSlice = mint ? mint.slice(0, 8) + '...' : 'unknown';

  if (status === 'success') {
    const txLink = `https://solscan.io/tx/${txSig}`;
    const emoji  = type === 'sell' ? '🔴' : '🟢';
    const label  = (type || 'trade').toUpperCase();

    const text =
      `${emoji} *${label} Executed*\n\n` +
      `Token: \`${tokenSlice}\`\n` +
      (pnl !== undefined ? `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL\n` : '') +
      `[View TX](${txLink})`;

    if (messageId) {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }).catch(() => {});
    } else {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }).catch(() => {});
    }
  } else if (status === 'failed') {
    const text = `❌ *Trade Failed*\n\n` +
      `Token: \`${tokenSlice}\`\n` +
      `Reason: ${error || 'Unknown error'}`;

    if (messageId) {
      await bot.telegram.editMessageText(chatId, messageId, undefined, text, {
        parse_mode: 'Markdown',
      }).catch(() => {});
    } else {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
  }
}

module.exports = { startSignalSubscriber };
