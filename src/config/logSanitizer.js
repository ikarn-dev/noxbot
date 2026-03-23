'use strict';

/**
 * Log Sanitizer (M1 mitigation)
 *
 * Scrubs API keys, tokens, and other secrets from log output.
 * Applied via Pino's logMethod hook in logger.js.
 *
 * Patterns matched:
 *   - Bearer tokens
 *   - Hex strings ≥32 chars (API keys, encryption keys)
 *   - Base64 JWT-like strings
 *   - Known env var patterns (BOT_TOKEN, HELIUS_API_KEY, etc.)
 */

const PATTERNS = [
  // Bearer tokens
  { regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: 'Bearer [REDACTED]' },

  // Telegram bot tokens (numeric:alphanumeric)
  { regex: /\d{8,10}:[A-Za-z0-9_-]{35}/g, replacement: '[BOT_TOKEN_REDACTED]' },

  // Long hex strings (≥32 chars) — API keys, encryption keys
  { regex: /\b[0-9a-fA-F]{32,}\b/g, replacement: '[HEX_KEY_REDACTED]' },

  // Base58 private keys (64-88 chars)
  { regex: /\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/g, replacement: '[PRIVATE_KEY_REDACTED]' },

  // JWT-like tokens (three dot-separated base64 segments)
  { regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, replacement: '[JWT_REDACTED]' },

  // Generic long alphanumeric strings that look like API keys (≥40 chars)
  { regex: /\b[A-Za-z0-9]{40,}\b/g, replacement: '[API_KEY_REDACTED]' },
];

/**
 * Sanitize a string by replacing all matched patterns
 * @param {string} input
 * @returns {string}
 */
function sanitize(input) {
  if (typeof input !== 'string') return input;

  let result = input;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Sanitize an object's string values (shallow, one level)
 * @param {Object} obj
 * @returns {Object}
 */
function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    sanitized[key] = typeof value === 'string' ? sanitize(value) : value;
  }
  return sanitized;
}

module.exports = { sanitize, sanitizeObject };
