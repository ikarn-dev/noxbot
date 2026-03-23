'use strict';

/**
 * Snipe Engine — Main Orchestrator
 *
 * Data flow (PRD §1.2):
 *   gRPC stream → parse → score token → threat check → broadcast/auto-snipe
 *
 * This runs as its own PM2 process (~180MB RAM budget).
 * Communicates with bot-server via Redis pub/sub on `signals:broadcast`.
 */

const logger = require('./config/logger');
const { redis } = require('./config/redis');
const eventBus  = require('./config/event-bus');
const { connectMongo } = require('./config/mongo');
const HeliusWebhookHandler = require('./streams/helius-webhook');
const DexScreenerPoller    = require('./streams/dexscreener-poller');
const { scoreToken } = require('./scoring/rule-engine');
const { cacheThreatData } = require('./threat/pre-cacher');
const TemplatePool = require('./execution/template-pool');
const Signal = require('./models/Signal');
const KOL = require('./models/KOL');

// Phase 4 scanners
const { startKolScanner }        = require('./kol/scanner');
const { startHoneypotWatcher }   = require('./threat/honeypot-watcher');
const { startDevWalletWatcher }  = require('./threat/dev-wallet-watcher');
const { startLpLockChecker }     = require('./threat/lp-lock-checker');
const { startPositionMonitor }   = require('./threat/position-monitor');

const SIGNAL_CHANNEL = 'signals:broadcast';
const AUTO_SNIPE_SCORE = 85;
const BROADCAST_SCORE = 55;

class SnipeEngine {
  constructor() {
    this.helius = new HeliusWebhookHandler();
    this.dexPoller = new DexScreenerPoller();
    this.templatePool = new TemplatePool();
    this._isRunning = false;
    this._processedMints = new Set(); // dedup within session
    this._scannerIntervals = [];      // Phase 4 scanner interval IDs
    this._stats = { tokensScanned: 0, signalsBroadcast: 0, autoSnipes: 0, blocked: 0, errors: 0 };
  }

  async start() {
    logger.info({ msg: 'Snipe engine starting' });

    await connectMongo();

    // Listen for events from both data sources
    const handleTx = (tx) => this._handleTransaction(tx);
    this.helius.on('transaction', handleTx);
    this.dexPoller.on('transaction', handleTx);

    // Start DexScreener polling (Helius is request-driven via Express route)
    const pollerId = this.dexPoller.start();
    if (pollerId) this._scannerIntervals.push(pollerId);

    this._isRunning = true;
    logger.info({ msg: 'Snipe engine live (Helius webhook + DexScreener poller)' });

    // Stats logging every 60s
    this._statsInterval = setInterval(() => {
      logger.info({ msg: 'Snipe engine stats', ...this._stats });
    }, 60_000);

    // Dedup cache cleanup every 5 min (prevent memory leak)
    this._cleanupInterval = setInterval(() => {
      if (this._processedMints.size > 10_000) {
        this._processedMints.clear();
        logger.debug({ msg: 'Cleared processed mints cache' });
      }
    }, 300_000);

    logger.info({ msg: 'Snipe engine started' });

    // Phase 4: Start background scanners
    try {
      const kolId = await startKolScanner();
      const hpId  = await startHoneypotWatcher();
      const dwId  = await startDevWalletWatcher();
      const lpId  = await startLpLockChecker();
      const pmId  = await startPositionMonitor();
      this._scannerIntervals.push(kolId, hpId, dwId, lpId, pmId);
      logger.info({ msg: 'Phase 4 scanners started', count: 5 });
    } catch (err) {
      logger.error({ msg: 'Phase 4 scanner startup failed (non-fatal)', error: err.message });
    }
  }

