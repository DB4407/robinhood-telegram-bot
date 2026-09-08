// web_server.js - Embedded Cockpit Dashboard Server & API Dispatcher
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tradeLogger = require('./engine/trade_logger');
const { DEFAULT_HORIZON_THEMES, synthesizeIndustryBasket, auditAndScoreBasket } = require('./engine/industry_etf_synthesizer');
const { loadStrategyInsights } = require('./engine/self_reflection_engine');

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
        const orderRes = await botBridge.callRobinhood('place_equity_order', {
          account_number: rhAccount,
          symbol: symbol,
          side: 'buy',
          type: 'market',
          dollar_amount: amountUSD.toFixed(2),
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
          amountUSD: amountUSD,
          price: parseFloat(ord.price || 0),
          shares: parseFloat(ord.quantity || 0)
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          order: ord,
          message: `🚀 Market Order Dispatched for $${amountUSD.toFixed(2)} of ${symbol}! (State: ${ord.state})`
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
            if (sellRes.data) {
              soldDetail = { symbol: liquidateSymbol, quantity: sellQty, state: sellRes.data.state };
              tradeLogger.logTradeExit(liquidateSymbol, parseFloat(sellRes.data.price || matchPos.average_buy_price), 'THEMATIC_REBALANCE');
            }
          }
        }

        // Step 2: Accumulate target ETF constituent
        const buyRes = await botBridge.callRobinhood('place_equity_order', {
          account_number: rhAccount,
          symbol: targetSymbol,
          side: 'buy',
          type: 'market',
          dollar_amount: amountUSD.toFixed(2),
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
          amountUSD: amountUSD,
          price: parseFloat(ord.price || 0),
          shares: parseFloat(ord.quantity || 0)
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          sold: soldDetail,
          bought: { symbol: targetSymbol, amountUSD: amountUSD, state: ord.state },
          message: `✅ Tactical Rebalance Dispatched! ${soldDetail ? `Liquidated ${soldDetail.quantity} shares of ${soldDetail.symbol} and ` : ''}accumulated $${amountUSD.toFixed(2)} of top-pick ${targetSymbol}.`
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
