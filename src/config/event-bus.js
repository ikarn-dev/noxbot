'use strict';

const { EventEmitter } = require('events');

/**
 * In-process Event Bus — replaces Redis pub/sub between PM2 processes.
 *
 * Now that everything runs in a single process, inter-module communication
 * uses a shared EventEmitter instead of Redis pub/sub channels.
 *
 * Channel mapping (old Redis → new EventEmitter):
 *   nox:signals         → 'signals'
 *   signals:broadcast   → 'signals:broadcast'
 *   nox:kol_alerts      → 'kol_alerts'
 *   nox:threat_alerts   → 'threat_alerts'
 *   nox:position_alerts → 'position_alerts'
 *   nox:trade_results   → 'trade_results'
 *
 * Zero Redis commands. Zero network latency. Zero cost.
 */

class EventBus extends EventEmitter {
  constructor() {
    super();
    // Allow many listeners (one per subscriber module)
    this.setMaxListeners(50);
  }

  /**
   * Publish a JSON message to a channel (drop-in replacement for redisPub.publish).
   * @param {string} channel
   * @param {string|object} message — string (already JSON) or object (will be serialized)
   */
  publish(channel, message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    this.emit(channel, channel, payload);
  }

  /**
   * Subscribe to a channel. The listener receives (channel, message) like Redis.
   * @param {string} channel
   * @param {function} handler — (channel: string, message: string) => void
   */
  subscribe(channel, handler) {
    this.on(channel, handler);
  }

  /**
   * Unsubscribe from a channel.
   * @param {string} channel
   * @param {function} handler
   */
  unsubscribe(channel, handler) {
    this.removeListener(channel, handler);
  }
}

// Singleton — shared across all modules
const eventBus = new EventBus();

module.exports = eventBus;
