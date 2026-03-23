/**
 * services/solana.js — Solana RPC + Jito helper
 * 
 * Provides:
 *   - RPC connection management with failover
 *   - Balance queries
 *   - Token account lookups
 *   - Transaction submission (normal + Jito bundle)
 *   - Confirmation polling
 */
'use strict';

const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  VersionedTransaction,
} = require('@solana/web3.js');
const log = require('../config/logger').child({ module: 'service:solana' });

// ─── Network config ───────────────────────
const NETWORK = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
const IS_DEVNET = NETWORK === 'devnet';

const DEFAULT_RPC = IS_DEVNET
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';

// ─── Multi-RPC with failover ──────────────
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL,
  process.env.SOLANA_RPC_BACKUP,
  DEFAULT_RPC,
].filter(Boolean);

const JITO_ENDPOINT   = process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf';
const JITO_TIP_WALLET = process.env.JITO_TIP_ACCOUNT;

log.info({ network: NETWORK, rpcCount: RPC_ENDPOINTS.length }, 'Solana service initialized');

let activeRpcIndex = 0;

function getConnection() {
  return new Connection(RPC_ENDPOINTS[activeRpcIndex], {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30_000,
  });
}

function failoverRpc() {
  activeRpcIndex = (activeRpcIndex + 1) % RPC_ENDPOINTS.length;
  log.warn({ newRpc: RPC_ENDPOINTS[activeRpcIndex] }, 'RPC failover');
}

// ─── Public API ───────────────────────────

/**
 * Get SOL balance for a wallet.
 */
async function getBalance(publicKeyStr) {
  try {
    const conn    = getConnection();
    const pubkey  = new PublicKey(publicKeyStr);
    const lamports = await conn.getBalance(pubkey);
    return lamports / LAMPORTS_PER_SOL;
  } catch (err) {
    log.error({ err: err.message, wallet: publicKeyStr }, 'balance fetch failed');
    failoverRpc();
    throw err;
  }
}

/**
 * Get token balance for a specific mint.
 */
async function getTokenBalance(walletStr, mintStr) {
  try {
    const conn   = getConnection();
    const wallet = new PublicKey(walletStr);
    const mint   = new PublicKey(mintStr);

    const accounts = await conn.getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length === 0) return 0;

    const info = accounts.value[0].account.data.parsed.info;
    return parseFloat(info.tokenAmount.uiAmountString || '0');
  } catch (err) {
    log.error({ err: err.message, wallet: walletStr, mint: mintStr }, 'token balance failed');
    failoverRpc();
    throw err;
  }
}

/**
 * Get all token accounts for a wallet.
 */
async function getTokenAccounts(walletStr) {
  const conn   = getConnection();
  const wallet = new PublicKey(walletStr);

  const { value: accounts } = await conn.getParsedTokenAccountsByOwner(wallet, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  return accounts
    .map(a => {
      const info = a.account.data.parsed.info;
      return {
        mint:    info.mint,
        balance: parseFloat(info.tokenAmount.uiAmountString || '0'),
        decimals: info.tokenAmount.decimals,
      };
    })
    .filter(t => t.balance > 0);
}

/**
 * Submit transaction via Jito bundle for MEV protection.
 */
async function sendJitoBundle(serializedTx, tipLamports = 1_000_000) {
  // Jito bundles don't work on devnet — fall back to normal send
  if (IS_DEVNET) {
    log.info({ msg: 'Devnet mode — sending via normal RPC (Jito skipped)' });
    return sendTransaction(serializedTx);
  }

  const bundlePayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [[Buffer.from(serializedTx).toString('base64')]],
  };

  const res = await fetch(`${JITO_ENDPOINT}/api/v1/bundles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundlePayload),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(`Jito bundle error: ${data.error.message}`);
  }

  return data.result; // bundle ID
}

/**
 * Submit a regular transaction.
 */
async function sendTransaction(serializedTx) {
  const conn = getConnection();
  const sig  = await conn.sendRawTransaction(serializedTx, {
    skipPreflight: true,
    maxRetries: 3,
  });
  return sig;
}

/**
 * Wait for transaction confirmation.
 */
async function confirmTransaction(signature, timeoutMs = 30_000) {
  const conn  = getConnection();
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status = await conn.getSignatureStatus(signature);
    if (status?.value?.confirmationStatus === 'confirmed' ||
        status?.value?.confirmationStatus === 'finalized') {
      return { confirmed: true, slot: status.value.slot };
    }
    if (status?.value?.err) {
      return { confirmed: false, error: JSON.stringify(status.value.err) };
    }
    await new Promise(r => setTimeout(r, 1_000));
  }

  return { confirmed: false, error: 'timeout' };
}

/**
 * Get recent blockhash.
 */
async function getRecentBlockhash() {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  return { blockhash, lastValidBlockHeight };
}

module.exports = {
  getConnection,
  getBalance,
  getTokenBalance,
  getTokenAccounts,
  sendJitoBundle,
  sendTransaction,
  confirmTransaction,
  getRecentBlockhash,
  JITO_TIP_WALLET,
  IS_DEVNET,
  NETWORK,
};
