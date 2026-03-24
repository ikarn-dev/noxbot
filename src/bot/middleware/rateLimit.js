/**
 * rateLimit.js — In-memory rate limiter
 *
 * Per-user: 10 actions/min
 * Global:   500 actions/sec
 * Auto-ban: >50 actions in 30s → 5min cooldown
 *
 * NOTE: Uses in-memory Maps instead of Redis to avoid Node v24
 * TLS memory leak (3 Redis TLS calls per update was the OOM trigger).
 * Fine for single-process deployment.
 */
'use strict';

const log = require('../../config/logger').child({ module: 'rateLimit' });

const USER_LIMIT    = 10;
const USER_WINDOW   = 60_000;   // ms
const GLOBAL_LIMIT  = 500;
const BAN_THRESHOLD = 50;
const BAN_WINDOW    = 30_000;   // ms
const BAN_DURATION  = 300_000;  // 5 min

// In-memory stores (auto-cleanup via expiry check)
const userCounts  = new Map(); // key → { count, resetAt }
const globalState = { count: 0, resetAt: 0 };
const bans        = new Map(); // userId → expiresAt
const abuseCounts = new Map(); // userId → { count, resetAt }

function getCount(map, key, windowMs) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now >= entry.resetAt) {
    const newEntry = { count: 1, resetAt: now + windowMs };
    map.set(key, newEntry);
    return 1;
  }
  entry.count++;
  return entry.count;
}

// Periodically clean up expired entries (every 60s)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userCounts)  { if (now >= v.resetAt) userCounts.delete(k); }
  for (const [k, v] of bans)       { if (now >= v) bans.delete(k); }
  for (const [k, v] of abuseCounts) { if (now >= v.resetAt) abuseCounts.delete(k); }
}, 60_000).unref();

function rateLimitMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();

    // Check ban
    const banExpiry = bans.get(userId);
    if (banExpiry && now < banExpiry) {
      log.warn({ userId }, 'rate-limited (banned)');
      return ctx.reply('🚫 Too many requests. Please wait 5 minutes.');
    }

    // Per-user limit (10/min)
    const userCount = getCount(userCounts, userId, USER_WINDOW);
    if (userCount > USER_LIMIT) {
      log.warn({ userId, count: userCount }, 'per-user rate limit hit');
      return ctx.reply('⚠️ Slow down — max 10 actions per minute.');
    }

    // Global limit (500/sec)
    if (now >= globalState.resetAt) {
      globalState.count = 1;
      globalState.resetAt = now + 1000;
    } else {
      globalState.count++;
    }
    if (globalState.count > GLOBAL_LIMIT) {
      log.warn({ count: globalState.count }, 'global rate limit hit');
      return ctx.reply('⚠️ Bot is under heavy load. Please try again.');
    }

    // Abuse detection (50 in 30s → ban)
    const abuseCount = getCount(abuseCounts, userId, BAN_WINDOW);
    if (abuseCount > BAN_THRESHOLD) {
      bans.set(userId, now + BAN_DURATION);
      log.error({ userId, count: abuseCount }, 'auto-banned for abuse');
      return ctx.reply('🚫 Banned for 5 minutes due to excessive requests.');
    }

    return next();
  };
}

module.exports = { rateLimitMiddleware };
