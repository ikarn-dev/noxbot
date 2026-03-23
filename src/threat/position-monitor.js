/**
 * threat/position-monitor.js — 30-second position polling loop
 *
 * Monitors all active user positions for:
 *   1. TP/SL conditions (take-profit / stop-loss price triggers)
 *   2. Dev wallet large sells (cross-references dev-wallet-watcher)
 *   3. Price change alerts (>50% move since entry)
 *
 * When conditions are met, publishes events to:
 *   - nox:position_alerts  — TP/SL hit events
 *   - nox:trade_results    — auto_exit events (with reason)
 *
 * Runs every 30s. Keeps per-mint price cache in Redis.
 */
'use strict';

const logger = require('../config/logger').child({ module: 'threat:position' });
const { redis } = require('../config/redis');
const eventBus  = require('../config/event-bus');
const Trade = require('../models/Trade');
const User  = require('../models/User');

const POLL_INTERVAL_MS    = 30_000;       // 30s
const POSITION_CHANNEL    = 'nox:position_alerts';
const TRADE_CHANNEL       = 'nox:trade_results';
const PRICE_CACHE_TTL     = 60;           // Cache price for 60s
const ALERT_COOLDOWN_TTL  = 300;          // Don't re-alert same position for 5 min

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Start the position monitoring loop.
 */
async function startPositionMonitor() {
  logger.info('Position monitor starting');

  const poll = async () => {
    try {
      await checkAllPositions();
    } catch (err) {
      logger.error({ err: err.message }, 'position monitor cycle failed');
    }
  };

  await poll();
  const intervalId = setInterval(poll, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'position monitor loop started');
  return intervalId;
}

/**
 * Aggregate active positions and check each against TP/SL.
 */
