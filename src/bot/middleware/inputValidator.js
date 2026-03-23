/**
 * inputValidator.js — Input sanitisation middleware
 * 
 * Validates mint addresses, amounts, percentages.
 * Escapes markdown in all external data.
 */
'use strict';

const log = require('../../config/logger').child({ module: 'inputValidator' });

// Solana Base58 address regex (32-44 chars, no 0/O/I/l)
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Trading limits from env
const MIN_TRADE  = parseFloat(process.env.MIN_TRADE_AMOUNT_SOL) || 0.01;
const MAX_TRADE  = parseFloat(process.env.MAX_SNIPE_AMOUNT_SOL) || 10;
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS_PER_USER) || 5;

/**
 * Telegram MarkdownV2 escape — escapes special chars.
 */
function escapeMarkdown(text) {
  if (typeof text !== 'string') return String(text ?? '');
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Validate a Solana Base58 address.
 */
function isValidMint(addr) {
  return typeof addr === 'string' && BASE58_REGEX.test(addr);
}

/**
 * Validate SOL amount within bounds.
 * @param {number} amount
 * @param {number} [balance] — user's SOL balance (optional upper bound)
 * @param {number} [userMax] — user's personal max trade (from settings)
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateAmount(amount, balance, userMax) {
  if (typeof amount !== 'number' || !isFinite(amount) || isNaN(amount)) {
    return { valid: false, reason: 'Amount must be a valid number' };
  }
  if (amount < MIN_TRADE) {
    return { valid: false, reason: `Minimum trade: ${MIN_TRADE} SOL` };
  }
  // User's personal cap takes priority, but never exceeds system max
  const effectiveMax = userMax ? Math.min(userMax, MAX_TRADE) : MAX_TRADE;
  const cap = balance ? Math.min(effectiveMax, balance - 0.01) : effectiveMax;
  if (amount > cap) {
    return { valid: false, reason: `Max trade: ${cap.toFixed(4)} SOL` };
  }
  return { valid: true };
}

/**
 * Validate sell percentage (1-100, integer).
 * @param {number} pct
 * @returns {{ valid: boolean, reason?: string }}
 */
function validatePercent(pct) {
  if (typeof pct !== 'number' || !isFinite(pct) || isNaN(pct)) {
    return { valid: false, reason: 'Percentage must be a valid number' };
  }
  const rounded = Math.round(pct);
  if (rounded < 1 || rounded > 100) {
    return { valid: false, reason: 'Percentage must be 1–100' };
  }
  return { valid: true, value: rounded };
}

/**
 * Global input validation middleware.
 * Attaches helper functions to ctx.state for downstream handlers.
 */
function inputValidatorMiddleware() {
  return async (ctx, next) => {
    // Attach validators to state for downstream use
    ctx.state.validate = {
      mint:    isValidMint,
      amount:  validateAmount,
      percent: validatePercent,
    };
    ctx.state.escapeMarkdown = escapeMarkdown;
    ctx.state.limits = { MIN_TRADE, MAX_TRADE, MAX_WALLETS };

    return next();
  };
}

module.exports = {
  inputValidatorMiddleware,
  isValidMint,
  validateAmount,
  validatePercent,
  escapeMarkdown,
  BASE58_REGEX,
};
