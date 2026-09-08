// web_server.js - Embedded Cockpit Dashboard Server & API Dispatcher
const fs = require('fs');
const path = require('path');
const { DEFAULT_HORIZON_THEMES, synthesizeIndustryBasket, auditAndScoreBasket } = require('./engine/industry_etf_synthesizer');
const { loadStrategyInsights } = require('./engine/self_reflection_engine');

const PROTOTYPE_HTML_PATH = path.join(__dirname, 'web_interface_prototype.html');

function handleWebRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Healthcheck
  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', timestamp: Date.now() }));
  }

  // 2. Thematic ETF Horizons API
  if (pathname === '/api/etf/themes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(DEFAULT_HORIZON_THEMES));
  }

  // 3. Strategy Insights API
  if (pathname === '/api/strategy/insights') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(loadStrategyInsights()));
  }

  // 4. Synthesize / Audit ETF Basket API
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

  // 5. Serve Web Interface Dashboard
  if (pathname === '/' || pathname === '/index.html' || pathname === '/cockpit') {
    if (fs.existsSync(PROTOTYPE_HTML_PATH)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(PROTOTYPE_HTML_PATH, 'utf8'));
    }
    // Fallback if prototype HTML is not in directory
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'healthy', message: 'Cockpit backend running.' }));
  }

  // 404 Fallback
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

module.exports = { handleWebRequest };
