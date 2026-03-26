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
  // Auto-track sent messages for /clear
  if (method === 'sendMessage' && data.result?.message_id && body.chat_id) {
    trackMsg(body.chat_id, data.result.message_id);
  }
  return data.result;
}

async function reply(chatId, text, opts = {}) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...opts });
}

// ─── Message Tracker (for /clear) ──────────────────

const sentMsgs = new Map(); // chatId → [messageId, ...]
const MAX_TRACKED = 100;

function trackMsg(chatId, msgId) {
  if (!sentMsgs.has(chatId)) sentMsgs.set(chatId, []);
  const arr = sentMsgs.get(chatId);
  arr.push(msgId);
  if (arr.length > MAX_TRACKED) arr.shift();
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

      // Track user messages so /clear can delete them too
      if (msg.message_id) trackMsg(chatId, msg.message_id);

      // Handle scene input (private key import)
      if (sess.scene === 'awaiting_key') {
        return handleKeyImport(chatId, text, msg.message_id, sess);
      }

      // Commands
      const parts = text.split(/\s+/);
      const cmd = parts[0].split('@')[0].toLowerCase();

      if (cmd === '/start') return handleStart(chatId, sess);
      if (cmd === '/help' || cmd === '/h') return handleHelp(chatId);
      if (cmd === '/clear') return handleClear(chatId);
      if (cmd === '/clearall') return handleClearAll(chatId);
      if (cmd === '/newwallet') return handleGenerate(chatId, sess);
      if (cmd === '/importwallet') return handleImport(chatId, sess);

      // Everything below requires wallet
      if (!sess.wallets?.length) {
        return reply(chatId, '🔑 No wallet set up yet. Use /start first.');
      }

      if (cmd === '/wallets') return handleWallets(chatId, sess);
      if (cmd === '/settings' || cmd === '/set') return handleSettings(chatId, sess, parts);
      if (cmd === '/dryrun') return handleDryrun(chatId, sess, parts[1]);
      if (cmd === '/pnl') return handlePnl(chatId, msg.from.id, parts[1]);
      if (cmd === '/positions' || cmd === '/pos') return handlePositions(chatId, msg.from.id);
      if (cmd === '/kols') return handleKols(chatId);
      if (cmd === '/token') return handleToken(chatId, parts[1]);
      if (cmd === '/buy' || cmd === '/b') return handleBuy(chatId, sess, parts[1], parts[2]);
      if (cmd === '/sell') return handleSell(chatId, sess, parts[1], parts[2]);
      if (cmd === '/snipe' || cmd === '/s') return handleSnipe(chatId, sess, parts[1], parts[2]);
      if (cmd === '/copy') return handleCopy(chatId, sess, parts.slice(1));
      if (cmd === '/refresh') return handleStart(chatId, sess);

      if (cmd.startsWith('/')) {
        return reply(chatId, `Unknown command. Use /help.`);
      }
    }

    if (cb) {
      const chatId = cb.message.chat.id;
      const data = cb.data;
      const sess = getSession(chatId);

      await tg('answerCallbackQuery', { callback_query_id: cb.id });

      if (data === 'onboard_generate') return handleGenerate(chatId, sess);
      if (data === 'onboard_import') return handleImport(chatId, sess);

      const userId = cb.from.id;

      // Help menu buttons
      if (data === 'cmd_positions') return handlePositions(chatId, userId);
      if (data === 'cmd_pnl') return handlePnl(chatId, userId, '7d');
      if (data === 'cmd_wallets') return handleWallets(chatId, sess);
      if (data === 'cmd_settings') return handleSettings(chatId, sess, ['settings']);
      if (data === 'cmd_kols') return handleKols(chatId);
      if (data === 'cmd_copy') {
        if (!sess.wallets?.length) return reply(chatId, '🔑 Set up a wallet first. Use /start.');
        return handleCopy(chatId, sess, null);
      }
      if (data === 'cmd_clearall') return handleClearAll(chatId);
      if (data === 'cmd_help') return handleHelp(chatId);

      // Token card buttons — IMPORTANT: sell_pct_ must be checked BEFORE sell_ prefix
      if (data.startsWith('buy_')) return handleBuy(chatId, sess, data.slice(4));
      if (data.startsWith('snipe_')) return handleSnipe(chatId, sess, data.slice(6));
      if (data.startsWith('token_')) return handleToken(chatId, data.slice(6));

      // Sell percentage buttons: sell_pct_<mint>_<pct>
      if (data.startsWith('sell_pct_')) {
        const rest = data.slice(9);
        const lastUnderscore = rest.lastIndexOf('_');
        const mint = rest.slice(0, lastUnderscore);
        const pct = parseInt(rest.slice(lastUnderscore + 1), 10);
        return handleSellExecute(chatId, sess, mint, pct);
      }

      // Copy toggle/remove: copy_toggle_<wallet>, copy_remove_<wallet>
      if (data.startsWith('copy_toggle_')) return handleCopyToggle(chatId, data.slice(12));
      if (data.startsWith('copy_remove_')) return handleCopyRemove(chatId, data.slice(12));

      // Sell buttons — check AFTER sell_pct_ to avoid prefix collision
      if (data.startsWith('sell_')) return handleSell(chatId, sess, data.slice(5));
    }
  } catch (err) {
    log.error({ error: err.message }, 'Update handler error');
  }
}

// ─── Handlers ──────────────────────────────────────

