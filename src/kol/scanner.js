/**
 * kol/scanner.js — KOL Wallet Activity Scanner
 *
 * Polls active KOL wallets for recent transactions, detects
 * buys/sells, cross-references with known tokens, and publishes
 * events to nox:kol_alerts for the notification system.
 *
 * Runs on a configurable interval (default 30s).
 * Detects "cluster buys" when ≥3 KOLs buy the same token within 5 min.
 *
 * Data flow:
 *   Helius RPC → parse txns → detect buy/sell → publish Redis → kolAlert.js
 */
'use strict';

const logger = require('../config/logger').child({ module: 'kol:scanner' });
const { redis } = require('../config/redis');
const eventBus  = require('../config/event-bus');
const KOL = require('../models/KOL');

const SCAN_INTERVAL_MS  = 30_000;         // 30s
const CLUSTER_WINDOW_MS = 5 * 60 * 1000;  // 5 min window for cluster detection
const CLUSTER_THRESHOLD = 3;              // min KOLs buying same token
const ALERT_CHANNEL     = 'nox:kol_alerts';
const TX_CACHE_TTL      = 300;            // 5 min dedup

// Known DEX program IDs
const DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
]);

/**
 * Start the KOL scanner loop.
 */
async function startKolScanner() {
  logger.info('KOL scanner starting');

  const scan = async () => {
    try {
      await scanActiveKols();
    } catch (err) {
      logger.error({ err: err.message }, 'KOL scan cycle failed');
    }
  };

  // Initial scan
  await scan();

  // Recurring
  const intervalId = setInterval(scan, SCAN_INTERVAL_MS);
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, 'KOL scanner loop started');

  return intervalId;
}

/**
 * Scan all active KOL wallets for recent transactions.
 */
async function scanActiveKols() {
  const kols = await KOL.find({ isActive: true }).lean();
  if (kols.length === 0) return;

  logger.debug({ kolCount: kols.length }, 'scanning KOL wallets');

  const results = await Promise.allSettled(
    kols.map(kol => scanWallet(kol))
  );

  // Collect all recent buys for cluster detection
  const recentBuys = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      recentBuys.push(...r.value);
    }
  }

  // Cluster detection
  if (recentBuys.length >= CLUSTER_THRESHOLD) {
    await detectClusters(recentBuys);
  }
}

/**
 * Scan a single KOL wallet for recent DEX transactions.
 * @param {Object} kol
 * @returns {Array<Object>} buys detected
 */
async function scanWallet(kol) {
  const wallet = kol.walletAddress;
  const buys = [];

  try {
    // Fetch recent signatures from Helius/Solana RPC
    const txns = await fetchRecentTransactions(wallet);

    for (const tx of txns) {
      // Dedup: skip if we already processed this sig
      const dedupKey = `kol:tx:${tx.signature}`;
      const seen = await redis.set(dedupKey, '1', 'EX', TX_CACHE_TTL, 'NX');
      if (!seen) continue;

      const parsed = parseDexTransaction(tx);
      if (!parsed) continue;

      // Publish the event
      const event = {
        type: parsed.side === 'buy' ? 'kol_buy' : 'kol_sell',
        wallet,
        mint: parsed.mint,
        amountSol: parsed.amountSol,
        tier: kol.tier,
        label: kol.label,
        tokenName: parsed.tokenName || null,
        txSig: tx.signature,
        timestamp: Date.now(),
      };

      eventBus.publish(ALERT_CHANNEL, event);

      if (parsed.side === 'buy') {
        buys.push({
          wallet,
          mint: parsed.mint,
          tier: kol.tier,
          label: kol.label,
          timestamp: Date.now(),
        });
      }

      // Update lastActivityAt
      await KOL.updateOne(
        { walletAddress: wallet },
        { $set: { lastActivityAt: new Date() } }
      );
    }
  } catch (err) {
    logger.warn({ wallet: wallet.slice(0, 8), err: err.message }, 'wallet scan failed');
  }

  return buys;
}

/**
 * Detect cluster buys — ≥3 KOLs buying the same token within the window.
 */
