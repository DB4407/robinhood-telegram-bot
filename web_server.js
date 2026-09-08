// web_server.js - Embedded Cockpit Dashboard Server & API Dispatcher
const fs = require('fs');
const path = require('path');
const { DEFAULT_HORIZON_THEMES, synthesizeIndustryBasket, auditAndScoreBasket } = require('./engine/industry_etf_synthesizer');
const { loadStrategyInsights } = require('./engine/self_reflection_engine');

const PROTOTYPE_HTML_PATH = path.join(__dirname, 'web_interface_prototype.html');

let botBridge = null;
function setBotBridge(bridge) {
  botBridge = bridge;
}

async function handleWebRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Healthcheck
  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now() }));
  }

  // 2. Real-Time Portfolio & Balances Sync
  if (pathname === '/api/portfolio/live') {
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

      const activePositions = [];
      if (pos && pos.data && pos.data.positions) {
        const active = pos.data.positions.filter(item => parseFloat(item.quantity) > 0);
        for (const item of active) {
          activePositions.push({
            symbol: item.symbol,
            quantity: parseFloat(item.quantity),
            average_buy_price: parseFloat(item.average_buy_price || 0)
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        connected: true,
        userName: botBridge.getUserName(),
        telegramId: botBridge.getTelegramId(),
        rhAccount: rhAccount ? '••••' + rhAccount.slice(-4) : 'Auto',
        totalEquity: totalVal,
        cash: cash,
        spendableCash: spendableCash,
        queuedOrders: queuedOrders,
        positions: activePositions
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // 3. Thematic ETF Horizons API
  if (pathname === '/api/etf/themes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(DEFAULT_HORIZON_THEMES));
  }

  // 4. Strategy Insights API
  if (pathname === '/api/strategy/insights') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(loadStrategyInsights()));
  }

  // 5. Synthesize / Audit ETF Basket API
  if (pathname === '/api/etf/audit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const themeQuery = payload.theme || 'ai_physical_infrastructure';
        const basket = await synthesizeIndustryBasket(themeQuery, 5);
        const scored = await auditAndScoreBasket(basket);
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
