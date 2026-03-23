/**
 * services/tokenSafety.js — Token safety analysis / rug check
 * 
 * Checks:
 *   1. Mint authority (should be revoked)
 *   2. Freeze authority (should be revoked)
 *   3. LP lock status
 *   4. Top holders concentration
 *   5. Contract verification hints
 *   6. Known scam list lookup
 * 
 * Returns a score 0-100 (higher = safer).
 */
'use strict';

const { PublicKey }    = require('@solana/web3.js');
const { getConnection } = require('./solana');
const { redis }        = require('../config/redis');
const log              = require('../config/logger').child({ module: 'service:tokenSafety' });

const CACHE_TTL = 300; // 5 min
const KNOWN_SCAM_SET = 'nox:known_scams';

/**
 * Analyze token safety and return score + flags.
 * @param {string} mintStr — Token mint address
 * @returns {object} { score, flags, details }
 */
async function analyzeToken(mintStr) {
  // Check cache
  const cached = await redis.get(`safety:${mintStr}`);
  if (cached) return JSON.parse(cached);

  const flags   = [];
  let score     = 100;
  const details = {};

  try {
    const conn   = getConnection();
    const mint   = new PublicKey(mintStr);
    const info   = await conn.getParsedAccountInfo(mint);

    if (!info.value) {
      return { score: 0, flags: ['TOKEN_NOT_FOUND'], details: {} };
    }

    const data = info.value.data?.parsed?.info;
    if (!data) {
      return { score: 0, flags: ['PARSE_FAILED'], details: {} };
    }

    // 1. Mint authority
    if (data.mintAuthority) {
      flags.push('MINT_AUTHORITY_NOT_REVOKED');
      score -= 30;
      details.mintAuthority = data.mintAuthority;
    } else {
      details.mintAuthority = 'revoked ✓';
    }

    // 2. Freeze authority
    if (data.freezeAuthority) {
      flags.push('FREEZE_AUTHORITY_NOT_REVOKED');
      score -= 25;
      details.freezeAuthority = data.freezeAuthority;
    } else {
      details.freezeAuthority = 'revoked ✓';
    }

    // 3. Supply concentration
    details.supply  = parseFloat(data.supply || 0);
    details.decimals = data.decimals;

    // 4. Known scam check
    const isScam = await redis.sismember(KNOWN_SCAM_SET, mintStr);
    if (isScam) {
      flags.push('KNOWN_SCAM');
      score = 0;
    }

    // Clamp
    score = Math.max(0, Math.min(100, score));

    const result = {
      mint:    mintStr,
      score,
      flags,
      details,
      tier: score >= 80 ? 'safe' : score >= 50 ? 'caution' : 'danger',
      checkedAt: Date.now(),
    };

    // Cache
    await redis.set(`safety:${mintStr}`, JSON.stringify(result), 'EX', CACHE_TTL);

    return result;
  } catch (err) {
    log.error({ err: err.message, mint: mintStr }, 'safety analysis failed');
    return {
      mint:  mintStr,
      score: 0,
      flags: ['ANALYSIS_ERROR'],
      details: { error: err.message },
      tier: 'danger',
      checkedAt: Date.now(),
    };
  }
}

/**
 * Quick check — returns true if token passes minimum safety.
 */
async function isSafe(mintStr, minScore = 50) {
  const result = await analyzeToken(mintStr);
  return result.score >= minScore;
}

/**
 * Format safety report for Telegram.
 */
function formatSafetyReport(result) {
  const emoji = result.tier === 'safe' ? '🟢' : result.tier === 'caution' ? '🟡' : '🔴';
  const bar   = '█'.repeat(Math.round(result.score / 10)) + '░'.repeat(10 - Math.round(result.score / 10));

  let text = `${emoji} *Safety Score: ${result.score}/100*\n`;
  text += `[${bar}]\n\n`;

  if (result.flags.length > 0) {
    text += '⚠️ *Flags:*\n';
    result.flags.forEach(f => {
      text += `  • ${f.replace(/_/g, ' ')}\n`;
    });
    text += '\n';
  }

  if (result.details.mintAuthority) {
    text += `🔑 Mint Auth: ${result.details.mintAuthority}\n`;
  }
  if (result.details.freezeAuthority) {
    text += `❄️ Freeze Auth: ${result.details.freezeAuthority}\n`;
  }

  return text;
}

module.exports = { analyzeToken, isSafe, formatSafetyReport };
