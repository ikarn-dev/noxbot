#!/usr/bin/env node
'use strict';

/**
 * Mainnet Preflight — Safety Checks Before Going Live
 *
 * Run this BEFORE switching to mainnet. It validates:
 *   1. Cluster is mainnet-beta
 *   2. Jito endpoints are real mainnet URLs
 *   3. MAX_SNIPE_AMOUNT_SOL ≤ 0.5 (beta cap)
 *   4. ENCRYPTION_MASTER_KEY is set and 64 hex chars
 *   5. MongoDB has auth (not localhost without password)
 *   6. No devnet URLs in production config
 *   7. Redis has AUTH configured
 *   8. Admin user IDs are set
 *
 * Exit code 0 = GO, 1 = NO-GO
 *
 * Usage:
 *   node scripts/mainnet-preflight.js
 */

require('dotenv').config();

const results = { pass: 0, fail: 0, warn: 0 };
const issues = [];

function pass(msg) {
  results.pass++;
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  results.fail++;
  issues.push(msg);
  console.log(`  ❌ ${msg}`);
}

function warn(msg) {
  results.warn++;
  console.log(`  ⚠️  ${msg}`);
}

// ─── 1. Cluster check ───────────────────────────────

function checkCluster() {
  const cluster = process.env.SOLANA_CLUSTER;
  if (cluster === 'mainnet-beta') {
    pass('SOLANA_CLUSTER = mainnet-beta');
  } else {
    fail(`SOLANA_CLUSTER = "${cluster || 'not set'}" (expected "mainnet-beta")`);
  }
}

// ─── 2. Jito endpoints ─────────────────────────────

function checkJitoEndpoints() {
  const endpoints = [];
  for (let i = 1; i <= 5; i++) {
    endpoints.push(process.env[`JITO_ENDPOINT_${i}`]);
  }

  const configured = endpoints.filter(e => e && e.includes('jito.wtf'));

  if (configured.length >= 3) {
    pass(`${configured.length}/5 Jito mainnet endpoints configured`);
  } else if (configured.length > 0) {
    warn(`Only ${configured.length}/5 Jito endpoints configured (min 3 recommended)`);
  } else {
    fail('No Jito mainnet endpoints configured');
  }

  // Check for devnet Jito (doesn't exist, but check for typos)
  const hasDevnet = endpoints.some(e => e && (e.includes('devnet') || e.includes('testnet')));
  if (hasDevnet) {
    fail('Jito endpoint contains devnet/testnet URL');
  }
}

// ─── 3. Snipe amount cap ────────────────────────────

function checkSnipeCap() {
  const maxSnipe = parseFloat(process.env.MAX_SNIPE_AMOUNT_SOL);

  if (isNaN(maxSnipe)) {
    fail('MAX_SNIPE_AMOUNT_SOL not set');
  } else if (maxSnipe <= 0.5) {
    pass(`MAX_SNIPE_AMOUNT_SOL = ${maxSnipe} SOL (within beta cap)`);
  } else {
    fail(`MAX_SNIPE_AMOUNT_SOL = ${maxSnipe} SOL (exceeds 0.5 SOL beta cap)`);
  }
}

// ─── 4. Encryption key ─────────────────────────────

function checkEncryption() {
  const key = process.env.ENCRYPTION_MASTER_KEY;

  if (!key || key.includes('_here')) {
    fail('ENCRYPTION_MASTER_KEY not set or still placeholder');
    return;
  }

  if (key.length !== 64) {
    fail(`ENCRYPTION_MASTER_KEY is ${key.length} chars (expected 64 hex chars)`);
    return;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    fail('ENCRYPTION_MASTER_KEY is not valid hex');
    return;
  }

  pass('ENCRYPTION_MASTER_KEY is 64 hex characters');
}

// ─── 5. MongoDB auth ───────────────────────────────

function checkMongoDB() {
  const uri = process.env.MONGODB_URI || '';

  if (!uri) {
    fail('MONGODB_URI not set');
    return;
  }

  if (uri.includes('mongodb+srv://')) {
    pass('MongoDB using SRV (Atlas/cloud) connection');
  } else if (uri.includes('@')) {
    pass('MongoDB has authentication credentials');
  } else if (uri.includes('localhost') || uri.includes('127.0.0.1')) {
    warn('MongoDB using localhost without auth — OK for dev, NOT for production');
  } else {
    warn('MongoDB URI does not appear to have auth configured');
  }
}

// ─── 6. No devnet URLs ─────────────────────────────

