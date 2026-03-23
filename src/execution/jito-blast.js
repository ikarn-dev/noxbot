'use strict';

/**
 * Jito Blast — 5-Endpoint Parallel Bundle Submission
 *
 * Submits Jito bundles to 5 geographic endpoints simultaneously.
 * First confirmation wins. This is the core MEV strategy:
 *   - Private mempool (bundles bypass public mempool)
 *   - Tip-based priority (higher tip = faster inclusion)
 *   - Geographic diversity (reduces latency variance)
 *
 * Endpoints (from PRD §1.5):
 *   1. Global (mainnet.block-engine.jito.wtf)
 *   2. NY (ny.mainnet.block-engine.jito.wtf)
 *   3. Amsterdam (amsterdam.mainnet.block-engine.jito.wtf)
 *   4. Frankfurt (frankfurt.mainnet.block-engine.jito.wtf)
 *   5. Tokyo (tokyo.mainnet.block-engine.jito.wtf)
 *
 * Edge cases:
 *   - A5: All 5 fail → retry 1× then surface error. No SOL deducted.
 *   - C1: Returns bundleId for tracking
 *   - K2: Private mempool prevents frontrunning
 *   - K3: Blockhash TTL + dedup by bundleId prevents replay
 */

const logger = require('../config/logger');

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

const SEND_TIMEOUT_MS = 5_000; // Per-endpoint timeout
const MAX_RETRIES = 1;

/**
 * Submit a bundle to a single Jito endpoint.
 *
 * @param {string} endpoint - Jito bundle API URL
 * @param {string[]} serializedTxs - Array of base64-encoded transactions
 * @param {AbortSignal} signal - Abort signal for timeout
 * @returns {{ bundleId: string, endpoint: string, latencyMs: number }}
 */
async function submitToEndpoint(endpoint, serializedTxs, signal) {
  const startMs = Date.now();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serializedTxs],
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'no body');
    throw new Error(`Jito ${response.status}: ${text}`);
  }

  const data = await response.json();
  const latencyMs = Date.now() - startMs;

  if (data.error) {
    throw new Error(`Jito RPC error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const bundleId = data.result;
  if (!bundleId) {
    throw new Error('No bundleId in Jito response');
  }

  return { bundleId, endpoint, latencyMs };
}

/**
 * Blast a bundle to all 5 Jito endpoints in parallel.
 * Returns the first successful result (fastest endpoint wins).
 *
 * @param {string[]} serializedTxs - Array of base64-encoded transactions
 * @param {Object} opts
 * @param {number} opts.timeoutMs - Per-endpoint timeout (default 5000ms)
 * @param {number} opts.retries - Max retries on total failure (default 1)
 * @returns {{ bundleId: string, endpoint: string, latencyMs: number, attempt: number }}
 * @throws {Error} If all endpoints fail after retries
 */
async function blastJitoBundle(serializedTxs, opts = {}) {
  const timeoutMs = opts.timeoutMs || SEND_TIMEOUT_MS;
  const maxRetries = opts.retries ?? MAX_RETRIES;
  const endpoints = opts.endpoints || JITO_ENDPOINTS;

  // Jito bundles are mainnet-only — skip on devnet
  const network = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
  if (network === 'devnet') {
    logger.info({ msg: 'Devnet mode — Jito blast skipped' });
    return { bundleId: `devnet-mock-${Date.now()}`, endpoint: 'devnet', latencyMs: 0, attempt: 1 };
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const startMs = Date.now();

    try {
      const result = await raceEndpoints(endpoints, serializedTxs, timeoutMs);

      logger.info({
        msg: 'Jito bundle submitted',
        bundleId: result.bundleId,
        winnerEndpoint: result.endpoint,
        latencyMs: result.latencyMs,
        attempt,
      });

      return { ...result, attempt };
    } catch (err) {
      const totalMs = Date.now() - startMs;

      if (attempt <= maxRetries) {
        logger.warn({
          msg: 'All Jito endpoints failed, retrying',
          attempt,
          totalMs,
          error: err.message,
        });
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 200));
      } else {
        logger.error({
          msg: 'Jito bundle submission failed after all retries',
          attempts: attempt,
          totalMs,
          error: err.message,
        });
        throw new Error(`Jito submission failed after ${attempt} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Race all endpoints. First success wins. If all fail, throw aggregate error.
 */
async function raceEndpoints(endpoints, serializedTxs, timeoutMs) {
  // Use AbortController per endpoint for clean timeout
  const controllers = endpoints.map(() => new AbortController());

  // Create a promise for each endpoint
  const promises = endpoints.map(async (endpoint, i) => {
    const timer = setTimeout(() => controllers[i].abort(), timeoutMs);

    try {
      const result = await submitToEndpoint(
        endpoint,
        serializedTxs,
        controllers[i].signal,
      );
      // Cancel other requests (first winner takes all)
      controllers.forEach((c, j) => {
        if (j !== i) c.abort();
      });
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  });

  // Promise.any — first resolved promise wins
  return Promise.any(promises);
}

/**
 * Check the status of a submitted bundle.
 *
 * @param {string} bundleId - The bundle ID from blastJitoBundle
 * @param {string} endpoint - Which endpoint to check (default: global)
 * @returns {{ status: string, slot: number|null }}
 */
async function getBundleStatus(bundleId, endpoint) {
  const url = endpoint || JITO_ENDPOINTS[0];
  const statusUrl = url.replace('/bundles', '/bundles');

  try {
    const response = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      }),
    });

    const data = await response.json();

    if (data.result && data.result.value && data.result.value.length > 0) {
      const status = data.result.value[0];
      return {
        bundleId: status.bundle_id,
        status: status.confirmation_status || 'unknown',
        slot: status.slot || null,
        transactions: status.transactions || [],
      };
    }

    return { bundleId, status: 'not_found', slot: null, transactions: [] };
  } catch (err) {
    logger.warn({
      msg: 'Bundle status check failed',
      bundleId,
      error: err.message,
    });
    return { bundleId, status: 'error', slot: null, transactions: [] };
  }
}

module.exports = {
  blastJitoBundle,
  getBundleStatus,
  JITO_ENDPOINTS,
};
