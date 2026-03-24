/**
 * bot/index.js — Telegraf bot instance, middleware chain, launcher
 *
 * IMPORTANT: Command/callback handlers are lazy-loaded AFTER bot.launch()
 * to avoid heavy transitive imports (@solana/web3.js, jupiterSwap, etc.)
 * at startup, which cause OOM on Node v24 due to a TLS memory leak.
 */
'use strict';

const { Telegraf, Scenes, session } = require('telegraf');
const { disconnectRedis } = require('../config/redis');
const log = require('../config/logger').child({ module: 'bot' });

// Middleware (lightweight — no heavy deps)
const { authMiddleware }           = require('./middleware/auth');
const { rateLimitMiddleware }      = require('./middleware/rateLimit');
const { inputValidatorMiddleware } = require('./middleware/inputValidator');

// Scenes (lightweight — only onboarding imports @solana/web3.js Keypair)
const onboardingScene   = require('./scenes/onboarding');
const copySetupScene    = require('./scenes/copySetup');
const customAmountScene = require('./scenes/customAmount');
const customSellScene   = require('./scenes/customSellPercent');

// ─── Bot Instance ──────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Stage (Scenes) ───────────────────────────────────
const stage = new Scenes.Stage([
  onboardingScene,
  copySetupScene,
  customAmountScene,
  customSellScene,
]);

// ─── Middleware Chain ──────────────────────────────────
bot.use(session());  // In-memory session (Node v24 TLS leak with Redis)
bot.use(authMiddleware());
bot.use(rateLimitMiddleware());
bot.use(inputValidatorMiddleware());
bot.use(stage.middleware());

// Structured logging
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  log.info({
    userId:  ctx.from?.id,
    type:    ctx.updateType,
    text:    ctx.message?.text?.slice(0, 50),
    ms,
  }, 'update processed');
});

// ─── /start command (always available) ─────────────────
bot.start(async (ctx) => {
  if (!ctx.session?.wallets || ctx.session.wallets.length === 0) {
    return ctx.scene.enter('onboarding');
  }
  return ctx.reply(
    `Welcome back to *Nox* ⚡\n\n` +
    `Active wallet: \`${ctx.session.activeWallet?.slice(0, 8)}...\`\n` +
    `Use /help for commands.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Error Handler ─────────────────────────────────────
bot.catch((err, ctx) => {
  log.error({
    err: err.message,
    stack: err.stack,
    userId: ctx.from?.id,
    updateType: ctx.updateType,
  }, 'unhandled bot error');
  ctx.reply('⚠️ An error occurred. Please try again.').catch(() => {});
});

/**
 * Register command and callback handlers.
 * Called AFTER bot.launch() to defer heavy imports.
 */
function registerHandlers() {
  log.info('Loading command handlers...');

  // Commands (these pull in @solana/web3.js, jupiterSwap, etc.)
  require('./commands/buy').register(bot);
  require('./commands/sell').register(bot);
  require('./commands/snipe').register(bot);
  require('./commands/copy').register(bot);
  require('./commands/kols').register(bot);
  require('./commands/positions').register(bot);
  require('./commands/pnl').register(bot);
  require('./commands/settings').register(bot);
  require('./commands/wallets').register(bot);
  require('./commands/dryrun').register(bot);
  require('./commands/help').register(bot);

  // Callbacks
  require('./callbacks/snipeCallback').register(bot);
  require('./callbacks/exitCallback').register(bot);
  require('./callbacks/copyCallback').register(bot);
  require('./callbacks/refreshCallback').register(bot);

  // Signal subscriber
  const { startSignalSubscriber } = require('./notifications/signalPush');
  startSignalSubscriber(bot);

  log.info('All handlers registered');
}

// ─── Standalone launch ─────────────────────────────────
async function launch() {
  if (process.env.WEBHOOK_DOMAIN) {
    const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
    await bot.launch({
      webhook: {
        domain:      process.env.WEBHOOK_DOMAIN,
        port:        parseInt(process.env.WEBHOOK_PORT) || 3000,
        hookPath:    webhookPath,
        secretToken: process.env.WEBHOOK_SECRET,
      },
    });
    log.info({ domain: process.env.WEBHOOK_DOMAIN }, 'bot launched (webhook)');
  } else {
    await bot.launch({ dropPendingUpdates: true });
    log.info('bot launched (long polling)');
  }

  registerHandlers();

  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down...');
    bot.stop(signal);
    await disconnectRedis();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  launch().catch(err => {
    log.fatal({ err: err.message }, 'bot launch failed');
    process.exit(1);
  });
}

module.exports = { bot, launch, registerHandlers };
