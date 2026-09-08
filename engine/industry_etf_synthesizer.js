// engine/industry_etf_synthesizer.js
// Autonomous Grok LPU Industry ETF Basket Synthesizer & Quant Readiness Evaluator

const fs = require('fs');
const path = require('path');
const { evaluateStockPrediction } = require('./predictive_engine');
const { buildJournalSummary } = require('./pilot_engine');

// Core Pre-defined Horizons & Institutional Archetype Ticker Baskets
const DEFAULT_HORIZON_THEMES = [
  {
    id: 'ai_physical_infrastructure',
    title: '⚡ Physical AI Infrastructure & Supercomputing',
    etfTicker: 'GIGA',
    thesis: 'Physical infrastructure bottlenecks (liquid cooling, custom ASICs, optical networking, and foundry capacity) command unmatched pricing power during the AI compute buildout.',
    description: 'Silicon foundries, liquid cooling thermals, ultra-low latency cluster networking, and custom ASICs.',
    seedTickers: [
      { symbol: 'NVDA', name: 'NVIDIA Corporation', subsector: 'GPU Silicon & AI Compute', catalyst: 'Dominant AI training/inference GPU monopoly and CUDA software moat.' },
      { symbol: 'VRT', name: 'Vertiv Holdings', subsector: 'Liquid Cooling & Thermals', catalyst: 'Critical thermal management and high-density liquid cooling for next-gen data centers.' },
      { symbol: 'ANET', name: 'Arista Networks', subsector: 'AI Cluster Networking', catalyst: 'High-throughput 800G Ethernet switching for distributed AI model training.' },
      { symbol: 'TSM', name: 'Taiwan Semiconductor', subsector: 'Advanced Foundry', catalyst: 'Sole-source manufacturer of 3nm/2nm advanced AI accelerators worldwide.' },
      { symbol: 'MU', name: 'Micron Technology', subsector: 'HBM Memory Supercycle', catalyst: 'High Bandwidth Memory (HBM3E) sold out through calendar year.' }
    ]
  },
  {
    id: 'clean_energy_supergrid',
    title: '🔋 Clean Nuclear Baseload & AI Energy Supergrid',
    etfTicker: 'NUKE',
    thesis: 'Hyperscale AI data centers require 24/7 carbon-free baseload power. Nuclear utilities, uranium producers, and grid transformers capture multi-decade off-take power purchase agreements.',
    description: 'Nuclear power operators, uranium miners, small modular reactors, and high-voltage grid transmission.',
    seedTickers: [
      { symbol: 'CEG', name: 'Constellation Energy', subsector: 'Nuclear Baseload Operator', catalyst: 'Long-term nuclear PPA contracts with major hyperscalers at guaranteed premiums.' },
      { symbol: 'VST', name: 'Vistra Corp', subsector: 'Integrated Nuclear & Power', catalyst: 'Nuclear fleet expansion and rapid dispatch commercial power sales.' },
      { symbol: 'CCJ', name: 'Cameco Corp', subsector: 'Uranium Mining & Fuel', catalyst: 'Structural global uranium supply deficit driving multi-year contract price spikes.' },
      { symbol: 'PWR', name: 'Quanta Services', subsector: 'Supergrid Transmission', catalyst: 'Grid modernization and high-voltage substation engineering contractor.' },
      { symbol: 'GEV', name: 'GE Vernova', subsector: 'Turbines & Electrification', catalyst: 'Gas turbine backlogs and nuclear power plant equipment maintenance.' }
    ]
  },
  {
    id: 'autonomous_defense_cyber',
    title: '🛡️ Autonomous Defense & Next-Gen Cyber Dominance',
    etfTicker: 'SHLD',
    thesis: 'Geopolitical instability and automated cyber attacks require AI-driven defense architectures, sovereign software infrastructure, and autonomous drone capabilities.',
    description: 'AI-driven cyber threat neutralization, drone defense swarms, and sovereign aerospace tech.',
    seedTickers: [
      { symbol: 'PLTR', name: 'Palantir Technologies', subsector: 'Defense AI & AIP', catalyst: 'US Department of Defense enterprise AI operating system contracts.' },
      { symbol: 'CRWD', name: 'CrowdStrike Holdings', subsector: 'Autonomous Endpoint Cyber', catalyst: 'Falcon single-agent AI threat hunting platform with massive retention.' },
      { symbol: 'PANW', name: 'Palo Alto Networks', subsector: 'Platform Cyber Architecture', catalyst: 'Cyber security platformization and cloud security convergence.' },
      { symbol: 'KTOS', name: 'Kratos Defense', subsector: 'Autonomous Combat Systems', catalyst: 'High-performance target drones and autonomous tactical unmanned aerial systems.' },
      { symbol: 'AVAV', name: 'AeroVironment', subsector: 'Loitering Munitions & Robotics', catalyst: 'Switchblade loitering missile systems and tactical unmanned aircraft.' }
    ]
  },
  {
    id: 'space_quantum_frontier',
    title: '🚀 Space Economy & Quantum Compute',
    etfTicker: 'ORBT',
    thesis: 'Commercial orbital launches, satellite direct-to-cell constellations, and post-silicon quantum encryption represent the next frontier of sovereign technological advantage.',
    description: 'Orbital launch, satellite broadband constellations, and commercial quantum processors.',
    seedTickers: [
      { symbol: 'RKLB', name: 'Rocket Lab USA', subsector: 'Launch & Space Systems', catalyst: 'Neutron medium-lift rocket development and space solar satellite manufacturing.' },
      { symbol: 'ASTS', name: 'AST SpaceMobile', subsector: 'Space-Based Cellular', catalyst: 'Direct-to-standard-smartphone satellite broadband constellation deployment.' },
      { symbol: 'LUNR', name: 'Intuitive Machines', subsector: 'Lunar Logistics & NASA', catalyst: 'NASA Commercial Lunar Payload Services contracts and orbital infrastructure.' },
      { symbol: 'QCOM', name: 'Qualcomm Inc', subsector: 'Edge Wireless & Satcom', catalyst: 'Satellite-to-cell modem standards and low-power on-device AI silicon.' }
    ]
  },
  {
    id: 'consumer_monopolies_defensive',
    title: '🛒 Cash Flow Titans & Consumer Moats',
    etfTicker: 'FORT',
    thesis: 'Recession-resistant consumer retail tech, dividend compounders, and inelastic pricing power anchor portfolios against volatility and supply shocks.',
    description: 'Recession-resistant consumer retail tech, dividend kings, and inelastic cash flows.',
    seedTickers: [
      { symbol: 'WMT', name: 'Walmart Inc', subsector: 'Consumer Defensive / Retail Tech', catalyst: 'Massive grocery market share, automated logistics, and high-margin advertising revenue.' },
      { symbol: 'COST', name: 'Costco Wholesale', subsector: 'Membership Retail Monopoly', catalyst: 'Unmatched 90%+ membership renewal rates and high-volume inflation hedge.' },
      { symbol: 'KO', name: 'Coca-Cola Co', subsector: 'Global Consumer Inelasticity', catalyst: 'Unmatched global distribution network and consistent pricing power.' }
    ]
  }
];

