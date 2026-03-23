/**
 * notifications/threatAlert.js — Threat-level change notifications
 *
 * Handles events from nox:threat_alerts channel:
 *   - threat_change   → token safety score dropped (LP drain, dev dump)
 *   - rug_confirmed   → emergency broadcast to all holders
 *   - honeypot_detected → token flagged as honeypot post-buy
 *   - dev_dumping      → dev wallet selling large amounts
 *
 * Targets: users who hold the affected token (confirmed buys without matching sells).
 */
'use strict';

const { Markup } = require('telegraf');
const log        = require('../../config/logger').child({ module: 'notif:threat' });
const User       = require('../../models/User');
const Trade      = require('../../models/Trade');
const { signCallback } = require('../middleware/callbackVerifier');

/**
 * Handle a threat alert event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleThreatAlert(bot, data) {
  const { type } = data;

  switch (type) {
    case 'rug_confirmed':
      return handleRugConfirmed(bot, data);
    case 'honeypot_detected':
      return handleHoneypot(bot, data);
    case 'dev_dumping':
      return handleDevDump(bot, data);
    case 'threat_change':
      return handleThreatChange(bot, data);
    default:
      log.warn({ type }, 'unknown threat alert type');
  }
}

/**
 * Find Telegram IDs of users holding a specific token.
 * Holders = users with confirmed buy trades and no matching 100% sell.
 */
async function findHolders(mint) {
  const holders = await Trade.aggregate([
    { $match: { tokenMint: mint, status: 'confirmed' } },
    {
      $group: {
        _id: '$userId',
        buys: {
          $sum: { $cond: [{ $eq: ['$type', 'buy'] }, '$amountSol', 0] },
        },
        sells: {
          $sum: { $cond: [{ $eq: ['$type', 'sell'] }, '$amountSol', 0] },
        },
      },
    },
    { $match: { $expr: { $gt: ['$buys', '$sells'] } } },
  ]);

  if (holders.length === 0) return [];

  const userIds = holders.map(h => h._id);
  return User.find({
    telegramId: { $in: userIds },
    'settings.notifyThreatAlerts': { $ne: false },
    isBanned: false,
  }).lean();
}

/**
 * Emergency: rug confirmed — sell immediately.
 */
async function handleRugConfirmed(bot, data) {
  const { mint, tokenName, reason } = data;
  const users = await findHolders(mint);

  if (users.length === 0) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const text =
    `🚨🚨 *RUG CONFIRMED* 🚨🚨\n\n` +
    `Token: ${tokenStr}\n` +
    `Mint: \`${mint}\`\n` +
    `Reason: ${reason || 'Liquidity removed / contract exploit'}\n\n` +
    `⚠️ *Sell immediately if you hold this token!*`;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 SELL 100%', signCallback('sell', mint, '100')),
          ],
        ]),
      });
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'rug alert push failed');
    }
  }

  log.error({ mint: mint?.slice(0, 8), reason, userCount: users.length }, 'RUG CONFIRMED alerts sent');
}

/**
 * Honeypot detected after purchase.
 */
async function handleHoneypot(bot, data) {
  const { mint, tokenName } = data;
  const users = await findHolders(mint);

  if (users.length === 0) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const text =
    `🍯 *Honeypot Detected*\n\n` +
    `Token: ${tokenStr}\n` +
    `Mint: \`${mint}\`\n\n` +
    `This token may prevent selling. ` +
    `If you can still sell, exit your position now.`;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 Try Sell', signCallback('sell', mint, '100')),
            Markup.button.callback('ℹ️ Details', signCallback('info', mint)),
          ],
        ]),
      });
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'honeypot alert push failed');
    }
  }

  log.warn({ mint: mint?.slice(0, 8), userCount: users.length }, 'honeypot alerts sent');
}

/**
 * Dev wallet dumping tokens.
 */
async function handleDevDump(bot, data) {
  const { mint, tokenName, devWallet, sellPct } = data;
  const users = await findHolders(mint);

  if (users.length === 0) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const devAddr  = devWallet ? devWallet.slice(0, 8) + '...' : 'Unknown';
  const text =
    `⚠️ *Dev Wallet Selling*\n\n` +
    `Token: ${tokenStr}\n` +
    `Dev: \`${devAddr}\`\n` +
    `Sold: ~${sellPct || '?'}% of holdings\n\n` +
    `The developer is reducing their position.`;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 Sell Now', signCallback('sell', mint, '100')),
            Markup.button.callback('👀 Monitor', signCallback('skip', mint)),
          ],
        ]),
      });
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'dev dump alert push failed');
    }
  }

  log.warn({ mint: mint?.slice(0, 8), sellPct, userCount: users.length }, 'dev dump alerts sent');
}

/**
 * Generic threat score change.
 */
async function handleThreatChange(bot, data) {
  const { mint, tokenName, oldScore, newScore, reason } = data;

  // Only alert on significant drops (≥20 points)
  if (typeof oldScore === 'number' && typeof newScore === 'number') {
    if (oldScore - newScore < 20) return;
  }

  const users = await findHolders(mint);
  if (users.length === 0) return;

  const tokenStr = tokenName || mint?.slice(0, 8) + '...';
  const text =
    `⚠️ *Safety Score Changed*\n\n` +
    `Token: ${tokenStr}\n` +
    `Score: ${oldScore ?? '?'} → ${newScore ?? '?'}\n` +
    `Reason: ${reason || 'Multiple factors changed'}\n\n` +
    `Review your position.`;

  for (const user of users) {
    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'threat change alert push failed');
    }
  }

  log.info({ mint: mint?.slice(0, 8), oldScore, newScore, userCount: users.length }, 'threat change alerts sent');
}

module.exports = { handleThreatAlert };
