'use strict';

/**
 * Wallet Encryption Utility — AES-256-GCM
 *
 * Encrypts/decrypts private keys at rest using a server-side secret.
 * Uses Node.js built-in crypto module (zero dependencies).
 *
 * Key derivation: HMAC_SECRET env var (32 bytes minimum) is used as the
 * encryption key. In production, this should be rotated periodically.
 */

const crypto = require('crypto');
const logger = require('../config/logger').child({ module: 'wallet-crypto' });

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the 32-byte encryption key from env.
 * Uses HMAC_SECRET or WALLET_ENCRYPTION_KEY. Falls back to a derived key
 * from BOT_TOKEN for initial setup (not recommended for production).
 */
function getEncryptionKey() {
  const rawKey = process.env.WALLET_ENCRYPTION_KEY || process.env.HMAC_SECRET;
  if (rawKey) {
    // Derive a consistent 32-byte key via SHA-256
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  // Fallback: derive from BOT_TOKEN (better than nothing)
  const fallback = process.env.BOT_TOKEN;
  if (fallback) {
    logger.warn('Using BOT_TOKEN-derived key for wallet encryption — set WALLET_ENCRYPTION_KEY for production');
    return crypto.createHash('sha256').update(fallback).digest();
  }

  throw new Error('No encryption key available — set WALLET_ENCRYPTION_KEY or HMAC_SECRET');
}

/**
 * Encrypt a plaintext private key.
 * @param {string} plaintext — Base58-encoded private key
 * @returns {{ encryptedPrivateKey: string, iv: string, authTag: string }}
 */
function encryptPrivateKey(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encryptedPrivateKey: encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt an encrypted private key.
 * @param {{ encryptedPrivateKey: string, iv: string, authTag: string }} data
 * @returns {string} — Base58-encoded private key
 */
function decryptPrivateKey({ encryptedPrivateKey, iv, authTag }) {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encryptedPrivateKey, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encryptPrivateKey, decryptPrivateKey };