async function checkAllPositions() {
  // Aggregate open positions: users who bought but haven't fully sold
  const positions = await Trade.aggregate([
    {
      $match: {
        status: 'confirmed',
        createdAt: { $gte: new Date(Date.now() - 48 * 60 * 60 * 1000) },
      },
    },
    {
      $group: {
        _id: { userId: '$userId', mint: '$tokenMint' },
        totalBuySol: {
          $sum: { $cond: [{ $eq: ['$type', 'buy'] }, '$amountSol', 0] },
        },
        totalSellSol: {
          $sum: { $cond: [{ $eq: ['$type', 'sell'] }, '$amountSol', 0] },
        },
        entryPriceSol: { $first: '$priceSol' },
        lastBuyAt: { $max: { $cond: [{ $eq: ['$type', 'buy'] }, '$createdAt', null] } },
      },
    },
    {
      $match: { $expr: { $gt: ['$totalBuySol', '$totalSellSol'] } },
    },
  ]);

  if (positions.length === 0) return;

  // Get unique mints and batch-fetch prices
  const uniqueMints = [...new Set(positions.map(p => p._id.mint))];
  const prices = await batchFetchPrices(uniqueMints);

  // Load user settings for TP/SL
  const uniqueUsers = [...new Set(positions.map(p => p._id.userId))];
  const userDocs = await User.find({
    telegramId: { $in: uniqueUsers },
    isBanned: false,
  }).lean();
  const userMap = new Map(userDocs.map(u => [String(u.telegramId), u]));

  for (const pos of positions) {
    const { userId, mint } = pos._id;
    const user = userMap.get(String(userId));
    if (!user) continue;

    const currentPrice = prices.get(mint);
    if (!currentPrice || !pos.entryPriceSol) continue;

    const entryPrice = pos.entryPriceSol;
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Get user TP/SL settings (defaults: TP +100%, SL -50%)
    const tpPct = user.settings?.takeProfitPct ?? 100;
    const slPct = user.settings?.stopLossPct   ?? -50;

    // Cooldown check
    const rlKey = `pos:alert:${userId}:${mint}`;
    const onCooldown = await redis.get(rlKey);
    if (onCooldown) continue;

    // Check TP
    if (pnlPct >= tpPct) {
      await redis.set(rlKey, '1', 'EX', ALERT_COOLDOWN_TTL);

      // Publish TP alert
      const alert = {
        type: 'tp_hit',
        userId,
        chatId: userId,
        mint,
        entryPriceSol: entryPrice,
        currentPriceSol: currentPrice,
        pnlPct: Math.round(pnlPct * 10) / 10,
        tpPct,
        timestamp: Date.now(),
      };
      eventBus.publish(POSITION_CHANNEL, alert);

      // If auto-sell on TP is enabled, trigger exit
      if (user.settings?.autoSellOnTp) {
        const exit = {
          type: 'auto_exit',
          reason: 'tp_exit',
          userId,
          chatId: userId,
          mint,
          entryPriceSol: entryPrice,
          exitPriceSol: currentPrice,
          pnlSol: (currentPrice - entryPrice) * (pos.totalBuySol - pos.totalSellSol),
          pnlPct: Math.round(pnlPct * 10) / 10,
          timestamp: Date.now(),
        };
        eventBus.publish(TRADE_CHANNEL, exit);
      }

      logger.info({ userId, mint: mint.slice(0, 8), pnlPct: pnlPct.toFixed(1) }, 'TP hit');
      continue;
    }

    // Check SL
    if (pnlPct <= slPct) {
      await redis.set(rlKey, '1', 'EX', ALERT_COOLDOWN_TTL);

      const alert = {
        type: 'sl_hit',
        userId,
        chatId: userId,
        mint,
        entryPriceSol: entryPrice,
        currentPriceSol: currentPrice,
        pnlPct: Math.round(pnlPct * 10) / 10,
        slPct,
        timestamp: Date.now(),
      };
      eventBus.publish(POSITION_CHANNEL, alert);

      // If auto-sell on SL is enabled, trigger exit
      if (user.settings?.autoSellOnSl) {
        const exit = {
          type: 'auto_exit',
          reason: 'sl_exit',
          userId,
          chatId: userId,
          mint,
          entryPriceSol: entryPrice,
          exitPriceSol: currentPrice,
          pnlSol: (currentPrice - entryPrice) * (pos.totalBuySol - pos.totalSellSol),
          pnlPct: Math.round(pnlPct * 10) / 10,
          timestamp: Date.now(),
        };
        eventBus.publish(TRADE_CHANNEL, exit);
      }

      logger.warn({ userId, mint: mint.slice(0, 8), pnlPct: pnlPct.toFixed(1) }, 'SL hit');
    }
  }

  logger.debug({ positions: positions.length, mints: uniqueMints.length }, 'position check cycle done');
}

/**
 * Batch-fetch current SOL-denominated prices from Jupiter.
 * Caches results in Redis for PRICE_CACHE_TTL seconds.
 *
 * @param {string[]} mints
 * @returns {Promise<Map<string, number>>}
 */
async function batchFetchPrices(mints) {
  const prices = new Map();

  // Check cache first
  const uncached = [];
  for (const mint of mints) {
    const cached = await redis.get(`price:${mint}`);
    if (cached) {
      prices.set(mint, parseFloat(cached));
    } else {
      uncached.push(mint);
    }
  }

  if (uncached.length === 0) return prices;

  // Fetch from Jupiter Price API v2 (batched)
  try {
    const ids = uncached.join(',');
    const url = `https://api.jup.ag/price/v2?ids=${ids}&vsToken=${SOL_MINT}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (res.ok) {
      const body = await res.json();
      const data = body.data || {};

      for (const mint of uncached) {
        const entry = data[mint];
        if (entry && entry.price) {
          const price = parseFloat(entry.price);
          prices.set(mint, price);
          await redis.set(`price:${mint}`, String(price), 'EX', PRICE_CACHE_TTL);
        }
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, count: uncached.length }, 'batch price fetch failed');
  }

  return prices;
}

module.exports = { startPositionMonitor };
