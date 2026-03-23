/**
 * services/jupiterSwap.js — Jupiter V6 Swap API integration
 * 
 * Provides:
 *   - Quote fetching with slippage
 *   - Swap transaction building  
 *   - SOL ↔ Token swaps
 *   - Price lookups
 */
'use strict';

const log = require('../config/logger').child({ module: 'service:jupiter' });

const JUPITER_API = process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

/**
 * Fetch swap quote from Jupiter.
 */
async function getQuote({
  inputMint  = SOL_MINT,
  outputMint,
  amount,         // in smallest unit (lamports for SOL)
  slippageBps = 300,
}) {
  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Build swap transaction from a quote.
 */
async function buildSwapTransaction({
  quoteResponse,
  userPublicKey,
  wrapAndUnwrapSol = true,
  useSharedAccounts = true,
  prioritizationFeeLamports,
}) {
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol,
      useSharedAccounts,
      prioritizationFeeLamports,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap build failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    swapTransaction: data.swapTransaction,
    lastValidBlockHeight: data.lastValidBlockHeight,
  };
}

/**
 * High-level: Get quote + build tx for a buy (SOL → Token).
 */
async function prepareBuy({ mint, amountLamports, wallet, slippageBps, priorityFee }) {
  log.info({ mint, amountLamports, wallet }, 'preparing buy');

  const quote = await getQuote({
    inputMint:   SOL_MINT,
    outputMint:  mint,
    amount:      amountLamports,
    slippageBps,
  });

  const { swapTransaction, lastValidBlockHeight } = await buildSwapTransaction({
    quoteResponse: quote,
    userPublicKey: wallet,
    prioritizationFeeLamports: priorityFee,
  });

  return {
    quote,
    swapTransaction,
    lastValidBlockHeight,
    outAmount:     quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}

/**
 * High-level: Get quote + build tx for a sell (Token → SOL).
 */
async function prepareSell({ mint, amountTokenSmallestUnit, wallet, slippageBps, priorityFee }) {
  log.info({ mint, amount: amountTokenSmallestUnit, wallet }, 'preparing sell');

  const quote = await getQuote({
    inputMint:   mint,
    outputMint:  SOL_MINT,
    amount:      amountTokenSmallestUnit,
    slippageBps,
  });

  const { swapTransaction, lastValidBlockHeight } = await buildSwapTransaction({
    quoteResponse: quote,
    userPublicKey: wallet,
    prioritizationFeeLamports: priorityFee,
  });

  return {
    quote,
    swapTransaction,
    lastValidBlockHeight,
    outAmount:     quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}

/**
 * Get token price in USD via Jupiter Price API.
 */
async function getPrice(mintStr) {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mintStr}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[mintStr]?.price || null;
  } catch {
    return null;
  }
}

module.exports = {
  getQuote,
  buildSwapTransaction,
  prepareBuy,
  prepareSell,
  getPrice,
  SOL_MINT,
};
