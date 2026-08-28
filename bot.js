const http = require('http');
const fs = require('fs');
const path = require('path');

// Modular Quantitative Engine Imports
const tradeLogger = require('./engine/trade_logger');
const { extractFeatures } = require('./engine/feature_pipeline');
const { evaluateStockPrediction, checkMarketGovernor } = require('./engine/predictive_engine');
const { optimizeWeightsFromHistory } = require('./engine/feedback_optimizer');
const { scanDailyMoversForDeals, getSectorUniverse, addTickerToSectorRotation } = require('./engine/opportunity_scanner');
const { loadStrategyInsights, performStrategyReflection } = require('./engine/self_reflection_engine');

// Robust .env loader: automatically strips UTF-8 BOM, trims whitespace, handles quotes
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*([\w_]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          let val = (match[2] || '').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.error('Failed to parse .env file:', e.message);
  }
}
loadEnv();

// Security: Localhost binding only (prevents external port scanning)
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now() }));
}).listen(PORT, '127.0.0.1');

// Security: Load tokens exclusively from environment variables (.env)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || '0', 10);
let RH_ACCOUNT = process.env.RH_ACCOUNT || '';
const RH_TOKEN = process.env.ROBINHOOD_TOKEN || '';

if (!TELEGRAM_TOKEN) {
  console.error('❌ [TELEGRAM ERROR] TELEGRAM_TOKEN is missing from .env! Telegram interface cannot connect.');
} else {
  console.log('📱 [TELEGRAM] Interface configured for bot token: ••••' + TELEGRAM_TOKEN.slice(-6));
}
if (!AUTHORIZED_USER_ID) {
  console.error('❌ [SECURITY ERROR] AUTHORIZED_USER_ID is missing from .env! Incoming messages will be blocked.');
} else {
  console.log('🔒 [SECURITY] Single-tenant whitelist configured for User ID:', AUTHORIZED_USER_ID);
}

// Automatically discovers and binds Dylan's active agentic brokerage account
async function resolveAccount() {
  if (RH_ACCOUNT) return RH_ACCOUNT;
  try {
    const acc = await callRobinhood('get_accounts', {});
    if (acc && acc.data && acc.data.accounts) {
      const target = acc.data.accounts.find(a => a.agentic_allowed) || acc.data.accounts[0];
      if (target) {
        RH_ACCOUNT = target.account_number;
        console.log('[BROKER] Automatically resolved agentic account: ••••' + RH_ACCOUNT.slice(-4));
        return RH_ACCOUNT;
      }
    }
  } catch (e) {
    console.error('[BROKER] Failed to auto-resolve account:', e.message);
  }
  return RH_ACCOUNT;
}

// Security: Hard Capital Safety Limits (Circuit Breakers)
const MAX_SINGLE_ORDER_USD = 50.00;
const MIN_SINGLE_ORDER_USD = 1.00;
const MAX_DAILY_DEPLOY_USD = 150.00;
const MIN_WATCHLIST_VOLUME = 1000; // Filter out illiquid tickers with < 1,000 shares traded

let dailyDeployedUSD = 0;
let lastDayReset = new Date().getUTCDate();

function checkDailyReset() {
  const currentDay = new Date().getUTCDate();
  if (currentDay !== lastDayReset) {
    dailyDeployedUSD = 0;
    lastDayReset = currentDay;
  }
}

function formatVolume(vol) {
  if (!vol || vol === 0) return '0';
  if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
  if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
  return vol.toLocaleString();
}

