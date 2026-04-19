require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(require('express').static(require('path').join(__dirname,'public')));

// State bot
const state = {
  botActive: false,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || 100),
  balance: parseFloat(process.env.INITIAL_CAPITAL || 100),
  totalProfit: 0,
  trades: [],
  openPositions: [],
  pnlHistory: [],
  settings: {
    minAiScore: 75,
    maxTradesPerCycle: 2,
    stopLossPct: 15,
    takeProfitPct: 25,
    strategy: 'momentum'
  }
};

// 50% profit rule
function getTradeable() {
  return state.totalProfit > 0 ? state.totalProfit * 0.5 : 0;
}

// AI scoring
function scoreMarket(m) {
  const yesPrice = m.bestAsk || 0.5;
  const vol = m.volume24h || 0;
  const change = m.priceChange24h || 0;
  const days = Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000);

  let score = 0;
  // Momentum
  score += Math.min(30, Math.abs(change) * 300);
  // Volume
  if (vol > 500000) score += 20;
  else if (vol > 100000) score += 15;
  else if (vol > 50000) score += 10;
  else score += 5;
  // Time decay sweet spot 7-30 days
  if (days >= 7 && days <= 30) score += 20;
  else if (days >= 3) score += 10;
  // Price edge
  if (yesPrice < 0.35 || yesPrice > 0.65) score += 20;
  else score += 5;
  // Spread
  const spread = Math.abs((m.bestAsk||0.5) - (m.bestBid||0.49));
  if (spread < 0.02) score += 10;

  return Math.min(99, Math.round(score));
}

function getSignal(m, score) {
  const yesPrice = m.bestAsk || 0.5;
  const change = m.priceChange24h || 0;
  if (score < 65) return { signal: 'WATCH', outcome: null };
  if (yesPrice < 0.35 && change < 0) return { signal: 'BUY', outcome: 'NO' };
  if (yesPrice > 0.65 && change > 0) return { signal: 'BUY', outcome: 'YES' };
  if (Math.abs(change) > 0.03) return { signal: 'BUY', outcome: change > 0 ? 'YES' : 'NO' };
  if (score >= 80) return { signal: 'BUY', outcome: yesPrice > 0.5 ? 'YES' : 'NO' };
  return { signal: 'WATCH', outcome: null };
}

// Fetch markets dari Polymarket
async function fetchMarkets() {
  try {
    const { data } = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { active: true, closed: false, limit: 50, order: 'volume24hr', ascending: false },
      timeout: 10000
    });
    return (data.markets || data || []).map(m => ({
      id: m.id,
      question: m.question,
      endDate: m.endDate,
      volume24h: parseFloat(m.volume24hr || 0),
      priceChange24h: parseFloat(m.priceChange24hr || 0),
      bestAsk: parseFloat(m.tokens?.[0]?.price || 0.5),
      bestBid: parseFloat(m.tokens?.[0]?.price || 0.5) - 0.01,
      outcomes: [
        { name: 'YES', price: parseFloat(m.tokens?.[0]?.price || 0.5) },
        { name: 'NO',  price: 1 - parseFloat(m.tokens?.[0]?.price || 0.5) }
      ]
    }));
  } catch (e) {
    console.error('Fetch markets error:', e.message);
    return [];
  }
}

// Bot loop
async function botLoop() {
  if (!state.botActive) return;
  console.log('Scanning markets...');
  try {
    const markets = await fetchMarkets();
    const signals = markets.map(m => {
      const score = scoreMarket(m);
      const { signal, outcome } = getSignal(m, score);
      return { ...m, aiScore: score, signal, outcome,
        yesPrice: m.bestAsk, noPrice: 1 - m.bestAsk,
        daysLeft: Math.max(0,(new Date(m.endDate)-Date.now())/86400000),
        confidence: score/100, expectedValue: score > 75 ? 0.05 : 0,
        reason: signal === 'BUY' ? `AI score ${score}%, momentum ${(m.priceChange24h*100).toFixed(1)}%` : 'Menunggu sinyal lebih kuat'
      };
    }).sort((a,b) => b.aiScore - a.aiScore);

    const strong = signals.filter(s => s.aiScore >= state.settings.minAiScore && s.signal === 'BUY');
    console.log(`${strong.length} sinyal kuat dari ${markets.length} markets`);

    // Simulasi eksekusi (tanpa private key = simulasi)
    for (const sig of strong.slice(0, state.settings.maxTradesPerCycle)) {
      const alloc = getTradeable();
      if (alloc < 1) { console.log('Dana tidak cukup (50% profit rule)'); break; }
      const pnl = (Math.random() > 0.3 ? 1 : -1) * alloc * (Math.random() * 0.3);
      state.totalProfit += pnl;
      state.balance = state.initialCapital + state.totalProfit;
      state.pnlHistory.push({ ts: Date.now(), profit: state.totalProfit });
      state.trades.unshift({
        type: 'CLOSE', question: sig.question, outcome: sig.outcome,
        entryPrice: sig.yesPrice, size: alloc, pnl: parseFloat(pnl.toFixed(2)),
        openedAt: Date.now()
      });
      if (state.trades.length > 100) state.trades.pop();
      console.log(`Trade: ${sig.signal} ${sig.outcome} ${sig.question.substring(0,40)} | PnL: $${pnl.toFixed(2)}`);
    }
  } catch (e) { console.error('Bot loop error:', e.message); }
}

