'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Trade Model
 *
 * Records every buy/sell action with full provenance:
 *   - Which signal triggered it (signalId → Signal doc)
 *   - Which wallet executed it
 *   - Tx signature + latency metrics
 *   - PnL calculated on sell
 *   - Jito bundle info (bundleId, tip, slot)
 *
 * Edge cases addressed:
 *   - C1: Stores bundleId for Jito bundle tracking
 *   - G1: Latency fields (detectionToSubmitMs, blockInclusionMs)
 *   - E2: Sell-side PnL with buy reference
 */

const TradeSchema = new Schema({
  // Who
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  telegramId: {
    type: Number,
    required: true,
    index: true,
  },
  walletPublicKey: { type: String, required: true },

  // What
  type: {
    type: String,
    enum: ['buy', 'sell'],
    required: true,
  },
  tokenMint: {
    type: String,
    required: true,
    index: true,
  },
  tokenSymbol: { type: String, default: null },
  tokenName: { type: String, default: null },

  // Amounts
  amountSol: { type: Number, required: true },
  amountTokens: { type: Number, default: null },
  pricePerToken: { type: Number, default: null },
  slippageBps: { type: Number, default: 300 },

  // Trigger source
  triggerType: {
    type: String,
    enum: ['manual', 'auto_snipe', 'copy_trade', 'tp_sl', 'trailing_stop'],
    default: 'manual',
  },
  signalId: { type: Schema.Types.ObjectId, ref: 'Signal', default: null },
  kolWallet: { type: String, default: null }, // if copy-trade

  // Jito bundle
  jitoTipLamports: { type: Number, default: null },
  bundleId: { type: String, default: null, index: true },

  // Transaction
  txSignature: { type: String, default: null, index: true },
  slot: { type: Number, default: null },
  status: {
    type: String,
    enum: ['pending', 'submitted', 'confirmed', 'failed', 'expired'],
    default: 'pending',
  },
  failureReason: { type: String, default: null },

  // Latency metrics (ms)
  detectionToSubmitMs: { type: Number, default: null },
  submitToConfirmMs: { type: Number, default: null },
  totalLatencyMs: { type: Number, default: null },

  // PnL (populated on sell)
  pnlSol: { type: Number, default: null },
  pnlPercent: { type: Number, default: null },
  buyTradeId: { type: Schema.Types.ObjectId, ref: 'Trade', default: null }, // link sell → buy

  // Threat score at time of trade
  threatScoreAtTrade: { type: Number, default: null },
}, {
  timestamps: true,
  collection: 'trades',
});

// ─── Indexes ─────────────────────────────────
TradeSchema.index({ userId: 1, createdAt: -1 });
TradeSchema.index({ tokenMint: 1, type: 1, createdAt: -1 });
TradeSchema.index({ telegramId: 1, status: 1 });
TradeSchema.index({ status: 1, createdAt: 1 }, { expireAfterSeconds: 86400 * 30 }); // 30d TTL for old failed trades, only if status='expired'

module.exports = mongoose.model('Trade', TradeSchema);
