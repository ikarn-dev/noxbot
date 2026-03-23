'use strict';

/**
 * Helius Webhook Handler
 *
 * Receives Helius Enhanced Transaction webhooks and emits normalized events
 * matching the same interface the old Yellowstone gRPC client used.
 *
 * Setup (one-time via Helius dashboard or API):
 *   POST https://api.helius.xyz/v0/webhooks
 *   - webhookURL: https://your-fly-app.fly.dev/api/helius-webhook
 *   - accountAddresses: [RAYDIUM_AMM_V4, RAYDIUM_CLMM, PUMP_FUN]
 *   - transactionTypes: ["SWAP"]
 *   - webhookType: "enhanced"
 *
 * Env vars:
 *   HELIUS_WEBHOOK_SECRET — shared secret for Authorization header validation
 */

const EventEmitter = require('events');
const logger = require('../config/logger').child({ module: 'helius-webhook' });

// Well-known Solana program IDs (same as old gRPC client)
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const PUMP_FUN       = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

class HeliusWebhookHandler extends EventEmitter {
  constructor() {
    super();
    this.secret = process.env.HELIUS_WEBHOOK_SECRET || '';
    this._stats = { received: 0, parsed: 0, errors: 0 };
  }

  /**
   * Express route handler: POST /api/helius-webhook
   * Mount this on the unified server's Express app.
   */
  get routeHandler() {
    return (req, res) => {
      // Validate webhook secret
      if (this.secret) {
        const auth = req.headers['authorization'] || '';
        if (auth !== this.secret && auth !== `Bearer ${this.secret}`) {
          logger.warn({ msg: 'Helius webhook auth failed' });
          return res.status(401).json({ error: 'unauthorized' });
        }
      }

      // Helius sends an array of enhanced transactions
      const transactions = Array.isArray(req.body) ? req.body : [req.body];
      this._stats.received += transactions.length;

      for (const tx of transactions) {
        try {
          const parsed = this._parseEnhancedTx(tx);
          if (parsed) {
            this._stats.parsed++;
            this.emit('transaction', parsed);
          }
        } catch (err) {
          this._stats.errors++;
          logger.error({ msg: 'Error parsing Helius tx', error: err.message });
        }
      }

      // Respond quickly — Helius expects a 200 within 10s
      res.status(200).json({ ok: true, processed: transactions.length });
    };
  }

  /**
   * Parse a Helius Enhanced Transaction into the normalized format
   * the snipe-engine expects (matching the old gRPC client output).
   */
  _parseEnhancedTx(tx) {
    if (!tx || !tx.signature) return null;

    // Determine source from account keys
    const accountKeys = tx.accountData?.map(a => a.account) || [];
    let source = 'unknown';

    if (accountKeys.includes(RAYDIUM_AMM_V4)) {
      source = 'raydium_amm';
    } else if (accountKeys.includes(RAYDIUM_CLMM)) {
      source = 'raydium_clmm';
    } else if (accountKeys.includes(PUMP_FUN)) {
      source = 'pump_fun';
    }

    // Extract token mints from token transfers (Helius Enhanced format)
    const tokenTransfers = tx.tokenTransfers || [];
    const mints = [...new Set(tokenTransfers.map(t => t.mint).filter(Boolean))];

    return {
      signature: tx.signature,
      slot: tx.slot || null,
      source,
      accountKeys,
      // The snipe engine uses accountKeys[2] as mint — provide mints array too
      mints,
      type: tx.type || 'SWAP',
      fee: tx.fee || 0,
      raw: tx,
      receivedAt: Date.now(),
    };
  }

  get stats() { return { ...this._stats }; }
}

module.exports = HeliusWebhookHandler;