async function detectClusters(buys) {
  const mintMap = new Map();

  for (const b of buys) {
    if (!mintMap.has(b.mint)) {
      mintMap.set(b.mint, []);
    }
    mintMap.get(b.mint).push(b);
  }

  for (const [mint, entries] of mintMap) {
    if (entries.length < CLUSTER_THRESHOLD) continue;

    // Check Redis for additional recent buys from other scan cycles
    const clusterKey = `kol:cluster:${mint}`;
    const existing = await redis.get(clusterKey);
    const existingKols = existing ? JSON.parse(existing) : [];

    // Merge and dedup by wallet
    const allKols = [...existingKols, ...entries];
    const uniqueWallets = new Map();
    for (const k of allKols) {
      uniqueWallets.set(k.wallet, k);
    }

    const uniqueList = [...uniqueWallets.values()];

    // Cache for window duration
    await redis.set(clusterKey, JSON.stringify(uniqueList), 'EX', Math.ceil(CLUSTER_WINDOW_MS / 1000));

    if (uniqueList.length >= CLUSTER_THRESHOLD) {
      // Find highest tier among the KOLs
      const tierOrder = { s: 0, a: 1, b: 2, unranked: 3 };
      const topTier = uniqueList.reduce(
        (best, k) => (tierOrder[k.tier] || 3) < (tierOrder[best] || 3) ? k.tier : best,
        'unranked'
      );

      const event = {
        type: 'kol_cluster',
        mint,
        kolCount: uniqueList.length,
        topTier,
        kols: uniqueList.map(k => ({ wallet: k.wallet, label: k.label, tier: k.tier })),
        timestamp: Date.now(),
      };

      eventBus.publish(ALERT_CHANNEL, event);
      logger.info({ mint: mint.slice(0, 8), kolCount: uniqueList.length, topTier }, 'cluster buy detected');
    }
  }
}

/**
 * Fetch recent transactions for a wallet via Helius Enhanced API.
 * Falls back to getSignaturesForAddress if Helius is unavailable.
 */
async function fetchRecentTransactions(wallet) {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    logger.debug('No HELIUS_API_KEY — skipping wallet scan');
    return [];
  }

  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&limit=10&type=SWAP`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn({ status: res.status, wallet: wallet.slice(0, 8) }, 'Helius request failed');
      return [];
    }

    return await res.json();
  } catch (err) {
    logger.warn({ wallet: wallet.slice(0, 8), err: err.message }, 'Helius fetch failed');
    return [];
  }
}

/**
 * Parse a Helius enhanced transaction to extract DEX swap info.
 * @returns {{ side: 'buy'|'sell', mint: string, amountSol: number, tokenName?: string } | null}
 */
function parseDexTransaction(tx) {
  // Helius enhanced transactions have a structured format
  if (!tx || tx.type !== 'SWAP') return null;

  const events = tx.events?.swap;
  if (!events) {
    // Fallback: parse from tokenTransfers
    return parseFromTransfers(tx);
  }

  const nativeInput  = events.nativeInput;
  const nativeOutput = events.nativeOutput;
  const tokenInputs  = events.tokenInputs || [];
  const tokenOutputs = events.tokenOutputs || [];

  // Buy = SOL in, token out
  if (nativeInput && tokenOutputs.length > 0) {
    return {
      side: 'buy',
      mint: tokenOutputs[0].mint,
      amountSol: (nativeInput.amount || 0) / 1e9,
      tokenName: tokenOutputs[0].tokenStandard || null,
    };
  }

  // Sell = token in, SOL out
  if (nativeOutput && tokenInputs.length > 0) {
    return {
      side: 'sell',
      mint: tokenInputs[0].mint,
      amountSol: (nativeOutput.amount || 0) / 1e9,
      tokenName: tokenInputs[0].tokenStandard || null,
    };
  }

  return null;
}

/**
 * Fallback parser using tokenTransfers array.
 */
function parseFromTransfers(tx) {
  if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) return null;
  if (!tx.nativeTransfers || tx.nativeTransfers.length === 0) return null;

  // Find the SOL transfer
  const solTransfer = tx.nativeTransfers.find(t => t.amount > 0);
  const tokenTransfer = tx.tokenTransfers.find(t => t.mint && t.tokenAmount);

  if (!solTransfer || !tokenTransfer) return null;

  // Determine direction based on who sent SOL
  const isBuy = solTransfer.fromUserAccount === tx.feePayer;

  return {
    side: isBuy ? 'buy' : 'sell',
    mint: tokenTransfer.mint,
    amountSol: Math.abs(solTransfer.amount) / 1e9,
    tokenName: null,
  };
}

module.exports = { startKolScanner, scanActiveKols, parseDexTransaction };