  async _handleTransaction(tx) {
    try {
      // Extract mint from the transaction (simplified — real impl parses instruction data)
      const mint = this._extractMint(tx);
      if (!mint) return;

      // Dedup: skip if we already processed this mint recently
      if (this._processedMints.has(mint)) return;
      this._processedMints.add(mint);

      this._stats.tokensScanned++;

      // 1. Fetch threat data (parallel with other data gathering)
      const threatData = await cacheThreatData(mint);

      // 2. Gather scoring inputs
      // Fetch live KOL matches for this mint
      const kolMatches = await this._findKolMatches(mint);

      const scoringInput = {
        volumeSpikePct: 0,      // TODO: DexScreener volume delta
        liquidityUsd: 0,        // TODO: DexScreener liquidity
        kolMatches,
        socialMentions: 0,      // TODO: X API mention count
        isHoneypot: threatData.isHoneypot,
        rugCheckScore: threatData.score,
        devHoldingsPct: threatData.devHoldingsPct,
        tokenAgeMinutes: 0,     // TODO: compute from first TX
        mintAuthorityRevoked: threatData.mintAuthorityRevoked,
        freezeAuthorityRevoked: threatData.freezeAuthorityRevoked,
        lpLockedPct: threatData.lpLockedPct,
        topHolderPct: threatData.topHolderPct,
      };

      // 3. Score the token
      const result = scoreToken(scoringInput);

      // 4. Handle blocked tokens
      if (result.blocked) {
        this._stats.blocked++;
        logger.info({ msg: 'Token blocked', mint, reason: result.blockReason, score: result.score });
        return;
      }

      // 5. Persist signal to MongoDB (matches Signal model schema)
      const signal = await Signal.create({
        tokenMint: mint,
        score: result.score,
        action: result.action,
        components: {
          threatScore: 100 - (threatData.score || 0),
          rugCheckPassed: threatData.score >= 80,
          mintAuthorityRevoked: threatData.mintAuthorityRevoked,
          freezeAuthorityRevoked: threatData.freezeAuthorityRevoked,
          liquidityLockedPct: threatData.lpLockedPct,
          topHolderConcentrationPct: threatData.topHolderPct,
          kolMatchCount: (scoringInput.kolMatches || []).length,
          isClusterSignal: result.breakdown.isCluster || false,
        },
        source: tx.source || 'helius',
        detectedSlot: tx.slot,
      });

      // 6. Broadcast or auto-snipe based on score
      if (result.score >= BROADCAST_SCORE) {
        const payload = {
          signalId: signal._id.toString(),
          mint,
          score: result.score,
          action: result.action,
          breakdown: result.breakdown,
          components: signal.components,
          source: signal.source,
          timestamp: Date.now(),
        };

        eventBus.publish(SIGNAL_CHANNEL, payload);
        this._stats.signalsBroadcast++;

        logger.info({ msg: 'Signal broadcast', mint, score: result.score, action: result.action });

        // Pre-warm TX templates for broadcastable signals
        this.templatePool.preWarm(mint).catch((err) => {
          logger.warn({ msg: 'Template pre-warm failed', mint, error: err.message });
        });
      }

      if (result.score >= AUTO_SNIPE_SCORE) {
        this._stats.autoSnipes++;
        // Auto-snipe is handled by bot-server reading from signals:broadcast
        // with action = 'strong_buy'. Bot-server checks user settings.
        logger.info({ msg: 'Auto-snipe eligible', mint, score: result.score });
      }
    } catch (err) {
      this._stats.errors++;
      logger.error({ msg: 'Error processing transaction', error: err.message, stack: err.stack });
    }
  }

  /**
   * Extract token mint address from a parsed gRPC transaction.
   * Simplified — real implementation parses program instruction data.
   */
  _extractMint(tx) {
    // Prefer mints array from Helius / DexScreener normalized events
    if (tx.mints && tx.mints.length > 0) {
      return tx.mints[0];
    }
    // Fallback: use accountKeys[2] (legacy gRPC compat)
    if (tx.accountKeys && tx.accountKeys.length > 2) {
      return tx.accountKeys[2] || null;
    }
    return null;
  }

  async stop() {
    this._isRunning = false;
    clearInterval(this._statsInterval);
    clearInterval(this._cleanupInterval);
    for (const id of this._scannerIntervals) clearInterval(id);
    this.dexPoller.stop();
    logger.info({ msg: 'Snipe engine stopped', stats: this._stats });
  }

  /**
   * Find KOL wallets that recently bought this mint.
   * Checks Redis cluster cache populated by kol/scanner.js.
   */
  async _findKolMatches(mint) {
    try {
      const clusterKey = `kol:cluster:${mint}`;
      const cached = await redis.get(clusterKey);
      if (!cached) return [];
      return JSON.parse(cached);
    } catch (_) {
      return [];
    }
  }

  get stats() { return { ...this._stats }; }
}

// ─── Standalone entry point ─────────────────
if (require.main === module) {
  const engine = new SnipeEngine();

  const shutdown = async (signal) => {
    logger.info({ msg: `Received ${signal}, shutting down` });
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ msg: 'Unhandled rejection', error: err.message, stack: err.stack });
  });

  engine.start().catch((err) => {
    logger.fatal({ msg: 'Snipe engine failed to start', error: err.message });
    process.exit(1);
  });
}

module.exports = SnipeEngine;
