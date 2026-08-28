// engine/feature_pipeline.js

async function fetchHistoricalBars(symbol) {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=3mo", {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart.result[0];
    if (!result || !result.indicators || !result.indicators.quote) return null;
    const quotes = result.indicators.quote[0];
    const closes = (quotes.close || []).filter(c => c !== null && !isNaN(c));
    const highs = (quotes.high || []).filter(h => h !== null && !isNaN(h));
    const lows = (quotes.low || []).filter(l => l !== null && !isNaN(l));
    const volumes = (quotes.volume || []).filter(v => v !== null && !isNaN(v));
    if (closes.length < 20) return null;
    return { closes, highs, lows, volumes };
  } catch (err) {
    console.error("[FEATURE PIPELINE] Error fetching bars for " + symbol + ":", err.message);
    return null;
  }
}

function standardDeviation(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
  return Math.sqrt(variance);
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - (100 / (1 + rs))).toFixed(2));
}

function calculateATR(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return 1;
  const trs = [];
  for (let i = n - period; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

async function extractFeatures(symbol) {
  const bars = await fetchHistoricalBars(symbol);
  if (!bars) return null;
  const { closes, highs, lows, volumes } = bars;
  const n = closes.length;
  const curPrice = closes[n - 1];
  const curVolume = volumes[volumes.length - 1] || 1;
  const rsi = calculateRSI(closes, 14);
  const rsiState = Number(((50 - rsi) / 50).toFixed(4));
  const sliceVol = volumes.slice(-20);
  const sortedVol = sliceVol.slice().sort((a, b) => a - b);
  const medianVol = sortedVol[Math.floor(sortedVol.length / 2)] || 1;
  const volRatio = curVolume / medianVol;
  const volumeAnomaly = Number(Math.max(-1, Math.min(1, (volRatio - 1) / 2)).toFixed(4));
  const price5dAgo = closes[Math.max(0, n - 6)];
  const roc5d = ((curPrice - price5dAgo) / price5dAgo) * 100;
  const momentum5d = Number(Math.max(-1, Math.min(1, roc5d / 10)).toFixed(4));
  const slice20 = closes.slice(-20);
  const sma20 = slice20.reduce((a, b) => a + b, 0) / 20;
  const std20 = standardDeviation(slice20);
  const bbWidth = (2 * std20) / (sma20 || 1);
  const atr = calculateATR(highs, lows, closes, 14);
  const atrRatio = atr / (curPrice || 1);
  const isSqueezing = bbWidth < (atrRatio * 2.2);
  const volatilitySqueeze = isSqueezing ? 1.0 : Number(Math.max(-1, Math.min(1, (atrRatio * 2.2 - bbWidth) / atrRatio)).toFixed(4));
  const slice50 = closes.slice(-Math.min(50, n));
  const sma50 = slice50.reduce((a, b) => a + b, 0) / slice50.length;
  const trendAlignment = (curPrice > sma20 && sma20 > sma50) ? 1.0 : (curPrice < sma20 && sma20 < sma50 ? -1.0 : 0.0);
  const squeezeVolumeInteraction = Number((volatilitySqueeze * Math.max(0, volumeAnomaly)).toFixed(4));
  return {
    symbol: symbol.toUpperCase(),
    features: {
      volumeAnomaly,
      rsiState,
      momentum5d,
      volatilitySqueeze,
      trendAlignment,
      squeezeVolumeInteraction,
      sentimentFactor: 0.0
    },
    raw: {
      curPrice: Number(curPrice.toFixed(2)),
      rsi,
      volume: curVolume,
      medianVolume: medianVol,
      volRatio: Number(volRatio.toFixed(2)),
      roc5dPct: Number(roc5d.toFixed(2)),
      sma20: Number(sma20.toFixed(2)),
      sma50: Number(sma50.toFixed(2)),
      isSqueezing
    }
  };
}

module.exports = { fetchHistoricalBars, extractFeatures, calculateRSI };
