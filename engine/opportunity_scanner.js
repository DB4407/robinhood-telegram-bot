// engine/opportunity_scanner.js - Daily Movers Opportunity Scanner & Dynamic Sector Rotation Integrator
const fs = require('fs');
const path = require('path');
const { evaluateStockPrediction } = require('./predictive_engine');
const { evaluateOpportunityDeal } = require('./pilot_engine');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'trading_config.json');
const MOVERS_WATCHLIST_ID = 'eddbebe5-34cc-4df1-953c-d3e3cb55bc19';

// Notification cooldown cache to prevent repetitive spam (4-hour cooldown per ticker)
const alertCooldowns = new Map();

function getTradingConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[OPPORTUNITY SCANNER] Error reading trading_config.json:', e.message);
  }
  return { universe: {}, risk: {} };
}

function saveTradingConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[OPPORTUNITY SCANNER] Error saving trading_config.json:', e.message);
    return false;
  }
}

function getSectorUniverse() {
  const cfg = getTradingConfig();
  if (cfg.universe && Object.keys(cfg.universe).length > 0) {
    return cfg.universe;
  }
  return {
    TSM: { name: 'Taiwan Semi', sector: 'Semiconductor Foundry' },
    NVDA: { name: 'NVIDIA', sector: 'GPU Silicon & AI Compute' },
    INTC: { name: 'Intel', sector: 'US Foundry Turnaround' },
    MRVL: { name: 'Marvell Tech', sector: 'Custom AI ASICs' },
    WMT: { name: 'Walmart', sector: 'Consumer Defensive / Retail Tech' },
    VRT: { name: 'Vertiv Holdings', sector: 'Liquid Cooling & Thermals' },
    ANET: { name: 'Arista Networks', sector: 'AI Cluster Networking' },
    MU: { name: 'Micron Tech', sector: 'HBM Memory Supercycle' },
    CEG: { name: 'Constellation Energy', sector: 'Nuclear AI Power' },
    PLTR: { name: 'Palantir Tech', sector: 'Enterprise AI Software' }
  };
}

function addTickerToSectorRotation(symbol, name = 'Growth Mover', sector = 'Discovered Opportunity') {
  const sym = symbol.toUpperCase().trim();
  const cfg = getTradingConfig();
  if (!cfg.universe) cfg.universe = {};

  if (!cfg.universe[sym]) {
    cfg.universe[sym] = { name, sector };
    saveTradingConfig(cfg);
    console.log('[OPPORTUNITY SCANNER] Added ' + sym + ' to Sector Rotation universe.');
    return true;
  }
  return false;
}

// News Sentiment Analyzer
async function fetchNewsForTicker(symbol, maxStories = 3) {
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + symbol + '&newsCount=' + maxStories, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.news || data.news.length === 0) return [];
    return data.news.slice(0, maxStories).map(n => ({
      title: n.title,
      publisher: n.publisher || 'Wire',
      link: n.link
    }));
  } catch (e) {
    return [];
  }
}

function scoreNewsSentiment(headlines) {
  if (!headlines || headlines.length === 0) return { score: 0, label: 'Neutral (No News)' };

  const bullishKeywords = [
    'surge', 'surges', 'surging', 'jump', 'jumps', 'beat', 'beats', 'soar', 'soars',
    'rise', 'rises', 'gain', 'gains', 'upgrade', 'upgrades', 'upgraded', 'buy', 'buys',
    'profit', 'profits', 'growth', 'rally', 'rallies', 'breakout', 'boost', 'boosts',
    'partnership', 'expansion', 'highs', 'bull', 'bullish', 'exceeds', 'accelerate', 'top'
  ];
  const bearishKeywords = [
    'fall', 'falls', 'drop', 'drops', 'plunge', 'plunges', 'sink', 'sinks', 'miss',
    'misses', 'cut', 'cuts', 'downgrade', 'downgrades', 'sell', 'sells', 'crash',
    'probe', 'lawsuit', 'warn', 'warns', 'warning', 'bankrupt', 'risk', 'lower', 'losses'
  ];

  let bull = 0;
  let bear = 0;

  for (const h of headlines) {
    const lower = (h.title || '').toLowerCase();
    bullishKeywords.forEach(w => { if (new RegExp('\\b' + w + '\\b', 'i').test(lower)) bull++; });
    bearishKeywords.forEach(w => { if (new RegExp('\\b' + w + '\\b', 'i').test(lower)) bear++; });
  }

  const net = bull - bear;
  if (net > 0) return { score: 1, label: 'Bullish Catalyst (' + bull + ' bull / ' + bear + ' bear)' };
  if (net < 0) return { score: -1, label: 'Bearish Headwind (' + bear + ' bear / ' + bull + ' bull)' };
  return { score: 0, label: 'Neutral / Balanced' };
}