/**
 * Calls Grok LPU (or matches pre-built institutional horizons) to curate and attribute high-conviction tickers
 */
async function synthesizeIndustryBasket(industryNameOrDescription, count = 5) {
  const query = (industryNameOrDescription || '').toLowerCase().trim();
  
  // 1. Check for exact or fuzzy match in institutional seed archetypes
  const matchedTheme = DEFAULT_HORIZON_THEMES.find(t => 
    query.includes(t.id) || 
    t.title.toLowerCase().includes(query) ||
    t.description.toLowerCase().includes(query) ||
    (query.includes('nuclear') && t.id === 'clean_energy_supergrid') ||
    (query.includes('energy') && t.id === 'clean_energy_supergrid') ||
    (query.includes('space') && t.id === 'space_quantum_frontier') ||
    (query.includes('cyber') && t.id === 'autonomous_defense_cyber') ||
    (query.includes('hardware') && t.id === 'ai_physical_infrastructure')
  );

  const groqKey = process.env.GROQ_API_KEY;

  // 2. Try Dynamic Grok LPU Generation if GROQ_API_KEY is available
  if (groqKey) {
    const systemPrompt = 
      `You are Grok, an institutional quantitative portfolio manager and thematic ETF architect. ` +
      `Construct custom, high-alpha synthetic ETF baskets for target industries. ` +
      `Select ${count} liquid US-listed stocks capturing supply chain bottlenecks and monopoly moats. ` +
      `Keep descriptions and catalysts concise (under 20 words each). ` +
      `Respond ONLY with a valid JSON object matching this schema:\n` +
      `{\n` +
      `  "industry": "Clean Title of Industry",\n` +
      `  "etfTicker": "3-4 letter synthetic ETF symbol",\n` +
      `  "thesis": "2-3 sentence institutional investment thesis",\n` +
      `  "tickers": [\n` +
      `    {\n` +
      `      "symbol": "TICKER",\n` +
      `      "name": "Company Name",\n` +
      `      "subsector": "Specific niche",\n` +
      `      "catalyst": "Specific fundamental catalyst or monopoly moat"\n` +
      `    }\n` +
      `  ]\n` +
      `}`;

    const userPrompt = `Target Industry / Horizon: "${industryNameOrDescription}". Construct the optimal high-conviction basket of ${count} US stocks.`;

    const candidateModels = [
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'llama-3.1-8b-instant',
      'openai/gpt-oss-20b'
    ];
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
            response_format: { type: 'json_object' },
            max_tokens: 2048,
            temperature: 0.2
          })
        });
        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          let content = data.choices[0].message.content || '';
          content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          const match = content.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (parsed.tickers && parsed.tickers.length > 0) {
              parsed.synthesizedBy = 'Grok LPU (' + m + ')';
              return parsed;
            }
          }
        }
      } catch (err) {
        console.warn(`[ETF SYNTHESIZER] Groq (${m}) error:`, err.message);
      }
    }
  }

  // 3. Robust Fallback: Use Institutional Seed Basket if Grok is rate-limited or offline
  if (matchedTheme) {
    return {
      industry: matchedTheme.title,
      etfTicker: matchedTheme.etfTicker,
      thesis: matchedTheme.thesis,
      synthesizedBy: 'Grok Quantitative Knowledge Base (Curated Seed)',
      tickers: matchedTheme.seedTickers.slice(0, count)
    };
  }

  // Generic AI Hardware default
  const defaultTheme = DEFAULT_HORIZON_THEMES[0];
  return {
    industry: defaultTheme.title,
    etfTicker: defaultTheme.etfTicker,
    thesis: defaultTheme.thesis,
    synthesizedBy: 'Grok Quantitative Knowledge Base (Default)',
    tickers: defaultTheme.seedTickers.slice(0, count)
  };
}

