'use strict';

/**
 * API Server — Express + SSE for Nox Dashboard
 *
 * Endpoints:
 *   GET  /api/health          — liveness probe
 *   GET  /api/signals         — paginated signal history
 *   GET  /api/signals/live    — SSE stream (real-time signals via Redis pub/sub)
 *   GET  /api/signals/:id     — single signal by MongoDB _id
 *   GET  /api/stats           — aggregate stats (counts, avg scores)
 *   GET  /api/engine/status   — snipe-engine runtime metrics from Redis
 *
 * Auth: API_SECRET header check (simple shared secret).
 * Memory budget: ~40MB (see ecosystem.config.js)
 */

require('dotenv').config();

const express = require('express');
const { connectMongo, disconnectMongo } = require('../config/mongo');
const { redis } = require('../config/redis');
const eventBus = require('../config/event-bus');
const logger = require('../config/logger');
const Signal = require('../models/Signal');

const log = logger.child({ module: 'api-server' });

const app = express();
const PORT = process.env.API_PORT || 3099;
const API_SECRET = process.env.API_SECRET || '';

// ─── Middleware ───────────────────────────────────

app.use(express.json());

// CORS — allow dashboard origins
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

// Auth middleware — skip for /api/health and OPTIONS
function authGuard(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/api/health') return next();

  if (!API_SECRET) return next(); // No secret configured = open (dev mode)

  const provided = req.headers['x-api-secret'];
  if (provided !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(authGuard);

// ─── GET /api/health ─────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// ─── GET /api/signals ────────────────────────────

app.get('/api/signals', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    // Optional filters
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.minScore) filter.score = { $gte: parseFloat(req.query.minScore) };

    const [signals, total] = await Promise.all([
      Signal.find(filter).sort({ detectedAt: -1 }).skip(skip).limit(limit).lean(),
      Signal.countDocuments(filter),
    ]);

    res.json({
      data: signals,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    log.error({ err: err.message }, 'GET /api/signals failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/signals/live — SSE Stream ──────────

/**
 * Server-Sent Events stream.
 * Subscribes to Redis nox:signals channel and relays to the HTTP client.
 * Connection cleanup on client disconnect.
 */
app.get('/api/signals/live', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // Nginx: disable buffering
  });

  // Send initial heartbeat
  res.write('event: connected\ndata: {"status":"connected"}\n\n');

  // In-process event bus handler (replaces Redis pub/sub)
  const onSignal = (payload) => {
    res.write(`event: signal\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  eventBus.subscribe('signals:broadcast', onSignal);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 30_000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    eventBus.unsubscribe('signals:broadcast', onSignal);
    log.debug('SSE client disconnected');
  });
});

// ─── GET /api/signals/:id ────────────────────────

app.get('/api/signals/:id', async (req, res) => {
  try {
    const signal = await Signal.findById(req.params.id).lean();
    if (!signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }
    res.json({ data: signal });
  } catch (err) {
    // Invalid ObjectId format
    if (err.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid signal ID' });
    }
    log.error({ err: err.message }, 'GET /api/signals/:id failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/stats ──────────────────────────────

app.get('/api/stats', async (_req, res) => {
  try {
    const [total, byAction, avgScore] = await Promise.all([
      Signal.countDocuments(),
      Signal.aggregate([
        { $group: { _id: '$action', count: { $sum: 1 } } },
      ]),
      Signal.aggregate([
        { $group: { _id: null, avg: { $avg: '$score' } } },
      ]),
    ]);

    res.json({
      data: {
        totalSignals: total,
        avgScore: avgScore[0]?.avg ?? 0,
        byAction: Object.fromEntries(byAction.map((a) => [a._id, a.count])),
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'GET /api/stats failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/engine/status ──────────────────────

app.get('/api/engine/status', async (_req, res) => {
  try {
    // Gather runtime metrics from Redis keys set by snipe-engine
    const [
      tokensSeen,
      tokensScored,
      bundlesSent,
      lastSignalTs,
      templateCount,
    ] = await Promise.all([
      redis.get('nox:metrics:tokens_seen').then((v) => parseInt(v, 10) || 0),
      redis.get('nox:metrics:tokens_scored').then((v) => parseInt(v, 10) || 0),
      redis.get('nox:metrics:bundles_sent').then((v) => parseInt(v, 10) || 0),
      redis.get('nox:metrics:last_signal_ts').then((v) => parseInt(v, 10) || null),
      redis.keys('template:*').then((keys) => keys.length),
    ]);

    res.json({
      data: {
        tokensSeen,
        tokensScored,
        bundlesSent,
        lastSignalTs,
        cachedTemplates: templateCount,
        uptimeSeconds: Math.floor(process.uptime()),
      },
    });
  } catch (err) {
    log.error({ err: err.message }, 'GET /api/engine/status failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── 404 catch-all ───────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Error handler ───────────────────────────────

app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'Unhandled API error');
  res.status(500).json({ error: 'Internal server error' });
});

// Export Express app (mounted by unified-server.js)
module.exports = { app, authGuard };
