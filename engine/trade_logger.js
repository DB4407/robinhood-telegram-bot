const fs = require('fs');
const path = require('path');

const JOURNAL_PATH = path.join(__dirname, '..', 'data', 'trades_journal.jsonl');

function appendJournalEntry(record) {
  try {
    const dir = path.dirname(JOURNAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(JOURNAL_PATH, line, 'utf8');
  } catch (err) {
    console.error('[TRADE LOGGER ERROR]:', err.message);
  }
}

function getCompletedTrades() {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  try {
    const lines = fs.readFileSync(JOURNAL_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l)).filter(t => t.type === 'EXIT');
  } catch (err) {
    return [];
  }
}

function logTradeEntry(data) {
  const entry = {
    id: 'TRD_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    type: 'ENTRY',
    timestamp: new Date().toISOString(),
    symbol: (data.symbol || '').toUpperCase(),
    side: data.side || 'buy',
    shares: parseFloat(data.shares || 0),
    entryPrice: parseFloat(data.price || 0),
    amountUSD: parseFloat(data.amountUSD || 0),
    snapshot: {
      rsi: data.rsi !== undefined ? parseFloat(data.rsi) : null,
      volumeRatio: data.volumeRatio !== undefined ? parseFloat(data.volumeRatio) : null,
      predictedProbability: data.probability !== undefined ? parseFloat(data.probability) : null,
      features: data.features || null
    }
  };
  appendJournalEntry(entry);
  console.log('[TRADE JOURNAL] Logged ENTRY for ' + entry.symbol + ' ($' + entry.amountUSD.toFixed(2) + ')');
  return entry;
}

function logTradeExit(data) {
  const exit = {
    id: 'EXT_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
    type: 'EXIT',
    timestamp: new Date().toISOString(),
    symbol: (data.symbol || '').toUpperCase(),
    exitPrice: parseFloat(data.exitPrice || 0),
    exitReason: data.exitReason || 'MANUAL',
    realizedPnlUSD: parseFloat(data.realizedPnlUD || 0),
    realizedPnlPct: parseFloat(data.realizedPnlPct || 0),
    durationHours: parseFloat(data.durationHours || 0),
    features: data.features || null,
    predictedProbability: data.predictedProbability || null,
    isWin: (parseFloat(data.realizedPnlPct || 0) > 0) ? 1 : 0
  };
  appendJournalEntry(exit);
  console.log('[TRADE JOURNAL] Logged EXIT for ' + exit.symbol + ' (' + (exit.realizedPnlPct >= 0 ? '+' : '') + exit.realizedPnlPct.toFixed(2) + '%) - Reason: ' + exit.exitReason);
  return exit;
}

module.exports = {
  logTradeEntry,
  logTradeExit,
  getCompletedTrades,
  JOURNAL_PATH
};