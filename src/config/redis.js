'use strict';

const Redis = require('ioredis');
const logger = require('./logger');

/**
 * Redis Configuration — Upstash-compatible
 *
 * Single ioredis client for:
 *   - Session storage (Telegraf sessions)
 *   - Caching (threat data, dedup keys, prices)
 *   - Rate limiting
 *
 * Pub/Sub is handled by the in-process EventEmitter (see event-bus.js).
 * This saves ~2 Redis connections and thousands of pub/sub commands per day,
 * keeping us well within Upstash free tier (10K commands/day).
 *
 * Accepts REDIS_URL in Upstash format: rediss://default:xxx@xxx.upstash.io:6379
 */

function buildOptions() {
  const url = process.env.REDIS_URL;

  if (url) {
    // Upstash provides a full rediss:// URL with TLS
    return {
      ...parseRedisUrl(url),
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        const delay = Math.min(times * 500, 10_000);
        logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting');
        return delay;
      },
      lazyConnect: true,  // Don't open TLS socket until first command
    };
  }

  // Local Redis fallback (dev)
  return {
    host: 'localhost',
    port: 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting');
      return delay;
    },
    lazyConnect: true,
  };
}

/**
 * Parse a Redis URL (redis:// or rediss://) into ioredis options.
 */
function parseRedisUrl(url) {
  const parsed = new URL(url);
  const opts = {
    host: parsed.hostname,
    port: parseInt(parsed.port, 10) || 6379,
  };

  if (parsed.password) {
    opts.password = decodeURIComponent(parsed.password);
  }
  if (parsed.username && parsed.username !== 'default') {
    opts.username = parsed.username;
  }

  // Upstash uses rediss:// (TLS)
  if (parsed.protocol === 'rediss:') {
    opts.tls = {};
  }

  return opts;
}

// Single client — sessions, cache, rate limits
const client = new Redis(buildOptions());

client.on('connect', () => logger.info('Redis connected'));
client.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));

// ─── Graceful Shutdown ─────────────────────────────────
async function disconnectRedis() {
  logger.info('Disconnecting Redis…');
  await client.quit().catch(() => {});
  logger.info('Redis disconnected');
}

// ─── Backward-compatible exports ───────────────────────
// Files that import redisPub/redisSub will be migrated to event-bus.js.
// These stubs prevent import errors during the transition.
const stubPub = {
  publish: (channel, message) => {
    logger.warn({ channel }, 'redisPub.publish called — migrate to event-bus.js');
    return Promise.resolve(0);
  },
};
const stubSub = {
  subscribe: () => Promise.resolve(),
  on: () => {},
  removeListener: () => {},
};

module.exports = {
  client,
  redis: client,
  // Stubs — will be removed after all files migrate to event-bus
  subscriber: stubSub,
  publisher: stubPub,
  redisSub: stubSub,
  redisPub: stubPub,
  disconnectRedis,
};
