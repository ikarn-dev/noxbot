/**
 * commands/wallets.js — /wallets
 * 
 * Multi-wallet management (add, remove, switch, list).
 * Max wallets enforced by MAX_WALLETS_PER_USER.
 */
'use strict';

const { Markup }       = require('telegraf');
const log              = require('../../config/logger').child({ module: 'cmd:wallets' });
const { signCallback } = require('../middleware/callbackVerifier');

const MAX_WALLETS = parseInt(process.env.MAX_WALLETS_PER_USER) || 5;

function register(bot) {
  bot.command('wallets', async (ctx) => {
    const wallets = ctx.session?.wallets || [];
    const active  = ctx.session?.activeWallet;

    if (wallets.length === 0) {
      return ctx.reply('🔑 No wallets configured. Use /start to create one.');
    }

    const header = '🔑 *Wallets*\n\n';
    const rows = wallets.map((w, i) => {
      const addr = w.publicKey.slice(0, 8) + '...' + w.publicKey.slice(-4);
      const isActive = w.publicKey === active ? ' ✅' : '';
      const label = w.label || `Wallet ${i + 1}`;
      return `${i + 1}. \`${addr}\` — ${label}${isActive}`;
    });

    const buttons = [];

    // Switch buttons for non-active wallets
    wallets.forEach((w, i) => {
      if (w.publicKey !== active) {
        buttons.push([
          Markup.button.callback(
            `Switch to ${w.label || `Wallet ${i + 1}`}`,
            signCallback('wallet_switch', w.publicKey)
          ),
        ]);
      }
    });

    // Add wallet button if under limit
    if (wallets.length < MAX_WALLETS) {
      buttons.push([
        Markup.button.callback('➕ Add Wallet', signCallback('wallet_add')),
      ]);
    }

    return ctx.reply(
      header + rows.join('\n') + `\n\nMax: ${MAX_WALLETS} wallets`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
    );
  });
}

module.exports = { register };
