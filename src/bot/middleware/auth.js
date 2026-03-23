/**
 * auth.js — Authentication middleware
 * 
 * Ensures user has a wallet connected before executing
 * trade-related actions. Non-destructive for read-only commands.
 */
'use strict';

const log = require('../../config/logger').child({ module: 'auth' });

// Commands that do NOT require a wallet
const PUBLIC_COMMANDS = new Set([
  '/start', '/help', '/h',
]);

// Scenes that do NOT require a wallet (onboarding creates one)
const PUBLIC_SCENES = new Set(['onboarding']);

/**
 * Auth middleware — blocks trade actions for users without wallets.
 * Reads session from ctx.session (hydrated by upstream session middleware).
 */
function authMiddleware() {
  return async (ctx, next) => {
    // Allow public commands
    if (ctx.message?.text) {
      const cmd = ctx.message.text.split(/\s/)[0].split('@')[0].toLowerCase();
      if (PUBLIC_COMMANDS.has(cmd)) return next();
    }

    // Allow users currently in onboarding scene
    if (ctx.scene?.current?.id && PUBLIC_SCENES.has(ctx.scene.current.id)) {
      return next();
    }

    // Session must exist
    if (!ctx.session) {
      log.warn({ telegramId: ctx.from?.id }, 'no session');
      return ctx.reply('⚠️ Session expired. Please /start again.');
    }

    // Must have at least one wallet
    const wallets = ctx.session.wallets;
    if (!wallets || wallets.length === 0) {
      log.info({ telegramId: ctx.from?.id }, 'no wallet connected');
      return ctx.reply('🔑 No wallet connected. Use /start to set up your wallet.');
    }

    // Must have an active wallet selected
    if (!ctx.session.activeWallet) {
      ctx.session.activeWallet = wallets[0].publicKey;
    }

    // Attach convenience props
    ctx.state.wallet = ctx.session.activeWallet;
    ctx.state.userId = ctx.from.id;

    return next();
  };
}

module.exports = { authMiddleware };