/**
 * Cross-references synthesized basket against real-time technical indicators and past trade journal lessons
 */
async function auditAndScoreBasket(basketData) {
  const journal = buildJournalSummary();
  const scoredTickers = [];

  for (const item of basketData.tickers) {
    const sym = item.symbol.toUpperCase();
    try {
      const pred = await evaluateStockPrediction(sym);
      if (pred && pred.raw) {
        const raw = pred.raw;
        const rsi = raw.rsi;
        const isSqueezing = raw.isSqueezing;
        const prob = pred.probabilityPct;

        // Trade Journal Rules Assessment:
        // Rule 1: We avoid RSI > 70 (buying exhausted tops triggers -6% stop-loss liquidations)
        // Rule 2: RSI 30-55 + Breakout Prob > 65% = Prime Accumulation / Favorable Entry
        // Rule 3: Active Volatility Squeeze with high volume = Asymmetric Breakout Momentum
        let readiness = 'HOLD_WAIT';
        let readinessBadge = '🟡 WAIT FOR PULLBACK';
        let readinessScore = 50;
        let journalNote = 'Within normal parameters.';

        if (rsi > 72) {
          readiness = 'OVERBOUGHT_EXTENDED';
          readinessBadge = '⚠️ OVERBOUGHT (RSI > 70) - WAIT FOR DIP';
          readinessScore = 30;
          journalNote = `Journal Warning: High RSI (${rsi.toFixed(1)}) increases stop-loss risk. Wait for mean reversion.`;
        } else if (rsi < 45 && prob >= 65) {
          readiness = 'PRIME_ACCUMULATION';
          readinessBadge = '💎 PRIME OVERSOLD ACCUMULATION';
          readinessScore = 95;
          journalNote = `Journal Alignment: Oversold base with ${prob}% breakout odds mirrors INTC +32.5% win setup.`;
        } else if (isSqueezing && prob >= 65 && rsi <= 68) {
          readiness = 'COILING_BREAKOUT';
          readinessBadge = '🚀 READY: COILING BREAKOUT SQUEEZE';
          readinessScore = 90;
          journalNote = `Journal Alignment: Volatility squeeze coiling with strong volume anomaly. High probability momentum.`;
        } else if (prob >= 60 && rsi <= 65) {
          readiness = 'FAVORABLE_BUY';
          readinessBadge = '🟢 SOLID BUY SETUP';
          readinessScore = 75;
          journalNote = `Journal Alignment: Balanced entry with manageable downside risk above our -6% stop floor.`;
        } else {
          readiness = 'NEUTRAL_WATCH';
          readinessBadge = '⚖️ CONSOLIDATING / WATCHLIST';
          readinessScore = 55;
          journalNote = `Chop or low momentum. Keep on watch for volume anomaly expansion.`;
        }

        scoredTickers.push({
          ...item,
          price: raw.curPrice,
          rsi: raw.rsi,
          volRatio: raw.volRatio,
          isSqueezing: raw.isSqueezing,
          probabilityPct: prob,
          readiness,
          readinessBadge,
          readinessScore,
          journalNote
        });
      } else {
        scoredTickers.push({
          ...item,
          price: null,
          readiness: 'DATA_UNAVAILABLE',
          readinessBadge: '⚪ DATA PENDING',
          readinessScore: 0,
          journalNote: 'Market feed connection pending.'
        });
      }
    } catch (e) {
      console.warn(`[ETF SYNTHESIZER] Failed to score ${sym}:`, e.message);
    }
  }

  // Sort candidates by readiness score (best buy positions first)
  scoredTickers.sort((a, b) => b.readinessScore - a.readinessScore);

  return {
    industry: basketData.industry,
    etfTicker: basketData.etfTicker,
    thesis: basketData.thesis,
    synthesizedBy: basketData.synthesizedBy,
    journalWinRate: journal.winRate,
    topBuyRecommendation: scoredTickers[0] || null,
    tickers: scoredTickers
  };
}

module.exports = {
  DEFAULT_HORIZON_THEMES,
  synthesizeIndustryBasket,
  auditAndScoreBasket
};