async function handleStart(chatId, sess) {
  const hasWallets = sess.wallets?.length > 0;
  const active = sess.activeWallet || sess.wallets?.[0]?.publicKey;
  const greeting = hasWallets
    ? `🌑 *Nox* ⚡\n\nYou have ${sess.wallets.length} wallet(s).\nActive:\n\`${active}\`\n\nAdd another or manage below:`
    : '🌑 *Welcome to Nox*\n\nThe fastest Solana sniper bot.\n\nLet\'s set up your wallet:';

  const buttons = [
    [{ text: '🔑 Generate New Wallet', callback_data: 'onboard_generate' }],
    [{ text: '📥 Import Private Key', callback_data: 'onboard_import' }],
  ];
  if (hasWallets) {
    buttons.push(
      [{ text: '💼 My Wallets', callback_data: 'cmd_wallets' }],
      [{ text: '📖 Help', callback_data: 'cmd_help' }]
    );
  }

  return tg('sendMessage', {
    chat_id: chatId,
    text: greeting,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleGenerate(chatId, sess) {
  const { Keypair } = require('@solana/web3.js');
  const _bs58 = require('bs58');
  const bs58 = _bs58.default || _bs58;
  const { encryptPrivateKey } = require('./utils/wallet-crypto');

  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const secretKey = bs58.encode(keypair.secretKey);
  const encrypted = encryptPrivateKey(secretKey);

  const walletNum = (sess.wallets?.length || 0) + 1;
  const label = walletNum === 1 ? 'Main' : `Wallet ${walletNum}`;
  const wallet = { publicKey, ...encrypted, label };

  if (!sess.wallets) sess.wallets = [];
  sess.wallets.push(wallet);
  sess.activeWallet = publicKey;
  if (!sess.settings) sess.settings = defaultSettings();

  await saveWallet(chatId, wallet, sess);

  const sentMsg = await reply(chatId,
    `✅ *Wallet Generated* (${label})\n\n` +
    `Address:\n\`${publicKey}\`\n\n` +
    `🔐 *SAVE YOUR PRIVATE KEY:*\n\`${secretKey}\`\n\n` +
    '⚠️ This message will be deleted in 60 seconds.'
  );

  setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: sentMsg.message_id }).catch(() => {}), 60_000);

  await reply(chatId,
    `🎉 *${label} ready!*\n\n` +
    `You have *${sess.wallets.length}* wallet(s).\n` +
    '🧪 Dry Run mode is *ON*.\nUse `/help` for all commands.'
  );
}

async function handleImport(chatId, sess) {
  sess.scene = 'awaiting_key';
  await reply(chatId, '📥 *Import Wallet*\n\nSend your Base58 private key.\n⚠️ The message will be deleted immediately.');
}

async function handleKeyImport(chatId, keyInput, msgId, sess) {
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

    // Check for duplicate
    if (sess.wallets?.some(w => w.publicKey === publicKey)) {
      return reply(chatId, `⚠️ This wallet is already added: \`${publicKey}\``);
    }

    const walletNum = (sess.wallets?.length || 0) + 1;
    const label = walletNum === 1 ? 'Imported' : `Imported ${walletNum}`;
    const wallet = { publicKey, ...encrypted, label };

    if (!sess.wallets) sess.wallets = [];
    sess.wallets.push(wallet);
    sess.activeWallet = publicKey;
    if (!sess.settings) sess.settings = defaultSettings();

    await saveWallet(chatId, wallet, sess);

    await reply(chatId,
      `✅ *Wallet imported* (${label})\n\n` +
      `Address:\n\`${publicKey}\`\n` +
      `⚠️ Your key message was deleted.\n\n` +
      `You have *${sess.wallets.length}* wallet(s).\nUse \`/help\` for commands.`
    );
  } catch (err) {
    const hint = err.message?.includes('length') || err.message?.includes('size')
      ? ' Expected 64 bytes (88 Base58 chars).'
      : err.message?.includes('Non-base58')
        ? ' Key contains invalid characters.'
        : '';
    await reply(chatId, `❌ Invalid private key.${hint}\nSend a valid Base58 key or use /start to try again.`);
  }
}

async function handleClear(chatId) {
  const ids = sentMsgs.get(chatId) || [];
  if (!ids.length) return reply(chatId, '🧹 Nothing to clear.');

  let deleted = 0;
  // Try bulk delete first (works for messages < 48 hours old)
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) {
    chunks.push(ids.slice(i, i + 100));
  }
  for (const chunk of chunks) {
    try {
      const result = await tg('deleteMessages', { chat_id: chatId, message_ids: chunk });
      if (result) { deleted += chunk.length; continue; }
    } catch { /* bulk delete not supported, fall through to individual */ }
    // Fallback: delete individually
    for (const msgId of chunk) {
      try {
        const result = await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
        if (result) deleted++;
      } catch { /* message already deleted or too old */ }
    }
  }
  sentMsgs.set(chatId, []);

  // Send confirmation (auto-deletes after 3s)
  const confirm = await tg('sendMessage', {
    chat_id: chatId,
    text: `🧹 Cleared ${deleted} message${deleted !== 1 ? 's' : ''}.`,
  });
  if (confirm?.message_id) {
    setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: confirm.message_id }).catch(() => {}), 3000);
  }
}

