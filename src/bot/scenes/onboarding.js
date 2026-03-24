/**
 * scenes/onboarding.js — First-run wallet setup wizard
 *
 * ALL heavy imports (@solana/web3.js, bs58, User model) are lazy-loaded
 * inside handlers to avoid bloating the heap before bot.launch().
 */
'use strict';

const { Scenes, Markup } = require('telegraf');
const log = require('../../config/logger').child({ module: 'scene:onboarding' });

const scene = new Scenes.WizardScene(
  'onboarding',

  // Step 1: Welcome
  async (ctx) => {
    await ctx.reply(
      '🌑 *Welcome to Nox*\n\n' +
      'The fastest Solana sniper bot.\n\n' +
      'Let\'s set up your wallet:',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Generate New Wallet', 'onboard_generate')],
          [Markup.button.callback('📥 Import Private Key', 'onboard_import')],
        ]),
      }
    );
    return ctx.wizard.next();
  },

  // Step 2: Handle wallet creation/import (text input for private key)
  async (ctx) => {
    if (ctx.message?.text) {
      const keyInput = ctx.message.text.trim();

      // Ignore commands
      if (keyInput.startsWith('/')) {
        await ctx.scene.reenter();
        return;
      }

      // Delete the message with the private key immediately
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      try {
        // Lazy-load heavy deps only when actually needed
        const { Keypair } = require('@solana/web3.js');
        const _bs58 = require('bs58');
        const bs58 = _bs58.default || _bs58;
        const { encryptPrivateKey } = require('../../utils/wallet-crypto');

        const secretKey = bs58.decode(keyInput);
        const keypair = Keypair.fromSecretKey(secretKey);
        const publicKey = keypair.publicKey.toBase58();

        const encrypted = encryptPrivateKey(keyInput);

        ctx.wizard.state.wallet = {
          publicKey,
          ...encrypted,
          label: 'Imported',
        };

        await ctx.reply(
          `✅ Wallet imported: \`${publicKey.slice(0, 8)}...\`\n\n` +
          '⚠️ Your private key message was deleted for safety.',
          { parse_mode: 'Markdown' }
        );

        return finishOnboarding(ctx);
      } catch {
        await ctx.reply('❌ Invalid private key. Please send a valid Base58 key or tap Generate.');
        return;
      }
    }
  },
);

// Handle /start while inside the scene — re-enter to reset wizard
scene.command('start', async (ctx) => {
  return ctx.scene.reenter();
});

// Handle "Generate" button
scene.action('onboard_generate', async (ctx) => {
  if (ctx.wizard.state.generating) return ctx.answerCbQuery('Already generating...');
  ctx.wizard.state.generating = true;
  await ctx.answerCbQuery();

  try {
    // Lazy-load heavy deps
    const { Keypair } = require('@solana/web3.js');
    const _bs58 = require('bs58');
    const bs58 = _bs58.default || _bs58;
    const { encryptPrivateKey } = require('../../utils/wallet-crypto');

    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);

    const encrypted = encryptPrivateKey(secretKey);

    ctx.wizard.state.wallet = {
      publicKey,
      ...encrypted,
      label: 'Main',
    };

    const sentMsg = await ctx.reply(
      `✅ *Wallet Generated*\n\n` +
      `Address: \`${publicKey}\`\n\n` +
      `🔐 *SAVE YOUR PRIVATE KEY:*\n` +
      `\`${secretKey}\`\n\n` +
      '⚠️ This message will be deleted in 60 seconds.\n' +
      '⚠️ Never share your private key with anyone.',
      { parse_mode: 'Markdown' }
    );

    // Auto-delete after 60s (capture message ID)
    setTimeout(async () => {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, sentMsg.message_id); } catch {}
    }, 60_000);

    return finishOnboarding(ctx);
  } catch (err) {
    log.error({ err: err.message }, 'keypair generation failed');
    await ctx.reply('❌ Wallet generation failed. Please try /start again.');
    return ctx.scene.leave();
  }
});

// Handle "Import" button
scene.action('onboard_import', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '📥 *Import Wallet*\n\n' +
    'Send your Base58 private key.\n' +
    '⚠️ The message will be deleted immediately.',
    { parse_mode: 'Markdown' }
  );
});

/**
 * Complete onboarding — save to session + MongoDB.
 */
async function finishOnboarding(ctx) {
  const wallet = ctx.wizard.state.wallet;
  if (!wallet) return ctx.scene.leave();

  // Initialize session
  ctx.session.wallets      = [wallet];
  ctx.session.activeWallet = wallet.publicKey;
  ctx.session.settings     = {
    slippage:    300,
    jitoTip:     1_000_000,
    snipeAmount: 0.1,
    autoSell:    false,
    takeProfit:  100,
    stopLoss:    50,
    dryRun:      true,
  };

  // Upsert user in MongoDB (lazy-load model)
  try {
    const User = require('../../models/User');
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        telegramId: ctx.from.id,
        username:   ctx.from.username,
        $push: {
          wallets: {
            publicKey:          wallet.publicKey,
            encryptedPrivateKey: wallet.encryptedPrivateKey,
            iv:                 wallet.iv,
            authTag:            wallet.authTag,
            label:              wallet.label,
            isDefault:          true,
          },
        },
        settings: ctx.session.settings,
      },
      { upsert: true, new: true }
    );
    log.info({ userId: ctx.from.id, wallet: wallet.publicKey }, 'user onboarded');
  } catch (err) {
    log.error({ err: err.message }, 'user save failed (MongoDB may not be connected yet)');
  }

  await ctx.reply(
    '🎉 *Setup Complete!*\n\n' +
    '🧪 You\'re starting in *Dry Run* mode.\n' +
    'Trades will be simulated — no real SOL spent.\n\n' +
    'Use `/dryrun off` when ready for live trading.\n' +
    'Use `/help` to see all commands.',
    { parse_mode: 'Markdown' }
  );

  return ctx.scene.leave();
}

module.exports = scene;