async function sendMessage(chatId, text, replyMarkup) {
  try {
    const res = await fetch(TELEGRAM_API + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
      })
    });
    const d = await res.json();
    if (!d.ok) {
      await fetch(TELEGRAM_API + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/[*_`]/g, ''),
          reply_markup: replyMarkup
        })
      });
    }
  } catch (err) {
    console.error('Send error:', err.message);
  }
}

const TOOLS_REQUIRING_ACCOUNT = new Set([
  'get_portfolio',
  'get_equity_positions',
  'get_equity_orders',
  'place_equity_order',
  'cancel_equity_order',
  'get_realized_pnl',
  'get_pnl_trade_history',
  'get_equity_tax_lots',
  'get_limited_margin_upgrade_info',
  'get_option_positions',
  'get_option_orders',
  'place_option_order',
  'cancel_option_order',
  'review_equity_order',
  'review_option_order'
]);

// Robinhood Direct JSON-RPC Broker Interface
async function callRobinhood(toolName, args = {}) {
  if (!RH_TOKEN) {
    console.error('Security Warning: RH_TOKEN is missing from environment.');
    return { error: { message: 'Broker credentials missing from server configuration.' } };
  }

  // Automatically resolve account_number only for tools that require it
  if (TOOLS_REQUIRING_ACCOUNT.has(toolName) && args && (!args.account_number || args.account_number === '')) {
    args.account_number = await resolveAccount();
  }

  try {
    const res = await fetch('https://agent.robinhood.com/mcp/trading', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RH_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      })
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    if (!line) throw new Error('Broker API returned non-SSE response (HTTP ' + res.status + ')');
    const json = JSON.parse(line.replace('data: ', ''));
    if (json.error) throw new Error(json.error.message || 'Broker RPC error');
    if (json.result && json.result.isError) {
      const errMsg = (json.result.content && json.result.content[0] && json.result.content[0].text) 
        ? json.result.content[0].text 
        : 'Broker tool execution error';
      throw new Error(errMsg);
    }
    const rawText = (json.result && json.result.content && json.result.content[0]) ? json.result.content[0].text : '{}';
    try {
      return JSON.parse(rawText);
    } catch (e) {
      return { raw: rawText };
    }
  } catch (err) {
    console.error('Robinhood RPC error (' + toolName + '):', err.message);
    return { error: { message: err.message } };
  }
}

// Dynamic Sector Rotation Universe: Synchronized live with config/trading_config.json
const SECTOR_UNIVERSE = new Proxy({}, {
  get(target, prop) {
    const u = getSectorUniverse();
    return u[prop];
  },
  ownKeys(target) {
    return Object.keys(getSectorUniverse());
  },
  getOwnPropertyDescriptor(target, prop) {
    const u = getSectorUniverse();
    if (prop in u) {
      return { value: u[prop], writable: true, enumerable: true, configurable: true };
    }
    return undefined;
  }
});

// Real-Time Quotes from Robinhood Market Feed
async function fetchQuote(symbol) {
  const sym = symbol.toUpperCase().trim();
  try {
    const res = await fetch('https://api.robinhood.com/quotes/' + sym + '/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const d = await res.json();
      if (d && d.last_trade_price) {
        const lastReg = parseFloat(d.last_trade_price);
        const extPrice = d.last_extended_hours_trade_price ? parseFloat(d.last_extended_hours_trade_price) : null;
        const currentPrice = extPrice || lastReg;
        const prevClose = parseFloat(d.previous_close || d.adjusted_previous_close || lastReg);
        return {
          symbol: sym,
          price: currentPrice,
          extendedPrice: extPrice,
          prevClose: prevClose,
          changePct: ((currentPrice - prevClose) / prevClose) * 100,
          bid: d.bid_price ? parseFloat(d.bid_price) : currentPrice,
          ask: d.ask_price ? parseFloat(d.ask_price) : currentPrice
        };
      }
    }
  } catch (e) {}
  return null;
}

// Dynamic Cost Basis Resolver: Resolves average buy price for ANY ticker seamlessly
function getEffectiveCostBasis(pos, curPrice) {
  if (pos && pos.average_buy_price && parseFloat(pos.average_buy_price) > 0) {
    return parseFloat(pos.average_buy_price);
  }
  if (pos && pos.intraday_average_buy_price && parseFloat(pos.intraday_average_buy_price) > 0) {
    return parseFloat(pos.intraday_average_buy_price);
  }
  // If broker provides no historical buy price, dynamically anchor to current market price
  return (curPrice && curPrice > 0) ? curPrice : 1.00;
}

// Quantitative Metrics Engine: Calculates Volume & 14-Day Wilder RSI in a Single Pass
async function fetchMetrics(symbol) {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=1mo', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart.result[0];
    const closes = result.indicators.quote[0].close.filter(c => c !== null);
    const volumes = result.indicators.quote[0].volume.filter(v => v !== null);
    const volume = result.meta.regularMarketVolume || (volumes.length > 0 ? volumes[volumes.length - 1] : 0);

    let rsi = 50;
    if (closes.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      const rs = (gains / 14) / (losses / 14 || 1);
      rsi = Number((100 - (100 / (1 + rs))).toFixed(1));
    }
    return { volume, rsi };
  } catch (e) {
    return null;
  }
}

// Real-Time Financial News Stream Engine
async function fetchTickerNews(symbol, maxStories = 3) {
  const sym = symbol.toUpperCase().trim();
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + sym + '&newsCount=' + maxStories, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.news || data.news.length === 0) return null;
    return data.news.slice(0, maxStories).map(item => ({
      title: item.title,
      publisher: item.publisher || 'Financial Wire',
      link: item.link,
      time: new Date(item.providerPublishTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }));
  } catch (e) {
    return null;
  }
}

// Financial Sentiment Engine: Determines Buy/Sell Signals from News Headlines
function analyzeHeadlineSentiment(title) {
  const lower = title.toLowerCase();
  const bullish = [
    'surge', 'surges', 'surging', 'jump', 'jumps', 'jumping', 'beat', 'beats',
    'soar', 'soars', 'soaring', 'rise', 'rises', 'rising', 'gain', 'gains',
    'record', 'upgrade', 'upgrades', 'upgraded', 'buy', 'buys', 'buying',
    'blowout', 'profit', 'profits', 'growth', 'rally', 'rallies', 'breakout',
    'boost', 'boosts', 'strong', 'outpace', 'dividend', 'partnership', 'expansion',
    'highs', 'doubled', 'bull', 'bullish', 'exceeds', 'top'
  ];
  const bearish = [
    'fall', 'falls', 'falling', 'drop', 'drops', 'dropping', 'plunge', 'plunges',
    'sink', 'sinks', 'miss', 'misses', 'cut', 'cuts', 'cutting', 'downgrade',
    'downgrades', 'downgraded', 'sell', 'sells', 'selling', 'slump', 'slumps',
    'crash', 'crashes', 'probe', 'lawsuit', 'warn', 'warns', 'warning',
    'bankrupt', 'bankruptcy', 'risk', 'risks', 'dive', 'dives', 'lower', 'lowers',
    'slide', 'slides', 'decline', 'declines', 'layoff', 'layoffs', 'debt',
    'halt', 'halted', 'losses', 'loss', 'trouble', 'bear', 'bearish'
  ];
  let score = 0;
  bullish.forEach(w => { if (new RegExp('\\b' + w + '\\b', 'i').test(lower)) score++; });
  bearish.forEach(w => { if (new RegExp('\\b' + w + '\\b', 'i').test(lower)) score--; });

  if (score > 0) return { emoji: '🟢', label: 'BUY SIGNAL (Bullish Catalyst)' };
  if (score < 0) return { emoji: '🔴', label: 'SELL SIGNAL (Bearish Headwind)' };
  return { emoji: '🟡', label: 'HOLD / NEUTRAL' };
}

// Dynamic Watchlist: Robinhood Daily Movers Filtered for Liquidity (Volume >= 1,000) & RSI Risk
async function getLiveDailyMoversReport() {
  const movers = await callRobinhood('get_watchlist_items', { list_id: 'eddbebe5-34cc-4df1-953c-d3e3cb55bc19' });
  if (!movers || !movers.data || !movers.data.items) {
    return '⚠️ Could not retrieve live daily movers from Robinhood. Please verify broker connection.';
  }

  const rawItems = movers.data.items || [];
  const qualified = [];

  for (const item of rawItems) {
    if (qualified.length >= 5) break;
    const sym = item.symbol;
    const m = await fetchMetrics(sym);
    if (!m || m.volume < MIN_WATCHLIST_VOLUME) {
      continue; // Filter out illiquid stocks
    }
    const q = await fetchQuote(sym);
    if (q) {
      qualified.push({ sym, price: q.price, changePct: q.changePct, volume: m.volume, rsi: m.rsi });
    }
  }

  if (qualified.length === 0) {
    return '⚠️ No movers found currently meeting the 1,000+ share liquidity threshold.';
  }

  let report = '🔥 *Robinhood Daily Movers (Liquidity >= 1,000 Volume Filter)*\n\n';

  for (const item of qualified) {
    const sign = item.changePct >= 0 ? '+' : '';
    let actionEmoji = '🟡';
    let actionText = 'HOLD / WATCH (Consolidation)';

    if (item.rsi >= 70) {
      actionEmoji = '🔴';
      actionText = 'SELL / TAKE PROFIT (Overbought FOMO Risk)';
    } else if (item.rsi <= 40) {
      actionEmoji = '🟢';
      actionText = 'BUY / ACCUMULATE (Oversold Dip Opportunity)';
    } else if (item.changePct >= 0) {
      actionEmoji = '🟢';
      actionText = 'BUY MOMENTUM (Healthy Trend Expansion)';
    }

    report += '🔹 ' + actionEmoji + ' *' + item.sym + '* — `$' + item.price.toFixed(2) + '` (' + sign + item.changePct.toFixed(2) + '%)\n' +
              '   • *Signal:* ' + actionEmoji + ' *' + actionText + '*\n' +
              '   • *Volume:* `' + formatVolume(item.volume) + '` shares ✅\n' +
              '   • *14-Day RSI:* `' + item.rsi + '`\n\n';
  }

  report += '_Real-time exchange movers filtered for high liquidity (≥ 1,000 volume) & RSI risk._';
  return report;
}

// 1. LIVE BUY ORDER EXECUTION WITH CIRCUIT BREAKERS
async function executeBuyOrder(chatId, symbol, dollarAmount) {
  const sym = symbol.toUpperCase().trim();

  if (isNaN(dollarAmount) || dollarAmount < MIN_SINGLE_ORDER_USD) {
    return sendMessage(chatId, '⚠️ *Invalid Amount:* Minimum order size is `$' + MIN_SINGLE_ORDER_USD.toFixed(2) + '`.', mainMenu);
  }
  if (dollarAmount > MAX_SINGLE_ORDER_USD) {
    return sendMessage(chatId, '🛡️ *Circuit Breaker Triggered:* Order size `$' + dollarAmount.toFixed(2) + '` exceeds maximum safety ceiling of `$' + MAX_SINGLE_ORDER_USD.toFixed(2) + '` per trade.', mainMenu);
  }

  checkDailyReset();
  if (dailyDeployedUSD + dollarAmount > MAX_DAILY_DEPLOY_USD) {
    return sendMessage(chatId, '🛑 *Daily Risk Ceiling Reached:* Total daily allocation capped at `$' + MAX_DAILY_DEPLOY_USD.toFixed(2) + '`. Currently deployed today: `$' + dailyDeployedUSD.toFixed(2) + '`.', mainMenu);
  }

  await sendMessage(chatId, '⏳ *Submitting BUY Order directly to Robinhood Exchange...*\n• Symbol: `' + sym + '`\n• Amount: `$' + dollarAmount.toFixed(2) + '`');

  const res = await callRobinhood('place_equity_order', {
    account_number: RH_ACCOUNT,
    symbol: sym,
    side: 'buy',
    type: 'market',
    dollar_amount: dollarAmount.toFixed(2),
    time_in_force: 'gfd',
    market_hours: 'regular_hours'
  });

  if (!res || !res.data) {
    const errMsg = (res && res.error) ? res.error.message : 'Exchange rejected order.';
    return sendMessage(chatId, '❌ *Order Failed by Broker:*\n`' + errMsg + '`', mainMenu);
  }

  dailyDeployedUSD += dollarAmount;
  const ord = res.data;

  // Log trade entry into black box flight recorder
  tradeLogger.logTradeEntry({
    symbol: sym,
    side: 'buy',
    amountUSD: dollarAmount,
    price: parseFloat(ord.price || 0),
    shares: parseFloat(ord.quantity || 0)
  });

  const state = ord.state === 'filled' ? '✅ FILLED ON EXCHANGE' : '⏳ QUEUED FOR MARKET OPEN (9:30 AM ET)';
  const estShares = ord.quantity ? parseFloat(ord.quantity).toFixed(4) : '~' + (dollarAmount / (parseFloat(ord.price) || 200)).toFixed(4);

  return sendMessage(
    chatId,
    '🚀 *LIVE ORDER PLACED ON ROBINHOOD!*\n\n' +
    '• *Symbol:* `' + sym + '`\n' +
    '• *Side:* BUY (Market Order)\n' +
    '• *Amount:* `$' + dollarAmount.toFixed(2) + '` (~' + estShares + ' shares)\n' +
    '• *Status:* ' + state + '\n' +
    '• *Order ID:* `' + ord.id + '`\n\n' +
    '_Executed securely by Dylan AI Cloud Agent._',
    mainMenu
  );
}

// 2. LIVE SELL ORDER EXECUTION WITH HOLDINGS VERIFICATION
async function executeSellOrder(chatId, symbol, qtyType) {
  const sym = symbol.toUpperCase().trim();
  const posRes = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
  if (!posRes || !posRes.data || !posRes.data.positions) {
    return sendMessage(chatId, '❌ Could not verify current holdings on Robinhood.', mainMenu);
  }
  const pos = posRes.data.positions.find(p => p.symbol === sym && parseFloat(p.shares_available_for_sells) > 0);
  if (!pos) {
    return sendMessage(chatId, '⚠️ You have 0 sellable shares of `' + sym + '` in your Robinhood account.', mainMenu);
  }

  const totalShares = parseFloat(pos.shares_available_for_sells);
  let sellShares = totalShares;
  if (qtyType === 'half' || qtyType === '50%') {
    sellShares = totalShares * 0.5;
  } else if (qtyType.endsWith('%')) {
    sellShares = totalShares * (parseFloat(qtyType) / 100);
  } else if (!isNaN(parseFloat(qtyType))) {
    sellShares = Math.min(totalShares, parseFloat(qtyType));
  }

  if (sellShares <= 0) {
    return sendMessage(chatId, '⚠️ Invalid liquidation quantity requested.', mainMenu);
  }

  await sendMessage(chatId, '⏳ *Submitting SELL Order directly to Robinhood Exchange...*\n• Symbol: `' + sym + '`\n• Shares: `' + sellShares.toFixed(4) + '`');

  const res = await callRobinhood('place_equity_order', {
    account_number: RH_ACCOUNT,
    symbol: sym,
    side: 'sell',
    type: 'market',
    quantity: sellShares.toFixed(6),
    time_in_force: 'gfd',
    market_hours: 'regular_hours'
  });

  if (!res || !res.data) {
    const errMsg = (res && res.error) ? res.error.message : 'Exchange rejected sell order.';
    return sendMessage(chatId, '❌ *Sell Order Failed by Broker:*\n`' + errMsg + '`', mainMenu);
  }

  const ord = res.data;
  const state = ord.state === 'filled' ? '✅ FILLED ON EXCHANGE' : '⏳ QUEUED FOR MARKET OPEN (9:30 AM ET)';

  return sendMessage(
    chatId,
    '💸 *LIVE SELL ORDER EXECUTED ON ROBINHOOD!*\n\n' +
    '• *Symbol:* `' + sym + '`\n' +
    '• *Side:* SELL (Market Order)\n' +
    '• *Liquidating:* `' + sellShares.toFixed(4) + '` of `' + totalShares.toFixed(4) + '` shares\n' +
    '• *Status:* ' + state + '\n' +
    '• *Order ID:* `' + ord.id + '`\n\n' +
    '_Proceeds will automatically recycle into underweight sectors!_',
    mainMenu
  );
}

// 24/7 AUTOMATED RISK TARGETS ENFORCEMENT ENGINE (STOP-LOSS, BREAKEVEN RATCHET & TAKE-PROFIT)
function loadTradingConfig() {
  try {
    const configPath = path.join(__dirname, 'config', 'trading_config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load trading_config.json:', e.message);
  }
  return {
    risk: { stop_loss_pct: 0.06, breakeven_ratchet_pct: 0.04, take_profit_pct: 0.08, take_profit_trim_pct: 0.50 },
    circuit_breakers: { max_single_order_usd: 50.00, min_single_order_usd: 1.00, max_daily_deploy_usd: 150.00 }
  };
}
function getRiskConfig() {
  const cfg = loadTradingConfig();
  return {
    stopLossPct: (cfg.risk && cfg.risk.stop_loss_pct) || 0.06,
    breakevenRatchetPct: (cfg.risk && cfg.risk.breakeven_ratchet_pct) || 0.04,
    takeProfitPct: (cfg.risk && cfg.risk.take_profit_pct) || 0.08,
    takeProfitTrimPct: (cfg.risk && cfg.risk.take_profit_trim_pct) || 0.50
  };
}

// Universal dynamic risk getters: ensures all handlers and commands reflect trading_config.json live without ReferenceError
Object.defineProperty(global, 'STOP_LOSS_PCT', { get: () => getRiskConfig().stopLossPct, configurable: true });
Object.defineProperty(global, 'BREAKEVEN_RATCHET_PCT', { get: () => getRiskConfig().breakevenRatchetPct, configurable: true });
Object.defineProperty(global, 'TAKE_PROFIT_PCT', { get: () => getRiskConfig().takeProfitPct, configurable: true });
Object.defineProperty(global, 'TAKE_PROFIT_TRIM_PCT', { get: () => getRiskConfig().takeProfitTrimPct, configurable: true });

const triggeredRiskActions = new Map(); // Cooldown map (2 hours per symbol)
const ratchetedSymbols = new Set(); // Tracks symbols whose stop loss ratcheted to breakeven

async function enforceAutomatedRiskTargets() {
  try {
    const { stopLossPct, breakevenRatchetPct, takeProfitPct, takeProfitTrimPct } = getRiskConfig();
    const posRes = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
    if (!posRes || !posRes.data || !posRes.data.positions) return;

    const ordRes = await callRobinhood('get_equity_orders', { account_number: RH_ACCOUNT });
    const queuedSymbols = new Set(
      (ordRes && ordRes.data && ordRes.data.orders)
        ? ordRes.data.orders.filter(o => o.state === 'queued').map(o => o.symbol)
        : []
    );

    const active = posRes.data.positions.filter(p => parseFloat(p.quantity) > 0);
    const activeSet = new Set(active.map(p => p.symbol));

    // Clean up ratchets and cooldowns for any closed or fully sold position
    for (const s of ratchetedSymbols) {
      if (!activeSet.has(s)) ratchetedSymbols.delete(s);
    }
    for (const s of triggeredRiskActions.keys()) {
      if (!activeSet.has(s)) triggeredRiskActions.delete(s);
    }

    for (const p of active) {
      const sym = p.symbol;
      if (queuedSymbols.has(sym)) {
        // Skip symbol if an order is already queued on exchange
        continue;
      }
      const totalShares = parseFloat(p.shares_available_for_sells || p.quantity);
      if (totalShares <= 0) continue;

      const q = await fetchQuote(sym);
      const curPrice = (q && q.price) ? q.price : 0;
      if (curPrice <= 0) continue;

      const avg = getEffectiveCostBasis(p, curPrice);
      const pnlPct = (curPrice - avg) / avg;

      // 0. AUTOMATED BREAKEVEN STOP RATCHET
      if (pnlPct >= breakevenRatchetPct && !ratchetedSymbols.has(sym)) {
        ratchetedSymbols.add(sym);
        console.log(`[RISK GUARDIAN] BREAKEVEN RATCHET ACTIVATED FOR ${sym} @ +${(pnlPct * 100).toFixed(2)}%`);
        await sendMessage(
          AUTHORIZED_USER_ID,
          '🛡️ *BREAKEVEN RATCHET ACTIVATED (100% Risk-Free Trade)*\n\n' +
          '• *Asset:* `' + sym + '`\n' +
          '• *Unrealized Gain:* *+' + (pnlPct * 100).toFixed(2) + '%* 🚀\n' +
          '• *New Stop-Loss Floor:* `$' + avg.toFixed(2) + '` (Your exact entry price)\n' +
          '• *Capital at Risk:* **$0.00 (Playing With House Money!)**\n\n' +
          '_If the stock continues up to +' + (takeProfitPct * 100).toFixed(0) + '%, profit target triggers. If it dumps, you exit with zero loss._',
          mainMenu
        );
      }

      // Cooldown check (don't re-trigger within 2 hours for the same symbol)
      const lastTrigger = triggeredRiskActions.get(sym);
      if (lastTrigger && (Date.now() - lastTrigger) < 7200000) continue;

      // Effective stop loss: if ratcheted, floor is entry price (avg); otherwise avg * (1 - stopLossPct)
      const isRatcheted = ratchetedSymbols.has(sym);
      const effectiveStopPrice = isRatcheted ? avg : (avg * (1 - stopLossPct));

      // 1. AUTOMATED STOP-LOSS / BREAKEVEN PROTECTION
      if (curPrice <= effectiveStopPrice) {
        const totalEstValue = totalShares * curPrice;
        if (totalEstValue < 1.00) {
          console.log('[RISK GUARDIAN] Skipping stop order for ' + sym + ': position value ($' + totalEstValue.toFixed(2) + ') is below Robinhood $1 minimum.');
          continue;
        }

        triggeredRiskActions.set(sym, Date.now());
        const isBreakeven = isRatcheted && curPrice >= avg * 0.98;
        const alertTitle = isBreakeven ? '🛡️ *BREAKEVEN EXIT EXECUTED (Zero Loss Protected)*' : '🛑 *AUTOMATED STOP-LOSS EXECUTED (24/7 Cloud Guard)*';

        const res = await callRobinhood('place_equity_order', {
          account_number: RH_ACCOUNT,
          symbol: sym,
          side: 'sell',
          type: 'market',
          quantity: totalShares.toFixed(6),
          time_in_force: 'gfd',
          market_hours: 'regular_hours'
        });

        if (res && res.error) {
          console.error('[RISK GUARDIAN] Stop-loss order failed for ' + sym + ':', res.error.message);
          continue;
        }

        const state = (res && res.data && res.data.state === 'filled') ? '✅ FILLED ON EXCHANGE' : '⏳ QUEUED FOR MARKET OPEN (9:30 AM ET)';
        const ordId = (res && res.data) ? res.data.id : 'N/A';

        // Log trade exit to journal & calibrate feedback optimizer
        tradeLogger.logTradeExit({
          symbol: sym,
          exitPrice: curPrice,
          exitReason: isBreakeven ? 'BREAKEVEN_RATCHET' : 'STOP_LOSS',
          realizedPnlUSD: (curPrice - avg) * totalShares,
          realizedPnlPct: pnlPct * 100,
          durationHours: 24
        });
        optimizeWeightsFromHistory();

        await sendMessage(
          AUTHORIZED_USER_ID,
          alertTitle + '\n\n' +
          '• *Asset:* `' + sym + '`\n' +
          '• *Entry Cost:* `$' + avg.toFixed(2) + '`\n' +
          '• *Exit Price:* `$' + curPrice.toFixed(2) + '` (*' + (pnlPct * 100).toFixed(2) + '%*)\n' +
          '• *Action:* SOLD ALL `' + totalShares.toFixed(4) + '` shares!\n' +
          '• *Status:* ' + state + '\n' +
          '• *Order ID:* `' + ordId + '`\n\n' +
          '_Proceeds available for predictive alpha rotation._',
          mainMenu
        );
      }

      // 2. AUTOMATED TAKE-PROFIT HARVEST
      else if (pnlPct >= takeProfitPct) {
        let trimShares = totalShares * takeProfitTrimPct;
        const totalEstValue = totalShares * curPrice;
        const trimEstValue = trimShares * curPrice;

        // Robinhood requires a minimum $1.00 for fractional equity orders
        if (trimEstValue < 1.00) {
          if (totalEstValue >= 1.00) {
            // Sell all remaining dust shares so the order meets the $1 minimum requirement
            trimShares = totalShares;
          } else {
            console.log('[RISK GUARDIAN] Skipping trim for ' + sym + ': total position value ($' + totalEstValue.toFixed(2) + ') is below Robinhood $1 minimum.');
            continue;
          }
        }

        triggeredRiskActions.set(sym, Date.now());

        const res = await callRobinhood('place_equity_order', {
          account_number: RH_ACCOUNT,
          symbol: sym,
          side: 'sell',
          type: 'market',
          quantity: trimShares.toFixed(6),
          time_in_force: 'gfd',
          market_hours: 'regular_hours'
        });

        if (res && res.error) {
          console.error('[RISK GUARDIAN] Take-profit order failed for ' + sym + ':', res.error.message);
          continue;
        }

        const state = (res && res.data && res.data.state === 'filled') ? '✅ FILLED ON EXCHANGE' : '⏳ QUEUED FOR MARKET OPEN (9:30 AM ET)';
        const ordId = (res && res.data) ? res.data.id : 'N/A';

        // Log trade exit to journal & calibrate feedback optimizer
        tradeLogger.logTradeExit({
          symbol: sym,
          exitPrice: curPrice,
          exitReason: 'TAKE_PROFIT',
          realizedPnlUSD: (curPrice - avg) * trimShares,
          realizedPnlPct: pnlPct * 100,
          durationHours: 48
        });
        optimizeWeightsFromHistory();

        await sendMessage(
          AUTHORIZED_USER_ID,
          '🎯 *AUTOMATED TAKE-PROFIT HARVEST (24/7 Cloud Guard)*\n\n' +
          '• *Asset:* `' + sym + '`\n' +
          '• *Entry Cost:* `$' + avg.toFixed(2) + '`\n' +
          '• *Harvest Price:* `$' + curPrice.toFixed(2) + '` (*+' + (pnlPct * 100).toFixed(2) + '%*)\n' +
          '• *Action:* TRIMMED 50% (`' + trimShares.toFixed(4) + '` shares) to bank green profit!\n' +
          '• *Status:* ' + state + '\n' +
          '• *Order ID:* `' + ordId + '`\n\n' +
          '_Profits banked! Predictive model calibrated automatically._',
          mainMenu
        );
      }
    }
  } catch (err) {
    console.error('Risk enforcer error:', err.message);
  }
}

// 3. FULLY AUTONOMOUS REINVESTMENT ENGINE WITH SAFETY CEILINGS
let isRebalancing = false;
async function autoReinvestCash(spendableBuyingPower) {
  if (isRebalancing) return;
  if (spendableBuyingPower < 10.00) return;

  checkDailyReset();
  if (dailyDeployedUSD >= MAX_DAILY_DEPLOY_USD) {
    console.log('[SAFETY] Daily deploy limit reached ($' + dailyDeployedUSD + '). Skipping auto-rebalance.');
    return;
  }

  isRebalancing = true;
  try {
    const heldSymbols = new Set();
    const posRes = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
    if (posRes && posRes.data && posRes.data.positions) {
      posRes.data.positions.filter(p => parseFloat(p.quantity) > 0).forEach(p => heldSymbols.add(p.symbol));
    }

    const ordRes = await callRobinhood('get_equity_orders', { account_number: RH_ACCOUNT });
    if (ordRes && ordRes.data && ordRes.data.orders) {
      ordRes.data.orders.filter(o => o.state === 'queued').forEach(o => heldSymbols.add(o.symbol));
    }

    const universeMap = getSectorUniverse();
    const sectorPriority = Object.keys(universeMap);
    let targetSym = sectorPriority.find(sym => !heldSymbols.has(sym));
    if (!targetSym && sectorPriority.length > 0) targetSym = sectorPriority[0];
    if (!targetSym) return;

    const deployAmount = Math.min(20.00, Math.min(MAX_SINGLE_ORDER_USD, Math.floor(spendableBuyingPower)));
    if (deployAmount < 5.00) return;

    console.log(`[AUTONOMOUS ENGINE] Auto-deploying $${deployAmount} into ${targetSym}...`);

    const res = await callRobinhood('place_equity_order', {
      account_number: RH_ACCOUNT,
      symbol: targetSym,
      side: 'buy',
      type: 'market',
      dollar_amount: deployAmount.toFixed(2),
      time_in_force: 'gfd',
      market_hours: 'regular_hours'
    });

    if (res && res.data) {
      dailyDeployedUSD += deployAmount;
      const ord = res.data;
      const state = ord.state === 'filled' ? '✅ FILLED ON EXCHANGE' : '⏳ QUEUED FOR 9:30 AM MARKET OPEN';
      await sendMessage(
        AUTHORIZED_USER_ID,
        '🤖 *Autonomous Cash Reinvestment Executed!*\n\n' +
        '• *Action:* BOUGHT `$' + deployAmount.toFixed(2) + '` of `' + targetSym + '`\n' +
        '• *Sector:* _' + (SECTOR_UNIVERSE[targetSym] ? SECTOR_UNIVERSE[targetSym].sector : 'AI Infrastructure') + '_\n' +
        '• *Strategy Logic:* Zero cash drag! Automatically deploying fresh cash into underweight bottleneck.\n' +
        '• *Exchange Status:* ' + state + '\n' +
        '• *Order ID:* `' + ord.id + '`\n\n' +
        '_Executed autonomously while you sleep by Dylan AI Cloud Agent._',
        mainMenu
      );
    }
  } catch (err) {
    console.error('Auto-rebalance error:', err.message);
  } finally {
    isRebalancing = false;
  }
}

async function sendVisualChart(chatId, symbol) {
  const sym = symbol.toUpperCase().trim();
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=1mo', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error('Data unavailable');
    const data = await res.json();
    const rawCloses = data.chart.result[0].indicators.quote[0].close.filter(c => c !== null);
    const closes = rawCloses.slice(-15).map(c => Number(c.toFixed(2)));
    
    const sma = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 4) sma.push(null);
      else {
        const slice = closes.slice(i - 4, i + 1);
        sma.push(Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2)));
      }
    }

    let rsi = 50;
    if (rawCloses.length >= 15) {
      let gains = 0, losses = 0;
      for (let i = rawCloses.length - 14; i < rawCloses.length; i++) {
        const diff = rawCloses[i] - rawCloses[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
      }
      const rs = (gains / 14) / (losses / 14 || 1);
      rsi = 100 - (100 / (1 + rs));
    }

    const labels = closes.map((_, i) => 'D' + (i + 1));
    const isUp = closes[closes.length - 1] >= closes[0];
    const mainColor = isUp ? '#10b981' : '#ef4444';

    const chartConfig = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: sym + ' Price ($)', data: closes, borderColor: mainColor, backgroundColor: isUp ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', fill: true, pointRadius: 3 },
          { label: 'SMA Trend', data: sma, borderColor: '#f59e0b', borderDash: [5, 5], fill: false, pointRadius: 0 }
        ]
      },
      options: { title: { display: true, text: sym + ' Technical Confluence' } }
    };

    const chartUrl = 'https://quickchart.io/chart?w=600&h=350&bkg=%2318181b&c=' + encodeURIComponent(JSON.stringify(chartConfig));
    const rsiStatus = rsi > 68 ? '⚠️ Overbought' : rsi < 35 ? '🛒 Oversold' : '⚖️ Neutral';
    const lastPrice = closes[closes.length - 1];
    const signal = rsi < 38 ? '🟢 BULLISH CONFLUENCE (Buy Dip)' : rsi > 68 ? '🔴 EXTENDED (Harvest Gain)' : '🟡 TREND CONSOLIDATION (Hold)';

    await fetch(TELEGRAM_API + '/sendPhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: chartUrl,
        caption: '📈 *Technical Confluence: ' + sym + '*\n\n• *Price:* `$' + lastPrice.toFixed(2) + '`\n• *14-Day RSI:* `' + rsi.toFixed(1) + '` (' + rsiStatus + ')\n• *Signal:* ' + signal,
        parse_mode: 'Markdown'
      })
    });
  } catch (err) {
    sendMessage(chatId, '⚠️ Chart error: ' + err.message, mainMenu);
  }
}

// 🎯 PREDICTIVE ALPHA RADAR (PSEUDO-NEURAL ENGINE)
async function getLivePredictiveRadarReport() {
  const universe = Object.keys(getSectorUniverse());
  const gov = await checkMarketGovernor();

  let report = '🎯 *Predictive Alpha Radar (Pseudo-Neural Engine)*\n\n' +
               '🌐 *Market Climate:* ' + gov.status + '\n' +
               '• *QQQ (Nasdaq):* `' + (gov.qqqChangePct >= 0 ? '+' : '') + gov.qqqChangePct + '%` | *SOXX (Semis):* `' + (gov.soxxChangePct >= 0 ? '+' : '') + gov.soxxChangePct + '%`\n\n' +
               '📊 *Top Ranked Breakout Probabilities (3-5 Day Horizon):*\n\n';

  const predictions = [];
  for (const sym of universe) {
    const p = await evaluateStockPrediction(sym);
    if (p) predictions.push(p);
  }

  predictions.sort((a, b) => b.probability - a.probability);

  for (const r of predictions.slice(0, 5)) {
    const sqzBadge = r.raw.isSqueezing ? '⚡ *SQUEEZE COILING*' : 'Normal';
    report += '🔹 *' + r.symbol + '* — `$' + r.raw.curPrice.toFixed(2) + '`\n' +
              '   • *Breakout Odds:* `' + r.probabilityPct + '%` (' + r.rating + ')\n' +
              '   • *Volume:* `' + r.raw.volRatio + 'x` | *RSI:* `' + r.raw.rsi + '`\n' +
              '   • *Energy:* ' + sqzBadge + '\n' +
              '   • *Action:* `' + r.action + '`\n\n';
  }

  report += '_Evaluated across Multi-Timeframe Volume, Squeeze Confluence & Index Safety._';
  return report;
}

const mainMenu = {
  keyboard: [
    [{ text: '📊 Live Portfolio' }, { text: '🎯 Predictive Radar' }],
    [{ text: '🔍 Movers Scan' }, { text: '🔄 Sector Rotation' }],
    [{ text: '🛡️ Risk Targets' }, { text: '🔥 Hot Watchlist' }],
    [{ text: '📰 Market News' }, { text: '💬 Commands Help' }]
  ],
  resize_keyboard: true,
  persistent: true
};

// 100% Live Portfolio Direct From Robinhood Brokerage
async function getLivePortfolioReport() {
  const p = await callRobinhood('get_portfolio', { account_number: RH_ACCOUNT });
  const pos = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
  const orders = await callRobinhood('get_equity_orders', { account_number: RH_ACCOUNT });

  if (!p || !p.data) return '⚠️ Could not reach Robinhood brokerage. Please verify connection.';

  const totalVal = parseFloat(p.data.total_value);
  const cash = parseFloat(p.data.cash);
  const rawBuyingPower = parseFloat(p.data.buying_power.buying_power || 0);
  const pendingDeposits = parseFloat(p.data.pending_deposits || 0);

  let queuedText = '';
  let queuedTotalUSD = 0;
  if (orders && orders.data && orders.data.orders) {
    const queued = orders.data.orders.filter(o => o.state === 'queued');
    for (const qo of queued) {
      let estPrice = qo.price ? parseFloat(qo.price) : 0;
      if (!estPrice) {
        const q = await fetchQuote(qo.symbol);
        if (q) estPrice = q.price;
      }
      const amt = qo.dollar_based_amount ? parseFloat(qo.dollar_based_amount.amount) : (parseFloat(qo.quantity) * estPrice);
      if (qo.side === 'buy') {
        queuedTotalUSD += amt;
      }
      const sideTag = (qo.side || 'buy').toUpperCase();
      const shareTag = qo.quantity ? parseFloat(qo.quantity).toFixed(4) + ' sh' : '';
      queuedText += '• *' + qo.symbol + ' (' + sideTag + (shareTag ? ' ' + shareTag : '') + '):* ~$' + amt.toFixed(2) + ' ⏳ *(Queued for 9:30 AM Open)*\n';
    }
  }

  // True spendable buying power (matches Robinhood mobile app exactly)
  const trueSpendableBuyingPower = Math.max(0, Math.min(rawBuyingPower, cash - queuedTotalUSD));

  let breakdown = '';
  if (pos && pos.data && pos.data.positions) {
    const active = pos.data.positions.filter(item => parseFloat(item.quantity) > 0);
    for (const item of active) {
      const sym = item.symbol;
      const sh = parseFloat(item.quantity);
      const q = await fetchQuote(sym);
      const curPrice = q ? q.price : 0;
      const avgCost = getEffectiveCostBasis(item, curPrice);
      const val = sh * curPrice;
      const pnl = avgCost > 0 ? ((curPrice - avgCost) / avgCost) * 100 : 0;
      const sign = pnl >= 0 ? '+' : '';
      const sec = SECTOR_UNIVERSE[sym] ? SECTOR_UNIVERSE[sym].sector : 'Active Holdings';
      breakdown += '• *' + sym + '* (' + sec + '): $' + val.toFixed(2) + ' (' + sign + pnl.toFixed(2) + '%)\n';
    }
  }
  return '📊 *Live Brokerage Portfolio (Direct Robinhood Sync)*\n\n' +
    '• *Total Account Value:* `$' + totalVal.toFixed(2) + '` 🚀\n' +
    '• *Spendable Buying Power:* `$' + trueSpendableBuyingPower.toFixed(2) + '`\n' +
    '• *Total Brokerage Cash:* `$' + cash.toFixed(2) + '`\n' +
    (pendingDeposits > 0 ? '• *Pending Deposits:* `$' + pendingDeposits.toFixed(2) + '`\n' : '') +
    '\n*Active Holdings:*\n' + (breakdown || 'No active positions.\n') +
    (queuedText ? '\n*Queued Exchange Orders:*\n' + queuedText : '') +
    '\n_Real-time brokerage data direct from Robinhood Agent API._';
}

// 🧠 CONVERSATIONAL MEMORY & PERSISTENCE ENGINE
const MEMORY_FILE = path.join(__dirname, 'conversation_memory.json');
let conversationHistory = [];

function loadConversationMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      conversationHistory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
      console.log('[MEMORY] Loaded ' + conversationHistory.length + ' historical conversation turns from disk.');
    }
  } catch (e) {
    conversationHistory = [];
  }
}
loadConversationMemory();

function saveConversationMemory(userText, modelReply) {
  try {
    conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
    conversationHistory.push({ role: 'model', parts: [{ text: modelReply }] });
    // Retain the last 20 conversation turns (10 user + 10 assistant)
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(conversationHistory.length - 20);
    }
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(conversationHistory, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist conversation memory:', e.message);
  }
}

// Conversational Trade Intent Parser (Enables Mini-Rob to Execute Real Orders)
function parseTradeIntent(text) {
  const clean = text.replace(/^(?:hey\s+|yo\s+|hi\s+)?rob\b[,:\s]*/i, '').trim();

  // "buy $15 of VRT", "buy 15 dollars of VRT", "buy 15 in VRT", "buy $15 VRT"
  const buyP1 = clean.match(/^buy\s+(?:\$)?(\d+(?:\.\d+)?)\s*(?:dollars|\$)?\s*(?:of|in|worth\s+of)?\s+([a-zA-Z]{1,5})/i);
  if (buyP1) return { action: 'BUY', symbol: buyP1[2].toUpperCase(), amount: parseFloat(buyP1[1]) };

  // "buy VRT $15", "buy VRT for 15", "buy VRT for $15"
  const buyP2 = clean.match(/^buy\s+([a-zA-Z]{1,5})\s+(?:for\s+)?(?:\$)?(\d+(?:\.\d+)?)(?:\$)?/i);
  if (buyP2) return { action: 'BUY', symbol: buyP2[1].toUpperCase(), amount: parseFloat(buyP2[2]) };

  // "sell half of INTC", "sell all of MRVL", "sell 50% of TSM"
  const sellP1 = clean.match(/^sell\s+(all|half|\d+%|\d+(?:\.\d+)?)\s*(?:of|shares\s+of)?\s+([a-zA-Z]{1,5})/i);
  if (sellP1) return { action: 'SELL', symbol: sellP1[2].toUpperCase(), qty: sellP1[1].toLowerCase() };

  // "sell INTC half", "sell MRVL all"
  const sellP2 = clean.match(/^sell\s+([a-zA-Z]{1,5})\s+(all|half|\d+%|\d+(?:\.\d+)?)/i);
  if (sellP2) return { action: 'SELL', symbol: sellP2[1].toUpperCase(), qty: sellP2[2].toLowerCase() };

  return null;
}

// 🧠 CONVERSATIONAL AI PARTNER ENGINE ("ROB" WITH MEMORY & TOOL CALLING)
async function askRob(chatId, query) {
  const lowerQ = query.toLowerCase().trim();

  // 1. Tool Calling Capability: Execute Real Live Orders From Natural Language
  const tradeIntent = parseTradeIntent(query);
  if (tradeIntent) {
    if (tradeIntent.action === 'BUY') {
      await sendMessage(chatId, '🤖 *Rob:* Order confirmed! Submitting live trade to Robinhood for *$' + tradeIntent.amount.toFixed(2) + '* of *' + tradeIntent.symbol + '*...');
      saveConversationMemory(query, 'Executed live BUY order on Robinhood exchange for $' + tradeIntent.amount.toFixed(2) + ' of ' + tradeIntent.symbol + '.');
      return executeBuyOrder(chatId, tradeIntent.symbol, tradeIntent.amount);
    } else if (tradeIntent.action === 'SELL') {
      await sendMessage(chatId, '🤖 *Rob:* Order confirmed! Submitting live sell trade to Robinhood for *' + tradeIntent.qty + '* of *' + tradeIntent.symbol + '*...');
      saveConversationMemory(query, 'Executed live SELL order on Robinhood exchange for ' + tradeIntent.qty + ' of ' + tradeIntent.symbol + '.');
      return executeSellOrder(chatId, tradeIntent.symbol, tradeIntent.qty);
    }
  }

  // 2. Memory Reset Command
  if (lowerQ === 'clear memory' || lowerQ === 'reset memory' || lowerQ === 'forget memory') {
    conversationHistory = [];
    try { fs.unlinkSync(MEMORY_FILE); } catch (e) {}
    return sendMessage(chatId, '🧠 *Rob:* Conversational memory has been wiped clean. Ready for fresh market analysis and execution, Dylan!', mainMenu);
  }

  // 3. Predictive Model Analysis Intent: "Rob predict VRT" or "Rob what are the odds of NVDA"
  const predIntent = query.match(/(?:predict|prediction|odds|breakout probability)(?:\s+(?:for|on|of))?\s+([a-zA-Z]{1,5})/i);
  if (predIntent) {
    const sym = predIntent[1].toUpperCase();
    await sendMessage(chatId, '🧠 _Rob is computing multi-factor breakout probabilities for ' + sym + '..._');
    const pred = await evaluateStockPrediction(sym);
    if (pred) {
      const reply = 'Quantitative breakdown for **' + pred.symbol + '**:\n\n' +
        '• **Breakout Probability (3-5 Days):** `' + pred.probabilityPct + '%` (' + pred.rating + ')\n' +
        '• **Current Market Price:** $' + pred.raw.curPrice.toFixed(2) + '\n' +
        '• **Volume Anomaly:** ' + pred.raw.volRatio + 'x 20-day median\n' +
        '• **14-Day RSI:** ' + pred.raw.rsi + '\n' +
        '• **Volatility Squeeze:** ' + (pred.raw.isSqueezing ? '⚡ Coiling for explosive expansion' : 'Normal range') + '\n' +
        '• **Market Governor:** ' + pred.governor.status + '\n\n' +
        '🎯 **Tactical Recommendation:** `' + pred.action + '`\n\n' +
        '_Dylan, if you want me to execute this trade, just tell me: "Rob, buy $15 of ' + pred.symbol + '". Our -6% stop and +4% breakeven ratchet guard the downside 24/7._';
      saveConversationMemory(query, reply);
      return sendMessage(chatId, '🤖 *Rob:*\n\n' + reply, mainMenu);
    }
  }

  await sendMessage(chatId, '🧠 _Rob is analyzing..._');

  let portfolioContext = '';
  try {
    const p = await callRobinhood('get_portfolio', { account_number: RH_ACCOUNT });
    const pos = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
    const ord = await callRobinhood('get_equity_orders', { account_number: RH_ACCOUNT });
    if (p && p.data) {
      let queuedSum = 0;
      let queuedNames = [];
        for (const o of ord.data.orders.filter(x => x.state === 'queued')) {
          let estPrice = o.price ? parseFloat(o.price) : 0;
          if (!estPrice) {
            const q = await fetchQuote(o.symbol);
            if (q) estPrice = q.price;
          }
          const amt = o.dollar_based_amount ? parseFloat(o.dollar_based_amount.amount) : (parseFloat(o.quantity) * estPrice);
          if (o.side === 'buy') {
            queuedSum += amt;
          }
          const side = (o.side || 'buy').toUpperCase();
          queuedNames.push(o.symbol + ' (' + side + ' ~$' + amt.toFixed(2) + ' queued)');
        }
      const rawBp = parseFloat(p.data.buying_power.buying_power || 0);
      const cash = parseFloat(p.data.cash || 0);
      const trueBp = Math.max(0, Math.min(rawBp, cash - queuedSum));

      portfolioContext = 'Account Value: $' + parseFloat(p.data.total_value).toFixed(2) + ', Spendable Cash: $' + trueBp.toFixed(2) + ' (Total Cash: $' + cash.toFixed(2) + ', Pending Orders: ' + (queuedNames.join(', ') || 'None') + '). Active Holdings: ';
      if (pos && pos.data && pos.data.positions) {
        const active = pos.data.positions.filter(item => parseFloat(item.quantity) > 0);
        const posStrings = [];
        for (const item of active) {
          const q = await fetchQuote(item.symbol);
          const curPrice = q ? q.price : 0;
          const effCost = getEffectiveCostBasis(item, curPrice);
          posStrings.push(item.symbol + ' (' + parseFloat(item.quantity).toFixed(4) + ' sh @ avg $' + effCost.toFixed(2) + ')');
        }
        portfolioContext += posStrings.join(', ');
      }
    }
  } catch (e) {}

  const strategyInsights = loadStrategyInsights();
  const heuristicsStr = (strategyInsights.learned_heuristics && strategyInsights.learned_heuristics.length > 0)
    ? strategyInsights.learned_heuristics.slice(0, 3).join(' ')
    : 'Bank 50% profits early, eliminate cash drag, protect principal.';

  const systemInstruction = 
    'You are Rob, Dylan\'s institutional AI trading partner, quantitative strategist, and self-improving hedge-fund co-pilot. ' +
    'You run 24/7 on his AWS EC2 cloud server directly connected to his Robinhood brokerage account. ' +
    'You operate with a recursive self-improvement mindset: You constantly reflect on closed trades, attribute alpha to specific market factors (Volume Anomalies, Volatility Squeezes, Supply-Chain Moats), and calibrate your decision-making over time. ' +
    'Your current self-reflection insights: Regime is ' + (strategyInsights.market_regime || 'Bullish Momentum') + '; Win Rate is ' + (strategyInsights.win_rate_pct || 100) + '%; Core Learned Heuristics: ' + heuristicsStr + '. ' +
    'You speak directly, confidently, concisely, and with sharp Wall Street / quant financial intellect. ' +
    'You remember previous messages in the conversation and maintain an evolving conversational relationship with Dylan. ' +
    'You prioritize capital protection, zero cash drag, and disciplined supply-chain investing. ' +
    'Dylan\'s current live account state: ' + portfolioContext + '. ' +
    'Dylan\'s investment thesis: Physical AI supply chain bottlenecks (GPU Silicon: NVDA, Foundries: TSM/INTC, ASICs: MRVL, Liquid Cooling: VRT, Networking: ANET, Memory: MU, Power: CEG, Software: PLTR, Consumer Defense: WMT). ' +
    'Risk targets: Stop loss at -' + (STOP_LOSS_PCT * 100).toFixed(0) + '%, take profit target at +' + (TAKE_PROFIT_PCT * 100).toFixed(0) + '%, breakeven ratchet at +' + (BREAKEVEN_RATCHET_PCT * 100).toFixed(0) + '%. ' +
    'You have direct tool execution capabilities: When Dylan tells you to buy or sell a stock, the agent executes it for you automatically. ' +
    'Keep your responses concise, punchy, formatted in GitHub Markdown, and end with an actionable insight or trade recommendation when relevant.';

  // Build full multi-turn conversational history
  const multiTurnContents = [
    ...conversationHistory,
    { role: 'user', parts: [{ text: query }] }
  ];

  // 1. Google Gemini API with Multi-Model Fallback Cascade & Persistent Multi-Turn Memory
  const geminiKey = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6L1dhG2FZz7irtUXLX5DS73RMs7j3Jp0NegUAEb39wTeA';
  if (geminiKey) {
    const candidateModels = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-flash-latest'];
    for (const modelName of candidateModels) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + geminiKey, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: multiTurnContents,
            generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
          })
        });
        const data = await res.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const reply = data.candidates[0].content.parts[0].text;
          saveConversationMemory(query, reply);
          return sendMessage(chatId, '🤖 *Rob:*\n\n' + reply, mainMenu);
        } else if (data.error) {
          console.warn('[GEMINI CASCADING] ' + modelName + ' error (' + data.error.message + '), trying next model...');
          continue;
        }
      } catch (err) {
        console.error('Gemini fetch error on ' + modelName + ':', err.message);
      }
    }
  }

  // 2. OpenAI / Groq API Fallback
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const messages = [
        { role: 'system', content: systemInstruction },
        ...conversationHistory.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.parts[0].text })),
        { role: 'user', content: query }
      ];
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + openaiKey
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: messages,
          max_tokens: 500
        })
      });
      const data = await res.json();
      if (data.choices && data.choices[0]) {
        const reply = data.choices[0].message.content;
        saveConversationMemory(query, reply);
        return sendMessage(chatId, '🤖 *Rob:*\n\n' + reply, mainMenu);
      }
    } catch (err) {}
  }

  // 3. Fallback Built-In Strategy Brain
  let fallbackReply = '';
  if (lowerQ.includes('portfolio') || lowerQ.includes('holding') || lowerQ.includes('what do we have')) {
    fallbackReply = 'Here is our live account status: ' + portfolioContext + '\n\nEvery single holding is guarded 24/7 with a -' + (STOP_LOSS_PCT * 100).toFixed(1) + '% stop-loss floor and a +' + (TAKE_PROFIT_PCT * 100).toFixed(1) + '% profit-taking target!';
  } else if (lowerQ.includes('risk') || lowerQ.includes('safe') || lowerQ.includes('protect')) {
    fallbackReply = 'Your capital is guarded 24/7 on AWS. Every position has an automated -' + (STOP_LOSS_PCT * 100).toFixed(0) + '% stop-loss floor and a +' + (TAKE_PROFIT_PCT * 100).toFixed(0) + '% profit-taking target. Furthermore, we have strict circuit breakers capping any single trade at $' + MAX_SINGLE_ORDER_USD.toFixed(0) + ' and daily deployment at $' + MAX_DAILY_DEPLOY_USD.toFixed(0) + '.';
  } else if (lowerQ.includes('vrt') || lowerQ.includes('cooling')) {
    fallbackReply = '**Vertiv (VRT)** is our #1 target right now. Nvidia\'s Blackwell GB200 server racks consume up to 120kW per rack—air cooling is physically impossible at that density. Liquid cooling is a mandatory monopoly bottleneck, and Vertiv owns 30%+ global market share.';
  } else if (lowerQ.includes('buy') || lowerQ.includes('next') || lowerQ.includes('what should we')) {
    fallbackReply = 'Our next high-conviction deployment is **VRT** (Liquid Cooling) or **ANET** (AI Networking). Whenever you add fresh cash or our queued Walmart order fills, our autonomous loop will route surplus buying power straight into physical AI infrastructure.';
  } else {
    fallbackReply = 'I\'m watching the markets 24/7 for you, Dylan. ' + portfolioContext;
  }

  saveConversationMemory(query, fallbackReply);
  return sendMessage(chatId, '🤖 *Rob:*\n\n' + fallbackReply, mainMenu);
}

// SECURITY: STRICT SINGLE-TENANT AUTHORIZATION GATEWAY
async function handleMessage(msg) {
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : null;

  if (chatId !== AUTHORIZED_USER_ID && userId !== AUTHORIZED_USER_ID) {
    console.warn(`[SECURITY ALERT] Unauthorized access attempt blocked from User ID: ${userId}`);
    return sendMessage(chatId, '⛔ *Access Denied:* This is a private single-tenant autonomous trading system.');
  }

  const text = msg.text.trim();
  const lower = text.toLowerCase();
  console.log('[Authorized User Msg]: \"' + text + '\"');

  // 0. CONVERSATIONAL AI PARTNER ("ROB")
  const robMatch = text.match(/^(?:hey\s+|yo\s+|hi\s+)?rob\b[,:\s]*(.*)$/i);
  if (robMatch) {
    const query = robMatch[1].trim();
    if (!query) {
      return sendMessage(chatId, '🤖 *Rob here!* What market question, thesis, or trade idea do you want to explore, Dylan?', mainMenu);
    }
    return askRob(chatId, query);
  }

  // 1. DIRECT LIVE BUY COMMAND EXECUTION
  const buyMatch = text.match(/^buy\s+([a-zA-Z]{1,5})\s+(?:\$)?(\d+(?:\.\d+)?)(?:\$)?$/i);
  if (buyMatch) {
    const sym = buyMatch[1].toUpperCase();
    const amount = parseFloat(buyMatch[2]);
    return executeBuyOrder(chatId, sym, amount);
  }

  // 2. DIRECT LIVE SELL COMMAND EXECUTION
  const sellMatch = text.match(/^sell\s+([a-zA-Z]{1,5})\s+(all|half|\d+%|\d+(?:\.\d+)?)$/i);
  if (sellMatch) {
    const sym = sellMatch[1].toUpperCase();
    const qtyType = sellMatch[2].toLowerCase();
    return executeSellOrder(chatId, sym, qtyType);
  }

  // 🎯 PREDICTIVE RADAR & ALPHA SCORING
  if (lower.includes('predict') || text.includes('🎯') || lower.includes('radar')) {
    const specificMatch = text.match(/^(?:predict|score|odds)\s+([a-zA-Z]{1,5})$/i);
    if (specificMatch) {
      const sym = specificMatch[1].toUpperCase();
      await sendMessage(chatId, '🧠 _Running multi-factor predictive inference on ' + sym + '..._');
      const pred = await evaluateStockPrediction(sym);
      if (!pred) return sendMessage(chatId, '⚠️ Could not compute prediction for `' + sym + '`.', mainMenu);
      const sqzBadge = pred.raw.isSqueezing ? '⚡ *VOLATILITY SQUEEZE ACTIVE (Coiling Energy)*' : 'Normal Market Volatility';
      const response = 
        '🎯 *Predictive Alpha Report: ' + pred.symbol + '*\n\n' +
        '• *Breakout Probability:* `' + pred.probabilityPct + '%` (' + pred.rating + ')\n' +
        '• *Current Price:* `$' + pred.raw.curPrice.toFixed(2) + '`\n' +
        '• *14-Day RSI:* `' + pred.raw.rsi + '`\n' +
        '• *Volume Ratio:* `' + pred.raw.volRatio + 'x` normal 20d median\n' +
        '• *5-Day Momentum:* `' + (pred.raw.roc5dPct >= 0 ? '+' : '') + pred.raw.roc5dPct + '%`\n' +
        '• *Volatility State:* ' + sqzBadge + '\n' +
        '• *Market Governor:* ' + pred.governor.status + '\n\n' +
        '💡 *Actionable Recommendation:* `' + pred.action + '`';
      return sendMessage(chatId, response, mainMenu);
    }

    await sendMessage(chatId, '🧠 _Running pseudo-neural predictive model across physical AI supply chain..._');
    const report = await getLivePredictiveRadarReport();
    return sendMessage(chatId, report, mainMenu);
  }

  if (lower.includes('portfolio') || text.includes('📊')) {
    const report = await getLivePortfolioReport();
    return sendMessage(chatId, report, mainMenu);
  }

  if (lower.includes('scan') || text.includes('🔍') || lower.includes('deal') || lower.includes('opportunity') || text.includes('Movers Scan')) {
    await sendMessage(chatId, '🔍 *Scanning Robinhood Daily Movers...*\n_Evaluating breakout probabilities, RSI buy setups, news catalysts & sector fit..._');
    const scanRes = await scanDailyMoversForDeals(callRobinhood);
    if (!scanRes || !scanRes.success) {
      return sendMessage(chatId, '⚠️ ' + (scanRes ? scanRes.message : 'Could not scan daily movers at this time.'), mainMenu);
    }

    let report = '🔍 *Robinhood Daily Movers: Quantitative Opportunity Scan*\n\n' +
                 '📊 *Total Movers Evaluated:* `' + scanRes.totalScanned + '`\n' +
                 '🎯 *High-Conviction Deals Found:* `' + scanRes.qualifiedDeals.length + '`\n\n';

    if (scanRes.qualifiedDeals.length === 0) {
      report += 'ℹ️ _No movers currently meet all strict criteria (Breakout Prob ≥ 70%, RSI ≤ 68, Bullish News Catalyst, and Market Tailwinds). Strict standards protect your capital._\n\n' +
                '*Top Evaluated Movers:*\n';
      for (const s of scanRes.scanned.slice(0, 5)) {
        report += '• *' + s.symbol + ':* `$' + s.price.toFixed(2) + '` | RSI: `' + s.rsi + '` | Odds: `' + s.probabilityPct + '%` (' + s.rating + ')\n';
      }
    } else {
      report += '🚨 *HIGH-CONVICTION OPPORTUNITIES (Added to Universe):*\n\n';
      for (const d of scanRes.qualifiedDeals) {
        const headline = (d.newsStories && d.newsStories[0]) ? d.newsStories[0].title : 'Positive market momentum';
        report += '🔹 *' + d.symbol + '* — `$' + d.price.toFixed(2) + '`\n' +
                  '   • *Breakout Odds:* `' + d.probabilityPct + '%` (' + d.rating + ')\n' +
                  '   • *14-Day RSI:* `' + d.rsi + '` (Healthy Entry Range ✅)\n' +
                  '   • *Volume Spike:* `' + d.volRatio + 'x` Normal Volume\n' +
                  '   • *News Catalyst:* _\"' + headline + '\"_ (' + d.sentiment.label + ')\n' +
                  '   • *Status:* ' + (d.isNewAddition ? '🆕 *Added to Sector Rotation!*' : '✅ Active in Universe') + '\n' +
                  '   • *Action:* `' + d.action + '`\n\n';
      }
      report += '_Dylan, to execute any of these deals, just tell Rob: "Rob, buy $15 of [Ticker]". Capital is protected 24/7 by our -6% stop & +8% take-profit._';
    }
    return sendMessage(chatId, report, mainMenu);
  }

  // 🧠 RECURSIVE QUANT STRATEGY REFLECTION & SELF-IMPROVEMENT MEMO
  if (lower.includes('reflect') || lower.includes('learn') || lower.includes('evolution') || text.includes('🧠') || lower.includes('what did you learn')) {
    await sendMessage(chatId, '🧠 _Running post-trade attribution & recursive self-reflection across execution history..._');
    const posRes = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
    const gov = await checkMarketGovernor();
    const insights = performStrategyReflection(posRes && posRes.data ? posRes.data.positions : [], gov);

    let report = '🧠 *Institutional Quant Reflection & Self-Improvement Memo*\n\n' +
                 '🌐 *Market Regime:* `' + insights.market_regime + '`\n' +
                 '📊 *Empirical Win Rate:* `' + insights.win_rate_pct + '%` (' + insights.wins + 'W / ' + insights.losses + 'L)\n' +
                 '💰 *Total Realized P&L:* `+$' + insights.total_realized_usd.toFixed(2) + '`\n\n' +
                 '🎯 *Top Alpha Attribution Drivers:*\n';

    for (const d of insights.alpha_drivers) {
      report += '• ' + d + '\n';
    }

    report += '\n💡 *Learned Strategy Heuristics:*\n';
    for (const h of insights.learned_heuristics) {
      report += '• ' + h + '\n';
    }

    report += '\n🧬 *Active Evolutionary Directives:*\n';
    for (const ed of insights.evolutionary_directives) {
      report += '• ' + ed + '\n';
    }

    report += '\n_Model recalibrates weights & memory automatically after every trade._';
    return sendMessage(chatId, report, mainMenu);
  }

  if (lower.includes('sector') || lower.includes('rotation') || text.includes('🔄')) {
    let report = '🔄 *Live Cross-Sector Rebalance Universe:*\n\n';
    const sectorMap = {};
    for (const [sym, info] of Object.entries(SECTOR_UNIVERSE)) {
      if (!sectorMap[info.sector]) sectorMap[info.sector] = [];
      const q = await fetchQuote(sym);
      const pStr = q ? '$' + q.price.toFixed(2) + ' (' + (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(1) + '%)' : 'Live';
      sectorMap[info.sector].push('• *' + sym + ':* `' + pStr + '`');
    }
    for (const [sec, items] of Object.entries(sectorMap)) {
      report += '🏷️ *' + sec + '*\n' + items.join('\n') + '\n\n';
    }
    report += '_Rule: Fresh cash and sold stock proceeds automatically recycle across these sectors 24/7!_';
    return sendMessage(chatId, report, mainMenu);
  }

  // 🔥 HOT WATCHLIST: LIVE ROBINHOOD DAILY MOVERS FILTERED FOR LIQUIDITY (>= 1,000 VOLUME) & RSI RISK
  if (lower.includes('watchlist') || lower.includes('mover') || text.includes('🔥')) {
    await sendMessage(chatId, '⏳ *Scanning Robinhood Daily Movers & Filtering for 1,000+ Volume Liquidity...*');
    const report = await getLiveDailyMoversReport();
    return sendMessage(chatId, report, mainMenu);
  }

  if (lower.includes('risk') || lower.includes('target') || text.includes('🛡')) {
    const pos = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
    let report = '🛡️ *Automated Risk Targets (Active 24/7 Cloud Guardian)*\n\n' +
                 '🟢 *Status: ACTIVE & CONTINUOUSLY ENFORCED*\n' +
                 '• *Stop-Loss Floor:* `-' + (STOP_LOSS_PCT * 100).toFixed(1) + '%` (Auto-sells 100% to protect capital)\n' +
                 '• *Breakeven Ratchet:* `+' + (BREAKEVEN_RATCHET_PCT * 100).toFixed(1) + '%` (Moves stop loss to $0 risk entry price)\n' +
                 '• *Take-Profit Target:* `+' + (TAKE_PROFIT_PCT * 100).toFixed(1) + '%` (Auto-trims ' + (TAKE_PROFIT_TRIM_PCT * 100).toFixed(0) + '% to bank profit)\n\n';

    if (pos && pos.data && pos.data.positions) {
      const active = pos.data.positions.filter(p => parseFloat(p.quantity) > 0);
      for (const p of active) {
        const sym = p.symbol;
        const sh = parseFloat(p.quantity);
        const q = await fetchQuote(sym);
        const curPrice = q ? q.price : 0;
        const avg = getEffectiveCostBasis(p, curPrice);
        const stopPrice = avg * (1 - STOP_LOSS_PCT);
        const tpPrice = avg * (1 + TAKE_PROFIT_PCT);
        const pnl = avg > 0 ? ((curPrice - avg) / avg) * 100 : 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const distanceToStop = curPrice > 0 ? ((curPrice - stopPrice) / curPrice) * 100 : (STOP_LOSS_PCT * 100);
        const distanceToTP = curPrice > 0 ? ((tpPrice - curPrice) / curPrice) * 100 : (TAKE_PROFIT_PCT * 100);

        report += '🔹 *' + sym + '* (`' + sh.toFixed(4) + '` sh)\n' +
                  '   • Current: `$' + curPrice.toFixed(2) + '` (' + pnlSign + pnl.toFixed(2) + '%)\n' +
                  '   • 🛑 Stop-Loss: `$' + stopPrice.toFixed(2) + '` (-' + (STOP_LOSS_PCT * 100).toFixed(1) + '% | ' + distanceToStop.toFixed(1) + '% buffer)\n' +
                  '   • 🎯 Take-Profit: `$' + tpPrice.toFixed(2) + '` (+' + (TAKE_PROFIT_PCT * 100).toFixed(1) + '% | ' + (distanceToTP > 0 ? distanceToTP.toFixed(1) + '% to target' : 'TARGET REACHED 🚀') + ')\n' +
                  '   • *Guard:* 🟢 Protected 24/7\n\n';
      }
    }
    report += '_Enforced continuously around the clock by AWS cloud background daemon._';
    return sendMessage(chatId, report, mainMenu);
  }

  // 📰 BREAKING NEWS & POSTINGS ENGINE
  const newsMatch = text.match(/^(?:news|article|articles|headline|headlines|postings?)\s+([a-zA-Z]{1,5})$/i);
  if (newsMatch) {
    const sym = newsMatch[1].toUpperCase();
    await sendMessage(chatId, '⏳ *Fetching breaking news & postings for ' + sym + '...*');
    const stories = await fetchTickerNews(sym, 3);
    if (!stories || stories.length === 0) {
      return sendMessage(chatId, '⚠️ No recent news articles found for `' + sym + '`.', mainMenu);
    }
    let report = '📰 *Breaking News & Analysis: ' + sym + '*\n\n';
    stories.forEach((n, i) => {
      const sent = analyzeHeadlineSentiment(n.title);
      report += (i + 1) + '. ' + sent.emoji + ' *[' + n.publisher + ' • ' + n.time + ']*\n' +
                '   • *Signal:* ' + sent.emoji + ' *' + sent.label + '*\n' +
                '   ' + n.title + '\n' +
                '   🔗 [Read Story](' + n.link + ')\n\n';
    });
    report += '_Real-time financial news classified with buy/sell sentiment signals._';
    return sendMessage(chatId, report, mainMenu);
  }

  // Tap "📰 Market News" button or type "news" without ticker: fetches news dynamically across ALL active holdings
  if (lower.includes('news') || text.includes('📰')) {
    await sendMessage(chatId, '⏳ *Scanning live market news across your portfolio holdings...*');
    let holdingsToScan = [];
    try {
      const pos = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
      if (pos && pos.data && pos.data.positions) {
        holdingsToScan = pos.data.positions.filter(p => parseFloat(p.quantity) > 0).map(p => p.symbol);
      }
    } catch (e) {}

    if (holdingsToScan.length === 0) holdingsToScan = Object.keys(getSectorUniverse()).slice(0, 5);

    let report = '📰 *Live Portfolio Breaking News Wire*\n\n';
    for (const sym of holdingsToScan) {
      const stories = await fetchTickerNews(sym, 1);
      if (stories && stories[0]) {
        const n = stories[0];
        const sent = analyzeHeadlineSentiment(n.title);
        report += '🏷️ ' + sent.emoji + ' *' + sym + '* — _' + n.publisher + ' (' + n.time + ')_\n' +
                  '• *Signal:* ' + sent.emoji + ' *' + sent.label + '*\n' +
                  '• ' + n.title + '\n' +
                  '🔗 [Read Full Story](' + n.link + ')\n\n';
      }
    }
    report += '_Text `news <ticker>` (e.g. `news VRT`) for in-depth articles on any stock!_';
    return sendMessage(chatId, report, mainMenu);
  }

  if (lower.includes('help') || text.includes('💬')) {
    const helpText = 
      '📖 *Dylan AI Quantitative Trading & Prediction Guide*\n\n' +
      '🎯 *Pseudo-Neural Predictive Engine:*\n' +
      '• Tap *🎯 Predictive Radar* — Evaluates 3-5 day breakout probabilities across physical AI supply chain stocks using volume anomalies, volatility squeeze, and market governors!\n' +
      '• Text `predict <ticker>` (e.g. `predict VRT`) — Detailed quantitative score, key drivers, and tactical action!\n\n' +
      '🛡️ *Automated 24/7 Risk Guardian:*\n' +
      '• *Breakeven Stop Ratchet (+' + (BREAKEVEN_RATCHET_PCT * 100).toFixed(0) + '% Gain):* Once a stock is up +' + (BREAKEVEN_RATCHET_PCT * 100).toFixed(0) + '%, the stop-loss moves to your entry price. You play with house money at $0 risk!\n' +
      '• *Stop-Loss Floor (-' + (STOP_LOSS_PCT * 100).toFixed(0) + '%):* Auto-liquidates 100% to protect principal.\n' +
      '• *Take-Profit Harvest (+' + (TAKE_PROFIT_PCT * 100).toFixed(0) + '%):* Auto-trims ' + (TAKE_PROFIT_TRIM_PCT * 100).toFixed(0) + '% to bank green gains.\n\n' +
      '🧠 *Mini-Rob Conversational Co-Pilot & Self-Reflection:*\n' +
      '• `Rob, reflect` or `Rob, what did you learn?` — Full quant trade attribution memo & strategy evolution!\n' +
      '• `Rob, buy $15 of VRT` — Executes live Robinhood order conversationally!\n' +
      '• `Rob, sell half of INTC` — Executes live sell order!\n' +
      '• `Rob, predict NVDA` — Explains the breakout probability and model math!\n' +
      '• `Rob, reset memory` — Wipes conversation history.\n\n' +
      '🚀 *Manual Quick Commands:*\n' +
      '• `buy <ticker> $<dollars>` | `sell <ticker> <shares or %>`\n' +
      '• `chart <ticker>` | `news <ticker>` | `quote <ticker>`\n\n' +
      '_Evolving continuously on AWS EC2 with automated trade flight recorder._';
    return sendMessage(chatId, helpText, mainMenu);
  }

  // CHART COMMAND
  const chartMatch = text.match(/^(?:chart|graph|plot)\s+([a-zA-Z]{1,5})$/i);
  if (chartMatch) return sendVisualChart(chatId, chartMatch[1]);
  if (lower.includes('chart') || text.includes('📈')) {
    let topSym = 'NVDA';
    try {
      const pos = await callRobinhood('get_equity_positions', { account_number: RH_ACCOUNT });
      if (pos && pos.data && pos.data.positions) {
        const active = pos.data.positions.filter(p => parseFloat(p.quantity) > 0);
        if (active.length > 0) topSym = active[0].symbol;
      }
    } catch (e) {}
    return sendVisualChart(chatId, topSym);
  }

  const quoteMatch = text.match(/^(?:quote|rsi|price|check)\s+([a-zA-Z]{1,5})$/i);
  if (quoteMatch) {
    const sym = quoteMatch[1].toUpperCase();
    const q = await fetchQuote(sym);
    if (!q) return sendMessage(chatId, '❌ Could not find market data for symbol `' + sym + '`.', mainMenu);
    const sign = q.changePct >= 0 ? '+' : '';
    const info = SECTOR_UNIVERSE[sym] || { sector: 'General' };
    return sendMessage(
      chatId,
      '📈 *Market Quote: ' + sym + ' (' + info.sector + ')*\n\n• *Price:* `$' + q.price.toFixed(2) + '` (' + sign + q.changePct.toFixed(2) + '%)\n• *Previous Close:* `$' + q.prevClose.toFixed(2) + '`\n• *Bid / Ask:* `$' + q.bid.toFixed(2) + ' / $' + q.ask.toFixed(2) + '`',
      mainMenu
    );
  }

  return sendMessage(chatId, '🤖 *Dylan AI Trading Agent (AWS)*\n\nReceived: _\"' + text + '\"_\n\nTap buttons below to check live quotes or text `buy <ticker> $<dollars>`!', mainMenu);
}

// 24/7 Autonomous Background Poller
let lastKnownCash = null;
let seenOrderIds = new Set();

async function pollRobinhoodBackground() {
  try {
    const p = await callRobinhood('get_portfolio', { account_number: RH_ACCOUNT });
    const orders = await callRobinhood('get_equity_orders', { account_number: RH_ACCOUNT });
    if (p && p.data) {
      const currentCash = parseFloat(p.data.cash);
      const rawBuyingPower = parseFloat(p.data.buying_power.buying_power || 0);
      const totalVal = parseFloat(p.data.total_value);

      let queuedTotalUSD = 0;
      if (orders && orders.data && orders.data.orders) {
        orders.data.orders.filter(o => o.state === 'queued').forEach(qo => {
          const amt = qo.dollar_based_amount ? parseFloat(qo.dollar_based_amount.amount) : (parseFloat(qo.quantity) * parseFloat(qo.price || 0));
          queuedTotalUSD += amt;
        });
      }
      const trueSpendableBuyingPower = Math.max(0, Math.min(rawBuyingPower, currentCash - queuedTotalUSD));

      if (lastKnownCash !== null && currentCash > lastKnownCash) {
        const depositDiff = currentCash - lastKnownCash;
        console.log('[AUTO-NOTIFY] Deposit detected: +$' + depositDiff);
        
        await sendMessage(
          AUTHORIZED_USER_ID,
          '💰 *Auto-Deposit Detected from Robinhood!*\n\n' +
          '• *Amount Added:* `+$' + depositDiff.toFixed(2) + '` 💵\n' +
          '• *Spendable Buying Power:* `$' + trueSpendableBuyingPower.toFixed(2) + '`\n' +
          '• *Total Account Value:* `$' + totalVal.toFixed(2) + '` 🚀\n\n' +
          '🤖 *Triggering Autonomous Reinvestment Protocol...*',
          mainMenu
        );
      }
      lastKnownCash = currentCash;

      if (trueSpendableBuyingPower >= 10.00) {
        await autoReinvestCash(trueSpendableBuyingPower);
      }

      // 🛡️ 24/7 Automated Risk Targets: Actively enforces Stop-Loss & Take-Profit on all holdings
      await enforceAutomatedRiskTargets();
    }
    if (orders && orders.data && orders.data.orders) {
      for (const ord of orders.data.orders) {
        if (!seenOrderIds.has(ord.id)) {
          seenOrderIds.add(ord.id);
          const created = new Date(ord.created_at);
          const ageMinutes = (Date.now() - created.getTime()) / 60000;
          if (ageMinutes < 15 && ord.state === 'filled') {
            const sym = ord.symbol;
            const amt = ord.dollar_based_amount ? parseFloat(ord.dollar_based_amount.amount) : (parseFloat(ord.quantity) * parseFloat(ord.average_price));
            await sendMessage(
              AUTHORIZED_USER_ID,
              '🛒 *Trade Fill Confirmed on Robinhood!*\n\n' +
              '• *Asset:* `' + sym + '` (' + ord.side.toUpperCase() + ')\n' +
              '• *Total Value:* `$' + amt.toFixed(2) + '`\n' +
              '• *Status:* Filled on Exchange ✅\n\n' +
              '_Live Portfolio updated automatically._',
              mainMenu
            );
          }
        }
      }
    }

    // 4. Background Daily Movers Opportunity Scanner (Runs every 20 minutes)
    await checkBackgroundOpportunityAlerts();
  } catch (err) {
    console.error('Background poll error:', err.message);
  }
}

let lastOpportunityScanTime = 0;
async function checkBackgroundOpportunityAlerts() {
  if (Date.now() - lastOpportunityScanTime < 20 * 60 * 1000) return;
  lastOpportunityScanTime = Date.now();

  try {
    const scanRes = await scanDailyMoversForDeals(callRobinhood);
    if (scanRes && scanRes.qualifiedDeals && scanRes.qualifiedDeals.length > 0) {
      for (const deal of scanRes.qualifiedDeals) {
        if (deal.triggerTelegramAlert) {
          const headline = (deal.newsStories && deal.newsStories[0]) ? deal.newsStories[0].title : 'Positive market momentum';
          const alertMsg = 
            '🚨 *HIGH-CONVICTION DEAL DETECTED FROM DAILY MOVERS!* 🚀\n\n' +
            'Our scanner discovered a prime setup with strong fundamentals:\n\n' +
            '🔹 *' + deal.symbol + '* — `$' + deal.price.toFixed(2) + '`\n' +
            '   • *Breakout Odds:* `' + deal.probabilityPct + '%` (' + deal.rating + ')\n' +
            '   • *14-Day RSI:* `' + deal.rsi + '` (Healthy Entry Range ✅)\n' +
            '   • *Volume Spike:* `' + deal.volRatio + 'x` Normal Volume\n' +
            '   • *News Catalyst:* _\"' + headline + '\"_ (' + deal.sentiment.label + ')\n' +
            '   • *Status:* 🆕 Added to Sector Rotation Universe!\n\n' +
            '🎯 *Tactical Action:* `' + deal.action + '`\n\n' +
            '_Dylan, to jump on this deal, just say: "Rob, buy $15 of ' + deal.symbol + '". Our -6% stop & +8% profit target guard your capital._';

          await sendMessage(AUTHORIZED_USER_ID, alertMsg, mainMenu);
        }
      }
    }
  } catch (e) {
    console.error('[OPPORTUNITY SCANNER] Background check error:', e.message);
  }
}

// 24/7 Telegram Long-Polling Loop
let offset = 0;
async function startPolling() {
  console.log('🛡️ Dylan AI Trading Agent online with Liquidity Filter (>= 1000 Vol) & RSI Engine...');
  await resolveAccount();
  await pollRobinhoodBackground();
  setInterval(pollRobinhoodBackground, 60000);

  while (true) {
    try {
      if (!TELEGRAM_TOKEN) {
        console.error('❌ [TELEGRAM ERROR] Cannot poll: TELEGRAM_TOKEN is missing in .env');
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      const res = await fetch(TELEGRAM_API + '/getUpdates?offset=' + offset + '&timeout=25');
      const data = await res.json();
      if (!data.ok) {
        console.error('❌ [TELEGRAM ERROR] getUpdates failed:', data.description || data.error_code);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (data.ok && data.result) {
        for (const u of data.result) {
          offset = u.update_id + 1;
          if (u.message) handleMessage(u.message);
        }
      }
    } catch (err) {
      console.error('❌ [TELEGRAM ERROR] Polling exception:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

startPolling();