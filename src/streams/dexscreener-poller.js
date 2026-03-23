'use strict';

/**
 * DexScreener Poller
 *
 * Polls the DexScreener API for new Solana token pairs every 10s.
 * Acts as a supplement/fallback to Helius webhooks.
 *
 * Free tier: no API key required, ~300 req/min rate limit.
 * Emits 'transaction' events matching the same interface as HeliusWebhookHandler.
 */

const EventEmitter = require('events');
const logger = require('../config/logger').child({ module: 'dexscreener' });

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
const DEXSCREENER_PAIRS_API = 'https://api.dexscreener.com/token-profiles/latest/v1';
const POLL_INTERVAL_MS = 10_000; // 10 seconds
const MAX_SEEN_CACHE = 5000;

class DexScreenerPoller extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.pollInterval = opts.pollInterval || POLL_INTERVAL_MS;
    this._intervalId = null;
    this._seenPairs = new Set();
    this._isRunning = false;
    this._stats = { polls: 0, newPairs: 0, errors: 0 };
  }

  /**
   * Start polling for new Solana pairs.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;

    logger.info({ msg: 'DexScreener poller starting', intervalMs: this.pollInterval });

    // Initial poll
    this._poll().catch(err => {
      logger.error({ msg: 'Initial DexScreener poll failed', error: err.message });
    });

    // Recurring poll
    this._intervalId = setInterval(() => {
      this._poll().catch(err => {
        logger.error({ msg: 'DexScreener poll error', error: err.message });
      });
    }, this.pollInterval);

    return this._intervalId;
  }

  /**
   * Stop polling.
   */
  stop() {
    this._isRunning = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    logger.info({ msg: 'DexScreener poller stopped', stats: this._stats });
  }

  /**
   * Fetch latest Solana pairs from DexScreener.
   */
  async _poll() {
    this._stats.polls++;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(
        `${DEXSCREENER_PAIRS_API}`,
        {
          headers: { 'Accept': 'application/json' },
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`DexScreener API ${res.status}: ${res.statusText}`);
      }

      const profiles = await res.json();
      const solanaProfiles = (Array.isArray(profiles) ? profiles : [])
        .filter(p => p.chainId === 'solana');

      for (const profile of solanaProfiles) {
        const pairKey = profile.tokenAddress;
        if (!pairKey || this._seenPairs.has(pairKey)) continue;

        this._seenPairs.add(pairKey);
        this._stats.newPairs++;

        // Emit in normalized format compatible with snipe-engine
        const event = {
          signature: null,
          slot: null,
          source: 'dexscreener',
          accountKeys: [pairKey],
          mints: [pairKey],
          type: 'NEW_PAIR',
          raw: profile,
          receivedAt: Date.now(),
        };

        this.emit('transaction', event);
      }

      // Prevent memory leak — trim seen cache
      if (this._seenPairs.size > MAX_SEEN_CACHE) {
        const entries = [...this._seenPairs];
        this._seenPairs = new Set(entries.slice(-Math.floor(MAX_SEEN_CACHE / 2)));
      }
    } catch (err) {
      this._stats.errors++;
      if (err.name === 'AbortError') {
        logger.warn({ msg: 'DexScreener poll timed out' });
      } else {
        throw err;
      }
    }
  }

  get stats() { return { ...this._stats }; }
}

module.exports = DexScreenerPoller;
