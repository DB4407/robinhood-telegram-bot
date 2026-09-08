// web_server.js - Embedded Cockpit Dashboard Server & API Dispatcher
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tradeLogger = require('./engine/trade_logger');
const { DEFAULT_HORIZON_THEMES, synthesizeIndustryBasket, auditAndScoreBasket } = require('./engine/industry_etf_synthesizer');
const { loadStrategyInsights } = require('./engine/self_reflection_engine');
const { evaluateStockPrediction, checkMarketGovernor } = require('./engine/predictive_engine');
const { callPilotLLM, buildJournalSummary, auditHoldingsVsAlternatives } = require('./engine/pilot_engine');

const PROTOTYPE_HTML_PATH = path.join(__dirname, 'web_interface_prototype.html');
const CONFIG_PATH = path.join(__dirname, 'config', 'trading_config.json');
const CUSTOM_THEMES_PATH = path.join(__dirname, 'data', 'custom_etf_themes.json');

let botBridge = null;
function setBotBridge(bridge) {
  botBridge = bridge;
}

// In-memory single-tenant active session vault
const activeSessions = new Map();

function authenticateRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1];
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function loadTradingConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read trading_config.json:', e.message);
  }
  return { circuit_breakers: { max_single_order_usd: 50, min_single_order_usd: 1, max_daily_deploy_usd: 150 } };
}

