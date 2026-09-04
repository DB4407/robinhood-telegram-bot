// engine/pilot_engine.js - Autonomous LLM Pilot for Strategic Trade Management & Journal Learning
const fs = require('fs');
const path = require('path');
const { getCompletedTrades } = require('./trade_logger');
const { loadStrategyInsights } = require('./self_reflection_engine');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'trading_config.json');

function loadTradingConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return { universe: {}, risk: {} };
}

/**
 * Universal Multi-Model LLM Caller (Groq LPU -> Gemini -> Fallback)
 */
async function callPilotLLM(systemPrompt, userPrompt, temperature = 0.4) {
  // 1. Try Groq (Ultra-Fast LPUs: GPT-120B / Qwen 27B)
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const candidateModels = ['openai/gpt-oss-120b', 'groq/compound-mini', 'qwen/qwen3.6-27b'];
    for (const m of candidateModels) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + groqKey
          },
          body: JSON.stringify({
            model: m,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 700,
            temperature: temperature
          })
        });
        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          let text = data.choices[0].message.content || '';
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          if (text) return { provider: 'Groq (' + m + ')', content: text };
        }
      } catch (err) {
        console.warn(`[PILOT ENGINE] Groq (${m}) error:`, err.message);
      }
    }
  }

  // 2. Try Google Gemini API
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const candidateGemini = ['gemini-2.0-flash', 'gemini-1.5-flash'];
    for (const m of candidateGemini) {
      try {
        const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + geminiKey, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { maxOutputTokens: 700, temperature: temperature }
          })
        });
        const data = await res.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts[0].text.trim();
          if (text) return { provider: 'Gemini (' + m + ')', content: text };
        }
      } catch (err) {
        console.warn(`[PILOT ENGINE] Gemini (${m}) error:`, err.message);
      }
    }
  }

  return null;
}

/**
 * Summarizes the historical trade journal into structured experience points
 */
