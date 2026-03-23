'use strict';

const logger = require('../config/logger');
const { redis } = require('../config/redis');

const THREAT_TTL = 120;
const FETCH_TIMEOUT = 8000;

async function fetchRugCheck(mint) {
  const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(process.env.RUGCHECK_API_KEY ? { Authorization: `Bearer ${process.env.RUGCHECK_API_KEY}` } : {}),
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { logger.warn({ msg: 'RugCheck error', mint, status: res.status }); return null; }
    return await res.json();
  } catch (err) {
    logger.warn({ msg: 'RugCheck fetch failed', mint, error: err.message });
    return null;
  }
}

async function fetchHoneypot(mint) {
  const buyUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=100000000&slippageBps=5000`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const buyRes = await fetch(buyUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!buyRes.ok) return { isHoneypot: false, sellTax: 0, source: 'jupiter_failed' };
    const buyQuote = await buyRes.json();

    const sellUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${buyQuote.outAmount}&slippageBps=5000`;
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), FETCH_TIMEOUT);
    const sellRes = await fetch(sellUrl, { signal: ctrl2.signal });
    clearTimeout(timer2);

    if (!sellRes.ok) return { isHoneypot: true, sellTax: 100, source: 'sell_failed' };
    const sellQuote = await sellRes.json();

    const loss = 1 - parseInt(sellQuote.outAmount, 10) / 100000000;
    return {
      isHoneypot: loss > 0.5,
      sellTax: Math.round(loss * 100),
      roundTripLossPct: Math.round(loss * 10000) / 100,
      source: 'jupiter_roundtrip',
    };
  } catch (err) {
    logger.warn({ msg: 'Honeypot check failed', mint, error: err.message });
    return null;
  }
}

function parseRugCheckData(raw) {
  if (!raw) return { score: 0, mintAuthorityRevoked: false, freezeAuthorityRevoked: false, lpLockedPct: 0, topHolderPct: 100, devHoldingsPct: 100, riskLevel: 'unknown', risks: [] };
  const score = raw.score ?? raw.tokenScore ?? 0;
  const risks = (raw.risks || raw.detectedRisks || []).map(r => typeof r === 'string' ? r : r.name || r.description);
  return {
    score: typeof score === 'number' ? score : 0,
    mintAuthorityRevoked: raw.mintAuthorityRevoked ?? raw.mintAuthority === null,
    freezeAuthorityRevoked: raw.freezeAuthorityRevoked ?? raw.freezeAuthority === null,
    lpLockedPct: raw.lpLockedPct ?? raw.liquidityLocked ?? 0,
    topHolderPct: raw.topHolderConcentration ?? raw.top10HoldersPct ?? 100,
    devHoldingsPct: raw.creatorBalance ?? raw.devHoldingsPct ?? 0,
    riskLevel: score >= 80 ? 'low' : score >= 60 ? 'medium' : score >= 40 ? 'high' : 'critical',
    risks,
  };
}

async function cacheThreatData(mint) {
  const start = Date.now();
  const [rugRaw, honeypot] = await Promise.all([fetchRugCheck(mint), fetchHoneypot(mint)]);
  const threat = parseRugCheckData(rugRaw);
  const hp = honeypot || { isHoneypot: false, sellTax: 0 };

  const agg = { ...threat, isHoneypot: hp.isHoneypot, sellTax: hp.sellTax || 0, roundTripLossPct: hp.roundTripLossPct || 0, cachedAt: Date.now(), fetchTimeMs: Date.now() - start };

  const pipe = redis.pipeline();
  pipe.set(`threat:${mint}`, JSON.stringify(agg), 'EX', THREAT_TTL);
  pipe.set(`honeypot:${mint}`, JSON.stringify(hp), 'EX', THREAT_TTL);
  pipe.set(`dev_wallet:${mint}`, JSON.stringify({ holdingsPct: threat.devHoldingsPct, cachedAt: Date.now() }), 'EX', THREAT_TTL);
  pipe.set(`holder_dist:${mint}`, JSON.stringify({ topHolderPct: threat.topHolderPct, cachedAt: Date.now() }), 'EX', THREAT_TTL);
  pipe.set(`lp_lock:${mint}`, JSON.stringify({ lockedPct: threat.lpLockedPct, mintAuthorityRevoked: threat.mintAuthorityRevoked, freezeAuthorityRevoked: threat.freezeAuthorityRevoked, cachedAt: Date.now() }), 'EX', THREAT_TTL);
  await pipe.exec();

  logger.info({ msg: 'Threat data cached', mint, score: agg.score, isHoneypot: agg.isHoneypot, fetchTimeMs: agg.fetchTimeMs });
  return agg;
}

async function getCachedThreat(mint) {
  try { const c = await redis.get(`threat:${mint}`); if (c) return JSON.parse(c); } catch (e) { logger.warn({ msg: 'Threat cache read error', error: e.message }); }
  return null;
}

async function getCachedHoneypot(mint) {
  try { const c = await redis.get(`honeypot:${mint}`); if (c) return JSON.parse(c); } catch (e) { logger.warn({ msg: 'Honeypot cache read error', error: e.message }); }
  return null;
}

module.exports = { cacheThreatData, getCachedThreat, getCachedHoneypot, fetchRugCheck, fetchHoneypot, parseRugCheckData };
