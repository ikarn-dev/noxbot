'use strict';

/**
 * Template Pool — Pre-built TX Template Manager
 *
 * Pre-builds and caches serialized swap transactions in Redis (55s TTL).
 * When a user clicks a buy button, we grab the cached TX, add their
 * wallet signature, and fire it via Jito — saving ~10ms vs building fresh.
 *
 * Redis key: `template:{mint}:{lamports}`
 * TTL: 55s (Solana blockhash validity ~60s, 5s safety margin)
 *
 * Edge cases:
 *   - A7: Template miss → build fresh (+10ms), transparent to user
 *   - S6: TTL prevents using expired blockhash
 *   - K3: Blockhash TTL prevents TX replay
 */

const { Connection, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const logger = require('../config/logger');
const { redis } = require('../config/redis');

const TEMPLATE_TTL = 55; // seconds
const KEY_PREFIX = 'template';

class TemplatePool {
  constructor(opts = {}) {
    const isDevnet = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase() === 'devnet';
    const defaultRpc = isDevnet ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
    this.rpcUrl = opts.rpcUrl || process.env.SOLANA_RPC_URL || defaultRpc;
    this.connection = new Connection(this.rpcUrl, 'confirmed');

    // Standard SOL amounts for pre-building (lamports)
    this.standardAmounts = [
      0.1 * 1e9,   // 100,000,000 lamports
      0.25 * 1e9,  // 250,000,000 lamports
      0.5 * 1e9,   // 500,000,000 lamports
      1.0 * 1e9,   // 1,000,000,000 lamports
    ];
  }

  /**
   * Redis key for a template.
   */
  _key(mint, lamports) {
    return `${KEY_PREFIX}:${mint}:${lamports}`;
  }

  /**
   * Get a cached template or build fresh.
   *
   * @param {string} mint - Token mint address
   * @param {number} lamports - Amount in lamports
   * @param {Object} opts
   * @param {string} opts.poolAddress - Raydium/Orca pool address
   * @param {number} opts.slippageBps - Slippage in basis points
   * @returns {{ serializedTx: string, blockhash: string, fromCache: boolean, buildTimeMs: number }}
   */
  async getOrBuild(mint, lamports, opts = {}) {
    const key = this._key(mint, lamports);
    const startMs = Date.now();

    // 1. Try cache
    try {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        logger.debug({ msg: 'Template cache hit', mint, lamports });
        return {
          ...parsed,
          fromCache: true,
          buildTimeMs: Date.now() - startMs,
        };
      }
    } catch (err) {
      logger.warn({ msg: 'Template cache read error', error: err.message });
    }

    // 2. Build fresh (A7: template miss)
    logger.debug({ msg: 'Template cache miss — building fresh', mint, lamports });
    const template = await this._buildTemplate(mint, lamports, opts);

    // 3. Cache for next user (non-blocking)
    this._cacheTemplate(key, template).catch((err) => {
      logger.warn({ msg: 'Template cache write error', error: err.message });
    });

    return {
      ...template,
      fromCache: false,
      buildTimeMs: Date.now() - startMs,
    };
  }

  /**
   * Pre-warm cache for standard amounts.
   * Called when a new token is detected with high score.
   *
   * @param {string} mint - Token mint address
   * @param {Object} opts
   * @param {string} opts.poolAddress - Pool address
   * @param {number} opts.slippageBps - Slippage bps
   */
  async preWarm(mint, opts = {}) {
    const warmStartMs = Date.now();
    const results = await Promise.allSettled(
      this.standardAmounts.map(async (lamports) => {
        const key = this._key(mint, lamports);
        const exists = await redis.exists(key);
        if (exists) return { lamports, status: 'cached' };

        const template = await this._buildTemplate(mint, lamports, opts);
        await this._cacheTemplate(key, template);
        return { lamports, status: 'built' };
      }),
    );

    const builtCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 'built',
    ).length;
    const failedCount = results.filter((r) => r.status === 'rejected').length;

    logger.info({
      msg: 'Template pre-warm complete',
      mint,
      built: builtCount,
      failed: failedCount,
      totalMs: Date.now() - warmStartMs,
    });

    return results;
  }

  /**
   * Build a swap transaction template.
   *
   * In production, this would call Jupiter's swap API or construct
   * a Raydium swap instruction directly. For now, we build a skeleton
   * TX with the correct blockhash that can be completed with user's
   * wallet and the actual swap instruction.
   *
   * @private
   */
  async _buildTemplate(mint, lamports, opts = {}) {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');

    // Build the swap transaction skeleton.
    // In production, use Jupiter Quote API → Swap API for the actual instructions.
    // The template stores the serialized base transaction that gets finalized
    // with the user's public key + Jito tip instruction at execution time.
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: new PublicKey('11111111111111111111111111111111'), // placeholder
    });

    // Placeholder: add a memo instruction to mark this as a Nox trade
    // Real implementation: Jupiter swap instruction goes here
    tx.add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey('11111111111111111111111111111111'),
        toPubkey: new PublicKey('11111111111111111111111111111111'),
        lamports: 0,
      }),
    );

    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    return {
      serializedTx: serialized,
      blockhash,
      lastValidBlockHeight,
      mint,
      lamports,
      slippageBps: opts.slippageBps || 300,
      poolAddress: opts.poolAddress || null,
      builtAt: Date.now(),
    };
  }

  /**
   * Cache a template in Redis with TTL.
   * @private
   */
  async _cacheTemplate(key, template) {
    await redis.set(key, JSON.stringify(template), 'EX', TEMPLATE_TTL);
  }

  /**
   * Invalidate all templates for a mint.
   */
  async invalidate(mint) {
    const keys = await redis.keys(`${KEY_PREFIX}:${mint}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
      logger.debug({ msg: 'Templates invalidated', mint, count: keys.length });
    }
  }

  /**
   * Get cache stats for monitoring.
   */
  async getStats() {
    const keys = await redis.keys(`${KEY_PREFIX}:*`);
    return {
      cachedTemplates: keys.length,
      prefix: KEY_PREFIX,
    };
  }
}

module.exports = TemplatePool;