function buildJournalSummary() {
  const completed = getCompletedTrades();
  const insights = loadStrategyInsights();

  const totalTrades = completed.length;
  let wins = 0;
  let losses = 0;
  let totalPnlUSD = 0;
  const symbolStats = {};

  for (const t of completed) {
    const pnl = parseFloat(t.realizedPnlUSD || 0);
    totalPnlUSD += pnl;
    if (pnl >= 0) wins++; else losses++;

    const sym = t.symbol || 'UNKNOWN';
    if (!symbolStats[sym]) symbolStats[sym] = { wins: 0, count: 0, pnl: 0 };
    symbolStats[sym].count++;
    symbolStats[sym].pnl += pnl;
    if (pnl >= 0) symbolStats[sym].wins++;
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : '100.0';
  const recentTrades = completed.slice(-5).map(t => {
    return `${t.symbol}: ${t.exitReason} (${t.realizedPnlPct > 0 ? '+' : ''}${t.realizedPnlPct}%, $${t.realizedPnlUSD})`;
  });

  return {
    totalTrades,
    winRate: `${winRate}%`,
    totalPnlUSD: totalPnlUSD.toFixed(2),
    recentExits: recentTrades.join(', ') || 'No closed exits yet',
    learnedHeuristics: insights.learned_heuristics || [],
    marketRegime: insights.market_regime || 'Bullish Tech Momentum'
  };
}

/**
 * Autonomous Cash Reinvestment Deliberation
 * The AI Pilot analyzes open holdings, spendable cash, sector rotation candidates,
 * telemetry (RSI, volume ratio, squeeze), and past trade lessons to select the optimal allocation.
 */
async function deliberateCashReinvestment({ spendableCash, openPositions, candidatesTelemetry, marketGovernor }) {
  const journal = buildJournalSummary();
  const cfg = loadTradingConfig();

  const heldSymbols = openPositions.map(p => `${p.symbol} (~$${(parseFloat(p.quantity) * parseFloat(p.currentPrice || p.average_buy_price)).toFixed(1)})`).join(', ') || 'None';

  const telemetryStr = candidatesTelemetry.map(c => {
    return `• ${c.symbol} (${c.name} - ${c.sector}): Price $${c.price.toFixed(2)}, RSI ${c.rsi.toFixed(1)}, VolRatio ${c.volRatio.toFixed(1)}x, Squeeze: ${c.isSqueezing ? 'COILING' : 'NORMAL'}`;
  }).join('\n');

  const systemPrompt = 
    `You are the Autonomous AI Pilot of an institutional quantitative trading operation. ` +
    `You operate 24/7, making deliberate capital allocation decisions rather than relying on dumb mechanical lists.\n` +
    `Your investment philosophy: Focus on physical AI supply chain monopoly bottlenecks (Foundries: TSM/INTC, Thermals/Liquid Cooling: VRT, Cluster Networking: ANET, ASICs: MRVL, Power: CEG, Memory: MU).\n` +
    `Your risk discipline: Capital protection first, zero cash drag second. Every trade is actively guarded by a -6% stop-loss floor and +4% breakeven ratchet.\n` +
    `You MUST respond ONLY with a clean JSON object containing your final pilot decision.`;

  const userPrompt = 
    `--- FLIGHT LOG (TRADE JOURNAL MEMORY) ---\n` +
    `• Historical Win Rate: ${journal.winRate} across ${journal.totalTrades} closed trades (Total P&L: +$${journal.totalPnlUSD})\n` +
    `• Recent Trade Exits: ${journal.recentExits}\n` +
    `• Core Learned Heuristics:\n${journal.learnedHeuristics.map(h => '  - ' + h).join('\n')}\n\n` +
    `--- CURRENT COCKPIT TELEMETRY ---\n` +
    `• Market Index Governor (QQQ/SOXX): ${marketGovernor ? (marketGovernor.isRiskOff ? 'DEFENSIVE RISK-OFF' : 'FAVORABLE TECH EXPANSION') : 'NORMAL'}\n` +
    `• Spendable Cash Available: $${spendableCash.toFixed(2)}\n` +
    `• Current Open Holdings: ${heldSymbols}\n\n` +
    `--- CANDIDATE UNIVERSE TELEMETRY ---\n` +
    `${telemetryStr}\n\n` +
    `TASK:\n` +
    `1. Review candidate setups and our current holdings.\n` +
    `2. Select the SINGLE highest-conviction candidate to deploy cash into (typically $10.00 to $20.00, maximum $${Math.min(25, Math.floor(spendableCash))}).\n` +
    `3. Connect your decision to our trade journal and core bottleneck thesis.\n\n` +
    `Return JSON format strictly as:\n` +
    `{\n` +
    `  "action": "BUY",\n` +
    `  "symbol": "<TICKER>",\n` +
    `  "amountUSD": <NUMBER>,\n` +
    `  "thesis": "<1-2 sentence high-conviction pilot rationale>",\n` +
    `  "learnedConnection": "<How this aligns with past journal wins or risk heuristics>",\n` +
    `  "confidence": <0.0 to 1.0>\n` +
    `}`;

  try {
    const result = await callPilotLLM(systemPrompt, userPrompt, 0.3);
    if (result && result.content) {
      let jsonStr = result.content;
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      if (parsed.symbol && parsed.amountUSD) {
        parsed.amountUSD = Math.max(5.00, Math.min(parseFloat(parsed.amountUSD), spendableCash));
        parsed.provider = result.provider;
        return parsed;
      }
    }
  } catch (err) {
    console.error('[PILOT ENGINE] Reinvestment deliberation error:', err.message);
  }

  // Safe Deterministic Fallback if LLM is unavailable
  const fallbackSym = candidatesTelemetry.length > 0 ? candidatesTelemetry[0].symbol : 'VRT';
  return {
    action: 'BUY',
    symbol: fallbackSym,
    amountUSD: Math.min(15.00, Math.floor(spendableCash)),
    thesis: `Deploying fresh cash into ${fallbackSym} infrastructure bottleneck to eliminate cash drag.`,
    learnedConnection: 'Heuristic fallback: prioritizing unheld semiconductor hardware bottlenecks.',
    confidence: 0.75,
    provider: 'Rule-Based Co-Pilot (Fallback)'
  };
}

/**
 * Autonomous Opportunity Deal Evaluation
 * Evaluates a sudden daily mover or breakout setup using LLM intelligence
 * to separate genuine structural catalysts from pump-and-dump dilution.
 */
async function evaluateOpportunityDeal({ symbol, price, changePct, volRatio, rsi, headlines, sentiment }) {
  const headlineStr = (headlines && headlines.length > 0)
    ? headlines.map(h => `• "${h.title}" (${h.publisher})`).join('\n')
    : 'No direct news stories captured.';

  const systemPrompt =
    `You are the Chief AI Risk Officer & Opportunity Scout for an autonomous trading fund. ` +
    `Your goal: Evaluate whether a surging daily mover is a high-probability institutional momentum trade ` +
    `or an exhausted pump-and-dump trap that will breach our -6% stop floor. ` +
    `Respond strictly with valid JSON.`;

  const userPrompt = 
    `Candidate Ticker: ${symbol}\n` +
    `Current Price: $${price.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)\n` +
    `Volume Surge: ${volRatio.toFixed(1)}x 20-day median volume\n` +
    `14-Day Wilder RSI: ${rsi.toFixed(1)}\n` +
    `News Sentiment: ${sentiment.label}\n\n` +
    `Recent Breaking Headlines:\n${headlineStr}\n\n` +
    `Core Rules from Trade Journal:\n` +
    `• We avoid RSI > 68 (buying exhausted tops leads to stop-loss liquidations).\n` +
    `• We demand real fundamental catalysts (contracts, earnings, partnerships) or clean supply-chain synergy.\n\n` +
    `Determine:\n` +
    `1. Is this a genuine high-conviction opportunity or a retail trap?\n` +
    `2. Should we alert the trader on Telegram and add to dynamic sector rotation?\n\n` +
    `Return JSON format strictly as:\n` +
    `{\n` +
    `  "verdict": "APPROVE",\n` +
    `  "rating": "HIGH_CONVICTION",\n` +
    `  "confidence": 0.85,\n` +
    `  "catalystAnalysis": "<1-2 sentence sharp evaluation of the news/volume driver>",\n` +
    `  "recommendedAction": "BUY"\n` +
    `}`;

  try {
    const result = await callPilotLLM(systemPrompt, userPrompt, 0.2);
    if (result && result.content) {
      let jsonStr = result.content;
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      parsed.provider = result.provider;
      return parsed;
    }
  } catch (err) {
    console.error(`[PILOT ENGINE] Opportunity evaluation error for ${symbol}:`, err.message);
  }

  // Fallback heuristic
  const isHealthy = rsi <= 68 && volRatio >= 1.5;
  return {
    verdict: isHealthy ? 'APPROVE' : 'REJECT',
    rating: isHealthy ? 'SPECULATIVE_MOMENTUM' : 'AVOID_EXHAUSTION',
    confidence: isHealthy ? 0.70 : 0.40,
    catalystAnalysis: `Volume spike of ${volRatio.toFixed(1)}x with RSI ${rsi.toFixed(1)}.`,
    recommendedAction: isHealthy ? 'WATCH' : 'PASS',
    provider: 'Rule-Based Scout (Fallback)'
  };
}

/**
 * Generates an executive Pilot Briefing for Telegram
 */
async function generatePilotBriefing(portfolio, openPositions, marketGovernor) {
  const journal = buildJournalSummary();
  const holdingsList = openPositions.map(p => `${p.symbol} (${parseFloat(p.quantity).toFixed(2)} sh)`).join(', ') || 'No active positions';

  const systemPrompt = 
    `You are Rob, the autonomous AI Trading Pilot. ` +
    `Deliver a sharp, confident, executive-level cockpit briefing for the trader's phone. ` +
    `Format in clean GitHub Markdown with punchy bullet points and financial emojis. ` +
    `Keep it under 150 words.`;

  const userPrompt = 
    `Portfolio State: Equity $${parseFloat(portfolio.total_value || 0).toFixed(2)}, Cash $${parseFloat(portfolio.cash || 0).toFixed(2)}\n` +
    `Active Holdings: ${holdingsList}\n` +
    `Market Governor: ${marketGovernor ? (marketGovernor.isRiskOff ? 'DEFENSIVE (Indices pulling back)' : 'BULLISH (Index momentum intact)') : 'NORMAL'}\n` +
    `Trade Journal: ${journal.winRate} win rate across ${journal.totalTrades} closed trades (+$${journal.totalPnlUSD} realized)\n` +
    `Learned Rules: ${journal.learnedHeuristics.slice(0, 2).join('; ')}\n\n` +
    `Provide:\n` +
    `1. Cockpit Status & Macro Assessment\n` +
    `2. Holdings Health & Capital Protection Check\n` +
    `3. Pilot's Next Tactical Move (Where the next cash goes and why)`;

  try {
    const result = await callPilotLLM(systemPrompt, userPrompt, 0.4);
    if (result && result.content) {
      return result.content;
    }
  } catch (e) {}

  return `👨‍✈️ *Autonomous AI Pilot Briefing*\n\n` +
         `🌐 *Cockpit Status:* Tech momentum operating within standard deviation channels.\n` +
         `📊 *Journal Metrics:* ${journal.winRate} win rate across ${journal.totalTrades} closed trades (+$${journal.totalPnlUSD} realized).\n` +
         `🛡️ *Holdings Health:* All ${openPositions.length} positions actively guarded by -6% stop-loss floors and breakeven ratchets.\n` +
         `🎯 *Next Tactical Directive:* Prioritizing liquid cooling (VRT) and cluster networking (ANET) on next cash accumulation.`;
}

module.exports = {
  deliberateCashReinvestment,
  evaluateOpportunityDeal,
  generatePilotBriefing,
  buildJournalSummary
};