async function handleClearAll(chatId) {
  const ids = sentMsgs.get(chatId) || [];
  
  let deleted = 0;
  if (ids.length) {
    // Try bulk delete first
    const chunks = [];
    for (let i = 0; i < ids.length; i += 100) {
      chunks.push(ids.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      try {
        const result = await tg('deleteMessages', { chat_id: chatId, message_ids: chunk });
        if (result) { deleted += chunk.length; continue; }
      } catch { /* fall through */ }
      for (const msgId of chunk) {
        try {
          const result = await tg('deleteMessage', { chat_id: chatId, message_id: msgId });
          if (result) deleted++;
        } catch { /* skip */ }
      }
    }
  }
  sentMsgs.set(chatId, []);

  // Send confirmation (auto-deletes after 3s)
  const confirm = await tg('sendMessage', {
    chat_id: chatId,
    text: deleted > 0
      ? `🧹 Cleared all ${deleted} message${deleted !== 1 ? 's' : ''} from chat.`
      : '🧹 Chat is already clean.',
  });
  if (confirm?.message_id) {
    setTimeout(() => tg('deleteMessage', { chat_id: chatId, message_id: confirm.message_id }).catch(() => {}), 3000);
  }
}

async function handleHelp(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text:
      '🌑 *Nox — Solana Sniper Bot*\n' +
      '━━━━━━━━━━━━━━━━━━\n\n' +

      '💰 *Trading*\n' +
      '  /buy `<mint>` — Buy a token\n' +
      '  /sell `<mint>` — Sell (with % buttons)\n' +
      '  /snipe `<mint>` — Priority snipe (Jito)\n' +
      '  /token `<mint>` — Live token details\n\n' +

      '📊 *Portfolio*\n' +
      '  /positions — Open positions\n' +
      '  /pnl `[24h|7d|30d]` — Profit & loss\n\n' +

      '🏆 *Intelligence*\n' +
      '  /kols — KOL leaderboard\n' +
      '  /copy `<wallet>` — Copy-trade a wallet\n\n' +

      '🔑 *Wallet*\n' +
      '  /wallets — View all wallets & balances\n' +
      '  /start — Setup / add wallet\n' +
      '  /newwallet — Generate new wallet\n' +
      '  /importwallet — Import private key\n\n' +

      '⚙️ *Config*\n' +
      '  /settings — View all settings\n' +
      '  /set `<key> <value>` — Change setting\n' +
      '  /dryrun — Toggle dry run\n\n' +

      '🧹 *Utility*\n' +
      '  /clear — Delete recent bot messages\n' +
      '  /clearall — Clear entire chat\n\n' +

      '━━━━━━━━━━━━━━━━━━\n' +
      '🧪 Dry Run is *ON* by default — no real SOL spent.',
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 Positions', callback_data: 'cmd_positions' },
          { text: '📈 PnL', callback_data: 'cmd_pnl' },
        ],
        [
          { text: '🏆 KOLs', callback_data: 'cmd_kols' },
          { text: '📋 Copy Trading', callback_data: 'cmd_copy' },
        ],
        [
          { text: '🔑 Wallets', callback_data: 'cmd_wallets' },
          { text: '⚙️ Settings', callback_data: 'cmd_settings' },
        ],
        [
          { text: '🧹 Clear Chat', callback_data: 'cmd_clearall' },
        ],
      ],
    },
  });
}

function defaultSettings() {
  return { slippage: 300, jitoTip: 1_000_000, snipeAmount: 0.1, autoSell: false, takeProfit: 100, stopLoss: 50, dryRun: true };
}

async function saveSettings(chatId, settings) {
  try {
    await ensureMongo();
    const User = require('./models/User');
    await User.findOneAndUpdate({ telegramId: chatId }, { settings }, { upsert: true });
  } catch (e) { log.warn({ error: e.message }, 'Settings save failed'); }
}

async function saveWallet(chatId, wallet, sess) {
  try {
    await ensureMongo();
    const User = require('./models/User');
    await User.findOneAndUpdate(
      { telegramId: chatId },
      {
        telegramId: chatId,
        $push: { wallets: { publicKey: wallet.publicKey, encryptedPrivateKey: wallet.encryptedPrivateKey, iv: wallet.iv, authTag: wallet.authTag, label: wallet.label, isDefault: true } },
        settings: sess.settings,
      },
      { upsert: true, new: true }
    );
    log.info({ chatId, wallet: wallet.publicKey }, 'Wallet saved');
  } catch (err) {
    log.error({ error: err.message }, 'Wallet save failed');
  }
}

// ─── Command Handlers ──────────────────────────────

async function handleWallets(chatId, sess) {
  const wallets = sess.wallets || [];
  const active = sess.activeWallet;

  const rows = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const isActive = w.publicKey === active;
    const label = w.label || `Wallet ${i + 1}`;
    const bal = await getSolBalance(w.publicKey);
    const balanceStr = bal > 0 ? `${bal.toFixed(4)} SOL` : '0 SOL';

    rows.push(
      `${isActive ? '✅' : '🔑'} *${label}*${isActive ? ' ✅' : ''}\n` +
      `\`${w.publicKey}\`\n` +
      `💰 Balance: \`${balanceStr}\``
    );
  }

  await reply(chatId,
    '🔑 *Your Wallets*\n━━━━━━━━━━━━━━━━━━\n\n' +
    rows.join('\n\n') +
    '\n\n_Tap the address to copy._\nUse /start to add a new wallet.'
  );
}

const SETTINGS_MAP = {
  slippage:    { key: 'slippage',    min: 50,   max: 5000,       unit: 'bps',      label: 'Slippage' },
  jitotip:     { key: 'jitoTip',     min: 1000, max: 100000000,  unit: 'lamports',  label: 'Jito Tip' },
  snipeamount: { key: 'snipeAmount', min: 0.01, max: 10,         unit: 'SOL',       label: 'Snipe Amount' },
  autosell:    { key: 'autoSell',    type: 'bool',               label: 'Auto-Sell' },
  takeprofit:  { key: 'takeProfit',  min: 10,   max: 10000,      unit: '%',         label: 'Take Profit' },
  stoploss:    { key: 'stopLoss',    min: 1,    max: 99,         unit: '%',         label: 'Stop Loss' },
  dryrun:      { key: 'dryRun',      type: 'bool',               label: 'Dry Run' },
};

async function handleSettings(chatId, sess, parts) {
  const settingKey = (parts[1] || '').toLowerCase();
  const value = parts[2] || null;

  if (!settingKey) {
    const s = sess.settings || {};
    const lines = Object.entries(SETTINGS_MAP).map(([k, cfg]) => {
      const current = s[cfg.key] ?? 'default';
      return `• *${cfg.label}*: \`${current}\`${cfg.unit ? ` ${cfg.unit}` : ''}`;
    });
    return reply(chatId, '⚙️ *Settings*\n\n' + lines.join('\n') + '\n\n`/set <key> <value>` to change.\nKeys: ' + Object.keys(SETTINGS_MAP).join(', '));
  }

  const cfg = SETTINGS_MAP[settingKey];
  if (!cfg) return reply(chatId, '❌ Unknown setting. Available: ' + Object.keys(SETTINGS_MAP).join(', '));
  if (!value) return reply(chatId, `📖 Usage: \`/set ${settingKey} <value>\``);

  if (!sess.settings) sess.settings = defaultSettings();

  if (cfg.type === 'bool') {
    sess.settings[cfg.key] = value === 'on' || value === 'true';
    await saveSettings(chatId, sess.settings);
    return reply(chatId, `✅ *${cfg.label}* set to \`${sess.settings[cfg.key] ? 'ON' : 'OFF'}\``);
  }

  const parsed = parseFloat(value);
  if (isNaN(parsed) || parsed < cfg.min || parsed > cfg.max) {
    return reply(chatId, `❌ ${cfg.label} must be ${cfg.min}–${cfg.max} ${cfg.unit}.`);
  }
  sess.settings[cfg.key] = parsed;
  await saveSettings(chatId, sess.settings);
  return reply(chatId, `✅ *${cfg.label}* set to \`${parsed} ${cfg.unit}\``);
}

