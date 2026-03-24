'use strict';

/**
 * Unified Server — Zero-import boot for Node v24 compatibility
 *
 * CRITICAL: Do NOT add any require() calls above boot() that pull in
 * heavy dependencies (@solana/web3.js, mongoose models, etc.).
 * Only 'telegraf', 'dotenv', and 'pino' are safe top-level imports.
 *
 * Boot phases:
 *   Phase 1 (t=0):   Bare Telegraf + onboarding scene → bot.launch()
 *   Phase 2 (t=2s):  MongoDB + lightweight commands
 *   Phase 3 (t=5s):  Heavy commands (@solana/web3.js)
 *   Phase 4 (t=8s):  Snipe engine + API
 */

require('dotenv').config();

const { Telegraf, Scenes, session } = require('telegraf');
const log = require('./config/logger').child({ module: 'unified' });

const PORT = parseInt(process.env.PORT || process.env.API_PORT || '3099', 10);

function mem(label) {
  const m = process.memoryUsage();
  log.info({ heapMB: Math.round(m.heapUsed / 1024 / 1024), rssMB: Math.round(m.rss / 1024 / 1024) }, label);
}

// ─── Phase 1: Bare bot ───────────────────────────

async function boot() {
  log.info('🚀 Nox starting');

  const bot = new Telegraf(process.env.BOT_TOKEN);

  // Onboarding scene — safe because it lazy-imports @solana/web3.js internally
  const onboardingScene = require('./bot/scenes/onboarding');
  const stage = new Scenes.Stage([onboardingScene]);

  bot.use(session());
  bot.use(stage.middleware());

  bot.start(async (ctx) => {
    if (!ctx.session?.wallets || ctx.session.wallets.length === 0) {
      return ctx.scene.enter('onboarding');
    }
    return ctx.reply(
      `Welcome back to *Nox* ⚡\n\nActive wallet: \`${ctx.session.activeWallet?.slice(0, 8)}...\`\nUse /help for commands.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.catch((err, ctx) => {
    log.error({ err: err.message, userId: ctx.from?.id }, 'bot error');
    ctx.reply('⚠️ An error occurred. Please try again.').catch(() => {});
  });

  // Minimal health check server
  const http = require('http');
  let ready = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ready' : 'booting', uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(PORT, () => log.info(`Health check on :${PORT}`));

  // CRITICAL: Flush Telegram's polling queue BEFORE launching.
  // dropPendingUpdates only clears webhook queues, not polling.
  // After multiple restarts, hundreds of stale updates accumulate.
  log.info('Flushing Telegram update queue...');
  try {
    const updates = await bot.telegram.callApi('getUpdates', { offset: -1, limit: 1 });
    if (updates && updates.length > 0) {
      // Skip past the last update
      await bot.telegram.callApi('getUpdates', { offset: updates[0].update_id + 1, limit: 0 });
      log.info({ cleared: updates[0].update_id }, 'Update queue flushed');
    } else {
      log.info('No pending updates');
    }
  } catch (err) {
    log.warn({ error: err.message }, 'Queue flush failed (non-fatal)');
  }

  mem('Phase 1: launching bot');
  await bot.launch({ dropPendingUpdates: true });
  log.info('✅ Bot live (long polling)');
  mem('Phase 1 complete');

  // ─── Phase 2: MongoDB + light commands (t=2s) ──
  setTimeout(async () => {
    try {
      log.info('Phase 2: connecting services...');
      const { connectMongo } = require('./config/mongo');
      await connectMongo();
      log.info('MongoDB connected');

      // Additional scenes
      stage.register(require('./bot/scenes/copySetup'));
      stage.register(require('./bot/scenes/customAmount'));
      stage.register(require('./bot/scenes/customSellPercent'));

      // Lightweight commands (no @solana/web3.js)
      require('./bot/commands/help').register(bot);
      require('./bot/commands/settings').register(bot);
      require('./bot/commands/wallets').register(bot);
      require('./bot/commands/positions').register(bot);
      require('./bot/commands/pnl').register(bot);
      require('./bot/commands/kols').register(bot);
      mem('Phase 2 complete');
    } catch (err) {
      log.error({ error: err.message }, 'Phase 2 failed');
    }

    // ─── Phase 3: Heavy commands (t=5s) ──────────
    setTimeout(() => {
      try {
        log.info('Phase 3: loading trade commands...');
        require('./bot/commands/buy').register(bot);
        require('./bot/commands/sell').register(bot);
        require('./bot/commands/snipe').register(bot);
        require('./bot/commands/copy').register(bot);
        require('./bot/commands/dryrun').register(bot);

        require('./bot/callbacks/snipeCallback').register(bot);
        require('./bot/callbacks/exitCallback').register(bot);
        require('./bot/callbacks/copyCallback').register(bot);
        require('./bot/callbacks/refreshCallback').register(bot);
        mem('Phase 3 complete');
      } catch (err) {
        log.error({ error: err.message }, 'Phase 3 failed');
      }

      // ─── Phase 4: Engine + API (t=8s) ───────────
      setTimeout(async () => {
        try {
          log.info('Phase 4: starting engine...');
          const { startSignalSubscriber } = require('./bot/notifications/signalPush');
          startSignalSubscriber(bot);

          const SnipeEngine = require('./snipe-engine');
          const engine = new SnipeEngine();
          await engine.start();

          // Upgrade health server to full API
          const { app: apiApp, setReady } = require('./api/server');
          apiApp.post('/api/helius-webhook', engine.helius.routeHandler);
          server.removeAllListeners('request');
          server.on('request', apiApp);

          setReady(true);
          ready = true;
          mem('Phase 4 complete — fully ready');
          log.info({ port: PORT, pid: process.pid }, '✅ Nox fully ready');
        } catch (err) {
          log.error({ error: err.message }, 'Phase 4 failed (bot still works)');
          ready = true;
        }
      }, 3000);
    }, 3000);
  }, 2000);

  // Graceful shutdown
  const shutdown = (signal) => {
    log.info(`${signal} — shutting down`);
    bot.stop(signal);
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    log.error({ error: err?.message }, 'unhandled rejection');
  });
}

boot().catch((err) => {
  log.fatal({ error: err.message, stack: err.stack }, 'Boot failed');
  process.exit(1);
});
