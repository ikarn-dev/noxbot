/**
 * adminGate.js — Admin command whitelist
 * 
 * Silently rejects non-admin users from admin commands.
 * Admin IDs configured via ADMIN_USER_IDS env var.
 */
'use strict';

const log = require('../../config/logger').child({ module: 'adminGate' });

// Parse admin IDs from env (comma-separated)
const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(id => !isNaN(id))
);

/**
 * Check if a Telegram userId is an admin.
 */
function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

/**
 * Admin gate middleware — silently ignores non-admin requests.
 * Attach to admin-only command handlers.
 */
function adminGateMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAdmin(userId)) {
      log.debug({ userId }, 'non-admin attempted admin command');
      return; // Silent rejection — no response
    }
    ctx.state.isAdmin = true;
    return next();
  };
}

module.exports = { adminGateMiddleware, isAdmin };
