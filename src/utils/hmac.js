'use strict';

const crypto = require('node:crypto');

/**
 * HMAC Utility (J2 mitigation)
 *
 * Signs and verifies callback_data for Telegram inline buttons.
 * Prevents callback data tampering — attacker can't forge valid buttons.
 *
 * Format: `action:mint:amount:hmac`
 * HMAC input: `action:mint:amount` (colon-separated)
 * Algorithm: HMAC-SHA256, truncated to 16 hex chars (64-bit security)
 *
 * Why truncated? Telegram callback_data has a 64-byte limit.
 * 64-bit HMAC is sufficient for short-lived inline buttons.
 */

const HMAC_SECRET = process.env.HMAC_SECRET || 'dev-hmac-secret-change-in-production';
const HMAC_LENGTH = 16; // 16 hex chars = 8 bytes = 64 bits

/**
 * Sign a callback data payload
 * @param {string} action - e.g. 'snipe', 'exit', 'copy', 'refresh'
 * @param {string} mint - token mint address
 * @param {string} amount - SOL amount or percentage
 * @returns {string} Signed callback_data: `action:mint:amount:hmac`
 */
function signCallback(action, mint, amount) {
  const payload = `${action}:${mint}:${amount}`;
  const hmac = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, HMAC_LENGTH);

  return `${payload}:${hmac}`;
}

/**
 * Verify a signed callback_data string
 * @param {string} callbackData - Full callback string: `action:mint:amount:hmac`
 * @returns {{ valid: boolean, action?: string, mint?: string, amount?: string }}
 */
function verifyCallback(callbackData) {
  if (!callbackData || typeof callbackData !== 'string') {
    return { valid: false };
  }

  const parts = callbackData.split(':');
  if (parts.length !== 4) {
    return { valid: false };
  }

  const [action, mint, amount, receivedHmac] = parts;
  const payload = `${action}:${mint}:${amount}`;
  const expectedHmac = crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(payload)
    .digest('hex')
    .slice(0, HMAC_LENGTH);

  // Constant-time comparison to prevent timing attacks
  const isValid =
    receivedHmac.length === expectedHmac.length &&
    crypto.timingSafeEqual(
      Buffer.from(receivedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex')
    );

  if (!isValid) {
    return { valid: false };
  }

  return { valid: true, action, mint, amount };
}

module.exports = { signCallback, verifyCallback };
