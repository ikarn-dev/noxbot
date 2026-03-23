/**
 * bot/index.js — Telegraf bot instance, middleware chain, launcher
 * 
 * Process: bot-server.js (~120MB)
 * Connects: Telegram API (webhook or polling), Redis (session + pub/sub), MongoDB
 * 
 * Middleware chain order:
 *   1. session (Redis-backed)
 *   2. auth (wallet check)
 *   3. rateLimit (10/min per user, 500/sec global)
 *   4. inputValidator (sanitise inputs)
 *   5. logging (Pino structured)
 * 
 * Per-handler middleware (not global):
 *   - callbackVerifier (HMAC on callback_data)
 *   - threatGate (trade safety)
 *   - adminGate (admin commands)
 */
'use strict';

const { Telegraf, Scenes, session } = require('telegraf');
const RedisStore = require('./session/redisStore');
const { redis, disconnectRedis } = require('../config/redis');
const { connectDB }                  = require('../config/mongo');
const log                            = require('../config/logger').child({ module: 'bot' });

// Middleware
const { authMiddleware }           = require('./middleware/auth');
const { rateLimitMiddleware }      = require('./middleware/rateLimit');
const { inputValidatorMiddleware } = require('./middleware/inputValidator');

// Commands
const buyCmd       = require('./commands/buy');
const sellCmd      = require('./commands/sell');
const snipeCmd     = require('./commands/snipe');
const copyCmd      = require('./commands/copy');
const kolsCmd      = require('./commands/kols');
const positionsCmd = require('./commands/positions');
const pnlCmd       = require('./commands/pnl');
const settingsCmd  = require('./commands/settings');
const walletsCmd   = require('./commands/wallets');
const dryrunCmd    = require('./commands/dryrun');
const helpCmd      = require('./commands/help');

// Scenes
const onboardingScene     = require('./scenes/onboarding');
const copySetupScene      = require('./scenes/copySetup');
const customAmountScene   = require('./scenes/customAmount');
const customSellScene     = require('./scenes/customSellPercent');

// Callbacks
const snipeCallback   = require('./callbacks/snipeCallback');
const exitCallback    = require('./callbacks/exitCallback');
const copyCallback    = require('./callbacks/copyCallback');
const refreshCallback = require('./callbacks/refreshCallback');

// Notifications (signal subscriber)
const { startSignalSubscriber } = require('./notifications/signalPush');

// ─── Bot Instance ──────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);

// ─── Stage (Scenes) ───────────────────────────────────
const stage = new Scenes.Stage([
  onboardingScene,
  copySetupScene,
  customAmountScene,
  customSellScene,
]);

// ─── Session Store (Redis) ─────────────────────────────
const sessionStore = new RedisStore(redis, {
  prefix: 'session:',
  ttl:    86400, // 24h
});

// ─── Middleware Chain ──────────────────────────────────
bot.use(session({ store: sessionStore }));  // #1 — Hydrate session
bot.use(authMiddleware());                   // #2 — Wallet check
bot.use(rateLimitMiddleware());              // #3 — Rate limiting
bot.use(inputValidatorMiddleware());         // #4 — Input sanitation
bot.use(stage.middleware());                 // #5 — Scene manager

// #6 — Structured logging (inline)
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

// ─── Commands ──────────────────────────────────────────
bot.start(async (ctx) => {
  // New users → onboarding; returning → welcome back
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

buyCmd.register(bot);
sellCmd.register(bot);
snipeCmd.register(bot);
copyCmd.register(bot);
kolsCmd.register(bot);
positionsCmd.register(bot);
pnlCmd.register(bot);
settingsCmd.register(bot);
walletsCmd.register(bot);
dryrunCmd.register(bot);
helpCmd.register(bot);

// ─── Callbacks ─────────────────────────────────────────
snipeCallback.register(bot);
exitCallback.register(bot);
copyCallback.register(bot);
refreshCallback.register(bot);

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

// ─── Launch ────────────────────────────────────────────
async function launch() {
  // Connect MongoDB
  await connectDB();
  log.info('MongoDB connected');

  // Start Redis signal subscriber
  startSignalSubscriber(bot);
  log.info('Signal subscriber started');

  // Webhook or polling
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
    await bot.launch();
    log.info('bot launched (long polling)');
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down...');
    bot.stop(signal);
    await disconnectRedis();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Run if executed directly
if (require.main === module) {
  launch().catch(err => {
    log.fatal({ err: err.message }, 'bot launch failed');
    process.exit(1);
  });
}

module.exports = { bot, launch };
