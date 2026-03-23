'use strict';

/**
 * Rule Engine — 8-Factor Token Scorer (0–100)
 *
 * Scoring factors (from PRD §1.2):
 *   1. Volume spike         → +20 max
 *   2. Liquidity depth      → +15 max
 *   3. KOL cluster          → +25 max (≥3 KOLs = cluster bonus)
 *   4. Social pre-shill     → +10 max (0 X mentions = early / bonus)
 *   5. Honeypot check       → hard block if true
 *   6. RugCheck score       → hard block if <80
 *   7. Dev holdings         → -10 to +5 (low dev% = bonus)
 *   8. Token age            → -5 to +5 (newer = bonus)
 *
 * Output: { score: 0–100, action: 'strong_buy'|'buy'|'watch'|'avoid'|'rug_alert', breakdown: {...} }
 *
 * Thresholds:
 *   score ≥ 85 → strong_buy (auto-snipe eligible)
 *   score ≥ 55 → buy (broadcast signal)
 *   score ≥ 40 → watch
 *   score  < 40 → avoid
 *   honeypot OR rugcheck fail → rug_alert
 */

const logger = require('../config/logger');

// ─── Factor configs ──────────────────────────────
const FACTORS = {
  VOLUME_SPIKE: {
    maxPoints: 20,
    tiers: [
      { threshold: 500, points: 20 },  // 500%+ spike
      { threshold: 300, points: 16 },
      { threshold: 200, points: 12 },
      { threshold: 100, points: 8 },
      { threshold: 50, points: 4 },
    ],
  },
  LIQUIDITY: {
    maxPoints: 15,
    tiers: [
      { threshold: 100_000, points: 15 },  // $100K+
      { threshold: 50_000, points: 12 },
      { threshold: 25_000, points: 9 },
      { threshold: 10_000, points: 6 },
      { threshold: 5_000, points: 3 },
    ],
  },
  KOL_CLUSTER: {
    maxPoints: 25,
    tierWeights: { s: 10, a: 7, b: 4, unranked: 1 },
    clusterThreshold: 3, // ≥3 KOLs = cluster
    clusterBonus: 5,
  },
  SOCIAL: {
    maxPoints: 10,
    // 0 mentions = pre-shill bonus, high mentions = already pumped
    tiers: [
      { maxMentions: 0, points: 10 },   // Pre-shill: nobody knows
      { maxMentions: 5, points: 7 },    // Very early
      { maxMentions: 20, points: 4 },   // Some buzz
      { maxMentions: 100, points: 1 },  // Already viral
      { maxMentions: Infinity, points: 0 },
    ],
  },
  DEV_HOLDINGS: {
    maxBonus: 5,
    maxPenalty: -10,
    thresholds: [
      { maxPct: 2, points: 5 },
      { maxPct: 5, points: 2 },
      { maxPct: 10, points: 0 },
      { maxPct: 25, points: -5 },
      { maxPct: 100, points: -10 },
    ],
  },
  TOKEN_AGE: {
    maxBonus: 5,
    maxPenalty: -5,
    thresholds: [
      { maxMinutes: 5, points: 5 },     // Fresh launch
      { maxMinutes: 30, points: 3 },
      { maxMinutes: 60, points: 1 },
      { maxMinutes: 480, points: -2 },  // 8h old
      { maxMinutes: Infinity, points: -5 },
    ],
  },
};

/**
 * Score a token based on 8 factors.
 *
 * @param {Object} input
 * @param {number} input.volumeSpikePct - Volume change % over 5 minutes
 * @param {number} input.liquidityUsd - Current liquidity in USD
 * @param {Array} input.kolMatches - Array of { wallet, tier, amountSol }
 * @param {number} input.socialMentions - Number of X/Twitter mentions
 * @param {boolean} input.isHoneypot - Honeypot.is result
 * @param {number} input.rugCheckScore - RugCheck score (0–100, higher = safer)
 * @param {number} input.devHoldingsPct - Dev wallet holdings as % of supply
 * @param {number} input.tokenAgeMinutes - Age since first transaction
 * @param {boolean} input.mintAuthorityRevoked - Whether mint authority is revoked
 * @param {boolean} input.freezeAuthorityRevoked - Whether freeze authority is revoked
 * @param {number} input.lpLockedPct - Percentage of LP locked
 * @param {number} input.topHolderPct - Top holder concentration %
 *
 * @returns {{ score: number, action: string, breakdown: Object, blocked: boolean, blockReason: string|null }}
 */
