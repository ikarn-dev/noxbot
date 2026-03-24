'use strict';

/**
 * Unified Server — Minimal, zero-Telegraf-polling server
 *
 * Uses native fetch() (undici) for ALL Telegram API calls
 * to avoid Node v24's TLS memory leak in the https module.
 *
 * Webhook mode: Express receives updates from Telegram (no outbound TLS)
 * Polling mode:  fetch()-based polling (undici TLS, not Node https TLS)
 */

require('dotenv').config();

const express = require('express');
const log = require('./config/logger').child({ module: 'server' });

const PORT = parseInt(process.env.PORT || '10000', 10);
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Telegram API via fetch() ──────────────────────

async function tg(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) log.warn({ method, error: data.description }, 'TG API error');
  return data.result;
}

async function reply(chatId, text, opts = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...opts });
}

// ─── Express App ───────────────────────────────────

const app = express();
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });
});

// ─── State (in-memory) ────────────────────────────

const sessions = new Map(); // chatId → { wallets, activeWallet, settings, scene }

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

// ─── MongoDB (lazy) ───────────────────────────────

let mongoReady = false;
async function ensureMongo() {
  if (mongoReady) return;
  const { connectMongo } = require('./config/mongo');
  await connectMongo();
  mongoReady = true;
  log.info('MongoDB connected');
}

// ─── Update Handler ────────────────────────────────

async function handleUpdate(update) {
  try {
    const msg = update.message;
    const cb = update.callback_query;

    if (msg?.text) {
      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const sess = getSession(chatId);

      // Handle scene input (private key import)
      if (sess.scene === 'awaiting_key') {
        return handleKeyImport(chatId, text, msg.message_id, sess);
      }

      // Commands
      if (text === '/start') return handleStart(chatId, sess);
      if (text === '/help') return handleHelp(chatId);

      // Other commands
      const cmd = text.split(/\s/)[0].toLowerCase();
      if (cmd.startsWith('/')) {
        if (!sess.wallets?.length) {
          return reply(chatId, '🔑 No wallet set up yet. Use /start first.');
        }
        return reply(chatId, `⚙️ \`${cmd}\` coming soon. Use /help to see available commands.`);
      }
    }

    if (cb) {
      const chatId = cb.message.chat.id;
      const data = cb.data;
      const sess = getSession(chatId);

      await tg('answerCallbackQuery', { callback_query_id: cb.id });

      if (data === 'onboard_generate') return handleGenerate(chatId, sess);
      if (data === 'onboard_import') return handleImport(chatId, sess);
    }
  } catch (err) {
    log.error({ error: err.message }, 'Update handler error');
  }
}

// ─── Handlers ──────────────────────────────────────

async function handleStart(chatId, sess) {
  if (sess.wallets?.length > 0) {
    return reply(chatId, `Welcome back to *Nox* ⚡\n\nActive wallet: \`${sess.activeWallet?.slice(0, 8)}...\`\nUse /help for commands.`);
  }

  return tg('sendMessage', {
    chat_id: chatId,
    text: '🌑 *Welcome to Nox*\n\nThe fastest Solana sniper bot.\n\nLet\'s set up your wallet:',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔑 Generate New Wallet', callback_data: 'onboard_generate' }],
        [{ text: '📥 Import Private Key', callback_data: 'onboard_import' }],
      ],
    },
  });
}

async function handleGenerate(chatId, sess) {
  // Lazy-load crypto only when needed
  const { Keypair } = require('@solana/web3.js');
  const _bs58 = require('bs58');
  const bs58 = _bs58.default || _bs58;
  const { encryptPrivateKey } = require('./utils/wallet-crypto');

  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const secretKey = bs58.encode(keypair.secretKey);
  const encrypted = encryptPrivateKey(secretKey);

  sess.wallets = [{ publicKey, ...encrypted, label: 'Main' }];
  sess.activeWallet = publicKey;
  sess.settings = defaultSettings();

  // Save to MongoDB  
  await saveUser(chatId, sess);

  const sentMsg = await reply(chatId,
    `✅ *Wallet Generated*\n\n` +
    `Address: \`${publicKey}\`\n\n` +
    `🔐 *SAVE YOUR PRIVATE KEY:*\n\`${secretKey}\`\n\n` +
    '⚠️ This message will be deleted in 60 seconds.'
  );

  // Auto-delete private key message
  setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: sentMsg.message_id }).catch(() => {}), 60_000);

  await reply(chatId,
    '🎉 *Setup Complete!*\n\n🧪 Starting in *Dry Run* mode.\nUse `/dryrun off` for live trading.\nUse `/help` for all commands.'
  );
}

async function handleImport(chatId, sess) {
  sess.scene = 'awaiting_key';
  await reply(chatId, '📥 *Import Wallet*\n\nSend your Base58 private key.\n⚠️ The message will be deleted immediately.');
}

