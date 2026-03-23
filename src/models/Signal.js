'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Signal Model
 *
 * A scored signal emitted when a new token is detected via Yellowstone gRPC
 * and passes through the threat + KOL intelligence pipeline.
 *
 * Signal lifecycle:
 *   1. Token detected (Yellowstone gRPC → Raydium pool creation)
 *   2. Threat assessment (RugCheck + on-chain heuristics)
 *   3. KOL correlation (who's buying? S-tier? Cluster buy?)
 *   4. Composite score 0–100 calculated
 *   5. Signal broadcasted via Redis pub/sub
 *   6. Users' auto-snipe or manual action
 *
 * Edge cases addressed:
 *   - A2: threatScore breakdown stored in components
 *   - K2: kolMatches with wallet + tier
 *   - S1: cluster detection (multiple KOLs buying = cluster signal)
 */

const ScoreComponentSchema = new Schema({
  // Threat assessment (0–100, lower = safer)
  threatScore: { type: Number, default: 100 },
  rugCheckPassed: { type: Boolean, default: false },
  mintAuthorityRevoked: { type: Boolean, default: false },
  freezeAuthorityRevoked: { type: Boolean, default: false },
  liquidityLockedPct: { type: Number, default: 0 },
  topHolderConcentrationPct: { type: Number, default: 100 },

  // KOL intelligence
  kolMatchCount: { type: Number, default: 0 },
  highestKolTier: { type: String, enum: ['s', 'a', 'b', 'none'], default: 'none' },
  isClusterSignal: { type: Boolean, default: false }, // 3+ KOLs = cluster

  // Market data at detection
  initialLiquiditySol: { type: Number, default: 0 },
  initialMarketCapSol: { type: Number, default: 0 },
  volumeFirst5Min: { type: Number, default: 0 },
}, { _id: false });

const KOLMatchSchema = new Schema({
  walletAddress: { type: String, required: true },
  label: { type: String },
  tier: { type: String, enum: ['s', 'a', 'b', 'unranked'] },
  action: { type: String, enum: ['buy', 'add_liquidity'], default: 'buy' },
  amountSol: { type: Number, default: 0 },
  detectedAt: { type: Date, default: Date.now },
}, { _id: false });

const SignalSchema = new Schema({
  // Token identity
  tokenMint: {
    type: String,
    required: true,
    index: true,
  },
  tokenSymbol: { type: String, default: null },
  tokenName: { type: String, default: null },
  poolAddress: { type: String, default: null },
  dex: {
    type: String,
    enum: ['raydium', 'orca', 'meteora', 'unknown'],
    default: 'raydium',
  },

  // Composite score (0–100)
  score: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    index: true,
  },

  // Recommended action
  action: {
    type: String,
    enum: ['strong_buy', 'buy', 'watch', 'avoid', 'rug_alert'],
    required: true,
  },

  // Score breakdown
  components: { type: ScoreComponentSchema, default: () => ({}) },

  // KOL matches
  kolMatches: { type: [KOLMatchSchema], default: [] },

  // Detection metadata
  detectedAt: { type: Date, default: Date.now, index: true },
  detectedSlot: { type: Number, default: null },
  source: {
    type: String,
    enum: ['yellowstone_grpc', 'manual_scan', 'kol_copy'],
    default: 'yellowstone_grpc',
  },

  // Lifecycle
  status: {
    type: String,
    enum: ['active', 'expired', 'rug_confirmed'],
    default: 'active',
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 15 * 60 * 1000), // 15 min TTL
    index: { expireAfterSeconds: 0 },
  },

  // Stats — how many users acted on this signal
  actedOnCount: { type: Number, default: 0 },
  totalVolumeSol: { type: Number, default: 0 },
}, {
  timestamps: true,
  collection: 'signals',
});

// ─── Indexes ─────────────────────────────────
SignalSchema.index({ score: -1, detectedAt: -1 });
SignalSchema.index({ action: 1, status: 1 });
SignalSchema.index({ 'components.isClusterSignal': 1, score: -1 });

module.exports = mongoose.model('Signal', SignalSchema);
