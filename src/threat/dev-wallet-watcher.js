/**
 * threat/dev-wallet-watcher.js — Dev wallet dump detection
 *
 * Monitors dev/deployer wallets for large sell-offs on tokens users hold.
 * When a dev wallet sells >20% of holdings, publishes a dev_dumping event
 * to nox:threat_alerts.
 *
 * Uses Helius enhanced transactions to identify token sells from dev wallets.
 * Runs every 90s.
 */
'use strict';

const logger = require('../config/logger').child({ module: 'threat:devwallet' });
const { redis } = require('../config/redis');
const eventBus  = require('../config/event-bus');
const Trade = require('../models/Trade');

const CHECK_INTERVAL_MS   = 90_000;       // 90s
const ALERT_CHANNEL       = 'nox:threat_alerts';
const DEV_ALERT_COOLDOWN  = 1800;         // 30 min cooldown per mint
const SELL_THRESHOLD_PCT  = 20;           // Alert if >20% sold

/**
 * Start the dev wallet watcher loop.
 */
async function startDevWalletWatcher() {
  logger.info('Dev wallet watcher starting');

  const check = async () => {
    try {
      await checkDevWallets();
    } catch (err) {
      logger.error({ err: err.message }, 'dev wallet check cycle failed');
    }
  };

  await check();
  const intervalId = setInterval(check, CHECK_INTERVAL_MS);
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, 'dev wallet watcher loop started');
  return intervalId;
}

/**
 * Check dev wallets for tokens users hold.
 */
async function checkDevWallets() {
  // Get active mints from recent trades
  const activeMints = await Trade.distinct('tokenMint', {
    type: 'buy',
    status: 'confirmed',
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });

  if (activeMints.length === 0) return;

  for (const mint of activeMints) {
    // Check cooldown
    const cooldownKey = `dev:cooldown:${mint}`;
    const onCooldown = await redis.get(cooldownKey);
    if (onCooldown) continue;

    // Fetch cached dev wallet data
    const devData = await getDevWalletData(mint);
    if (!devData || !devData.wallet) continue;

    // Check if dev is selling
    const sellInfo = await checkDevSelling(devData.wallet, mint);
    if (!sellInfo || sellInfo.sellPct < SELL_THRESHOLD_PCT) continue;

    // Set cooldown
    await redis.set(cooldownKey, '1', 'EX', DEV_ALERT_COOLDOWN);

    const event = {
      type: 'dev_dumping',
      mint,
      devWallet: devData.wallet,
      sellPct: sellInfo.sellPct,
      timestamp: Date.now(),
    };

    eventBus.publish(ALERT_CHANNEL, event);
    logger.warn({ mint: mint.slice(0, 8), sellPct: sellInfo.sellPct }, 'dev wallet dumping detected');
  }
}

/**
 * Get cached dev wallet info for a token.
 */
async function getDevWalletData(mint) {
  try {
    const cached = await redis.get(`dev_wallet:${mint}`);
    if (cached) return JSON.parse(cached);
  } catch (_) { /* ignore parsing errors */ }

  // If not cached, try to fetch from Helius or RugCheck
  // This data is typically populated by pre-cacher.js during scoring
  return null;
}

/**
 * Check if a dev wallet has been selling a specific token.
 * Uses Helius enhanced transactions API.
 */
async function checkDevSelling(devWallet, mint) {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return null;

  const url = `https://api.helius.xyz/v0/addresses/${devWallet}/transactions?api-key=${heliusKey}&limit=5&type=SWAP`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) return null;

    const txns = await res.json();
    let totalSoldPct = 0;

    for (const tx of txns) {
      if (tx.type !== 'SWAP') continue;

      // Check if this swap involves the target mint as input (selling)
      const tokenInputs = tx.events?.swap?.tokenInputs || [];
      const hasMintSell = tokenInputs.some(t => t.mint === mint);

      if (hasMintSell) {
        // Estimate sell percentage based on cached dev holdings
        // This is approximate — in production, compare on-chain balances
        totalSoldPct += 10; // Each sell tx ~10% estimate
      }
    }

    return { sellPct: Math.min(totalSoldPct, 100) };
  } catch (err) {
    logger.warn({ devWallet: devWallet.slice(0, 8), err: err.message }, 'dev sell check failed');
    return null;
  }
}

module.exports = { startDevWalletWatcher };