async function handleDryrun(chatId, sess, arg) {
  if (!sess.settings) sess.settings = defaultSettings();
  const a = (arg || '').toLowerCase();
  if (a === 'on' || a === 'true') sess.settings.dryRun = true;
  else if (a === 'off' || a === 'false') sess.settings.dryRun = false;
  else sess.settings.dryRun = !sess.settings.dryRun;

  const on = sess.settings.dryRun;
  await reply(chatId,
    `🧪 Dry Run: *${on ? 'ON' : 'OFF'}*\n\n` +
    (on ? 'All trades will be simulated — no real SOL spent.' : '⚠️ Trades are now *LIVE* — real SOL will be used.')
  );
}

async function handlePnl(chatId, userId, period) {
  try {
    await ensureMongo();
    const Trade = require('./models/Trade');
    const periods = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6, 'all': null };
    const p = period || '7d';
    if (!periods.hasOwnProperty(p)) return reply(chatId, '📖 Usage: `/pnl [24h|7d|30d|all]`');

    const query = { telegramId: userId, status: 'filled', type: 'sell' };
    const ms = periods[p];
    if (ms) query.createdAt = { $gte: new Date(Date.now() - ms) };

    const trades = await Trade.find(query).lean();
    if (!trades.length) return reply(chatId, `📊 No completed trades in ${p}.`);

    let total = 0, wins = 0, losses = 0;
    for (const t of trades) { const pnl = t.realisedPnlSol || 0; total += pnl; pnl > 0 ? wins++ : losses++; }
    const wr = ((wins / trades.length) * 100).toFixed(1);
    const e = total >= 0 ? '🟢' : '🔴';

    await reply(chatId,
      `📊 *PnL Summary (${p})*\n\n` +
      `${e} Total: ${total >= 0 ? '+' : ''}${total.toFixed(4)} SOL\n` +
      `📈 Win Rate: ${wr}%\n✅ ${wins} | ❌ ${losses} | 📝 ${trades.length}`
    );
  } catch (err) {
    log.error({ error: err.message }, 'pnl failed');
    await reply(chatId, '⚠️ Could not calculate PnL.');
  }
}

async function handlePositions(chatId, userId) {
  try {
    await ensureMongo();
    const Trade = require('./models/Trade');
    const positions = await Trade.find({
      telegramId: userId, status: 'filled', type: 'buy', closedAt: { $exists: false },
    }).sort({ createdAt: -1 }).limit(20).lean();

    if (!positions.length) return reply(chatId, '📭 No open positions.\n\nUse /buy to open one.');

    const rows = positions.map(p => {
      const mint = p.mint?.slice(0, 8) + '...';
      const entry = p.amountSol?.toFixed(4) || '?';
      return `⚪ \`${mint}\` — ${entry} SOL`;
    });

    await reply(chatId, '📊 *Open Positions*\n\n' + rows.join('\n'));
  } catch (err) {
    log.error({ error: err.message }, 'positions failed');
    await reply(chatId, '⚠️ Could not load positions.');
  }
}

// ─── Trading Infrastructure (lazy-loaded) ──────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidMint(mint) {
  return typeof mint === 'string' && MINT_RE.test(mint);
}

async function getSolBalance(publicKey) {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [publicKey] }),
    });
    const data = await res.json();
    return (data.result?.value || 0) / 1e9; // SOL
  } catch { return 0; }
}

async function getTokenBalance(publicKey, mint) {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [publicKey, { mint }, { encoding: 'jsonParsed' }],
      }),
    });
    const data = await res.json();
    const accounts = data.result?.value || [];
    if (!accounts.length) return { balance: 0, decimals: 0, raw: 0 };
    const info = accounts[0].account.data.parsed.info;
    return {
      balance: parseFloat(info.tokenAmount.uiAmountString || '0'),
      decimals: info.tokenAmount.decimals,
      raw: parseInt(info.tokenAmount.amount, 10),
    };
  } catch { return { balance: 0, decimals: 0, raw: 0 }; }
}

function getKeypairFromSession(sess) {
  const w = sess.wallets?.find(w => w.publicKey === sess.activeWallet) || sess.wallets?.[0];
  if (!w) throw new Error('No wallet found');
  const { decryptPrivateKey } = require('./utils/wallet-crypto');
  const secretKeyBase58 = decryptPrivateKey(w);
  const _bs58 = require('bs58');
  const bs58 = _bs58.default || _bs58;
  const { Keypair } = require('@solana/web3.js');
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}

async function executeSwap(swapTransactionBase64, keypair) {
  const { VersionedTransaction } = require('@solana/web3.js');
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

  // Deserialize the Jupiter swap tx
  const txBuf = Buffer.from(swapTransactionBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Send transaction
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  const sendRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'sendTransaction',
      params: [serialized, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }],
    }),
  });
  const sendData = await sendRes.json();
  if (sendData.error) throw new Error(sendData.error.message || 'Send failed');

  return sendData.result; // transaction signature
}

// ─── On-Demand Data Fetchers ───────────────────────

async function fetchTokenFromDex(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const data = await res.json();
    if (data.pairs?.length > 0) {
      const p = data.pairs[0];
      return {
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '???',
        price: p.priceUsd || 'N/A',
        priceChange24h: p.priceChange?.h24 || 0,
        volume24h: p.volume?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        fdv: p.fdv || 0,
        pairAddress: p.pairAddress,
        dexId: p.dexId,
        url: p.url,
      };
    }
  } catch (err) {
    log.warn({ error: err.message }, 'DexScreener fetch failed');
  }
  return null;
}

