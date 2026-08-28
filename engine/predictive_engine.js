// engine/predictive_engine.js - Pseudo-Neural Predictive Probability Scorer & Market Index Governor
const fs = require("fs");
const path = require("path");
const { extractFeatures } = require("./feature_pipeline");

const WEIGHTS_PATH = path.join(__dirname, "..", "data", "model_weights.json");
const CONFIG_PATH = path.join(__dirname, "..", "config", "trading_config.json");

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_PATH)) {
      return JSON.parse(fs.readFileSync(WEIGHTS_PATH, "utf8"));
    }
  } catch (err) {}
  return {
    features: {
      volumeAnomaly: 1.25,
      rsiState: -0.75,
      momentum5d: 1.10,
      volatilitySqueeze: 1.45,
      trendAlignment: 1.15,
      squeezeVolumeInteraction: 1.85,
      sentimentFactor: 0.85
    },
    bias: -0.45
  };
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, z))));
}

// Market Index Governor: Monitors QQQ (Nasdaq) and SOXX (Semiconductors)
async function checkMarketGovernor() {
  try {
    const resQqq = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=1d&range=5d", { headers: { "User-Agent": "Mozilla/5.0" } });
    const resSoxx = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SOXX?interval=1d&range=5d", { headers: { "User-Agent": "Mozilla/5.0" } });
    let qqqChg = 0, soxxChg = 0;
    if (resQqq.ok) {
      const d = await resQqq.json();
      const c = d.chart.result[0].indicators.quote[0].close.filter(x => x !== null);
      if (c.length >= 2) qqqChg = ((c[c.length - 1] - c[c.length - 2]) / c[c.length - 2]) * 100;
    }
    if (resSoxx.ok) {
      const d = await resSoxx.json();
      const c = d.chart.result[0].indicators.quote[0].close.filter(x => x !== null);
      if (c.length >= 2) soxxChg = ((c[c.length - 1] - c[c.length - 2]) / c[c.length - 2]) * 100;
    }
    const isRiskOff = (qqqChg < -1.5 && soxxChg < -1.5);
    return {
      isRiskOff,
      qqqChangePct: Number(qqqChg.toFixed(2)),
      soxxChangePct: Number(soxxChg.toFixed(2)),
      status: isRiskOff ? "⚠️ RESTRICTED (Tech / Semi Panic Selling)" : "🟢 CLEAR (Market Tailwinds Active)"
    };
  } catch (e) {
    return { isRiskOff: false, qqqChangePct: 0, soxxChangePct: 0, status: "🟢 CLEAR (Default Safe)" };
  }
}

async function evaluateStockPrediction(symbol, sentimentScore = 0.0) {
  const featData = await extractFeatures(symbol);
  if (!featData) return null;

  const weights = loadWeights();
  const f = featData.features;
  f.sentimentFactor = Number(Math.max(-1, Math.min(1, sentimentScore)).toFixed(4));

  // Linear combination of multi-factor features
  let z = weights.bias || -0.45;
  const contributions = {};
  for (const [key, val] of Object.entries(f)) {
    const w = (weights.features && weights.features[key] !== undefined) ? weights.features[key] : 1.0;
    const contribution = val * w;
    z += contribution;
    contributions[key] = Number(contribution.toFixed(4));
  }

  let prob = sigmoid(z);

  // Apply Market Index Governor
  const gov = await checkMarketGovernor();
  if (gov.isRiskOff) {
    prob = prob * 0.75; // 25% confidence penalty during market dump
  }
  prob = Number(Math.max(0.01, Math.min(0.99, prob)).toFixed(4));

  let rating = "🔴 LOW PROBABILITY";
  let action = "AVOID / WAIT";
  if (prob >= 0.70) {
    rating = "🟢 HIGH CONVICTION BREAKOUT";
    action = "STRONG BUY / SCALE IN";
  } else if (prob >= 0.50) {
    rating = "🟡 MODERATE CONVICTION";
    action = "WATCH / ACCUMULATE DIP";
  }

  return {
    symbol: symbol.toUpperCase(),
    probability: prob,
    probabilityPct: Number((prob * 100).toFixed(1)),
    rating,
    action,
    governor: gov,
    features: f,
    raw: featData.raw,
    contributions
  };
}

module.exports = {
  evaluateStockPrediction,
  checkMarketGovernor,
  loadWeights
};
