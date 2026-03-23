'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * KOL Model
 *
 * KOL (Key Opinion Leader) registry — tracked wallets with performance stats.
 *
 * Fields:
 *   - wallet identity + social links
 *   - tier (s/a/b/unranked) with auto-promotion via stats
 *   - rolling performance stats (win rate, PnL, avg hold time)
 *   - tags for filtering (degen, sniper, whale, diamond-hands, etc.)
 *   - last activity tracking for stale KOL detection
 *
 * Edge cases addressed:
 *   - K2: Tags + tier filtering for signal scorer
 *   - K3: lastActivityAt for stale KOL pruning
 */

const KOLSchema = new Schema({
  // Identity
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  label: { type: String, required: true },
  twitterHandle: { type: String, default: null },
  telegramHandle: { type: String, default: null },

  // Tier — determines signal score multiplier
  tier: {
    type: String,
    enum: ['s', 'a', 'b', 'unranked'],
    default: 'unranked',
  },

  // Rolling 30-day performance stats
  stats: {
    tradesTracked: { type: Number, default: 0 },
    winRate: { type: Number, default: 0, min: 0, max: 100 }, // percentage
    avgPnlPercent: { type: Number, default: 0 },
    totalPnlSol: { type: Number, default: 0 },
    avgHoldTimeMinutes: { type: Number, default: 0 },
    largestWinSol: { type: Number, default: 0 },
    largestLossSol: { type: Number, default: 0 },
    rugsPulled: { type: Number, default: 0 }, // tokens that went to 0
    lastUpdatedAt: { type: Date, default: Date.now },
  },

  // Tags for filtering and signal scoring
  tags: {
    type: [String],
    default: [],
    enum: [
      'degen',         // aggressive, high-frequency trader
      'sniper',        // buys very early in token lifecycle
      'whale',         // large position sizes
      'diamond-hands', // long hold times
      'flipper',       // buys and sells quickly
      'insider',       // suspected insider (flagged, not banned)
      'copy-worthy',   // algorithmically recommended for copy
      'blacklisted',   // banned from copy-trade
    ],
  },

  // Tracking state
  isActive: { type: Boolean, default: true },
  lastActivityAt: { type: Date, default: null },
  firstSeenAt: { type: Date, default: Date.now },

  // Source — how this KOL was added
  addedBy: {
    type: String,
    enum: ['manual', 'auto_discovery', 'community_vote'],
    default: 'manual',
  },
  addedByTelegramId: { type: Number, default: null },

  // Notes
  notes: { type: String, default: null, maxlength: 500 },
}, {
  timestamps: true,
  collection: 'kols',
});

// ─── Indexes ─────────────────────────────────
KOLSchema.index({ tier: 1, isActive: 1 });
KOLSchema.index({ tags: 1 });
KOLSchema.index({ 'stats.winRate': -1, tier: 1 });
KOLSchema.index({ lastActivityAt: 1 }); // for stale detection

module.exports = mongoose.model('KOL', KOLSchema);
