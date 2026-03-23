#!/usr/bin/env node
'use strict';

/**
 * Devnet Checklist — Automated Pre-Deployment Validation
 *
 * Runs 8 checks against a devnet environment before any code
 * is promoted to mainnet. Exit code 0 = all pass, 1 = failures.
 *
 * Usage:
 *   node scripts/devnet-checklist.js
 *   NODE_ENV=development node scripts/devnet-checklist.js
 */

require('dotenv').config();

const CHECKS = [];
const results = { pass: 0, fail: 0, skip: 0 };

function check(name, fn) {
  CHECKS.push({ name, fn });
}

async function run(label, fn) {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.pass++;
    console.log(`  ✅ ${label} (${ms}ms)`);
    return true;
  } catch (err) {
    const ms = Date.now() - start;
    results.fail++;
    console.log(`  ❌ ${label} (${ms}ms) — ${err.message}`);
    return false;
  }
}

// ─── Check 1: Redis ping ────────────────────────────

check('Redis ping', async () => {
  const Redis = require('ioredis');
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = new Redis(url, {
    password: process.env.REDIS_PASSWORD || undefined,
    connectTimeout: 5000,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error(`Unexpected: ${pong}`);
  } finally {
    await client.quit().catch(() => {});
  }
});

// ─── Check 2: MongoDB connection ────────────────────

check('MongoDB connection', async () => {
  const mongoose = require('mongoose');
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/nox';

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    const admin = mongoose.connection.db.admin();
    const info = await admin.serverStatus();
    if (!info.version) throw new Error('No server version returned');
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
});

// ─── Check 3: Helius API key ────────────────────

check('Helius API key', async () => {
  const key = process.env.HELIUS_API_KEY;
  if (!key || key.includes('your_')) throw new Error('HELIUS_API_KEY not set');

  // Verify with a lightweight RPC health call via Helius
  const rpcUrl = `https://devnet.helius-rpc.com/?api-key=${key}`;
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(`Helius RPC error: ${data.error.message}`);
  console.log(`    → Helius devnet RPC reachable`);
});

// ─── Check 4: Solana RPC health ─────────────────────

check('Solana RPC health', async () => {
  const network = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
  const rpcUrl = process.env.SOLANA_RPC_URL
    || (network === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');

  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getHealth',
    }),
  });

  const data = await resp.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  if (data.result !== 'ok') throw new Error(`RPC not healthy: ${data.result}`);
});

// ─── Check 5: Telegram bot token ────────────────────

check('Telegram bot token (getMe)', async () => {
  const token = process.env.BOT_TOKEN;
  if (!token || token.includes('your_')) throw new Error('BOT_TOKEN not configured');

  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await resp.json();
  if (!data.ok) throw new Error(`getMe failed: ${data.description}`);
  console.log(`    → Bot username: @${data.result.username}`);
});

// ─── Check 6: Rule engine smoke test ────────────────

check('Rule engine smoke test', async () => {
  const { scoreToken } = require('../src/scoring/rule-engine');

  const result = scoreToken({
    volume24h: 100_000,
    liquidity: 50_000,
    kolCount: 0,
    socialMentions: 0,
    honeypot: false,
    rugScore: 90,
    devHoldings: 10,
    tokenAgeDays: 0.5,
  });

  if (typeof result.score !== 'number') throw new Error('No score returned');
  if (result.score < 0 || result.score > 100) throw new Error(`Score out of range: ${result.score}`);
  if (!result.action) throw new Error('No action returned');
  console.log(`    → Score: ${result.score}, Action: ${result.action}`);
});

// ─── Check 7: Template pool build ───────────────────

check('Template pool build cycle', async () => {
  // Verify the module loads and exports expected interface
  const { TemplatePool } = require('../src/execution/template-pool');

  if (typeof TemplatePool !== 'function') throw new Error('TemplatePool not a constructor');

  // Verify it can be instantiated (don't actually connect to RPC)
  const pool = new TemplatePool({
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  });

  if (!pool.getTemplate) throw new Error('Missing getTemplate method');
  if (!pool.preWarm) throw new Error('Missing preWarm method');
  if (!pool.invalidate) throw new Error('Missing invalidate method');
});

// ─── Check 8: Environment variables ─────────────────

check('Required environment variables', async () => {
  const required = [
    'BOT_TOKEN',
    'REDIS_URL',
    'MONGODB_URI',
    'SOLANA_RPC_URL',
    'HELIUS_API_KEY',
    'HMAC_SECRET',
  ];

  const missing = required.filter(k => {
    const val = process.env[k];
    return !val || val.includes('your_') || val.includes('_here');
  });

  if (missing.length > 0) {
    throw new Error(`Missing or placeholder: ${missing.join(', ')}`);
  }
});

// ─── Runner ─────────────────────────────────────────

async function main() {
  console.log('\n🔍 Nox Devnet Checklist\n');
  console.log(`  Cluster: ${process.env.SOLANA_CLUSTER || 'devnet'}`);
  console.log(`  Node:    ${process.version}`);
  console.log(`  Date:    ${new Date().toISOString()}\n`);

  for (const { name, fn } of CHECKS) {
    await run(name, fn);
  }

  console.log(`\n─── Summary ───`);
  console.log(`  ✅ Pass: ${results.pass}`);
  console.log(`  ❌ Fail: ${results.fail}`);
  console.log(`  ⏭  Skip: ${results.skip}`);
  console.log(`  Total: ${CHECKS.length}\n`);

  if (results.fail > 0) {
    console.log('⚠️  Some checks failed. Fix issues before proceeding.\n');
    process.exit(1);
  } else {
    console.log('✅ All checks passed. Ready for devnet deployment.\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error running checklist:', err);
  process.exit(1);
});
