/**
 * notifications/listingAlert.js — New token listing broadcasts
 *
 * Broadcasts new token listings to users who have listing alerts enabled.
 * Rate-limited: max 10 listing alerts per user per minute.
 *
 * Called from signalPush.js when type === 'new_listing' on nox:signals.
 */
'use strict';

const { Markup }       = require('telegraf');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'notif:listing' });
const User             = require('../../models/User');
const { signCallback } = require('../middleware/callbackVerifier');

const RATE_LIMIT_MAX   = 10;
const RATE_LIMIT_WINDOW = 60; // 1 minute

/**
 * Handle a new listing event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleListingAlert(bot, data) {
  const {
    mint, tokenName, tokenSymbol, dex,
    liquidityUsd, rugCheckScore, poolAddress,
  } = data;

  if (!mint) return;

  // Find users with listing alerts enabled (via notifyKolAlerts as proxy,
  // or a dedicated field — using notifyKolAlerts for now since the User
  // model doesn't have a separate listingAlerts field)
  const users = await User.find({
    onboardingComplete: true,
    isBanned: false,
    'settings.autoSnipeEnabled': true, // Only auto-snipe users get listing alerts
  }).lean();

  if (users.length === 0) return;

  const tokenStr   = tokenName || tokenSymbol || mint.slice(0, 8) + '...';
  const symbolStr  = tokenSymbol ? `($${tokenSymbol})` : '';
  const dexStr     = (dex || 'unknown').toUpperCase();
  const liqStr     = liquidityUsd
    ? `$${liquidityUsd >= 1000 ? (liquidityUsd / 1000).toFixed(1) + 'K' : liquidityUsd.toFixed(0)}`
    : 'Unknown';
  const rugStr     = typeof rugCheckScore === 'number' ? `${rugCheckScore}/100` : 'N/A';
  const safeEmoji  = rugCheckScore >= 80 ? '✅' : rugCheckScore >= 50 ? '⚠️' : '🔴';

  const text =
    `🆕 *New Listing Detected*\n\n` +
    `Token: ${tokenStr} ${symbolStr}\n` +
    `DEX: ${dexStr}\n` +
    `Liquidity: ${liqStr}\n` +
    `Safety: ${safeEmoji} ${rugStr}\n` +
    `Mint: \`${mint}\``;

  let sent = 0;
  for (const user of users) {
    // Rate limit: max 10 listing alerts per minute per user
    const rlKey = `notify:listing:${user.telegramId}`;
    const count = await redis.incr(rlKey);
    if (count === 1) {
      await redis.expire(rlKey, RATE_LIMIT_WINDOW);
    }
    if (count > RATE_LIMIT_MAX) continue;

    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🎯 Snipe', signCallback('buy', mint, '0.1')),
            Markup.button.callback('👀 Watch', signCallback('skip', mint)),
          ],
        ]),
      });
      sent++;
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'listing alert push failed');
    }
  }

  log.info({
    mint: mint.slice(0, 8),
    tokenName,
    liqStr,
    userCount: users.length,
    sent,
  }, 'listing alerts sent');
}

module.exports = { handleListingAlert };
