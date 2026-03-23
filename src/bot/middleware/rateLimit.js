/**
 * rateLimit.js — Redis-backed rate limiter
 * 
 * Per-user: 10 actions/min
 * Global:   500 actions/sec
 * Auto-ban: >50 actions in 30s → 5min cooldown
 */
'use strict';

const { redis } = require('../../config/redis');
const log = require('../../config/logger').child({ module: 'rateLimit' });

const USER_LIMIT    = 10;     // per user per 60s
const USER_WINDOW   = 60;     // seconds
const GLOBAL_LIMIT  = 500;    // all users per 1s
const GLOBAL_WINDOW = 1;      // second
const BAN_THRESHOLD = 50;     // actions in 30s → auto-ban
const BAN_WINDOW    = 30;     // seconds
const BAN_DURATION  = 300;    // 5 minute cooldown

/**
 * Increment a key and set TTL if new. Returns current count.
 */
async function incrementWindow(key, windowSec) {
  const multi = redis.multi();
  multi.incr(key);
  multi.expire(key, windowSec);
  const results = await multi.exec();
  return results[0][1]; // count
}

/**
 * Rate limit middleware for Telegraf.
 */
function rateLimitMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const nowSec = Math.floor(Date.now() / 1000);

    try {
      // Check ban first
      const banned = await redis.get(`ratelimit:ban:${userId}`);
      if (banned) {
        log.warn({ userId }, 'rate-limited (banned)');
        return ctx.reply('🚫 Too many requests. Please wait 5 minutes.');
      }

      // Per-user limit (10/min)
      const userKey = `ratelimit:user:${userId}:${Math.floor(nowSec / USER_WINDOW)}`;
      const userCount = await incrementWindow(userKey, USER_WINDOW);
      if (userCount > USER_LIMIT) {
        log.warn({ userId, count: userCount }, 'per-user rate limit hit');
        return ctx.reply('⚠️ Slow down — max 10 actions per minute.');
      }

      // Global limit (500/sec)
      const globalKey = `ratelimit:global:${Math.floor(nowSec / GLOBAL_WINDOW)}`;
      const globalCount = await incrementWindow(globalKey, GLOBAL_WINDOW + 1);
      if (globalCount > GLOBAL_LIMIT) {
        log.warn({ globalCount }, 'global rate limit hit');
        return ctx.reply('⚠️ Bot is under heavy load. Please try again.');
      }

      // Abuse detection (50 actions in 30s → auto-ban)
      const abuseKey = `ratelimit:abuse:${userId}:${Math.floor(nowSec / BAN_WINDOW)}`;
      const abuseCount = await incrementWindow(abuseKey, BAN_WINDOW);
      if (abuseCount > BAN_THRESHOLD) {
        await redis.set(`ratelimit:ban:${userId}`, '1', 'EX', BAN_DURATION);
        log.error({ userId, count: abuseCount }, 'auto-banned for abuse');
        return ctx.reply('🚫 Banned for 5 minutes due to excessive requests.');
      }
    } catch (err) {
      // If Redis is down, let requests through (fail-open for read commands)
      log.error({ err: err.message }, 'rate limiter error');
    }

    return next();
  };
}

module.exports = { rateLimitMiddleware };