async function handleKeyImport(chatId, keyInput, msgId, sess) {
  // Delete the key message immediately
  await tg('deleteMessage', { chat_id: chatId, message_id: msgId }).catch(() => {});
  sess.scene = null;

  if (keyInput.startsWith('/')) {
    return handleStart(chatId, sess);
  }

  try {
    const { Keypair } = require('@solana/web3.js');
    const _bs58 = require('bs58');
    const bs58 = _bs58.default || _bs58;
    const { encryptPrivateKey } = require('./utils/wallet-crypto');

    const secretKey = bs58.decode(keyInput);
    const keypair = Keypair.fromSecretKey(secretKey);
    const publicKey = keypair.publicKey.toBase58();
    const encrypted = encryptPrivateKey(keyInput);

    sess.wallets = [{ publicKey, ...encrypted, label: 'Imported' }];
    sess.activeWallet = publicKey;
    sess.settings = defaultSettings();

    await saveUser(chatId, sess);

    await reply(chatId,
      `✅ Wallet imported: \`${publicKey.slice(0, 8)}...\`\n⚠️ Your key message was deleted.\n\n` +
      '🎉 *Setup Complete!*\n🧪 Starting in *Dry Run* mode.\nUse `/help` for commands.'
    );
  } catch {
    await reply(chatId, '❌ Invalid private key. Send a valid Base58 key or use /start to try again.');
  }
}

async function handleHelp(chatId) {
  await reply(chatId,
    '*Nox Commands* ⚡\n\n' +
    '/start — Setup wallet\n' +
    '/help — This message\n' +
    '/wallets — Manage wallets\n' +
    '/buy <mint> — Buy token\n' +
    '/sell <mint> — Sell token\n' +
    '/positions — View positions\n' +
    '/pnl — Profit & loss\n' +
    '/settings — Bot settings\n' +
    '/dryrun — Toggle dry run'
  );
}

function defaultSettings() {
  return { slippage: 300, jitoTip: 1_000_000, snipeAmount: 0.1, autoSell: false, takeProfit: 100, stopLoss: 50, dryRun: true };
}

async function saveUser(chatId, sess) {
  try {
    await ensureMongo();
    const User = require('./models/User');
    const w = sess.wallets[0];
    await User.findOneAndUpdate(
      { telegramId: chatId },
      {
        telegramId: chatId,
        $push: { wallets: { publicKey: w.publicKey, encryptedPrivateKey: w.encryptedPrivateKey, iv: w.iv, authTag: w.authTag, label: w.label, isDefault: true } },
        settings: sess.settings,
      },
      { upsert: true, new: true }
    );
    log.info({ chatId, wallet: w.publicKey }, 'User saved');
  } catch (err) {
    log.error({ error: err.message }, 'User save failed');
  }
}

// ─── Webhook route ─────────────────────────────────

app.post(`/bot${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200); // Respond immediately
  await handleUpdate(req.body);
});

// ─── Start ─────────────────────────────────────────

async function start() {
  log.info('🚀 Nox starting');

  app.listen(PORT, () => log.info({ port: PORT }, 'Server listening'));

  if (WEBHOOK_DOMAIN) {
    // Production: set webhook
    const url = `${WEBHOOK_DOMAIN}/bot${BOT_TOKEN}`;
    await tg('setWebhook', { url, drop_pending_updates: true });
    log.info({ url }, '✅ Webhook set — ready');
  } else {
    // Local dev: simple fetch-based polling
    log.info('Starting fetch-based polling...');

    // Flush old updates
    await tg('deleteWebhook', { drop_pending_updates: true });
    let offset = 0;

    async function poll() {
      try {
        const updates = await tg('getUpdates', { offset, limit: 10, timeout: 30 });
        if (updates?.length) {
          for (const u of updates) {
            await handleUpdate(u);
            offset = u.update_id + 1;
          }
        }
        setTimeout(poll, 100);
      } catch (err) {
        if (err?.message?.includes('Conflict') || String(err).includes('Conflict')) {
          log.warn('Another bot instance is polling. Retrying in 10s...');
          await new Promise(r => setTimeout(r, 10000));
        } else {
          log.warn({ error: err.message }, 'Poll error');
          await new Promise(r => setTimeout(r, 3000));
        }
        setTimeout(poll, 100);
      }
    }
    poll();
    log.info('✅ Polling started — ready');
  }

  const mem = process.memoryUsage();
  log.info({ heapMB: Math.round(mem.heapUsed / 1024 / 1024), rssMB: Math.round(mem.rss / 1024 / 1024) }, 'Memory at startup');
}

process.on('unhandledRejection', (err) => log.error({ error: err?.message }, 'unhandled rejection'));
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));

start().catch((err) => {
  log.fatal({ error: err.message }, 'Failed to start');
  process.exit(1);
});
