'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * User Model
 *
 * Core schema for all Telegram users. Stores:
 *   - Telegram identity
 *   - Encrypted wallets (AES-256-GCM, encrypted at rest)
 *   - Trading settings (slippage, Jito tip, auto-snipe, etc.)
 *   - Copy-trade targets (linked KOL wallets)
 *   - Tier/subscription info
 *   - 2FA with TOTP (speakeasy)
 *   - Rate-limit state
 *
 * Edge cases addressed:
 *   - F1: 2FA TOTP support (twoFASecret, twoFAEnabled)
 *   - B4: Max 5 wallets per user (validated at application layer)
 *   - H1: Concurrent wallet access (use atomic $push/$pull)
 */

const WalletSchema = new Schema({
  label: { type: String, default: 'Main Wallet' },
  publicKey: { type: String, required: true },
  encryptedPrivateKey: { type: String, required: true }, // AES-256-GCM encrypted
  iv: { type: String, required: true },
  authTag: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const CopyTargetSchema = new Schema({
  kolWallet: { type: String, required: true, index: true },
  kolName: { type: String },
  allocationSol: { type: Number, default: 0.1, min: 0.01 },
  maxPerTrade: { type: Number, default: 0.5 },
  enabled: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now },
}, { _id: true });

const SettingsSchema = new Schema({
  slippageBps: { type: Number, default: 300, min: 50, max: 5000 },
  jitoTipLamports: { type: Number, default: 1_000_000, min: 100_000 },
  autoSnipeEnabled: { type: Boolean, default: false },
  autoSnipeAmountSol: { type: Number, default: 0.1 },
  autoSnipeMinScore: { type: Number, default: 70, min: 0, max: 100 },
  maxOpenPositions: { type: Number, default: 10, min: 1, max: 50 },
  defaultTradeAmountSol: { type: Number, default: 0.1 },
  // Per-user max trade cap (null = use global MAX_SNIPE_AMOUNT_SOL from env)
  maxTradeAmountSol: { type: Number, default: null, min: 0.01 },
  // Custom quick-buy button amounts (SOL values shown when /buy <mint> is called)
  buyPresets: { type: [Number], default: [0.1, 0.25, 0.5, 1] },
  // Sell settings
  autoTakeProfitPct: { type: Number, default: null }, // null = manual
  autoStopLossPct: { type: Number, default: null },
  trailingStopPct: { type: Number, default: null },
  // Notification preferences
  notifyOnBuy: { type: Boolean, default: true },
  notifyOnSell: { type: Boolean, default: true },
  notifyKolAlerts: { type: Boolean, default: true },
  notifyThreatAlerts: { type: Boolean, default: true },
}, { _id: false });

const UserSchema = new Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },
  username: { type: String, default: null },
  firstName: { type: String, default: null },
  languageCode: { type: String, default: 'en' },

  // Wallets (max 5 enforced at app layer)
  wallets: {
    type: [WalletSchema],
    default: [],
    validate: {
      validator: (v) => v.length <= 5,
      message: 'Maximum 5 wallets allowed per user',
    },
  },

  // Trading settings
  settings: { type: SettingsSchema, default: () => ({}) },

  // Copy-trade targets
  copyTargets: {
    type: [CopyTargetSchema],
    default: [],
    validate: {
      validator: (v) => v.length <= 20,
      message: 'Maximum 20 copy targets allowed',
    },
  },

  // Tier / subscription
  tier: {
    type: String,
    enum: ['free', 'alpha', 'whale'],
    default: 'free',
  },
  tierExpiresAt: { type: Date, default: null },

  // 2FA (TOTP)
  twoFAEnabled: { type: Boolean, default: false },
  twoFASecret: { type: String, default: null }, // encrypted

  // Rate limiting / abuse
  dailyTradeCount: { type: Number, default: 0 },
  dailyTradeResetAt: { type: Date, default: Date.now },

  // Referral
  referredBy: { type: Number, default: null }, // telegramId of referrer
  referralCode: { type: String, unique: true, sparse: true },

  // Flags
  isBanned: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  acceptedToS: { type: Boolean, default: false },
  onboardingComplete: { type: Boolean, default: false },
}, {
  timestamps: true,
  collection: 'users',
});

// ─── Indexes ─────────────────────────────────
UserSchema.index({ 'wallets.publicKey': 1 });
UserSchema.index({ tier: 1, createdAt: -1 });

module.exports = mongoose.model('User', UserSchema);