/**
 * Scans Robinhood Daily Movers, runs pseudo-neural breakout predictions,
 * cross-checks news sentiment, and returns qualified deals.
 */
async function scanDailyMoversForDeals(callRobinhood) {
  const moversRes = await callRobinhood('get_watchlist_items', { list_id: MOVERS_WATCHLIST_ID });
  if (!moversRes || !moversRes.data || !moversRes.data.items) {
    return { success: false, message: 'Could not fetch daily movers from Robinhood.' };
  }

  const items = moversRes.data.items || [];
  const scanned = [];
  const qualifiedDeals = [];

  for (const item of items.slice(0, 15)) {
    const sym = (item.symbol || '').toUpperCase().trim();
    if (!sym || sym.includes('.') || sym.length > 5) continue;

    try {
      // 1. Prediction Model
      const pred = await evaluateStockPrediction(sym);
      if (!pred) continue;

      const rsi = pred.raw.rsi;
      const isHealthyRsi = rsi <= 68; // Avoid overbought FOMO tops

      // 2. Market News Cross-Check
      const newsStories = await fetchNewsForTicker(sym, 3);
      const sentiment = scoreNewsSentiment(newsStories);

      const candidate = {
        symbol: sym,
        price: pred.raw.curPrice,
        probability: pred.probability,
        probabilityPct: pred.probabilityPct,
        rating: pred.rating,
        action: pred.action,
        rsi: rsi,
        volRatio: pred.raw.volRatio,
        isSqueezing: pred.raw.isSqueezing,
        governor: pred.governor,
        newsStories: newsStories,
        sentiment: sentiment
      };
      scanned.push(candidate);

      // 3. AI Pilot Deliberation & Verification
      const isHighConviction = pred.probability >= 0.70;
      const isMarketSafe = !pred.governor.isRiskOff;

      if (isHighConviction && isHealthyRsi && isMarketSafe) {
        const prevClose = pred.raw.prevClose || pred.raw.curPrice;
        const changePct = prevClose > 0 ? ((pred.raw.curPrice - prevClose) / prevClose) * 100 : 0;
        const pilotEval = await evaluateOpportunityDeal({
          symbol: sym,
          price: pred.raw.curPrice,
          changePct: changePct,
          volRatio: pred.raw.volRatio,
          rsi: rsi,
          headlines: newsStories,
          sentiment: sentiment
        });

        candidate.pilotEval = pilotEval;

        if (pilotEval.verdict === 'APPROVE') {
          // Dynamically add to sector rotation universe
          const added = addTickerToSectorRotation(sym, sym + ' (' + pilotEval.rating + ')', 'AI-Piloted Daily Mover');
          candidate.isNewAddition = added;

          const lastAlert = alertCooldowns.get(sym);
          const shouldAlert = !lastAlert || (Date.now() - lastAlert > 4 * 3600 * 1000);
          if (shouldAlert) {
            alertCooldowns.set(sym, Date.now());
            candidate.triggerTelegramAlert = true;
          }

          qualifiedDeals.push(candidate);
        } else {
          console.log(`[AI PILOT SCOUT] Vetoed ${sym}: ${pilotEval.catalystAnalysis || 'Did not meet institutional quality threshold'}`);
        }
      }
    } catch (err) {
      console.error('[OPPORTUNITY SCANNER] Error scanning ' + sym + ':', err.message);
    }
  }

  return {
    success: true,
    totalScanned: scanned.length,
    scanned: scanned,
    qualifiedDeals: qualifiedDeals
  };
}

module.exports = {
  scanDailyMoversForDeals,
  getSectorUniverse,
  addTickerToSectorRotation,
  fetchNewsForTicker,
  scoreNewsSentiment
};
