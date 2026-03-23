'use strict';

const pino = require('pino');
const { sanitize } = require('./logSanitizer');

/**
 * Pino Structured Logger
 *
 * - Production: JSON output (for log aggregators)
 * - Development: pino-pretty for human-readable output
 * - All log output passes through logSanitizer to strip API keys/secrets
 */

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // Custom serializers to sanitize sensitive data
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  // Redact specific paths globally
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'encryptedPrivateKey',
      'twoFASecret',
      'password',
    ],
    censor: '[REDACTED]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
  // Custom hook: sanitize each log line
  hooks: {
    logMethod(inputArgs, method) {
      // Sanitize string arguments (messages)
      const sanitizedArgs = inputArgs.map((arg) => {
        if (typeof arg === 'string') {
          return sanitize(arg);
        }
        return arg;
      });
      return method.apply(this, sanitizedArgs);
    },
  },
});

module.exports = logger;
