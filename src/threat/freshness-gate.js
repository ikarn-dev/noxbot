/**
 * threat/freshness-gate.js — Trade-time re-validation
 *
 * Re-checks token safety *immediately before* sending a transaction.
 * Called by execution layer (jito-blast.js) just before submitting.
 *
 * Returns { pass, reason, score } — if pass === false, the trade
 * should be aborted and the user notified.
 *
 * Why:  Pre-cached scores may be stale by the time a user clicks
 *       "Buy" on a cluster alert. This gate ensures the token
 *       hasn't become a honeypot or lost its LP in the interim.
 */
'use strict';

const logger = require('../config/logger').child({ module: 'threat:freshness' });
const { redis } = require('../config/redis');
const { fetchRugCheck, parseRugCheckData, fetchHoneypot } = require('./pre-cacher');

const FRESHNESS_TTL = 30;              // Accept cached score if ≤30s old
const MIN_SAFE_SCORE = 40;             // Below this → block the trade
const MAX_SELL_TAX   = 30;             // Honeypot sell-tax threshold (%)

/**
 * Re-validate a token just before executing a trade.
 *
 * @param {string} mint — Token mint address
 * @param {Object} [opts]
 * @param {number} [opts.minScore=40]  — Minimum acceptable safety score
 * @param {number} [opts.maxSellTax=30] — Max acceptable sell tax %
 * @returns {Promise<{pass: boolean, reason?: string, score?: number, sellTax?: number}>}
 */
async function validateBeforeTrade(mint, opts = {}) {
  const minScore   = opts.minScore   ?? MIN_SAFE_SCORE;
  const maxSellTax = opts.maxSellTax ?? MAX_SELL_TAX;

  // 1. Check for a very-recent cached result (avoid hammering APIs)
  const freshKey = `freshness:${mint}`;
  const cached = await redis.get(freshKey);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      return data; // Already validated within FRESHNESS_TTL
    } catch (_) { /* ignore bad cache */ }
  }

  // 2. Re-fetch from RugCheck
  let score = null;
  const rugRaw = await fetchRugCheck(mint);
  if (rugRaw) {
    const parsed = parseRugCheckData(rugRaw);
    score = parsed.score;

    if (score != null && score < minScore) {
      const result = { pass: false, reason: `Safety score too low: ${score}`, score };
      await redis.set(freshKey, JSON.stringify(result), 'EX', FRESHNESS_TTL);
      logger.warn({ mint: mint.slice(0, 8), score }, 'freshness gate BLOCKED — low score');
      return result;
    }

    // Check LP status
    if (parsed.lpLockedPct != null && parsed.lpLockedPct < 5) {
      const result = { pass: false, reason: 'LP unlocked or drained', score };
      await redis.set(freshKey, JSON.stringify(result), 'EX', FRESHNESS_TTL);
      logger.warn({ mint: mint.slice(0, 8), lpPct: parsed.lpLockedPct }, 'freshness gate BLOCKED — LP drained');
      return result;
    }
  }

  // 3. Re-check honeypot via Jupiter round-trip
  const hp = await fetchHoneypot(mint);
  if (hp) {
    if (hp.isHoneypot) {
      const result = { pass: false, reason: 'Honeypot detected', score, sellTax: hp.sellTax };
      await redis.set(freshKey, JSON.stringify(result), 'EX', FRESHNESS_TTL);
      logger.warn({ mint: mint.slice(0, 8), sellTax: hp.sellTax }, 'freshness gate BLOCKED — honeypot');
      return result;
    }

    if (hp.sellTax > maxSellTax) {
      const result = { pass: false, reason: `Sell tax too high: ${hp.sellTax}%`, score, sellTax: hp.sellTax };
      await redis.set(freshKey, JSON.stringify(result), 'EX', FRESHNESS_TTL);
      logger.warn({ mint: mint.slice(0, 8), sellTax: hp.sellTax }, 'freshness gate BLOCKED — high sell tax');
      return result;
    }
  }

  // 4. All checks passed
  const result = { pass: true, score, sellTax: hp?.sellTax ?? null };
  await redis.set(freshKey, JSON.stringify(result), 'EX', FRESHNESS_TTL);
  logger.debug({ mint: mint.slice(0, 8), score }, 'freshness gate PASSED');
  return result;
}

module.exports = { validateBeforeTrade };