async function handleKols(chatId) {
  try {
    await ensureMongo();
    const KOL = require('./models/KOL');
    const kols = await KOL.find({ tier: { $in: ['S', 'A'] } })
      .sort({ 'performance.winRate': -1 })
      .limit(15)
      .lean();

    if (!kols.length) return reply(chatId, '📊 No KOL data available yet.');

    const rows = kols.map((k, i) => {
      const medal = i < 3 ? ['🥇', '🥈', '🥉'][i] : `${i + 1}.`;
      const wr = ((k.performance?.winRate || 0) * 100).toFixed(0);
      const trades = k.performance?.totalTrades || 0;
      const pnl = (k.performance?.totalPnlSol || 0).toFixed(2);
      const addr = k.wallet.slice(0, 6) + '...' + k.wallet.slice(-4);
      return `${medal} \`${addr}\` *[${k.tier}]* WR:${wr}% T:${trades} PnL:${pnl}◎`;
    });

    await reply(chatId, '🏆 *KOL Leaderboard*\n━━━━━━━━━━━━━━━━━━\n\n' + rows.join('\n'));
  } catch (err) {
    log.error({ error: err.message }, 'kols failed');
    await reply(chatId, '⚠️ Could not load KOL leaderboard.');
  }
}

async function handleToken(chatId, mint) {
  if (!mint) return reply(chatId, '📖 Usage: `/token <mint_address>`');
  if (!isValidMint(mint)) return reply(chatId, '❌ Invalid token address. Must be a valid Solana mint (32-44 chars).');

  await reply(chatId, `🔍 Looking up \`${mint.slice(0, 8)}...\``);

  const token = await fetchTokenFromDex(mint);
  if (!token) return reply(chatId, '❌ Token not found on DexScreener.');

  const change = token.priceChange24h;
  const changeEmoji = change >= 0 ? '🟢' : '🔴';
  const liq = token.liquidity > 1000 ? `$${(token.liquidity / 1000).toFixed(1)}K` : `$${token.liquidity}`;
  const vol = token.volume24h > 1000 ? `$${(token.volume24h / 1000).toFixed(1)}K` : `$${token.volume24h}`;
  const fdv = token.fdv > 1e6 ? `$${(token.fdv / 1e6).toFixed(2)}M` : `$${(token.fdv / 1000).toFixed(1)}K`;

  await tg('sendMessage', {
    chat_id: chatId,
    text:
      `📊 *${token.name}* (${token.symbol})\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `💵 Price: \`$${token.price}\`\n` +
      `${changeEmoji} 24h: \`${change >= 0 ? '+' : ''}${change}%\`\n` +
      `📈 Volume: \`${vol}\`\n` +
      `💧 Liquidity: \`${liq}\`\n` +
      `🏷️ FDV: \`${fdv}\`\n` +
      `🔗 DEX: ${token.dexId}\n\n` +
      `\`${mint}\``,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🟢 Buy', callback_data: `buy_${mint}` },
          { text: '🎯 Snipe', callback_data: `snipe_${mint}` },
          { text: '🔴 Sell', callback_data: `sell_${mint}` },
        ],
        [
          { text: '🔗 DexScreener', url: token.url || `https://dexscreener.com/solana/${mint}` },
        ],
      ],
    },
  });
}

async function handleBuy(chatId, sess, mint, amountArg) {
  if (!mint) return reply(chatId, '📖 Usage: `/buy <mint> [amount_sol]`');
  if (!isValidMint(mint)) return reply(chatId, '❌ Invalid token address.');

  const token = await fetchTokenFromDex(mint);
  const name = token ? `${token.name} (${token.symbol})` : `\`${mint.slice(0, 8)}...\``;
  const priceInfo = token ? `\nPrice: \`$${token.price}\`` : '';
  const amount = amountArg ? parseFloat(amountArg) : (sess.settings?.snipeAmount || 0.1);
  const slippage = sess.settings?.slippage || 300;
  const wallet = sess.activeWallet || sess.wallets?.[0]?.publicKey;

  if (isNaN(amount) || amount <= 0) return reply(chatId, '❌ Invalid amount. Must be > 0 SOL.');

  // Dry run mode
  if (sess.settings?.dryRun) {
    return tg('sendMessage', {
      chat_id: chatId,
      text:
        `🧪 *DRY RUN — Buy ${name}*${priceInfo}\n\n` +
        `Amount: \`${amount} SOL\`\n` +
        `Slippage: \`${slippage} bps\`\n\n` +
        `_Use \`/dryrun off\` for live trades._`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
        ],
      },
    });
  }

  // LIVE MODE — Check balance first
  const balance = await getSolBalance(wallet);
  if (balance < 0.001) {
    return reply(chatId,
      `💸 *Wallet has no SOL*\n\n` +
      `Deposit SOL to trade:\n\`${wallet}\`\n\n` +
      `_Tap the address to copy._`
    );
  }
  const estimatedFee = 0.005; // ~5000 lamports for rent + tx fee
  if (balance < amount + estimatedFee) {
    return reply(chatId,
      `⚠️ *Insufficient SOL*\n\n` +
      `Balance: \`${balance.toFixed(4)} SOL\`\n` +
      `Needed: \`${(amount + estimatedFee).toFixed(4)} SOL\` (${amount} + fees)\n\n` +
      `Deposit more SOL:\n\`${wallet}\``
    );
  }

  // Execute via Jupiter
  await reply(chatId, `⏳ Buying ${amount} SOL of ${name}...`);

  try {
    const { prepareBuy } = require('./services/jupiterSwap');
    const amountLamports = Math.floor(amount * 1e9);
    const { swapTransaction, outAmount, priceImpactPct } = await prepareBuy({
      mint,
      amountLamports,
      wallet,
      slippageBps: slippage,
      priorityFee: sess.settings?.jitoTip || 1_000_000,
    });

    const keypair = getKeypairFromSession(sess);
    const sig = await executeSwap(swapTransaction, keypair);
    log.info({ chatId, mint, amount, sig }, 'Buy executed');

    // Record trade
    try {
      await ensureMongo();
      const Trade = require('./models/Trade');
      await Trade.create({ telegramId: chatId, type: 'buy', mint, amountSol: amount, wallet, status: 'filled', source: 'manual', signature: sig });
    } catch (e) { log.warn({ error: e.message }, 'Trade record failed'); }

    const tokensReceived = outAmount ? (parseInt(outAmount, 10) / 1e6).toFixed(4) : '?';
    const impact = priceImpactPct ? `\nPrice Impact: \`${parseFloat(priceImpactPct).toFixed(2)}%\`` : '';

    return tg('sendMessage', {
      chat_id: chatId,
      text:
        `✅ *Buy Successful!*\n\n` +
        `Token: ${name}${priceInfo}\n` +
        `Spent: \`${amount} SOL\`\n` +
        `Received: \`~${tokensReceived}\`${impact}\n\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${sig})`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔴 Sell', callback_data: `sell_${mint}` }],
          [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
        ],
      },
    });
  } catch (err) {
    log.error({ error: err.message, mint }, 'Buy failed');
    const errMsg = err.message.includes('quote failed') || err.message.includes('No route')
      ? '❌ No liquidity route found for this token.'
      : err.message.includes('insufficient') || err.message.includes('0x1')
        ? '❌ Insufficient funds or balance changed during swap.'
        : err.message.includes('blockhash')
          ? '⚠️ Network congestion — please try again.'
          : `❌ Buy failed: \`${err.message.slice(0, 100)}\``;
    return reply(chatId, errMsg);
  }
}