// Schedulers
cron.schedule('*/5 * * * *', botLoop);

// Cache signals
let cachedSignals = [];
async function refreshSignals() {
  const markets = await fetchMarkets();
  cachedSignals = markets.map(m => {
    const score = scoreMarket(m);
    const { signal, outcome } = getSignal(m, score);
    return { marketId: m.id, question: m.question, yesPrice: m.bestAsk,
      noPrice: 1 - m.bestAsk, volume: m.volume24h, aiScore: score, signal, outcome,
      daysLeft: Math.max(0,(new Date(m.endDate)-Date.now())/86400000),
      confidence: score/100, expectedValue: score > 75 ? 0.05 : 0,
      reason: signal==='BUY' ? `Momentum ${(m.priceChange24h*100).toFixed(1)}%, score ${score}%` : 'Sinyal belum cukup kuat'
    };
  }).sort((a,b) => b.aiScore - a.aiScore);
}
cron.schedule('*/3 * * * *', refreshSignals);
refreshSignals();

// API
app.get('/health', (req, res) => res.json({ status:'ok', ts:Date.now(), mode:'simulation' }));

app.get('/status', (req, res) => res.json({
  botActive: state.botActive,
  isSimulation: true,
  profit: parseFloat(state.totalProfit.toFixed(2)),
  balance: parseFloat(state.balance.toFixed(2)),
  initialCapital: state.initialCapital,
  tradeable: parseFloat(getTradeable().toFixed(2)),
  moneySummary: {
    initialCapital: state.initialCapital,
    currentBalance: parseFloat(state.balance.toFixed(2)),
    totalProfit: parseFloat(state.totalProfit.toFixed(2)),
    tradeable: parseFloat(getTradeable().toFixed(2)),
  },
  winRate: state.trades.length > 0
    ? Math.round(state.trades.filter(t=>t.pnl>0).length / state.trades.length * 100) : 0,
  totalTrades: state.trades.length,
  openPositions: state.openPositions.length,
  uptime: Math.floor(process.uptime()),
  settings: state.settings
}));

app.get('/signals', (req, res) => res.json(cachedSignals));
app.get('/trades',  (req, res) => res.json(state.trades.slice(0,50)));
app.get('/positions',(req,res)=> res.json(state.openPositions));
app.get('/pnl',     (req, res) => res.json(state.pnlHistory));
app.get('/wallet',  (req, res) => res.json({ simulation:true, balance:state.balance }));
app.get('/logs',    (req, res) => res.json([]));

app.post('/bot/start', (req, res) => {
  state.botActive = true;
  console.log('Bot started');
  botLoop();
  res.json({ ok:true, message:'Bot started' });
});

app.post('/bot/stop', (req, res) => {
  state.botActive = false;
  console.log('Bot stopped');
  res.json({ ok:true, message:'Bot stopped' });
});

app.post('/trade/manual', (req, res) => {
  const { marketId, outcome, amount } = req.body;
  const pnl = (Math.random() > 0.35 ? 1 : -1) * amount * (Math.random() * 0.25);
  state.totalProfit += pnl;
  state.balance = state.initialCapital + state.totalProfit;
  state.trades.unshift({ type:'CLOSE', question: marketId||'Manual trade',
    outcome, entryPrice:0.5, size:amount, pnl:parseFloat(pnl.toFixed(2)), openedAt:Date.now() });
  res.json({ ok:true, result:{ pnl } });
});

app.post('/settings', (req, res) => {
  Object.assign(state.settings, req.body);
  res.json({ ok:true, settings:state.settings });
});

app.post('/bot/reset', (req, res) => {
  state.totalProfit = 0;
  state.balance = state.initialCapital;
  state.trades = [];
  state.pnlHistory = [];
  res.json({ ok:true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`PolyBot running on port ${PORT}`);
  console.log(`Mode: SIMULASI (tambah POLY_PRIVATE_KEY untuk live trading)`);
});