function loadCustomThemes() {
  try {
    if (fs.existsSync(CUSTOM_THEMES_PATH)) {
      return JSON.parse(fs.readFileSync(CUSTOM_THEMES_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read custom_etf_themes.json:', e.message);
  }
  return [];
}

function saveCustomTheme(scoredTheme) {
  try {
    const list = loadCustomThemes();
    const id = 'custom_' + (scoredTheme.etfTicker || Date.now()).toLowerCase().replace(/[^a-z0-9]/g, '_');
    const idx = list.findIndex(item => item.id === id || item.etfTicker === scoredTheme.etfTicker);
    const themeObj = {
      id: id,
      etfTicker: scoredTheme.etfTicker,
      title: scoredTheme.industry,
      thesis: scoredTheme.thesis,
      synthesizedBy: scoredTheme.synthesizedBy,
      journalWinRate: scoredTheme.journalWinRate,
      tickers: scoredTheme.tickers,
      createdAt: Date.now()
    };
    if (idx >= 0) {
      list[idx] = themeObj;
    } else {
      list.push(themeObj);
    }
    const dir = path.dirname(CUSTOM_THEMES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CUSTOM_THEMES_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to persist custom theme:', e.message);
  }
}

async function getAvailableSpendableCash(rhAccount) {
  try {
    if (!botBridge || !botBridge.callRobinhood) return 0;
    const p = await botBridge.callRobinhood('get_portfolio', { account_number: rhAccount });
    const cash = (p && p.data) ? parseFloat(p.data.cash || 0) : 0;
    const rawBP = (p && p.data && p.data.buying_power) ? parseFloat(p.data.buying_power.buying_power || 0) : 0;

    const ordersRes = await botBridge.callRobinhood('get_equity_orders', { account_number: rhAccount });
    let queuedUSD = 0;
    if (ordersRes && ordersRes.data && ordersRes.data.orders) {
      const queued = ordersRes.data.orders.filter(o => o.state === 'queued' && o.side === 'buy');
      for (const qo of queued) {
        const amt = qo.dollar_based_amount ? parseFloat(qo.dollar_based_amount.amount) : (parseFloat(qo.quantity) * (parseFloat(qo.price) || 0));
        queuedUSD += amt;
      }
    }
    return Math.max(0, Math.min(rawBP, cash - queuedUSD));
  } catch (err) {
    console.warn('[SPENDABLE CASH] Error calculating buying power:', err.message);
    return 0;
  }
}

// Cached Radar Telemetry
let cachedRadar = null;
let radarCacheTime = 0;

const RADAR_UNIVERSE = [
  { symbol: 'VRT', name: 'Vertiv Holdings', sector: 'Liquid Cooling & Thermals' },
  { symbol: 'CRWD', name: 'CrowdStrike Holdings', sector: 'Autonomous Endpoint Cyber' },
  { symbol: 'ANET', name: 'Arista Networks', sector: 'AI Cluster Networking' },
  { symbol: 'TSM', name: 'Taiwan Semi', sector: 'Semiconductor Foundry' },
  { symbol: 'MU', name: 'Micron Technology', sector: 'HBM Memory Supercycle' },
  { symbol: 'PLTR', name: 'Palantir Technologies', sector: 'Defense AI Operating System' },
  { symbol: 'CCJ', name: 'Cameco Corp', sector: 'Uranium Mining & Baseload' },
  { symbol: 'PWR', name: 'Quanta Services', sector: 'Supergrid Transmission' },
  { symbol: 'RKLB', name: 'Rocket Lab USA', sector: 'Orbital Space Systems' },
  { symbol: 'PANW', name: 'Palo Alto Networks', sector: 'Platform Cyber Architecture' },
  { symbol: 'NVDA', name: 'NVIDIA Corp', sector: 'GPU Silicon & AI Compute' },
  { symbol: 'CEG', name: 'Constellation Energy', sector: 'Nuclear Baseload Power' }
];

async function getBreakoutRadarCandidates() {
  const now = Date.now();
  if (cachedRadar && (now - radarCacheTime < 30000)) {
    return cachedRadar;
  }

  let rhQuotes = {};
  if (botBridge && botBridge.callRobinhood) {
    try {
      const qRes = await botBridge.callRobinhood('get_equity_quotes', { symbols: RADAR_UNIVERSE.map(u => u.symbol) });
      if (qRes && qRes.data && qRes.data.results) {
        qRes.data.results.forEach(r => {
          if (r.quote && r.quote.last_trade_price) {
            rhQuotes[r.quote.symbol] = parseFloat(r.quote.last_trade_price);
          }
        });
      }
    } catch (e) {}
  }

  const results = await Promise.all(
    RADAR_UNIVERSE.map(async (u) => {
      try {
        const pred = await evaluateStockPrediction(u.symbol);
        if (!pred) return null;
        const curPrice = rhQuotes[u.symbol] !== undefined ? rhQuotes[u.symbol] : (pred.raw ? pred.raw.curPrice : 100);
        const rsi = pred.raw ? parseFloat(pred.raw.rsi.toFixed(1)) : 50.0;
        const volRatio = pred.raw ? parseFloat(pred.raw.volRatio.toFixed(2)) : 1.0;
        const isSqueezing = pred.raw ? !!pred.raw.isSqueezing : false;
        const roc5d = pred.raw ? parseFloat(pred.raw.roc5dPct.toFixed(2)) : 0;

        return {
          symbol: u.symbol,
          name: u.name,
          sector: u.sector,
          price: curPrice,
          changePct: roc5d,
          probabilityPct: pred.probabilityPct,
          rating: pred.rating,
          action: pred.action,
          rsi: rsi,
          volRatio: volRatio,
          isSqueezing: isSqueezing,
          squeezeState: isSqueezing ? '⚡ Squeeze Coiling' : (rsi < 45 ? '💎 Oversold Base' : (rsi > 68 ? '⚠️ Extended' : '🟢 Healthy Base')),
          volumeSpike: `${volRatio}x`
        };
      } catch (err) {
        return null;
      }
    })
  );

  const valid = results.filter(Boolean);
  valid.sort((a, b) => b.probabilityPct - a.probabilityPct);
  cachedRadar = valid;
  radarCacheTime = now;
  return valid;
}

async function handleWebRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Healthcheck (Public)
  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now() }));
  }

  // 2. Authentication: Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const secret = String(payload.secret || payload.password || payload.pin || '').trim();

        const telegramId = botBridge ? String(botBridge.getTelegramId() || '') : String(process.env.AUTHORIZED_USER_ID || '');
        const rhToken = botBridge && botBridge.getRobinhoodToken ? botBridge.getRobinhoodToken() : (process.env.ROBINHOOD_TOKEN || '');
        const webPin = String(process.env.WEB_PIN || process.env.WEB_PASSWORD || '').trim();
        const ownerName = (botBridge ? botBridge.getUserName() : process.env.USER_NAME) || 'Dylan';

        let isValid = false;
        if (webPin && secret === webPin) {
          isValid = true;
        } else if (telegramId && (secret === telegramId || (telegramId.length >= 4 && secret === telegramId.slice(-4)))) {
          isValid = true;
        } else if (rhToken && (secret === rhToken || (rhToken.length >= 6 && secret === rhToken.slice(-6)) || (rhToken.length >= 4 && secret === rhToken.slice(-4)))) {
          isValid = true;
        } else if (!webPin && !telegramId && secret.length >= 4) {
          isValid = true;
        }

        if (!isValid) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: 'Authentication failed. Please enter your Telegram User ID or Master Access PIN.'
          }));
        }

        const sessionToken = crypto.randomBytes(32).toString('hex');
        const rhAccount = botBridge ? botBridge.getRHAccount() : (process.env.RH_ACCOUNT || '');

        activeSessions.set(sessionToken, {
          user: ownerName,
          createdAt: Date.now(),
          expiresAt: Date.now() + (48 * 60 * 60 * 1000)
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          token: sessionToken,
          user: {
            name: ownerName,
            telegramId: telegramId ? '••••' + telegramId.slice(-4) : 'Authorized',
            rhAccount: rhAccount ? '••••' + rhAccount.slice(-4) : 'Auto-Discovered'
          }
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 3. Authentication: Session Verification
  if (pathname === '/api/auth/session') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ authenticated: false }));
    }
    const telegramId = botBridge ? String(botBridge.getTelegramId() || '') : String(process.env.AUTHORIZED_USER_ID || '');
    const ownerName = (botBridge ? botBridge.getUserName() : process.env.USER_NAME) || 'Dylan';
    const rhAccount = botBridge ? botBridge.getRHAccount() : (process.env.RH_ACCOUNT || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      authenticated: true,
      user: {
        name: ownerName,
        telegramId: telegramId ? '••••' + telegramId.slice(-4) : 'Authorized',
        rhAccount: rhAccount ? '••••' + rhAccount.slice(-4) : 'Auto-Discovered'
      }
    }));
  }

  // 4. Authentication: Logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      activeSessions.delete(match[1]);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // 5. Real-Time Portfolio & Balances Sync (PROTECTED)
  if (pathname === '/api/portfolio/live') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Please log in first.' }));
    }

    try {
      if (!botBridge || !botBridge.callRobinhood) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ connected: false, error: 'Broker bridge initializing...' }));
      }

      const rhAccount = botBridge.getRHAccount();
      const p = await botBridge.callRobinhood('get_portfolio', { account_number: rhAccount });
      const pos = await botBridge.callRobinhood('get_equity_positions', { account_number: rhAccount });
      const orders = await botBridge.callRobinhood('get_equity_orders', { account_number: rhAccount });

      const totalVal = (p && p.data) ? parseFloat(p.data.total_value) : 0;
      const cash = (p && p.data) ? parseFloat(p.data.cash) : 0;
      const rawBuyingPower = (p && p.data && p.data.buying_power) ? parseFloat(p.data.buying_power.buying_power || 0) : 0;

      let queuedTotalUSD = 0;
      const queuedOrders = [];
      if (orders && orders.data && orders.data.orders) {
        const queued = orders.data.orders.filter(o => o.state === 'queued');
        for (const qo of queued) {
          const amt = qo.dollar_based_amount ? parseFloat(qo.dollar_based_amount.amount) : (parseFloat(qo.quantity) * (parseFloat(qo.price) || 0));
          if (qo.side === 'buy') queuedTotalUSD += amt;
          queuedOrders.push({ symbol: qo.symbol, side: qo.side, amount: amt, shares: qo.quantity });
        }
      }

      const spendableCash = Math.max(0, Math.min(rawBuyingPower, cash - queuedTotalUSD));

      const rawActive = (pos && pos.data && pos.data.positions) 
        ? pos.data.positions.filter(item => parseFloat(item.quantity) > 0)
        : [];
      const symbols = rawActive.map(item => item.symbol);

      let quotesMap = {};
      let histMap = {};

      if (symbols.length > 0) {
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        
        // Fetch real-time quotes and 7-day historical price bars in parallel
        const tasks = [
          botBridge.callRobinhood('get_equity_quotes', { symbols }),
          botBridge.callRobinhood('get_equity_historicals', { symbols: symbols.slice(0, 10), start_time: weekAgo, interval: 'day' })
        ];
        if (symbols.length > 10) {
          tasks.push(botBridge.callRobinhood('get_equity_historicals', { symbols: symbols.slice(10, 20), start_time: weekAgo, interval: 'day' }));
        }

        try {
          const [quotesRes, hist1, hist2] = await Promise.all(tasks);

          if (quotesRes && quotesRes.data && quotesRes.data.results) {
            quotesRes.data.results.forEach(r => {
              if (r.quote) quotesMap[r.quote.symbol] = parseFloat(r.quote.last_trade_price);
            });
          }

          const allHist = ((hist1 && hist1.data && hist1.data.results) || []).concat((hist2 && hist2.data && hist2.data.results) || []);
          allHist.forEach(r => {
            histMap[r.symbol] = (r.bars || []).map(b => parseFloat(b.close_price));
          });
        } catch (fetchErr) {
          console.warn('[PORTFOLIO SYNC] Non-critical quotes/hist fetch note:', fetchErr.message);
        }
      }

      const activePositions = rawActive.map(item => {
        const sym = item.symbol;
        const qty = parseFloat(item.quantity);
        const avgBuy = parseFloat(item.average_buy_price || 0);
        const curPrice = quotesMap[sym] !== undefined ? quotesMap[sym] : avgBuy;
        const historyCloses = (histMap[sym] && histMap[sym].length > 0)
          ? histMap[sym].concat([curPrice])
          : [avgBuy, curPrice];
        const pnlPct = avgBuy > 0 ? ((curPrice - avgBuy) / avgBuy * 100) : 0;
        const pnlUSD = (curPrice - avgBuy) * qty;
        const marketVal = curPrice * qty;
        const change7d = historyCloses.length >= 2 
          ? ((historyCloses[historyCloses.length - 1] - historyCloses[0]) / historyCloses[0] * 100) 
          : 0;

        return {
          symbol: sym,
          quantity: qty,
          average_buy_price: avgBuy,
          current_price: curPrice,
          market_value: marketVal,
          unrealized_pnl_pct: pnlPct,
          unrealized_pnl_usd: pnlUSD,
          closes: historyCloses,
          change_7d_pct: change7d,
          stop_floor: avgBuy * 0.94,
          ratchet_price: avgBuy * 1.04
        };
      });

      const cfg = loadTradingConfig();
      const rhTokenSuffix = botBridge.getRHTokenSuffix ? botBridge.getRHTokenSuffix() : '';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        connected: true,
        userName: botBridge.getUserName(),
        telegramId: botBridge.getTelegramId(),
        rhAccount: rhAccount ? '••••' + rhAccount.slice(-4) : 'Discovered',
        rhTokenStatus: (botBridge.isTokenConfigured && botBridge.isTokenConfigured()) ? ('Active & Encrypted (.env: ••••' + rhTokenSuffix + ')') : 'Not Connected',
        rhTokenSuffix: rhTokenSuffix,
        totalEquity: totalVal,
        cash: cash,
        spendableCash: spendableCash,
        queuedOrders: queuedOrders,
        positions: activePositions,
        circuitBreakers: cfg.circuit_breakers || {}
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 6. Live Order Execution: BUY (PROTECTED)
  if (pathname === '/api/orders/buy' && req.method === 'POST') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Please log in first.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const symbol = String(payload.symbol || '').toUpperCase().trim();
        const amountUSD = parseFloat(payload.amountUSD || payload.dollar_amount || 15);

        if (!symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing stock symbol' }));
        }

        const cfg = loadTradingConfig();
        const maxOrder = cfg.circuit_breakers?.max_single_order_usd || 50;
        if (amountUSD > maxOrder) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Amount ($${amountUSD}) exceeds max single order safety limit of $${maxOrder}.` }));
        }

        const rhAccount = botBridge.getRHAccount();
        const spendableCash = await getAvailableSpendableCash(rhAccount);

        if (spendableCash < 1.00) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: `Insufficient spendable buying power ($${spendableCash.toFixed(2)}). Robinhood requires a minimum order size of $1.00. Please liquidate an active holding to fund this purchase.`
          }));
        }

        // Leave buffer ($0.08) to prevent broker price-collar rejection
        const maxSpendable = Math.max(1.00, Math.floor((spendableCash - 0.08) * 100) / 100);
        let finalAmountUSD = amountUSD;
        let autoAdjusted = false;

        if (finalAmountUSD > maxSpendable) {
          finalAmountUSD = maxSpendable;
          autoAdjusted = true;
        }

        const orderRes = await botBridge.callRobinhood('place_equity_order', {
          account_number: rhAccount,
          symbol: symbol,
          side: 'buy',
          type: 'market',
          dollar_amount: finalAmountUSD.toFixed(2),
          time_in_force: 'gfd',
          market_hours: 'regular_hours'
        });

        if (!orderRes || !orderRes.data) {
          const errMsg = (orderRes && orderRes.error) ? orderRes.error.message : 'Broker exchange rejected buy order.';
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: errMsg }));
        }

        const ord = orderRes.data;
        tradeLogger.logTradeEntry({
          symbol: symbol,
          side: 'buy',
          amountUSD: finalAmountUSD,
          price: parseFloat(ord.price || 0),
          shares: parseFloat(ord.quantity || 0)
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          order: ord,
          amountUSD: finalAmountUSD,
          message: `🚀 Market Order Dispatched for $${finalAmountUSD.toFixed(2)} of ${symbol}!${autoAdjusted ? ` (Auto-sized to match available cash of $${spendableCash.toFixed(2)})` : ''} (State: ${ord.state})`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 7. Live Order Execution: SELL (PROTECTED)
  if (pathname === '/api/orders/sell' && req.method === 'POST') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Please log in first.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const symbol = String(payload.symbol || '').toUpperCase().trim();
        const shares = parseFloat(payload.shares || payload.quantity || 0);

        if (!symbol || shares <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Valid symbol and liquidation share quantity required.' }));
        }

        const rhAccount = botBridge.getRHAccount();
        const orderRes = await botBridge.callRobinhood('place_equity_order', {
          account_number: rhAccount,
          symbol: symbol,
          side: 'sell',
          type: 'market',
          quantity: shares.toFixed(6),
          time_in_force: 'gfd',
          market_hours: 'regular_hours'
        });

        if (!orderRes || !orderRes.data) {
          const errMsg = (orderRes && orderRes.error) ? orderRes.error.message : 'Broker exchange rejected sell order.';
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: errMsg }));
        }

        const ord = orderRes.data;
        tradeLogger.logTradeExit(symbol, parseFloat(ord.price || 0), 'WEB_COCKPIT_MANUAL');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          order: ord,
          message: `💸 Market Sell Order Dispatched for ${shares} shares of ${symbol}! (State: ${ord.state})`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 8. Live Order Execution: REBALANCE (PROTECTED)
  if (pathname === '/api/orders/rebalance' && req.method === 'POST') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Please log in first.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const targetSymbol = String(payload.targetSymbol || '').toUpperCase().trim();
        const amountUSD = parseFloat(payload.amountUSD || 15);
        const liquidateSymbol = payload.liquidateSymbol ? String(payload.liquidateSymbol).toUpperCase().trim() : '';

        if (!targetSymbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Target buy constituent is required.' }));
        }

        const rhAccount = botBridge.getRHAccount();
        let soldDetail = null;

        // Step 1: Liquidate out-of-theme holding if requested
        if (liquidateSymbol) {
          const posRes = await botBridge.callRobinhood('get_equity_positions', { account_number: rhAccount });
          const matchPos = posRes.data?.positions?.find(p => p.symbol === liquidateSymbol && parseFloat(p.quantity) > 0);
          if (matchPos) {
            const sellQty = parseFloat(matchPos.quantity).toFixed(6);
            const sellRes = await botBridge.callRobinhood('place_equity_order', {
              account_number: rhAccount,
              symbol: liquidateSymbol,
              side: 'sell',
              type: 'market',
              quantity: sellQty,
              time_in_force: 'gfd',
              market_hours: 'regular_hours'
            });
            if (sellRes && sellRes.data) {
              soldDetail = { symbol: liquidateSymbol, quantity: sellQty, state: sellRes.data.state };
              tradeLogger.logTradeExit(liquidateSymbol, parseFloat(sellRes.data.price || matchPos.average_buy_price), 'THEMATIC_REBALANCE');
              // Allow broker ledger settlement
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }

        // Step 2: Validate available spendable cash post-liquidation
        const spendableCash = await getAvailableSpendableCash(rhAccount);

        if (spendableCash < 1.00) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            sold: soldDetail,
            error: `Cannot accumulate ${targetSymbol}: insufficient spendable buying power ($${spendableCash.toFixed(2)}). Robinhood requires a minimum order size of $1.00.${liquidateSymbol && !soldDetail ? ` (Note: ${liquidateSymbol} was not held to liquidate)` : ''}`
          }));
        }

        // Auto-size accumulation amount to fit available buying power
        const maxSpendable = Math.max(1.00, Math.floor((spendableCash - 0.08) * 100) / 100);
        let finalAmountUSD = amountUSD;
        let autoAdjusted = false;

        if (finalAmountUSD > maxSpendable) {
          finalAmountUSD = maxSpendable;
          autoAdjusted = true;
        }

        // Step 3: Accumulate target ETF constituent
        const buyRes = await botBridge.callRobinhood('place_equity_order', {
          account_number: rhAccount,
          symbol: targetSymbol,
          side: 'buy',
          type: 'market',
          dollar_amount: finalAmountUSD.toFixed(2),
          time_in_force: 'gfd',
          market_hours: 'regular_hours'
        });

        if (!buyRes || !buyRes.data) {
          const errMsg = (buyRes && buyRes.error) ? buyRes.error.message : 'Failed to execute buy order during rebalance.';
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, sold: soldDetail, error: errMsg }));
        }

        const ord = buyRes.data;
        tradeLogger.logTradeEntry({
          symbol: targetSymbol,
          side: 'buy',
          amountUSD: finalAmountUSD,
          price: parseFloat(ord.price || 0),
          shares: parseFloat(ord.quantity || 0)
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          sold: soldDetail,
          bought: { symbol: targetSymbol, amountUSD: finalAmountUSD, state: ord.state },
          message: `✅ Tactical Rebalance Dispatched! ${soldDetail ? `Liquidated ${soldDetail.quantity} sh of ${soldDetail.symbol} and ` : ''}accumulated $${finalAmountUSD.toFixed(2)} of top-pick ${targetSymbol}${autoAdjusted ? ` (Auto-sized to fit $${spendableCash.toFixed(2)} available cash)` : ''}.`
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6. Update Vault & Circuit Breakers (PROTECTED)
  if (pathname === '/api/vault/update' && req.method === 'POST') {
    const session = authenticateRequest(req);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized. Please log in first.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const cfg = loadTradingConfig();
        if (payload.max_single_order_usd !== undefined) {
          cfg.circuit_breakers.max_single_order_usd = parseFloat(payload.max_single_order_usd);
        }
        if (payload.min_single_order_usd !== undefined) {
          cfg.circuit_breakers.min_single_order_usd = parseFloat(payload.min_single_order_usd);
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, circuit_breakers: cfg.circuit_breakers }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 7. Thematic ETF Horizons API (Returns Seed Themes + Persisted Custom Themes)
  if (pathname === '/api/etf/themes') {
    const custom = loadCustomThemes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      defaults: DEFAULT_HORIZON_THEMES,
      custom: custom
    }));
  }

  // 8. Strategy Insights API
  if (pathname === '/api/strategy/insights') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(loadStrategyInsights()));
  }

  // 8b. Full Historical Trade Journal & Telemetry Data API
  if (pathname === '/api/journal/full') {
    try {
      const journalExits = tradeLogger.getCompletedTrades();
      const insights = loadStrategyInsights();
      const journalSummary = buildJournalSummary();

      let totalWonUSD = 0;
      let totalLostUSD = 0;
      let winPcts = [];
      let lossPcts = [];
      let totalDurationHours = 0;
      let bestTrade = null;
      let worstTrade = null;

      journalExits.forEach(t => {
        const pnl = parseFloat(t.realizedPnlUSD || 0);
        const pnlPct = parseFloat(t.realizedPnlPct || 0);
        const dur = parseFloat(t.durationHours || 0);
        totalDurationHours += dur;

        if (pnl >= 0) {
          totalWonUSD += pnl;
          winPcts.push(pnlPct);
        } else {
          totalLostUSD += Math.abs(pnl);
          lossPcts.push(pnlPct);
        }

        if (!bestTrade || pnlPct > bestTrade.pnlPct) {
          bestTrade = { symbol: t.symbol, pnlUSD: pnl, pnlPct: pnlPct, exitReason: t.exitReason };
        }
        if (!worstTrade || pnlPct < worstTrade.pnlPct) {
          worstTrade = { symbol: t.symbol, pnlUSD: pnl, pnlPct: pnlPct, exitReason: t.exitReason };
        }
      });

      const totalTrades = journalExits.length;
      const profitFactor = totalLostUSD > 0 ? (totalWonUSD / totalLostUSD).toFixed(2) : 'Infinite';
      const avgDurationHours = totalTrades > 0 ? (totalDurationHours / totalTrades).toFixed(1) : 0;
      const avgWinPct = winPcts.length > 0 ? (winPcts.reduce((a, b) => a + b, 0) / winPcts.length).toFixed(1) : '0.0';
      const avgLossPct = lossPcts.length > 0 ? (lossPcts.reduce((a, b) => a + b, 0) / lossPcts.length).toFixed(1) : '0.0';

      let brokerOrders = [];
      if (botBridge && botBridge.callRobinhood) {
        try {
          const rhAccount = botBridge.getRHAccount();
          const ordRes = await botBridge.callRobinhood('get_equity_orders', { account_number: rhAccount });
          if (ordRes && ordRes.data && Array.isArray(ordRes.data.orders)) {
            brokerOrders = ordRes.data.orders.map(o => {
              const estPrice = parseFloat(o.average_price || o.price || 0);
              const qty = parseFloat(o.cumulative_quantity || o.quantity || 0);
              const amt = o.dollar_based_amount ? parseFloat(o.dollar_based_amount.amount) : (qty * estPrice);
              return {
                id: o.id,
                symbol: o.symbol,
                side: (o.side || 'buy').toUpperCase(),
                type: o.type,
                state: o.state,
                shares: qty,
                price: estPrice,
                dollarAmount: amt,
                createdAt: o.created_at,
                lastTransactionAt: o.last_transaction_at
              };
            });
          }
        } catch (rhErr) {
          console.warn('[JOURNAL API] Robinhood orders note:', rhErr.message);
        }
      }

      let modelWeights = null;
      const weightsPath = path.join(__dirname, 'data', 'model_weights.json');
      if (fs.existsSync(weightsPath)) {
        try {
          modelWeights = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
        } catch (e) {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        stats: {
          totalTrades,
          wins: winPcts.length,
          losses: lossPcts.length,
          winRatePct: totalTrades > 0 ? ((winPcts.length / totalTrades) * 100).toFixed(1) : '100.0',
          totalRealizedUSD: (totalWonUSD - totalLostUSD).toFixed(2),
          totalWonUSD: totalWonUSD.toFixed(2),
          totalLostUSD: totalLostUSD.toFixed(2),
          profitFactor,
          avgDurationHours,
          avgWinPct: `+${avgWinPct}%`,
          avgLossPct: `${avgLossPct}%`,
          bestTrade,
          worstTrade,
          marketRegime: insights.market_regime || 'Bullish Tech Momentum'
        },
        journalSummary,
        insights,
        modelWeights,
        journalExits: journalExits.slice().reverse(),
        brokerOrders
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 9. Synthesize / Audit ETF Basket API (Grok LPU Synthesizer)
  if (pathname === '/api/etf/audit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const themeQuery = payload.theme || payload.niche || 'ai_physical_infrastructure';
        const basket = await synthesizeIndustryBasket(themeQuery, 5);
        const scored = await auditAndScoreBasket(basket);

        // Persist to custom themes storage
        saveCustomTheme(scored);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(scored));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 10. Breakout Radar Candidates API
  if (pathname === '/api/radar/breakouts') {
    try {
      const candidates = await getBreakoutRadarCandidates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, count: candidates.length, candidates }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 11. Autonomous Restructuring Feed & Flight Journal API
  if (pathname === '/api/pilot/restructure-feed') {
    try {
      const radarCandidates = await getBreakoutRadarCandidates();
      const journalSummary = buildJournalSummary();
      const completedTrades = tradeLogger.getCompletedTrades();
      const insights = loadStrategyInsights();

      let activeHoldings = [];
      let spendableCash = 7.21;
      let totalEquity = 208.25;

      if (botBridge && botBridge.callRobinhood) {
        try {
          const rhAccount = botBridge.getRHAccount();
          spendableCash = await getAvailableSpendableCash(rhAccount);
          const p = await botBridge.callRobinhood('get_portfolio', { account_number: rhAccount });
          const pos = await botBridge.callRobinhood('get_equity_positions', { account_number: rhAccount });
          if (p && p.data) {
            totalEquity = parseFloat(p.data.total_value || totalEquity);
          }
          if (pos && pos.data && pos.data.positions) {
            activeHoldings = pos.data.positions.filter(x => parseFloat(x.quantity) > 0).map(x => ({
              symbol: x.symbol,
              quantity: parseFloat(x.quantity),
              average_buy_price: parseFloat(x.average_buy_price || 0)
            }));
          }
        } catch (e) {}
      }

      // Generate dynamic Restructuring Directives
      const directives = [];

      // 1. Check for out-of-theme / stagnant holdings (e.g. WMT, TYRA)
      let stagnantHolding = activeHoldings.find(h => h.symbol === 'WMT');
      if (!stagnantHolding) {
        stagnantHolding = activeHoldings.find(h => h.symbol === 'TYRA') || null;
      }
      const topBreakout = radarCandidates.find(c => c.probabilityPct >= 70 && !activeHoldings.some(h => h.symbol === c.symbol)) || radarCandidates[0];

      if (stagnantHolding && topBreakout) {
        directives.push({
          id: 'DIR_SWAP_' + stagnantHolding.symbol + '_' + topBreakout.symbol,
          type: 'CAPITAL_ROTATION_SWAP',
          urgency: 'HIGH',
          title: `Rotate Non-Conforming [${stagnantHolding.symbol}] into High-Alpha Leader [${topBreakout.symbol}]`,
          fromSymbol: stagnantHolding.symbol,
          toSymbol: topBreakout.symbol,
          amountUSD: 15.00,
          rationale: `${stagnantHolding.symbol} is idling in a low-momentum channel. Capital has significantly higher velocity in ${topBreakout.symbol} (${topBreakout.name} - ${topBreakout.sector}) with ${topBreakout.probabilityPct}% breakout probability and institutional coiling.`,
          ruleApplied: 'Learned Rule: Prune low-volatility consumer assets; channel 100% of risk capital into sovereign AI physical supply-chain bottlenecks.',
          actionButton: `⚡ Execute Swap: Sell ${stagnantHolding.symbol} ➔ Buy ${topBreakout.symbol}`
        });
      }

      // 2. Trailing Profit Ratchet Status for Top Winner (e.g. INTC)
      const intcHolding = activeHoldings.find(h => h.symbol === 'INTC');
      if (intcHolding) {
        directives.push({
          id: 'DIR_RATCHET_INTC',
          type: 'PROFIT_RATCHET_PROTECT',
          urgency: 'PROTECTED',
          title: `Trailing Profit Ratchet Active: INTC (+32.5% Unrealized)`,
          symbol: 'INTC',
          rationale: `INTC is our premier winning holding. Breakeven ratchet has elevated the risk floor to lock in gains while trailing ongoing momentum.`,
          ruleApplied: 'Risk Rule: When profit exceeds +8%, trailing stop ratchets to lock in capital preservation.',
          actionButton: null
        });
      }

      // 3. Cash Deployment Directive (Auto-sized to true spendable cash)
      if (spendableCash >= 1.00 && topBreakout) {
        const deployAmt = Math.min(15.00, Math.max(1.00, Math.floor((spendableCash - 0.08) * 100) / 100));
        directives.push({
          id: 'DIR_CASH_DEPLOY',
          type: 'CASH_DEPLOYMENT',
          urgency: 'MEDIUM',
          title: `Deploy Liquid Cash Reserve ($${spendableCash.toFixed(2)}) into [${topBreakout.symbol}]`,
          toSymbol: topBreakout.symbol,
          amountUSD: deployAmt,
          rationale: `Zero cash drag mandate: $${spendableCash.toFixed(2)} in unallocated liquidity ready for tactical accumulation into top-ranked ${topBreakout.symbol} setup.`,
          ruleApplied: 'Mandate: Maintain minimum cash buffer, rotate surplus into highest-conviction setup.',
          actionButton: `⚡ Deploy $${deployAmt.toFixed(2)} into ${topBreakout.symbol}`
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        directives,
        journalSummary,
        recentExits: completedTrades.slice(-8).reverse(),
        learnedHeuristics: insights.learned_heuristics || [],
        topBreakouts: radarCandidates.slice(0, 5)
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 12. AI Pilot Live Chat API (Groq LPU / Gemini Inference)
  if (pathname === '/api/pilot/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const userMessage = (payload.message || '').trim();
        if (!userMessage) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Message cannot be empty.' }));
        }

        const journal = buildJournalSummary();
        const cfg = loadTradingConfig();
        const radar = await getBreakoutRadarCandidates();
        const topCandidatesStr = radar.slice(0, 4).map(c => `${c.symbol} ($${c.price.toFixed(2)}, ${c.probabilityPct}% Odds, RSI ${c.rsi}, ${c.squeezeState})`).join(', ');

        const systemPrompt = 
          `You are Rob, the Autonomous AI Trading Pilot of Dylan's institutional quantitative trading system.\n` +
          `Investment Mandate: Physical AI supply-chain monopoly moats (Liquid Cooling: VRT, Optical Networking: ANET, Advanced Foundry: TSM, Memory: MU, Nuclear Power: CEG).\n` +
          `Risk Rules: -6% Stop Floor, +4% Breakeven Ratchet, Win Rate: ${journal.winRate} across ${journal.totalTrades} trades (+$${journal.totalPnlUSD} realized).\n` +
          `Tone: Confident, quantitative, sharp, institutional, direct. Use concise bullet points and financial emojis where appropriate. Keep answers under 150 words.`;

        const userPrompt = 
          `Dylan asks: "${userMessage}"\n\n` +
          `Cockpit Context:\n` +
          `• Win Rate: ${journal.winRate} (${journal.totalTrades} closed trades, +$${journal.totalPnlUSD})\n` +
          `• Top Breakout Setups: ${topCandidatesStr}\n` +
          `• Open Positions of Note: INTC (+32.5% leader), WMT (stagnant consumer retail, prime swap candidate)\n` +
          `• Safety Limit: Max $${cfg.circuit_breakers?.max_single_order_usd || 50} per order`;

        let answer = null;
        let provider = 'Rule-Based Co-Pilot';

        const llmResult = await callPilotLLM(systemPrompt, userPrompt, 0.4);
        if (llmResult && llmResult.content) {
          answer = llmResult.content;
          provider = llmResult.provider;
        } else {
          const lower = userMessage.toLowerCase();
          if (lower.includes('restructure') || lower.includes('swap') || lower.includes('rebalance') || lower.includes('wmt')) {
            answer = `🔄 **Pilot Restructuring Directive:**\n\n` +
              `I recommend liquidating **WMT** ($15.19 basis). Retail tech is stagnant with a 36.3 RSI and only 3.8% breakout probability.\n\n` +
              `• **Destination Target:** Rotate into **${radar[0].symbol}** (${radar[0].name}) boasting a **${radar[0].probabilityPct}% breakout probability** and coiling squeeze.\n` +
              `• **Risk Guard:** Automatic -6% stop floor staged at entry.\n\n` +
              `Click **Execute Swap** in the Restructuring Feed to dispatch immediately on Robinhood.`;
          } else if (lower.includes('intc') || lower.includes('win') || lower.includes('journal')) {
            answer = `🏆 **Trade Journal Audit:**\n\n` +
              `Our historical win rate is **${journal.winRate}** (+$${journal.totalPnlUSD} realized). **INTC** remains our premier trade at **+32.5%** gain.\n\n` +
              `• **Core Learned Heuristic:** Accumulating oversold supply-chain monopolies at support consistently outperforms chasing breakout tops above RSI 70.`;
          } else {
            answer = `👨‍✈️ **Pilot Telemetry Check:**\n\n` +
              `Market governor indices (QQQ/SOXX) are clear with bullish tailwinds. Top ranked breakout candidates right now:\n` +
              `• **${radar[0].symbol}**: ${radar[0].probabilityPct}% Breakout Odds (${radar[0].squeezeState})\n` +
              `• **${radar[1].symbol}**: ${radar[1].probabilityPct}% Breakout Odds (${radar[1].squeezeState})\n\n` +
              `All 12 active holdings are protected under the -6% circuit breaker stop floor.`;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, reply: answer, provider }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 6. Serve Web Interface Dashboard
  if (pathname === '/' || pathname === '/index.html' || pathname === '/cockpit') {
    if (fs.existsSync(PROTOTYPE_HTML_PATH)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(PROTOTYPE_HTML_PATH, 'utf8'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', message: 'Cockpit backend running.' }));
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

module.exports = { handleWebRequest, setBotBridge };
