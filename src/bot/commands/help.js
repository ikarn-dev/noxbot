/**
 * commands/help.js — /help, /h
 * 
 * Full command reference with categories.
 */
'use strict';

function register(bot) {
  bot.command(['help', 'h'], async (ctx) => {
    const isAdmin = (process.env.ADMIN_USER_IDS || '').split(',')
      .map(id => parseInt(id.trim(), 10))
      .includes(ctx.from.id);

    let text =
      '📖 *Nox Commands*\n\n' +
      '*Trading*\n' +
      '`/buy <mint> [sol]` — Buy tokens\n' +
      '`/sell <mint> [%]` — Sell position\n' +
      '`/snipe <mint> [sol]` — Priority snipe\n\n' +
      '*Copy Trading*\n' +
      '`/copy <wallet>` — Copy trade a wallet\n' +
      '`/kols` — KOL leaderboard\n\n' +
      '*Portfolio*\n' +
      '`/pos` — Open positions\n' +
      '`/pnl [24h|7d|30d|all]` — PnL summary\n\n' +
      '*Settings*\n' +
      '`/set <key> <val>` — Configure bot\n' +
      '`/wallets` — Manage wallets\n' +
      '`/dryrun` — Toggle dry run\n\n' +
      '*Shortcuts*\n' +
      '`/b` = /buy, `/s` = /snipe, `/h` = /help\n';

    if (isAdmin) {
      text +=
        '\n*Admin*\n' +
        '`/stats` — Bot statistics\n' +
        '`/broadcast <msg>` — Send to all users\n';
    }

    return ctx.reply(text, { parse_mode: 'Markdown' });
  });
}

module.exports = { register };
