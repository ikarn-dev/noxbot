/**
 * session/redisStore.js — Telegraf session store backed by Redis
 * 
 * Stores full session JSON with configurable TTL.
 * Used by bot/index.js session middleware.
 */
'use strict';

class RedisStore {
  /**
   * @param {import('ioredis').Redis} redis — ioredis instance
   * @param {Object} opts
   * @param {string} [opts.prefix='session:'] — key prefix
   * @param {number} [opts.ttl=86400] — TTL in seconds
   */
  constructor(redis, opts = {}) {
    this.redis  = redis;
    this.prefix = opts.prefix || 'session:';
    this.ttl    = opts.ttl || 86400;
  }

  _key(key) {
    return `${this.prefix}${key}`;
  }

  async get(key) {
    const data = await this.redis.get(this._key(key));
    if (!data) return undefined;
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async set(key, session) {
    const data = JSON.stringify(session);
    await this.redis.set(this._key(key), data, 'EX', this.ttl);
  }

  async delete(key) {
    await this.redis.del(this._key(key));
  }
}

module.exports = RedisStore;