async function handleSell(chatId, sess, mint, pctArg) {
  if (!mint) return reply(chatId, '📖 Usage: `/sell <mint> [percent]`');
  if (!isValidMint(mint)) return reply(chatId, '❌ Invalid token address.');
  const token = await fetchTokenFromDex(mint);
  const name = token ? `${token.name} (${token.symbol})` : `\`${mint.slice(0, 8)}...\``;
  const priceInfo = token ? `\nPrice: \`$${token.price}\`` : '';
  const wallet = sess.activeWallet || sess.wallets?.[0]?.publicKey;

  // Check token balance before showing sell UI
  if (!sess.settings?.dryRun) {
    const { balance } = await getTokenBalance(wallet, mint);
    if (balance <= 0) {
      return reply(chatId,
        `📭 *No ${name} holdings*\n\n` +
        `Your wallet doesn't hold this token.\nUse /buy to purchase first.`
      );
    }
  }

  // If percent given, execute directly
  if (pctArg) {
    const pct = parseInt(pctArg, 10);
    if (isNaN(pct) || pct < 1 || pct > 100) return reply(chatId, '❌ Percent must be 1–100.');
    return handleSellExecute(chatId, sess, mint, pct);
  }

  // Show percent buttons
  await tg('sendMessage', {
    chat_id: chatId,
    text: `🔴 *Sell ${name}*${priceInfo}\n\nSelect percentage to sell:`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '25%', callback_data: `sell_pct_${mint}_25` },
          { text: '50%', callback_data: `sell_pct_${mint}_50` },
          { text: '75%', callback_data: `sell_pct_${mint}_75` },
          { text: '100%', callback_data: `sell_pct_${mint}_100` },
        ],
        [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
      ],
    },
  });
}

async function handleSellExecute(chatId, sess, mint, pct) {
  const token = await fetchTokenFromDex(mint);
  const name = token ? `${token.name} (${token.symbol})` : `\`${mint.slice(0, 8)}...\``;
  const wallet = sess.activeWallet || sess.wallets?.[0]?.publicKey;
  const slippage = sess.settings?.slippage || 300;

  if (sess.settings?.dryRun) {
    return reply(chatId, `🧪 *DRY RUN* — Would sell ${pct}% of ${name}\n\nSlippage: \`${slippage} bps\`\n\n_Use \`/dryrun off\` for live trades._`);
  }

  // LIVE MODE — Check token balance
  const { balance, raw, decimals } = await getTokenBalance(wallet, mint);
  if (balance <= 0) {
    return reply(chatId,
      `📭 *No ${name} holdings*\n\nYour wallet doesn't hold this token.`
    );
  }

  // Check SOL for fees
  const solBal = await getSolBalance(wallet);
  if (solBal < 0.003) {
    return reply(chatId,
      `⚠️ *Need SOL for gas fees*\n\n` +
      `SOL Balance: \`${solBal.toFixed(4)}\`\n` +
      `Deposit SOL:\n\`${wallet}\``
    );
  }

  const sellAmount = Math.floor(raw * pct / 100);
  if (sellAmount <= 0) return reply(chatId, '❌ Amount too small to sell.');

  await reply(chatId, `⏳ Selling ${pct}% of ${name} (${(balance * pct / 100).toFixed(4)} tokens)...`);

  try {
    const { prepareSell } = require('./services/jupiterSwap');
    const { swapTransaction, outAmount, priceImpactPct } = await prepareSell({
      mint,
      amountTokenSmallestUnit: sellAmount,
      wallet,
      slippageBps: slippage,
      priorityFee: sess.settings?.jitoTip || 1_000_000,
    });

    const keypair = getKeypairFromSession(sess);
    const sig = await executeSwap(swapTransaction, keypair);
    log.info({ chatId, mint, pct, sig }, 'Sell executed');

    // Record trade
    try {
      await ensureMongo();
      const Trade = require('./models/Trade');
      const solReceived = outAmount ? parseInt(outAmount, 10) / 1e9 : 0;
      await Trade.create({ telegramId: chatId, type: 'sell', mint, amountSol: solReceived, wallet, status: 'filled', source: 'manual', signature: sig });
    } catch (e) { log.warn({ error: e.message }, 'Trade record failed'); }

    const solReceived = outAmount ? (parseInt(outAmount, 10) / 1e9).toFixed(4) : '?';
    const impact = priceImpactPct ? `\nPrice Impact: \`${parseFloat(priceImpactPct).toFixed(2)}%\`` : '';

    return tg('sendMessage', {
      chat_id: chatId,
      text:
        `✅ *Sell Successful!*\n\n` +
        `Token: ${name}\n` +
        `Sold: \`${pct}%\` (${(balance * pct / 100).toFixed(4)} tokens)\n` +
        `Received: \`~${solReceived} SOL\`${impact}\n\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${sig})`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          pct < 100 ? [{ text: '🔴 Sell More', callback_data: `sell_${mint}` }] : [],
          [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
        ].filter(row => row.length),
      },
    });
  } catch (err) {
    log.error({ error: err.message, mint }, 'Sell failed');
    const errMsg = err.message.includes('quote failed') || err.message.includes('No route')
      ? '❌ No liquidity route found for this token.'
      : err.message.includes('insufficient') || err.message.includes('0x1')
        ? '❌ Insufficient balance — token amount may have changed.'
        : err.message.includes('blockhash')
          ? '⚠️ Network congestion — please try again.'
          : `❌ Sell failed: \`${err.message.slice(0, 100)}\``;
    return reply(chatId, errMsg);
  }
}

