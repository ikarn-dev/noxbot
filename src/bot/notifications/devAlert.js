/**
 * notifications/devAlert.js — Dev wallet activity alert
 *
 * Handles 'dev_dumping' events from nox:threat_alerts.
 * Shows: dev wallet, % sold, remaining dev holdings, urgency level.
 * Provides inline "Exit Now" button for immediate action.
 *
 * Separated from threatAlert.js so it can have its own rate-limiting
 * and formatting distinct from generic threat-level changes.
 */
'use strict';

const { Markup }       = require('telegraf');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'notif:devalert' });
const User             = require('../../models/User');
const Trade            = require('../../models/Trade');
const { signCallback } = require('../middleware/callbackVerifier');

const ALERT_COOLDOWN = 600; // 10 min cooldown per mint per user

/**
 * Handle a dev wallet dumping event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleDevAlert(bot, data) {
  const {
    mint, tokenName, devWallet, devSoldPct,
    devRemainingPct, estimatedImpact,
  } = data;

  // Find users holding this token
  const holders = await Trade.find({
    mint,
    side: 'buy',
    status: 'confirmed',
  }).distinct('userId');

  if (holders.length === 0) return;

  const users = await User.find({
    telegramId: { $in: holders },
    isBanned: false,
    'settings.notifyThreatAlerts': { $ne: false },
  }).lean();

  if (users.length === 0) return;

  const tokenStr = tokenName || (mint ? mint.slice(0, 8) + '...' : 'unknown');
  const devAddr  = devWallet ? devWallet.slice(0, 6) + '...' + devWallet.slice(-4) : 'unknown';
  const severity = (devSoldPct || 0) >= 50 ? '🔴 CRITICAL' : '🟡 WARNING';

  const text =
    `⚠️ *Dev Wallet Dumping*\n\n` +
    `${severity}\n` +
    `Token: \`${tokenStr}\`\n` +
    `Mint: \`${mint}\`\n` +
    `Dev: \`${devAddr}\`\n` +
    `Sold: ${Number(devSoldPct || 0).toFixed(1)}% of holdings\n` +
    `Dev remaining: ${Number(devRemainingPct || 0).toFixed(1)}%\n` +
    (estimatedImpact ? `Est. price impact: -${Number(estimatedImpact).toFixed(1)}%\n` : '') +
    `\n💡 _Dev selling large amounts may signal exit_`;

  const buttons = Markup.inlineKeyboard([
    [
      Markup.button.callback('🚨 Exit Now', signCallback('sell', mint, '100')),
      Markup.button.callback('📊 Check', signCallback('refresh', mint)),
    ],
    [
      Markup.button.callback('🔕 Mute Token', signCallback('mute', mint)),
    ],
  ]);

  let sent = 0;
  for (const user of users) {
    // Rate limit: 1 dev alert per mint per user per cooldown
    const rlKey = `notify:dev:${user.telegramId}:${mint}`;
    const isNew = await redis.set(rlKey, '1', 'EX', ALERT_COOLDOWN, 'NX');
    if (!isNew) continue;

    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...buttons,
      });
      sent++;
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'dev alert push failed');
    }
  }

  log.info({ mint: mint?.slice(0, 8), devSoldPct, holders: holders.length, sent }, 'dev alerts sent');
}

module.exports = { handleDevAlert };
