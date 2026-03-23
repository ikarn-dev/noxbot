/**
 * threat/honeypot-watcher.js — Post-buy honeypot detection
 *
 * After a user buys a token, periodically re-checks if it can still be
 * sold. If the sell quote fails or the round-trip loss exceeds 50%,
 * publishes a honeypot_detected event to nox:threat_alerts.
 *
 * Runs every 60s for tokens with active user positions.
 */
'use strict';

const logger = require('../config/logger').child({ module: 'threat:honeypot' });
const { redis } = require('../config/redis');
const eventBus  = require('../config/event-bus');
const { fetchHoneypot, getCachedHoneypot } = require('./pre-cacher');
const Trade = require('../models/Trade');

const CHECK_INTERVAL_MS = 60_000;       // 60s
const ALERT_CHANNEL     = 'nox:threat_alerts';
const ALREADY_ALERTED_TTL = 3600;       // Don't re-alert for 1 hour

/**
 * Start the honeypot watcher loop.
 */
async function startHoneypotWatcher() {
  logger.info('Honeypot watcher starting');

  const check = async () => {
    try {
      await checkActivePositions();
    } catch (err) {
      logger.error({ err: err.message }, 'honeypot check cycle failed');
    }
  };

  await check();
  const intervalId = setInterval(check, CHECK_INTERVAL_MS);
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, 'honeypot watcher loop started');
  return intervalId;
}

/**
 * Find tokens with active user positions and re-check honeypot status.
 */
async function checkActivePositions() {
  // Get distinct mints with confirmed buys in the last 24h
  const activeMints = await Trade.distinct('tokenMint', {
    type: 'buy',
    status: 'confirmed',
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  if (activeMints.length === 0) return;

  logger.debug({ mintCount: activeMints.length }, 'checking active positions for honeypots');

  for (const mint of activeMints) {
    // Skip if we already alerted for this mint recently
    const alertedKey = `honeypot:alerted:${mint}`;
    const alreadyAlerted = await redis.get(alertedKey);
    if (alreadyAlerted) continue;

    // Check cached honeypot data first
    const cached = await getCachedHoneypot(mint);
    if (cached && !cached.isHoneypot) continue; // Already verified OK

    // Re-check
    const result = await fetchHoneypot(mint);
    if (!result) continue;

    if (result.isHoneypot) {
      // Mark as alerted
      await redis.set(alertedKey, '1', 'EX', ALREADY_ALERTED_TTL);

      const event = {
        type: 'honeypot_detected',
        mint,
        sellTax: result.sellTax,
        roundTripLossPct: result.roundTripLossPct,
        source: result.source,
        timestamp: Date.now(),
      };

      eventBus.publish(ALERT_CHANNEL, event);
      logger.warn({ mint: mint.slice(0, 8), sellTax: result.sellTax }, 'honeypot detected post-buy');
    }
  }
}

module.exports = { startHoneypotWatcher };