function scoreToken(input) {
  const breakdown = {};
  let blocked = false;
  let blockReason = null;

  // ─── Factor 5: Honeypot Check (hard block) ──────
  if (input.isHoneypot === true) {
    return {
      score: 0,
      action: 'rug_alert',
      breakdown: { honeypot: true },
      blocked: true,
      blockReason: 'Honeypot detected',
    };
  }

  // ─── Factor 6: RugCheck Score (hard block if < 80) ──
  if (typeof input.rugCheckScore === 'number' && input.rugCheckScore < 80) {
    return {
      score: Math.min(input.rugCheckScore, 39), // Cap at avoid territory
      action: 'rug_alert',
      breakdown: { rugCheckScore: input.rugCheckScore },
      blocked: true,
      blockReason: `RugCheck score too low: ${input.rugCheckScore}/100`,
    };
  }

  // ─── Factor 1: Volume Spike ─────────────────────
  const volumePoints = scoreTiers(
    input.volumeSpikePct || 0,
    FACTORS.VOLUME_SPIKE.tiers,
  );
  breakdown.volume = volumePoints;

  // ─── Factor 2: Liquidity Depth ──────────────────
  const liquidityPoints = scoreTiers(
    input.liquidityUsd || 0,
    FACTORS.LIQUIDITY.tiers,
  );
  breakdown.liquidity = liquidityPoints;

  // ─── Factor 3: KOL Cluster ─────────────────────
  const kolResult = scoreKolCluster(input.kolMatches || []);
  breakdown.kol = kolResult.points;
  breakdown.kolDetails = kolResult;

  // ─── Factor 4: Social Pre-Shill ─────────────────
  const socialPoints = scoreSocial(input.socialMentions ?? 0);
  breakdown.social = socialPoints;

  // ─── Factor 7: Dev Holdings ─────────────────────
  const devPoints = scoreTiers(
    input.devHoldingsPct ?? 100,
    FACTORS.DEV_HOLDINGS.thresholds,
  );
  breakdown.devHoldings = devPoints;

  // ─── Factor 8: Token Age ────────────────────────
  const agePoints = scoreTiers(
    input.tokenAgeMinutes ?? Infinity,
    FACTORS.TOKEN_AGE.thresholds,
  );
  breakdown.tokenAge = agePoints;

  // ─── Compute total ─────────────────────────────
  const rawScore =
    volumePoints +
    liquidityPoints +
    kolResult.points +
    socialPoints +
    devPoints +
    agePoints;

  // Clamp to 0–100
  const score = Math.max(0, Math.min(100, rawScore));

  // ─── Determine action ──────────────────────────
  let action;
  if (score >= 85) action = 'strong_buy';
  else if (score >= 55) action = 'buy';
  else if (score >= 40) action = 'watch';
  else action = 'avoid';

  // ─── Additional metadata ───────────────────────
  breakdown.rugCheckScore = input.rugCheckScore ?? null;
  breakdown.mintAuthorityRevoked = input.mintAuthorityRevoked ?? false;
  breakdown.freezeAuthorityRevoked = input.freezeAuthorityRevoked ?? false;
  breakdown.lpLockedPct = input.lpLockedPct ?? 0;
  breakdown.topHolderPct = input.topHolderPct ?? 100;
  breakdown.isCluster = kolResult.isCluster;

  logger.debug({
    msg: 'Token scored',
    score,
    action,
    breakdown,
  });

  return { score, action, breakdown, blocked, blockReason };
}

// ─── Helpers ──────────────────────────────────

/**
 * Score a value against a tiered threshold list.
 * Returns points from the first tier where value >= threshold.
 */
function scoreTiers(value, tiers) {
  for (const tier of tiers) {
    if (tier.threshold !== undefined && value >= tier.threshold) {
      return tier.points;
    }
    if (tier.maxMentions !== undefined && value <= tier.maxMentions) {
      return tier.points;
    }
    if (tier.maxPct !== undefined && value <= tier.maxPct) {
      return tier.points;
    }
    if (tier.maxMinutes !== undefined && value <= tier.maxMinutes) {
      return tier.points;
    }
  }
  return 0;
}

/**
 * Score KOL cluster based on matched wallets and their tiers.
 */
function scoreKolCluster(kolMatches) {
  if (!kolMatches || kolMatches.length === 0) {
    return { points: 0, isCluster: false, matchCount: 0, breakdown: {} };
  }

  const config = FACTORS.KOL_CLUSTER;
  let points = 0;
  const tierCounts = { s: 0, a: 0, b: 0, unranked: 0 };

  for (const kol of kolMatches) {
    const tier = (kol.tier || 'unranked').toLowerCase();
    const weight = config.tierWeights[tier] || config.tierWeights.unranked;
    points += weight;
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  }

  const isCluster = kolMatches.length >= config.clusterThreshold;
  if (isCluster) {
    points += config.clusterBonus;
  }

  // Cap at max points
  points = Math.min(points, config.maxPoints);

  return {
    points,
    isCluster,
    matchCount: kolMatches.length,
    breakdown: tierCounts,
  };
}

/**
 * Score social mentions (inverted — fewer mentions = better for sniping).
 */
function scoreSocial(mentions) {
  const tiers = FACTORS.SOCIAL.tiers;
  for (const tier of tiers) {
    if (mentions <= tier.maxMentions) {
      return tier.points;
    }
  }
  return 0;
}

module.exports = { scoreToken, FACTORS };