function checkNoDevnet() {
  const rpcUrl = process.env.SOLANA_RPC_URL || '';
  const grpcUrl = process.env.YELLOWSTONE_GRPC_URL || '';

  const devnetPatterns = ['devnet.solana.com', 'testnet.solana.com', 'devnet'];

  const rpcHasDevnet = devnetPatterns.some(p => rpcUrl.includes(p));
  const grpcHasDevnet = devnetPatterns.some(p => grpcUrl.includes(p));

  if (rpcHasDevnet) {
    fail(`SOLANA_RPC_URL points to devnet: ${rpcUrl}`);
  } else {
    pass('SOLANA_RPC_URL is not devnet');
  }

  if (grpcHasDevnet) {
    fail(`YELLOWSTONE_GRPC_URL points to devnet: ${grpcUrl}`);
  } else if (!grpcUrl) {
    fail('YELLOWSTONE_GRPC_URL not set');
  } else {
    pass('YELLOWSTONE_GRPC_URL is not devnet');
  }
}

// ─── 7. Redis auth ─────────────────────────────────

function checkRedis() {
  const url = process.env.REDIS_URL || '';
  const password = process.env.REDIS_PASSWORD;

  if (password && password.length > 0) {
    pass('Redis AUTH password configured');
  } else if (url.includes('@')) {
    pass('Redis URL contains auth credentials');
  } else {
    warn('Redis has no AUTH password — OK for dev, set REDIS_PASSWORD for production');
  }
}

// ─── 8. Admin user IDs ─────────────────────────────

function checkAdmin() {
  const adminIds = process.env.ADMIN_USER_IDS;

  if (!adminIds) {
    fail('ADMIN_USER_IDS not set');
    return;
  }

  const ids = adminIds.split(',').map(s => s.trim()).filter(Boolean);

  if (ids.length === 0) {
    fail('ADMIN_USER_IDS is empty');
  } else if (ids.some(id => !/^\d+$/.test(id))) {
    fail('ADMIN_USER_IDS contains non-numeric values');
  } else {
    pass(`${ids.length} admin user ID(s) configured`);
  }
}

// ─── 9. HMAC secret ────────────────────────────────

function checkHmac() {
  const secret = process.env.HMAC_SECRET;

  if (!secret || secret.includes('_here')) {
    fail('HMAC_SECRET not set or still placeholder');
  } else if (secret.length < 32) {
    warn(`HMAC_SECRET is only ${secret.length} chars (recommended ≥32)`);
  } else {
    pass('HMAC_SECRET configured');
  }
}

// ─── 10. Beta user cap ─────────────────────────────

function checkBetaCap() {
  const maxUsers = parseInt(process.env.BETA_MAX_USERS);
  const betaSnipe = parseFloat(process.env.BETA_MAX_SNIPE_SOL);

  if (!isNaN(maxUsers) && maxUsers <= 50) {
    pass(`BETA_MAX_USERS = ${maxUsers}`);
  } else if (isNaN(maxUsers)) {
    warn('BETA_MAX_USERS not set (default: unlimited)');
  } else {
    warn(`BETA_MAX_USERS = ${maxUsers} (> 50, are you sure?)`);
  }

  if (!isNaN(betaSnipe) && betaSnipe <= 0.1) {
    pass(`BETA_MAX_SNIPE_SOL = ${betaSnipe}`);
  } else if (isNaN(betaSnipe)) {
    warn('BETA_MAX_SNIPE_SOL not set (using MAX_SNIPE_AMOUNT_SOL)');
  }
}

// ─── Runner ─────────────────────────────────────────

function main() {
  console.log('\n🚀 Nox Mainnet Preflight\n');
  console.log(`  Date:    ${new Date().toISOString()}`);
  console.log(`  Node:    ${process.version}`);
  console.log(`  Cluster: ${process.env.SOLANA_CLUSTER || 'not set'}\n`);

  checkCluster();
  checkJitoEndpoints();
  checkSnipeCap();
  checkEncryption();
  checkMongoDB();
  checkNoDevnet();
  checkRedis();
  checkAdmin();
  checkHmac();
  checkBetaCap();

  console.log(`\n─── Summary ───`);
  console.log(`  ✅ Pass: ${results.pass}`);
  console.log(`  ❌ Fail: ${results.fail}`);
  console.log(`  ⚠️  Warn: ${results.warn}`);
  console.log(`  Total: ${results.pass + results.fail + results.warn}\n`);

  if (results.fail > 0) {
    console.log('🛑 NO-GO — Fix critical issues before launch:\n');
    issues.forEach((issue, i) => console.log(`  ${i + 1}. ${issue}`));
    console.log();
    process.exit(1);
  } else if (results.warn > 0) {
    console.log('⚠️  GO with WARNINGS — Review warnings before launch.\n');
    process.exit(0);
  } else {
    console.log('✅ GO — All preflight checks passed. Ready for mainnet.\n');
    process.exit(0);
  }
}

main();
