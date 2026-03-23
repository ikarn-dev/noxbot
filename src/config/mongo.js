'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');

/**
 * MongoDB Connection
 *
 * - Production: MongoDB Atlas M0 free tier
 * - Development: local Docker container (docker-compose.yml)
 * - Auto-reconnect via mongoose defaults
 * - Graceful shutdown on SIGINT/SIGTERM
 */

const MONGO_OPTIONS = {
  // Connection pool
  maxPoolSize: 10,
  minPoolSize: 2,
  // Timeouts
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  // Misc
  autoIndex: process.env.NODE_ENV !== 'production',
};

async function connectMongo() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/nox';

  mongoose.connection.on('connected', () => {
    logger.info({ uri: uri.replace(/\/\/.*@/, '//<redacted>@') }, 'MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(uri, MONGO_OPTIONS);
}

async function disconnectMongo() {
  logger.info('Disconnecting MongoDB…');
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}

module.exports = { connectMongo, disconnectMongo };