async function handleSnipe(chatId, sess, mint, amountArg) {
  if (!mint) return reply(chatId, '📖 *Snipe Usage*\n\n`/snipe <mint> [sol_amount]`\n`/s <mint> [sol_amount]`\n\nUses Jito private mempool for MEV-protected execution.');
  if (!isValidMint(mint)) return reply(chatId, '❌ Invalid token address.');

  const token = await fetchTokenFromDex(mint);
  const name = token ? `${token.name} (${token.symbol})` : `\`${mint.slice(0, 8)}...\``;
  const priceInfo = token ? `\nPrice: \`$${token.price}\`` : '';
  const amount = amountArg ? parseFloat(amountArg) : (sess.settings?.snipeAmount || 0.1);
  const slippage = sess.settings?.slippage || 300;
  const jitoTip = sess.settings?.jitoTip || 1_000_000;
  const wallet = sess.activeWallet || sess.wallets?.[0]?.publicKey;

  if (isNaN(amount) || amount <= 0) return reply(chatId, '❌ Invalid amount.');

  if (sess.settings?.dryRun) {
    return tg('sendMessage', {
      chat_id: chatId,
      text:
        `🧪 *DRY RUN — Snipe ${name}*${priceInfo}\n\n` +
        `🎯 Amount: \`${amount} SOL\`\n` +
        `⚡ Priority Fee: \`${jitoTip} lamports\`\n` +
        `📊 Slippage: \`${slippage} bps\`\n\n` +
        `_Use \`/dryrun off\` for live trades._`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
        ],
      },
    });
  }

  // LIVE MODE — Check balance
  const balance = await getSolBalance(wallet);
  const totalNeeded = amount + (jitoTip / 1e9) + 0.005;
  if (balance < 0.001) {
    return reply(chatId,
      `💸 *Wallet has no SOL*\n\nDeposit SOL to snipe:\n\`${wallet}\``
    );
  }
  if (balance < totalNeeded) {
    return reply(chatId,
      `⚠️ *Insufficient SOL for snipe*\n\n` +
      `Balance: \`${balance.toFixed(4)} SOL\`\n` +
      `Needed: \`~${totalNeeded.toFixed(4)} SOL\` (${amount} + priority fee + gas)\n\n` +
      `Deposit more:\n\`${wallet}\``
    );
  }

  await reply(chatId, `🎯 Sniping ${amount} SOL of ${name} with priority fee...`);

  try {
    const { prepareBuy } = require('./services/jupiterSwap');
    const amountLamports = Math.floor(amount * 1e9);
    const { swapTransaction, outAmount, priceImpactPct } = await prepareBuy({
      mint,
      amountLamports,
      wallet,
      slippageBps: slippage,
      priorityFee: jitoTip,
    });

    const keypair = getKeypairFromSession(sess);

    // Use Jito blast for MEV-protected execution (5 endpoints in parallel)
    const { VersionedTransaction } = require('@solana/web3.js');
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);
    const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

    let sig;
    try {
      const { blastJitoBundle } = require('./execution/jito-blast');
      const jitoResult = await blastJitoBundle([signedBase64]);
      sig = jitoResult.bundleId;
      log.info({ chatId, mint, amount, jitoTip, bundleId: sig, endpoint: jitoResult.endpoint, latencyMs: jitoResult.latencyMs }, 'Snipe via Jito blast');
    } catch (jitoErr) {
      // Fallback to normal RPC if Jito fails
      log.warn({ error: jitoErr.message }, 'Jito blast failed, falling back to RPC');
      sig = await executeSwap(swapTransaction, keypair);
      log.info({ chatId, mint, amount, sig }, 'Snipe via RPC fallback');
    }

    // Record trade
    try {
      await ensureMongo();
      const Trade = require('./models/Trade');
      await Trade.create({ telegramId: chatId, type: 'buy', mint, amountSol: amount, wallet, status: 'filled', source: 'snipe', signature: sig });
    } catch (e) { log.warn({ error: e.message }, 'Trade record failed'); }

    const tokensReceived = outAmount ? (parseInt(outAmount, 10) / 1e6).toFixed(4) : '?';
    const impact = priceImpactPct ? `\nPrice Impact: \`${parseFloat(priceImpactPct).toFixed(2)}%\`` : '';

    return tg('sendMessage', {
      chat_id: chatId,
      text:
        `🎯 *Snipe Successful!*\n\n` +
        `Token: ${name}${priceInfo}\n` +
        `Spent: \`${amount} SOL\`\n` +
        `Received: \`~${tokensReceived}\`\n` +
        `Priority Fee: \`${jitoTip} lamports\`${impact}\n\n` +
        `🔗 [View on Solscan](https://solscan.io/tx/${sig})`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔴 Sell', callback_data: `sell_${mint}` }],
          [{ text: '📊 Token Details', callback_data: `token_${mint}` }],
        ],
      },
    });
  } catch (err) {
    log.error({ error: err.message, mint }, 'Snipe failed');
    const errMsg = err.message.includes('quote failed') || err.message.includes('No route')
      ? '❌ No liquidity route — token may not be tradeable yet.'
      : err.message.includes('insufficient') || err.message.includes('0x1')
        ? '❌ Insufficient funds or balance changed during swap.'
        : err.message.includes('blockhash')
          ? '⚠️ Network congestion — retry the snipe.'
          : `❌ Snipe failed: \`${err.message.slice(0, 100)}\``;
    return reply(chatId, errMsg);
  }
}

