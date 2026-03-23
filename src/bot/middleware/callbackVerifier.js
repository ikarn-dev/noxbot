/**
 * callbackVerifier.js — HMAC callback_data verification
 * 
 * Signs inline button callback_data at creation time.
 * Verifies HMAC on receipt to prevent tampering.
 * 
 * Format: action:param1:param2:hmac
 * Example: snipe:So1...xyz:100000000:a3f2...
 */
'use strict';

const { sign, verify } = require('../../utils/hmac');
const log = require('../../config/logger').child({ module: 'callbackVerifier' });

const SEPARATOR = ':';

/**
 * Create signed callback data string.
 * 
 * @param {string} action — e.g. "snipe", "exit", "copy", "refresh"
 * @param  {...string} params — additional params (mint, amount, etc.)
 * @returns {string} — "action:param1:param2:hmac"
 */
function signCallback(action, ...params) {
  const payload = [action, ...params].join(SEPARATOR);
  const hmac = sign(payload);
  return `${payload}${SEPARATOR}${hmac}`;
}

/**
 * Parse and verify signed callback data.
 * 
 * @param {string} data — raw callback_data string
 * @returns {{ valid: boolean, action?: string, params?: string[], raw?: string }}
 */
function parseCallback(data) {
  if (!data || typeof data !== 'string') {
    return { valid: false };
  }

  const parts = data.split(SEPARATOR);
  if (parts.length < 2) return { valid: false };

  const hmac = parts.pop();
  const payload = parts.join(SEPARATOR);

  if (!verify(payload, hmac)) {
    return { valid: false };
  }

  const [action, ...params] = parts;
  return { valid: true, action, params, raw: payload };
}

/**
 * Per-handler middleware that verifies callback HMAC.
 * Use on callback_query handlers that process trade actions.
 */
function callbackVerifierMiddleware() {
  return async (ctx, next) => {
    if (!ctx.callbackQuery?.data) return next();

    const result = parseCallback(ctx.callbackQuery.data);
    if (!result.valid) {
      log.warn({ userId: ctx.from?.id, data: ctx.callbackQuery.data }, 'invalid callback HMAC');
      await ctx.answerCbQuery('⚠️ Invalid action. Please retry.');
      return;
    }

    // Attach parsed data for downstream
    ctx.state.callback = {
      action: result.action,
      params: result.params,
      raw: result.raw,
    };

    return next();
  };
}

module.exports = {
  signCallback,
  parseCallback,
  callbackVerifierMiddleware,
};
