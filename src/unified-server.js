'use strict';

/**
 * Unified Server — Single-process entry point for Nox bot
 *
 * Replaces the 5 PM2 processes with one process:
 *   1. Telegram Bot (Telegraf — webhook or long-polling)
 *   2. API + Dashboard SSE (Express)
 *   3. Snipe Engine (in-process, event-driven)
 *   4. Helius Webhook receiver (Express route)
 *   5. DexScreener Poller (setInterval)
 *   6. Phase-4 background scanners (setInterval)
 *
 * Total memory target: < 200MB (fits Fly.io free tier 256MB)
 */

require('dotenv').config();

const http = require('http');
const logger = require('./config/logger').child({ module: 'unified' });
const { connectMongo, disconnectMongo } = require('./config/mongo');
const { disconnectRedis } = require('./config/redis');

// Sub-systems
const { bot, launch: launchBot } = require('./bot/index');
const { app: apiApp } = require('./api/server');
const SnipeEngine = require('./snipe-engine');

const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3099', 10);

// ─── Boot ──────────────────────────────────────────

async function boot() {
  logger.info({ msg: '🚀 Nox unified server starting' });

  // 1. Connect shared services
  await connectMongo();
  logger.info({ msg: 'MongoDB connected' });

  // 2. Start the snipe engine (Helius + DexScreener event sources)
  const engine = new SnipeEngine();
  await engine.start();

  // 3. Mount Helius webhook on the API Express app
  apiApp.post('/api/helius-webhook', engine.helius.routeHandler);
  logger.info({ msg: 'Helius webhook mounted on /api/helius-webhook' });

  // 4. Start the Telegram bot
  if (process.env.WEBHOOK_DOMAIN) {
    // Webhook mode: bot registers its own webhook path on Telegram's servers.
    // We set up an Express route that Telegraf's webhookCallback returns.
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
    apiApp.use(bot.webhookCallback(webhookPath));

    // Tell Telegram about our webhook
    await bot.telegram.setWebhook(
      `${process.env.WEBHOOK_DOMAIN}${webhookPath}`,
      { secret_token: process.env.WEBHOOK_SECRET }
    );
    logger.info({ msg: 'Bot launched (webhook)', domain: process.env.WEBHOOK_DOMAIN });
  } else {
    // Long-polling mode (dev / no public URL)
    await bot.launch();
    logger.info({ msg: 'Bot launched (long polling)' });
  }

  // 5. Start HTTP server (Express handles API + webhook routes)
  const server = http.createServer(apiApp);
  server.listen(PORT, () => {
    logger.info({ msg: `HTTP server listening on :${PORT}` });
  });

  // ─── Graceful Shutdown ─────────────────────────
  const shutdown = async (signal) => {
    logger.info({ msg: `Received ${signal}, shutting down…` });

    // Stop accepting new requests
    server.close();

    // Stop sub-systems
    bot.stop(signal);
    await engine.stop();
    await disconnectRedis();
    await disconnectMongo();

    logger.info({ msg: 'Shutdown complete' });
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => {
    logger.error({ msg: 'Unhandled rejection', error: err?.message, stack: err?.stack });
  });

  logger.info({
    msg: '✅ Nox unified server ready',
    port: PORT,
    mode: process.env.WEBHOOK_DOMAIN ? 'webhook' : 'polling',
    pid: process.pid,
    memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}

boot().catch((err) => {
  logger.fatal({ msg: 'Failed to start unified server', error: err.message, stack: err.stack });
  process.exit(1);
});
