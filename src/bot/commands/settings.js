/**
 * commands/settings.js — /set <key> <value>
 * 
 * User settings management stored in session.
 */
'use strict';

const log = require('../../config/logger').child({ module: 'cmd:settings' });

const SETTINGS_MAP = {
  slippage:    { parse: (v) => parseInt(v, 10), min: 50, max: 5000, unit: 'bps',   label: 'Slippage' },
  jitotip:     { parse: (v) => parseInt(v, 10), min: 1000, max: 100_000_000, unit: 'lamports', label: 'Jito Tip' },
  snipeamount: { parse: (v) => parseFloat(v),   min: 0.01, max: 10, unit: 'SOL',   label: 'Snipe Amount' },
  tradeamount: { parse: (v) => parseFloat(v),   min: 0.01, max: 100, unit: 'SOL',  label: 'Default Trade Amount' },
  maxtrade:    { parse: (v) => parseFloat(v),   min: 0.01, max: 100, unit: 'SOL',  label: 'Max Trade Amount' },
  buypresets:  { parse: (v) => v.split(',').map(Number).filter(n => n > 0), type: 'array', label: 'Buy Presets', unit: 'SOL' },
  autosell:    { parse: (v) => v === 'on' || v === 'true', type: 'bool', label: 'Auto-Sell' },
  takeprofit:  { parse: (v) => parseInt(v, 10), min: 10, max: 10000, unit: '%',    label: 'Take Profit' },
  stoploss:    { parse: (v) => parseInt(v, 10), min: 1, max: 99, unit: '%',        label: 'Stop Loss' },
  dryrun:      { parse: (v) => v === 'on' || v === 'true', type: 'bool', label: 'Dry Run' },
};

// Session key mapping (camelCase)
const KEY_MAP = {
  slippage:    'slippage',
  jitotip:     'jitoTip',
  snipeamount: 'snipeAmount',
  tradeamount: 'defaultTradeAmountSol',
  maxtrade:    'maxTradeAmountSol',
  buypresets:  'buyPresets',
  autosell:    'autoSell',
  takeprofit:  'takeProfit',
  stoploss:    'stopLoss',
  dryrun:      'dryRun',
};

function register(bot) {
  bot.command(['set', 'settings'], async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const key   = (parts[1] || '').toLowerCase();
    const value = parts[2] || null;

    // No args — show current settings
    if (!key) {
      const s = ctx.session?.settings || {};
      const lines = Object.entries(SETTINGS_MAP).map(([k, cfg]) => {
        const sessionKey = KEY_MAP[k];
        const current = s[sessionKey] ?? 'default';
        return `• *${cfg.label}*: \`${current}\`${cfg.unit ? ` ${cfg.unit}` : ''}`;
      });

      return ctx.reply(
        '⚙️ *Settings*\n\n' +
        lines.join('\n') +
        '\n\n`/set <key> <value>` to change.\n' +
        'Keys: ' + Object.keys(SETTINGS_MAP).join(', '),
        { parse_mode: 'Markdown' }
      );
    }

    const cfg = SETTINGS_MAP[key];
    if (!cfg) {
      return ctx.reply(`❌ Unknown setting: \`${key}\`\nAvailable: ${Object.keys(SETTINGS_MAP).join(', ')}`, { parse_mode: 'Markdown' });
    }

    if (value === null) {
      return ctx.reply(`📖 Usage: \`/set ${key} <value>\``, { parse_mode: 'Markdown' });
    }

    const parsed = cfg.parse(value);

    // Validate by type
    if (cfg.type === 'array') {
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(n => isNaN(n))) {
        return ctx.reply(`❌ ${cfg.label}: provide comma-separated numbers.\nExample: \`/set buypresets 0.1,0.25,0.5,1,2\``, { parse_mode: 'Markdown' });
      }
      if (parsed.length > 6) {
        return ctx.reply(`❌ Maximum 6 preset amounts.`);
      }
    } else if (cfg.type !== 'bool') {
      if (isNaN(parsed) || !isFinite(parsed)) {
        return ctx.reply(`❌ ${cfg.label} must be a number.`);
      }
      if (parsed < cfg.min || parsed > cfg.max) {
        return ctx.reply(`❌ ${cfg.label} must be ${cfg.min}–${cfg.max} ${cfg.unit}.`);
      }
    }

    // Update session
    if (!ctx.session.settings) ctx.session.settings = {};
    const sessionKey = KEY_MAP[key];
    ctx.session.settings[sessionKey] = parsed;

    let display;
    if (cfg.type === 'bool') display = parsed ? 'ON' : 'OFF';
    else if (cfg.type === 'array') display = parsed.join(', ') + ` ${cfg.unit}`;
    else display = `${parsed} ${cfg.unit}`;

    log.info({ userId: ctx.from.id, key, value: parsed }, 'setting updated');
    return ctx.reply(`✅ *${cfg.label}* set to \`${display}\``, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
