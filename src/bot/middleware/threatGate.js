/**
 * threatGate.js — Per-handler middleware for trade safety
 * 
 * Checks threat:{mint} in Redis before executing any buy/snipe.
 * Blocks if score < 80 or honeypot detected.
 * Used as per-handler middleware, NOT global.
 */
'use strict';

const { redis } = require('../../config/redis');
const log = require('../../config/logger').child({ module: 'threatGate' });

const MIN_THREAT_SCORE = 80;

/**
 * Threat gate middleware factory.
 * 
 * @param {Function} getMint — fn(ctx) => string — extracts mint address from context
 * @returns {Function} Telegraf middleware
 */
function threatGate(getMint) {
  return async (ctx, next) => {
    const mint = typeof getMint === 'function' ? getMint(ctx) : null;
    if (!mint) {
      log.warn({ userId: ctx.from?.id }, 'threatGate: no mint extracted');
      return ctx.reply('⚠️ Invalid token address.');
    }

    try {
      // Parallel fetch: threat score + honeypot
      const [threatRaw, honeypotRaw] = await redis.mget(
        `threat:${mint}`,
        `honeypot:${mint}`
      );

      // Honeypot hard block
      if (honeypotRaw) {
        const honeypot = JSON.parse(honeypotRaw);
        if (honeypot.isHoneypot) {
          log.warn({ mint, userId: ctx.from?.id }, 'honeypot blocked');
          return ctx.reply('🔴 HONEYPOT DETECTED — Trade blocked for your safety.');
        }
      }

      // Threat score check
      if (threatRaw) {
        const threat = JSON.parse(threatRaw);
        const score = threat.score ?? 0;
        if (score < MIN_THREAT_SCORE) {
          log.warn({ mint, score, userId: ctx.from?.id }, 'threat score too low');
          return ctx.reply(
            `🔴 Trade blocked — Safety score: ${score}/100 (min: ${MIN_THREAT_SCORE})\n` +
            `Use /threat ${mint} to see details.`
          );
        }
      } else {
        // No cached threat data — warn but don't block
        log.info({ mint }, 'no threat data cached, allowing with warning');
        ctx.state.threatWarning = true;
      }

      // Check dev wallet holdings
      const devRaw = await redis.get(`dev_wallet:${mint}`);
      if (devRaw) {
        const dev = JSON.parse(devRaw);
        if (dev.holdingPct > 50) {
          return ctx.reply(
            `🔴 Dev holds ${dev.holdingPct.toFixed(1)}% of supply — HIGH RISK\n` +
            `Trade blocked for your safety.`
          );
        }
        if (dev.holdingPct > 20) {
          ctx.state.devWarning = `⚠️ Dev holds ${dev.holdingPct.toFixed(1)}% of supply`;
        }
      }

      // Check LP lock
      const lpRaw = await redis.get(`lp_lock:${mint}`);
      if (lpRaw) {
        const lp = JSON.parse(lpRaw);
        if (!lp.locked) {
          ctx.state.lpWarning = '⚠️ LP is NOT locked — elevated rug risk';
        }
      }

      // Attach mint to state for downstream handlers
      ctx.state.mint = mint;
      ctx.state.threatPassed = true;
    } catch (err) {
      log.error({ err: err.message, mint }, 'threatGate error');
      return ctx.reply('⚠️ Could not verify token safety. Please try again.');
    }

    return next();
  };
}

module.exports = { threatGate };
