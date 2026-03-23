/**
 * threat/lp-lock-checker.js — Liquidity pool lock status monitor
 *
 * Periodically re-checks LP lock status for tokens users hold.
 * If liquidity becomes unlocked or LP is drained, publishes
 * rug_confirmed or threat_change events to nox:threat_alerts.
 *
 * Runs every 2 minutes.
 */
'use strict';

const logger = require('../config/logger').child({ module: 'threat:lplock' });
const { redis } = require('../config/redis');
const eventBus  = require('../config/event-bus');
const { fetchRugCheck, parseRugCheckData } = require('./pre-cacher');
const Trade = require('../models/Trade');

const CHECK_INTERVAL_MS = 120_000;        // 2 min
const ALERT_CHANNEL     = 'nox:threat_alerts';
const RUG_COOLDOWN_TTL  = 3600;           // 1 hour cooldown per mint
const LP_DROP_THRESHOLD = 30;             // Alert if LP drops ≥30%

/**
 * Start the LP lock checker loop.
 */
async function startLpLockChecker() {
  logger.info('LP lock checker starting');

  const check = async () => {
    try {
      await checkLpLocks();
    } catch (err) {
      logger.error({ err: err.message }, 'LP lock check cycle failed');
    }
  };

  await check();
  const intervalId = setInterval(check, CHECK_INTERVAL_MS);
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, 'LP lock checker loop started');
  return intervalId;
}

/**
 * Check LP lock status for tokens with active positions.
 */
async function checkLpLocks() {
  // Get active mints
  const activeMints = await Trade.distinct('tokenMint', {
    type: 'buy',
    status: 'confirmed',
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  if (activeMints.length === 0) return;

  logger.debug({ mintCount: activeMints.length }, 'checking LP locks');

  for (const mint of activeMints) {
    // Cooldown check
    const cooldownKey = `lp:cooldown:${mint}`;
    const onCooldown = await redis.get(cooldownKey);
    if (onCooldown) continue;

    // Get previous LP data
    const prevKey = `lp_lock:${mint}`;
    let prevData = null;
    try {
      const cached = await redis.get(prevKey);
      if (cached) prevData = JSON.parse(cached);
    } catch (_) { /* ignore */ }

    // Fresh fetch from RugCheck
    const rugRaw = await fetchRugCheck(mint);
    if (!rugRaw) continue;

    const newData = parseRugCheckData(rugRaw);

    // Compare with previous data
    if (prevData) {
      const lpDrop = (prevData.lockedPct || 0) - (newData.lpLockedPct || 0);

      // LP significantly dropped — potential rug
      if (lpDrop >= LP_DROP_THRESHOLD) {
        await redis.set(cooldownKey, '1', 'EX', RUG_COOLDOWN_TTL);

        if (newData.lpLockedPct <= 5) {
          // LP fully drained = rug confirmed
          const event = {
            type: 'rug_confirmed',
            mint,
            reason: `LP dropped from ${prevData.lockedPct}% to ${newData.lpLockedPct}% — liquidity drained`,
            timestamp: Date.now(),
          };
          eventBus.publish(ALERT_CHANNEL, event);
          logger.error({ mint: mint.slice(0, 8), lpDrop }, 'RUG CONFIRMED: LP drained');
        } else {
          // Significant drop but not fully drained
          const event = {
            type: 'threat_change',
            mint,
            oldScore: prevData.score || null,
            newScore: newData.score,
            reason: `LP lock dropped from ${prevData.lockedPct}% to ${newData.lpLockedPct}%`,
            timestamp: Date.now(),
          };
          eventBus.publish(ALERT_CHANNEL, event);
          logger.warn({ mint: mint.slice(0, 8), lpDrop }, 'LP lock degraded');
        }
      }

      // Mint authority re-enabled (was revoked, now active)
      if (prevData.mintAuthorityRevoked && !newData.mintAuthorityRevoked) {
        await redis.set(cooldownKey, '1', 'EX', RUG_COOLDOWN_TTL);

        const event = {
          type: 'threat_change',
          mint,
          oldScore: prevData.score || null,
          newScore: newData.score,
          reason: 'Mint authority re-enabled — token supply can be inflated',
          timestamp: Date.now(),
        };
        await redisPub.publish(ALERT_CHANNEL, JSON.stringify(event));
        logger.warn({ mint: mint.slice(0, 8) }, 'mint authority re-enabled');
      }
    }

    // Update cache with new data
    await redis.set(prevKey, JSON.stringify({
      lockedPct: newData.lpLockedPct,
      mintAuthorityRevoked: newData.mintAuthorityRevoked,
      freezeAuthorityRevoked: newData.freezeAuthorityRevoked,
      score: newData.score,
      cachedAt: Date.now(),
    }), 'EX', 600); // 10 min cache
  }
}

module.exports = { startLpLockChecker };