async function handleCopy(chatId, sess, args) {
  if (!sess.wallets?.length) {
    return reply(chatId, '🔑 Set up a wallet first. Use /start.');
  }

  await ensureMongo();
  const User = require('./models/User');
  const user = await User.findOne({ telegramId: chatId }).lean();
  const copies = user?.copyTargets || [];

  const targetWallet = Array.isArray(args) ? args[0] : args;

  if (!targetWallet) {
    // Show current copy targets
    if (!copies.length) {
      return reply(chatId,
        '📋 *Copy Trading*\n━━━━━━━━━━━━━━━━━━\n\n' +
        'No copy targets set.\n\n' +
        '`/copy <wallet>` — Start copy trading\n' +
        '`/copy <wallet> <multiplier> <maxSol>` — Custom config\n\n' +
        '_Tip: Use /kols to find top-performing wallets._'
      );
    }

    const list = copies.map((c, i) => {
      const addr = `${c.kolWallet.slice(0, 6)}...${c.kolWallet.slice(-4)}`;
      const status = c.enabled ? '🟢 Active' : '⭕ Paused';
      return `${i + 1}. \`${addr}\` ${status}\n   ${c.multiplier || 1}x · Max: ${c.maxSol || 0.5} SOL`;
    }).join('\n');

    const buttons = copies.flatMap(c => [
      [
        { text: `${c.enabled ? '⭕ Pause' : '🟢 Enable'} ${c.kolWallet.slice(0, 6)}...`, callback_data: `copy_toggle_${c.kolWallet}` },
        { text: '🗑 Remove', callback_data: `copy_remove_${c.kolWallet}` },
      ],
    ]);
    buttons.push([{ text: '🔄 Refresh', callback_data: 'cmd_copy' }]);

    return tg('sendMessage', {
      chat_id: chatId,
      text: `📋 *Copy Targets (${copies.length})*\n━━━━━━━━━━━━━━━━━━\n\n${list}\n\n_Use \`/copy <wallet>\` to add more._`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
    });
  }

  // Add new copy target — /copy <wallet> [multiplier] [maxSol]
  const wallet = targetWallet;
  const multiplier = Array.isArray(args) && args[1] ? parseFloat(args[1]) : 1;
  const maxSol = Array.isArray(args) && args[2] ? parseFloat(args[2]) : 0.5;

  if (!isValidMint(wallet)) {
    return reply(chatId, '❌ Invalid wallet address. Must be a valid Solana address (32-44 chars).');
  }

  if (multiplier <= 0 || multiplier > 10) {
    return reply(chatId, '❌ Multiplier must be between 0.1 and 10.');
  }

  if (maxSol <= 0 || maxSol > 100) {
    return reply(chatId, '❌ Max SOL must be between 0.01 and 100.');
  }

  // Check for duplicate
  if (copies.some(c => c.kolWallet === wallet)) {
    return reply(chatId, `⚠️ Already copy-trading this wallet:\n\`${wallet}\`\n\nUse /copy to manage targets.`);
  }

  try {
    await User.findOneAndUpdate(
      { telegramId: chatId },
      { $push: { copyTargets: { kolWallet: wallet, multiplier, maxSol, enabled: true } } }
    );
    log.info({ chatId, target: wallet, multiplier, maxSol }, 'Copy target added');
    return reply(chatId,
      `✅ *Copy target added*\n\n` +
      `Wallet:\n\`${wallet}\`\n` +
      `Multiplier: \`${multiplier}x\`\n` +
      `Max per trade: \`${maxSol} SOL\`\n\n` +
      `_Copy-trading mirrors the target's buys._\n` +
      `Use \`/copy\` to manage all targets.`
    );
  } catch (err) {
    log.error({ error: err.message }, 'copy add failed');
    return reply(chatId, '⚠️ Could not add copy target.');
  }
}

async function handleCopyToggle(chatId, wallet) {
  try {
    await ensureMongo();
    const User = require('./models/User');
    const user = await User.findOne({ telegramId: chatId });
    const target = user?.copyTargets?.find(c => c.kolWallet === wallet);
    if (!target) return reply(chatId, '❌ Copy target not found.');

    target.enabled = !target.enabled;
    await user.save();

    const addr = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
    await reply(chatId, `${target.enabled ? '🟢' : '⭕'} Copy target \`${addr}\` ${target.enabled ? 'enabled' : 'paused'}.`);

    // Refresh the list
    const sess = getSession(chatId);
    return handleCopy(chatId, sess, null);
  } catch (err) {
    log.error({ error: err.message }, 'copy toggle failed');
    return reply(chatId, '⚠️ Could not update copy target.');
  }
}

async function handleCopyRemove(chatId, wallet) {
  try {
    await ensureMongo();
    const User = require('./models/User');
    await User.findOneAndUpdate(
      { telegramId: chatId },
      { $pull: { copyTargets: { kolWallet: wallet } } }
    );

    const addr = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
    await reply(chatId, `🗑 Removed copy target \`${addr}\``);

    // Refresh the list
    const sess = getSession(chatId);
    return handleCopy(chatId, sess, null);
  } catch (err) {
    log.error({ error: err.message }, 'copy remove failed');
    return reply(chatId, '⚠️ Could not remove copy target.');
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

    // Self-ping keep-alive: prevents Render free tier from sleeping
    const keepAliveUrl = `${WEBHOOK_DOMAIN}/api/health`;
    setInterval(async () => {
      try {
        await fetch(keepAliveUrl);
      } catch { /* ignore */ }
    }, 60 * 1000); // every 1 minute
    log.info('🔄 Keep-alive started (1min interval)');
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
