// engine/crypto_sandbox.js - 24/7 Crypto Quantitative Sandbox & Strategy Simulator
const fs = require('fs');
const path = require('path');

const TOP_5_CRYPTOS = [
  { symbol: 'BTC-USD', name: 'Bitcoin' },
  { symbol: 'ETH-USD', name: 'Ethereum' },
  { symbol: 'SOL-USD', name: 'Solana' },
  { symbol: 'XRP-USD', name: 'Ripple' },
  { symbol: 'DOGE-USD', name: 'Dogecoin' }
];

const SANDBOX_DATA_PATH = path.join(__dirname, '..', 'data', 'crypto_sandbox_journal.jsonl');

function standardDeviation(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
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

// Fetch historical candles from Coinbase Exchange public API (supports 900 = 15m, 3600 = 1h)
async function fetchCandles(symbol, granularity = 3600, limit = 350) {
  try {
    const res = await fetch('https://api.exchange.coinbase.com/products/' + symbol + '/candles?granularity=' + granularity, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.slice(0, limit).reverse().map(c => ({
      time: c[0] * 1000,
      iso: new Date(c[0] * 1000).toISOString(),
      low: c[1],
      high: c[2],
      open: c[3],
      close: c[4],
      volume: c[5]
    }));
  } catch (err) {
    console.error('[CRYPTO SANDBOX] Error fetching ' + symbol + ':', err.message);
    return null;
  }
}

/**
 * Runs a Replay Simulation across the Top 5 Cryptos
 * supports interval: '15m' (granularity 900) or '1h' (granularity 3600)
 */
async function runCryptoSimulation(options = {}) {
  const interval = options.interval || '1h';
  const granularity = interval === '15m' ? 900 : 3600;
  const tradeSizeUSD = options.tradeSizeUSD || 20.0;
  const stopLossPct = options.stopLossPct || 0.06;
  const ratchetPct = options.ratchetPct || 0.04;
  const takeProfitPct = options.takeProfitPct || 0.08;
  const simHours = options.hours || 24;

  // Number of candles to simulate
  const barsToSim = interval === '15m' ? Math.min(300, simHours * 4) : Math.min(300, simHours);

  const simulationResults = [];
  let totalDeployedCapital = 0;
  let totalRealizedProfitUSD = 0;

  for (const asset of TOP_5_CRYPTOS) {
    const sym = asset.symbol;
    const needed = Math.min(350, barsToSim + 35);
    const candles = await fetchCandles(sym, granularity, needed);
    if (!candles || candles.length < 35) continue;

    const startIndex = Math.max(25, candles.length - barsToSim);
    let inPosition = false;
    let position = null;

    for (let i = startIndex; i < candles.length; i++) {
      const currentCandle = candles[i];
      const lookbackCloses = candles.slice(i - 20, i).map(c => c.close);
      const lookbackHighs = candles.slice(i - 20, i).map(c => c.high);
      const lookbackLows = candles.slice(i - 20, i).map(c => c.low);
      const lookbackVolumes = candles.slice(i - 20, i).map(c => c.volume);

      const curPrice = currentCandle.close;
      const rsi = calculateRSI(lookbackCloses, 14);
      const atr = calculateATR(lookbackHighs, lookbackLows, lookbackCloses, 14);
      const sma20 = lookbackCloses.reduce((a, b) => a + b, 0) / lookbackCloses.length;
      const std20 = standardDeviation(lookbackCloses);
      const bbWidth = (2 * std20) / (sma20 || 1);
      const atrRatio = atr / (curPrice || 1);
      const isSqueezing = bbWidth < (atrRatio * 2.1);

      const medianVol = lookbackVolumes.slice().sort((a, b) => a - b)[Math.floor(lookbackVolumes.length / 2)] || 1;
      const volRatio = currentCandle.volume / medianVol;
      const momentum3bars = ((curPrice - candles[i - 3].close) / candles[i - 3].close) * 100;

      // 1. POSITION MANAGEMENT
      if (inPosition) {
        const pnlPct = (curPrice - position.entryPrice) / position.entryPrice;

        // Breakeven ratchet check (+4%)
        if (pnlPct >= ratchetPct && !position.isRatcheted) {
          position.isRatcheted = true;
        }

        // Take-Profit Check (+8%)
        if (pnlPct >= takeProfitPct) {
          const trimProceeds = (position.shares * 0.50) * curPrice;
          const trimProfit = trimProceeds - (position.costUSD * 0.50);
          totalRealizedProfitUSD += trimProfit;
          position.realizedProfitUSD += trimProfit;
          position.costUSD *= 0.50;
          position.shares *= 0.50;

          simulationResults.push({
            symbol: sym,
            name: asset.name,
            action: 'TAKE_PROFIT (50% Trim)',
            entryTime: position.entryTime,
            exitTime: currentCandle.iso,
            entryPrice: position.entryPrice,
            exitPrice: curPrice,
            pnlPct: Number((pnlPct * 100).toFixed(2)),
            pnlUSD: Number(trimProfit.toFixed(2)),
            trigger: 'Hit +' + (takeProfitPct * 100) + '% Profit Target'
          });

          position.isRatcheted = true;
        }

        // Stop-Loss or Breakeven Exit Check
        // In 15m, use dynamic ATR floor to prevent wick outs
        const dynamicStop = interval === '15m' ? Math.max(0.05, Math.min(0.08, (atr * 2.2) / position.entryPrice)) : stopLossPct;
        const effectiveStopPrice = position.isRatcheted ? position.entryPrice : (position.entryPrice * (1 - dynamicStop));

        if (currentCandle.low <= effectiveStopPrice) {
          const exitPrice = effectiveStopPrice;
          const exitProceeds = position.shares * exitPrice;
          const tradePnl = exitProceeds - position.costUSD;
          totalRealizedProfitUSD += tradePnl;

          simulationResults.push({
            symbol: sym,
            name: asset.name,
            action: position.isRatcheted ? 'BREAKEVEN_EXIT' : 'STOP_LOSS',
            entryTime: position.entryTime,
            exitTime: currentCandle.iso,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            pnlPct: Number((((exitPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2)),
            pnlUSD: Number(tradePnl.toFixed(2)),
            trigger: position.isRatcheted ? 'Breakeven Floor Hit ($0 Loss Protected)' : 'Hit Stop-Loss'
          });

          inPosition = false;
          position = null;
        }
      }

      // 2. ENTRY SIGNAL DETECTION
      if (!inPosition) {
        const isEntrySignal = volRatio >= 1.25 && rsi >= 35 && rsi <= 68 && momentum3bars > 0;

        if (isEntrySignal) {
          inPosition = true;
          totalDeployedCapital += tradeSizeUSD;
          position = {
            symbol: sym,
            entryTime: currentCandle.iso,
            entryPrice: curPrice,
            costUSD: tradeSizeUSD,
            shares: tradeSizeUSD / curPrice,
            isRatcheted: false,
            realizedProfitUSD: 0
          };

          simulationResults.push({
            symbol: sym,
            name: asset.name,
            action: 'HYPOTHETICAL_BUY',
            entryTime: currentCandle.iso,
            exitTime: 'ACTIVE_RUNNER',
            entryPrice: curPrice,
            exitPrice: curPrice,
            pnlPct: 0.0,
            pnlUSD: 0.0,
            trigger: 'Vol Burst ' + volRatio.toFixed(1) + 'x | RSI ' + rsi.toFixed(1) + ' | Coiling Setup'
          });
        }
      }
    }

    // Mark-to-market open holdings
    if (inPosition && position) {
      const lastPrice = candles[candles.length - 1].close;
      const unrealizedPnlPct = ((lastPrice - position.entryPrice) / position.entryPrice) * 100;
      const unrealizedUSD = (position.shares * lastPrice) - position.costUSD;

      simulationResults.push({
        symbol: sym,
        name: asset.name,
        action: 'OPEN_HOLDING',
        entryTime: position.entryTime,
        exitTime: 'Current Market Price',
        entryPrice: position.entryPrice,
        exitPrice: lastPrice,
        pnlPct: Number(unrealizedPnlPct.toFixed(2)),
        pnlUSD: Number(unrealizedUSD.toFixed(2)),
        trigger: 'Still active in sandbox (Unrealized ' + (unrealizedPnlPct >= 0 ? '+' : '') + unrealizedPnlPct.toFixed(2) + '%)'
      });
    }
  }

  const closedTrades = simulationResults.filter(t => t.action !== 'HYPOTHETICAL_BUY' && t.action !== 'OPEN_HOLDING');
  let wins = 0;
  let losses = 0;
  for (const ct of closedTrades) {
    if (ct.pnlUSD >= 0) wins++; else losses++;
  }

  const netClosedProfit = closedTrades.reduce((a, b) => a + b.pnlUSD, 0);
  const openHoldings = simulationResults.filter(t => t.action === 'OPEN_HOLDING');
  const netUnrealizedProfit = openHoldings.reduce((a, b) => a + b.pnlUSD, 0);
  const totalNetValue = netClosedProfit + netUnrealizedProfit;
  const overallROI = totalDeployedCapital > 0 ? (totalNetValue / totalDeployedCapital) * 100 : 0;

  return {
    interval,
    testPeriodHours: simHours,
    barsSimulated: barsToSim,
    totalDeployedCapital: Number(totalDeployedCapital.toFixed(2)),
    netClosedProfitUSD: Number(netClosedProfit.toFixed(2)),
    netUnrealizedProfitUSD: Number(netUnrealizedProfit.toFixed(2)),
    totalNetGainUSD: Number(totalNetValue.toFixed(2)),
    totalROI: Number(overallROI.toFixed(2)),
    totalTradesTriggered: simulationResults.filter(t => t.action === 'HYPOTHETICAL_BUY').length,
    closedExits: closedTrades.length,
    wins,
    losses,
    winRatePct: closedTrades.length > 0 ? Number(((wins / closedTrades.length) * 100).toFixed(1)) : 100.0,
    tradeLog: simulationResults
  };
}

module.exports = {
  TOP_5_CRYPTOS,
  runCryptoSimulation,
  run24HourCryptoSimulation: runCryptoSimulation,
  fetchCandles
};
