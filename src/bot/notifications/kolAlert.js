/**
 * notifications/kolAlert.js — KOL activity alerts
 *
 * Handles events from nox:kol_alerts channel:
 *   - kol_buy     → alert users copying this wallet
 *   - kol_sell    → alert users copying this wallet
 *   - kol_cluster → broadcast cluster signal to subscribed users
 *
 * Rate-limited: 1 alert per wallet per user per 5 minutes.
 */
'use strict';

const { Markup }       = require('telegraf');
const { redis }        = require('../../config/redis');
const log              = require('../../config/logger').child({ module: 'notif:kol' });
const User             = require('../../models/User');
const KOL              = require('../../models/KOL');
const { signCallback } = require('../middleware/callbackVerifier');

const RATE_LIMIT_TTL = 300; // 5 minutes

/**
 * Tier badge for display.
 */
const TIER_BADGE = {
  s: '👑 S-Tier',
  a: '🔥 A-Tier',
  b: '⭐ B-Tier',
  unranked: '📊 Tracked',
};

/**
 * Handle a KOL alert event.
 * @param {import('telegraf').Telegraf} bot
 * @param {Object} data
 */
async function handleKolAlert(bot, data) {
  const { type } = data;

  switch (type) {
    case 'kol_buy':
    case 'kol_sell':
      return handleKolTrade(bot, data);
    case 'kol_cluster':
      return handleKolCluster(bot, data);
    default:
      log.warn({ type }, 'unknown kol alert type');
  }
}

/**
 * Handle individual KOL buy/sell event.
 */
async function handleKolTrade(bot, data) {
  const { type, wallet, mint, amountSol, tier, label, tokenName } = data;

  // Find users who copy this wallet AND have KOL alerts enabled
  const users = await User.find({
    'copyTargets.kolWallet': wallet,
    'copyTargets.enabled': true,
    'settings.notifyKolAlerts': { $ne: false },
    isBanned: false,
  }).lean();

  if (users.length === 0) return;

  const action   = type === 'kol_buy' ? 'BOUGHT' : 'SOLD';
  const emoji    = type === 'kol_buy' ? '🟢' : '🔴';
  const badge    = TIER_BADGE[tier] || TIER_BADGE.unranked;
  const nameStr  = label || wallet.slice(0, 8) + '...';
  const tokenStr = tokenName || mint?.slice(0, 8) + '...';

  for (const user of users) {
    // Rate limit: 1 alert per wallet per user per 5min
    const rlKey = `notify:kol:${user.telegramId}:${wallet}`;
    const exists = await redis.set(rlKey, '1', 'EX', RATE_LIMIT_TTL, 'NX');
    if (!exists) continue; // Already notified recently

    const copy      = user.copyTargets.find(c => c.kolWallet === wallet);
    const copyAmt   = copy ? Math.min(
      (amountSol || 0.1) * 1,
      copy.maxPerTrade || 0.5,
    ).toFixed(4) : null;

    const text =
      `${emoji} *KOL ${action}*\n\n` +
      `${badge}\n` +
      `Wallet: \`${wallet.slice(0, 8)}...${wallet.slice(-4)}\`\n` +
      `Name: ${nameStr}\n` +
      `Token: ${tokenStr}\n` +
      `Amount: ${(amountSol || 0).toFixed(4)}◎`;

    const buttons = type === 'kol_buy'
      ? Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Copy Buy', signCallback('buy', mint, copyAmt)),
            Markup.button.callback('❌ Skip', signCallback('skip', mint)),
          ],
        ])
      : Markup.inlineKeyboard([
          [
            Markup.button.callback('🔴 Sell Mine', signCallback('sell', mint, '100')),
            Markup.button.callback('👀 Watch', signCallback('skip', mint)),
          ],
        ]);

    try {
      await bot.telegram.sendMessage(user.telegramId, text, {
        parse_mode: 'Markdown',
        ...buttons,
      });
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'kol alert push failed');
    }
  }

  log.info({ type, wallet: wallet.slice(0, 8), mint: mint?.slice(0, 8), userCount: users.length }, 'kol trade alerts sent');
}

/**
 * Handle cluster buy event (≥3 KOLs buying same token).
 */
async function handleKolCluster(bot, data) {
  const { mint, tokenName, kolCount, topTier, kols } = data;

  // Broadcast to all users with KOL alerts enabled
  const users = await User.find({
    'settings.notifyKolAlerts': { $ne: false },
    onboardingComplete: true,
    isBanned: false,
  }).lean();

  if (users.length === 0) return;

  const badge     = TIER_BADGE[topTier] || TIER_BADGE.unranked;
  const tokenStr  = tokenName || mint?.slice(0, 8) + '...';
  const kolNames  = (kols || []).map(k => k.label || k.wallet?.slice(0, 8)).join(', ') || 'Multiple';

  const text =
    `🚨 *CLUSTER BUY DETECTED*\n\n` +
    `Token: ${tokenStr}\n` +
    `Mint: \`${mint}\`\n` +
    `KOLs: ${kolCount} wallets buying\n` +
    `Top tier: ${badge}\n` +
    `Who: ${kolNames}\n\n` +
    `⚡ Multiple tracked wallets are buying the same token!`;

  for (const user of users) {
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
    } catch (err) {
      log.warn({ userId: user.telegramId, err: err.message }, 'cluster alert push failed');
    }
  }

  log.info({ mint: mint?.slice(0, 8), kolCount, userCount: users.length }, 'cluster alerts sent');
}

module.exports = { handleKolAlert };
