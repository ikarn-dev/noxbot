/**
 * scenes/onboarding.js — First-run wallet setup wizard
 * 
 * Steps:
 *   1. Welcome message + create/import choice
 *   2. Generate new keypair OR accept private key import
 *   3. Confirm wallet + set initial settings
 */
'use strict';

const { Scenes, Markup } = require('telegraf');
const { Keypair }        = require('@solana/web3.js');
const bs58               = require('bs58');
const log                = require('../../config/logger').child({ module: 'scene:onboarding' });
const User               = require('../../models/User');

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

  // Step 2: Handle wallet creation/import
  async (ctx) => {
    // This step handles text input (for private key import)
    if (ctx.message?.text) {
      const keyInput = ctx.message.text.trim();

      // Delete the message with the private key immediately
      await ctx.deleteMessage(ctx.message.message_id).catch(() => {});

      try {
        const secretKey = bs58.decode(keyInput);
        const keypair = Keypair.fromSecretKey(secretKey);
        const publicKey = keypair.publicKey.toBase58();

        ctx.wizard.state.wallet = {
          publicKey,
          encryptedKey: keyInput, // TODO: encrypt with user's PIN
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
        return; // Stay on this step
      }
    }
  },
);

// Handle "Generate" button
scene.action('onboard_generate', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    const keypair   = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKey = bs58.encode(keypair.secretKey);

    ctx.wizard.state.wallet = {
      publicKey,
      encryptedKey: secretKey, // TODO: encrypt at rest
      label: 'Main',
    };

    await ctx.reply(
      `✅ *Wallet Generated*\n\n` +
      `Address: \`${publicKey}\`\n\n` +
      `🔐 *SAVE YOUR PRIVATE KEY:*\n` +
      `\`${secretKey}\`\n\n` +
      '⚠️ This message will be deleted in 60 seconds.\n' +
      '⚠️ Never share your private key with anyone.',
      { parse_mode: 'Markdown' }
    );

    // Auto-delete after 60s
    setTimeout(async () => {
      try { await ctx.deleteMessage(); } catch {}
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
    dryRun:      true, // Start in dry run for safety
  };

  // Upsert user in MongoDB
  try {
    await User.findOneAndUpdate(
      { telegramId: ctx.from.id },
      {
        telegramId: ctx.from.id,
        username:   ctx.from.username,
        $push:      { wallets: { publicKey: wallet.publicKey, label: wallet.label } },
        activeWallet: wallet.publicKey,
        settings:   ctx.session.settings,
      },
      { upsert: true, new: true }
    );
    log.info({ userId: ctx.from.id, wallet: wallet.publicKey }, 'user onboarded');
  } catch (err) {
    log.error({ err: err.message }, 'user save failed');
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
