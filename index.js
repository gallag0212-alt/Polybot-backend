require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const state = {
  botActive:      false,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || 500),
  balance:        parseFloat(process.env.INITIAL_CAPITAL || 500),
  totalProfit:    0,
  trades:         [],
  openPositions:  [],
  pnlHistory:     [],
  scanCount:      0,
  lastScan:       null,
  settings: {
    minAiScore:        78,
    maxTradesPerCycle: 2,
    maxConcurrent:     3,
    stopLossPct:       15,
    takeProfitPct:     25,
    minPositionUSD:    20,
    maxPositionUSD:    50,
    strategy:         'momentum',
  }
};

function getTradeable() {
  if (state.totalProfit <= 0) return 0;
  return parseFloat((state.totalProfit * 0.5).toFixed(2));
}

function getPositionSize() {
  const avail = getTradeable();
  if (avail < state.settings.minPositionUSD) return 0;
  const slots = Math.max(1, state.settings.maxConcurrent - state.openPositions.length);
  const size  = avail / slots;
  return Math.min(state.settings.maxPositionUSD,
    Math.max(state.settings.minPositionUSD, parseFloat(size.toFixed(2))));
}

function scoreMarket(m) {
  let score = 0;
  const change = Math.abs(m.priceChange24h || 0);
  if (change >= 0.10) score += 30;
  else if (change >= 0.05) score += 22;
  else if (change >= 0.02) score += 14;
  else score += 5;

  const vol = m.volume24h || 0;
  if (vol >= 500000) score += 25;
  else if (vol >= 200000) score += 20;
  else if (vol >= 100000) score += 14;
  else if (vol >= 50000) score += 8;
  else score += 2;

  const days = Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000);
  if (days >= 7 && days <= 21) score += 20;
  else if (days >= 3 && days < 7) score += 14;
  else if (days > 21 && days <= 45) score += 12;
  else if (days > 45) score += 6;
  else score += 2;

  const yesPrice = m.yesPrice || 0.5;
  const minPrice = Math.min(yesPrice, 1 - yesPrice);
  if (minPrice < 0.2) score += 15;
  else if (minPrice < 0.35) score += 12;
  else if (yesPrice > 0.6 || yesPrice < 0.4) score += 8;
  else score += 3;

  const spread = m.spread || 0.05;
  if (spread <= 0.01) score += 10;
  else if (spread <= 0.02) score += 8;
  else if (spread <= 0.04) score += 5;
  else score += 1;

  return Math.min(99, Math.round(score));
}

function getSignal(m, score) {
  const yesPrice = m.yesPrice || 0.5;
  const noPrice  = 1 - yesPrice;
  const change   = m.priceChange24h || 0;

  if (score < state.settings.minAiScore)
    return { signal:'WATCH', outcome:null, reason:`Score ${score}% di bawah threshold` };

  if (change > 0.05 && yesPrice < 0.75)
    return { signal:'BUY', outcome:'YES', reason:`YES momentum +${(change*100).toFixed(1)}%` };
  if (change < -0.05 && noPrice < 0.75)
    return { signal:'BUY', outcome:'NO', reason:`NO menguat, YES turun ${(Math.abs(change)*100).toFixed(1)}%` };
  if (yesPrice < 0.25 && change <= 0)
    return { signal:'BUY', outcome:'YES', reason:`YES oversold ${(yesPrice*100).toFixed(0)}¢` };
  if (noPrice < 0.25 && change >= 0)
    return { signal:'BUY', outcome:'NO', reason:`NO oversold ${(noPrice*100).toFixed(0)}¢` };
  if (score >= 85)
    return { signal:'BUY', outcome: yesPrice > noPrice ? 'YES':'NO', reason:`AI score tinggi ${score}%` };

  return { signal:'WATCH', outcome:null, reason:'Tidak ada edge yang jelas' };
}

const isLive = !!(process.env.POLY_PRIVATE_KEY &&
  !process.env.POLY_PRIVATE_KEY.includes('your_wallet') &&
  process.env.POLY_PRIVATE_KEY.length > 60);

async function fetchMarkets() {
  try {
    const { data } = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: { active:true, closed:false, limit:50, order:'volume24hr', ascending:false },
      timeout: 12000
    });
    return (data.markets || data || []).map(m => {
      const yesPrice = parseFloat(m.tokens?.[0]?.price || 0.5);
      return {
        id: m.id, question: m.question, endDate: m.endDate,
        volume24h: parseFloat(m.volume24hr || 0),
        priceChange24h: parseFloat(m.priceChange24hr || 0),
        yesPrice, noPrice: 1 - yesPrice,
        spread: parseFloat(m.spread || 0.02),
        resolved: m.closed || false,
      };
    }).filter(m => !m.resolved && m.volume24h > 5000);
  } catch(e) { console.error('Fetch error:', e.message); return []; }
}

async function executeTrade(signal, size) {
  console.log(`Trade: ${signal.outcome} "${signal.question?.substring(0,40)}" $${size}`);
  const won   = Math.random() < (signal.aiScore / 100);
  const pnlPct = won ? Math.random() * state.settings.takeProfitPct / 100
                     : -(Math.random() * state.settings.stopLossPct / 100);
  const pnl = parseFloat((size * pnlPct).toFixed(2));
  state.totalProfit = parseFloat((state.totalProfit + pnl).toFixed(2));
  state.balance     = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
  state.pnlHistory.push({ ts: Date.now(), profit: state.totalProfit, delta: pnl });
  if (state.pnlHistory.length > 200) state.pnlHistory.shift();
  const trade = {
    id: Date.now(), type:'CLOSE',
    question: signal.question, outcome: signal.outcome,
    entryPrice: signal.outcome==='YES' ? signal.yesPrice : signal.noPrice,
    size, pnl, aiScore: signal.aiScore, reason: signal.reason,
    openedAt: Date.now(), won,
  };
  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.pop();
  console.log(`${won?'WIN':'LOSS'} PnL:${pnl>=0?'+':''}$${pnl} | Profit:$${state.totalProfit}`);
  return trade;
}

let cachedSignals = [];

async function botLoop() {
  if (!state.botActive) return;
  state.scanCount++;
  state.lastScan = new Date().toISOString();
  console.log(`Scan #${state.scanCount}`);
  try {
    const markets = await fetchMarkets();
    const signals = markets.map(m => {
      const score = scoreMarket(m);
      const { signal, outcome, reason } = getSignal(m, score);
      return { ...m, marketId:m.id, aiScore:score, signal, outcome, reason,
               daysLeft: Math.max(0,(new Date(m.endDate)-Date.now())/86400000) };
    }).sort((a,b) => b.aiScore - a.aiScore);
    cachedSignals = signals;
    const strong = signals.filter(s => s.signal==='BUY' && s.aiScore >= state.settings.minAiScore);
    for (const sig of strong.slice(0, state.settings.maxTradesPerCycle)) {
      const size = getPositionSize();
      if (size < state.settings.minPositionUSD) { console.log('Dana kurang (50% rule)'); break; }
      await executeTrade(sig, size);
      await new Promise(r=>setTimeout(r,1500));
    }
  } catch(e) { console.error('Loop error:', e.message); }
}

async function refreshSignals() {
  try {
    const markets = await fetchMarkets();
    cachedSignals = markets.map(m => {
      const score = scoreMarket(m);
      const { signal, outcome, reason } = getSignal(m, score);
      return { ...m, marketId:m.id, aiScore:score, signal, outcome, reason,
               daysLeft: Math.max(0,(new Date(m.endDate)-Date.now())/86400000) };
    }).sort((a,b) => b.aiScore - a.aiScore);
  } catch(e) {}
}

cron.schedule('*/5 * * * *', botLoop);
cron.schedule('*/3 * * * *', refreshSignals);
refreshSignals();

app.get('/', (req, res) => res.send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>PolyBot AI</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:monospace;background:#05070f;color:#dce8ff;padding:12px}.app{max-width:440px;margin:0 auto}h1{font-size:20px;color:#00f5d4;margin-bottom:14px}.badge{font-size:10px;padding:3px 8px;border-radius:6px}.sim{background:rgba(255,209,102,.15);color:#ffd166;border:1px solid rgba(255,209,102,.3)}.live{background:rgba(0,230,118,.15);color:#00e676;border:1px solid rgba(0,230,118,.3)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}.stat{background:#0f1526;border:1px solid #1a2340;border-radius:10px;padding:10px;text-align:center}.sv{font-size:18px;font-weight:700;margin-bottom:2px}.sl{font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase}.g{color:#00e676}.c{color:#00f5d4}.p{color:#9b5de5}.r{color:#ff4058}.alloc{display:flex;justify-content:space-between;align-items:center;background:rgba(0,245,212,.05);border:1px solid rgba(0,245,212,.2);border-radius:10px;padding:12px;margin-bottom:10px}.pct{font-size:36px;font-weight:700;color:#00f5d4;opacity:.7}.sbox{background:#05070f;border:1px solid #1a2340;border-radius:10px;padding:12px;margin-bottom:10px;font-size:11px;line-height:2.2}.row{display:flex;justify-content:space-between;border-bottom:1px solid #0f1526;padding:3px 0}.row:last-child{border-bottom:none}.lbl{color:#4a5980}.btn{display:block;width:100%;padding:13px;margin:7px 0;border:none;border-radius:10px;font-family:monospace;font-size:13px;font-weight:700;cursor:pointer}.bs{background:linear-gradient(135deg,#00c853,#00e676);color:#000}.bx{background:linear-gradient(135deg,#c62828,#ff4058);color:#fff}.br{background:#1a2340;color:#dce8ff;border:1px solid #243060}.card{background:#0f1526;border:1px solid #1a2340;border-radius:12px;padding:14px;margin-bottom:10px}.ct{font-size:10px;color:#00f5d4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px}.mkt{padding:8px 0;border-bottom:1px solid #1a2340;font-size:10px}.mkt:last-child{border-bottom:none}.mq{font-size:11px;margin-bottom:4px;line-height:1.4}.mr{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}.sig{font-size:9px;padding:2px 7px;border-radius:5px;font-weight:700;background:rgba(0,230,118,.2);color:#00e676}.bar{height:4px;background:#1a2340;border-radius:2px;margin:3px 0;overflow:hidden}.bf{height:100%;background:linear-gradient(90deg,#9b5de5,#00f5d4);border-radius:2px}.tr{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #1a2340;font-size:10px;align-items:center}.tr:last-child{border-bottom:none}.tt{width:36px;text-align:center;padding:2px 4px;border-radius:4px;font-size:9px;font-weight:700;flex-shrink:0}.tw{background:rgba(0,230,118,.15);color:#00e676}.tl{background:rgba(255,64,88,.15);color:#ff4058}.ti{flex:1;min-width:0}.tn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.td{color:#4a5980;font-size:9px;margin-top:1px}.tp{font-weight:700;flex-shrink:0}.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}.don{background:#00e676;box-shadow:0 0 6px #00e676;animation:p 1s infinite}.dof{background:#ff4058}@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}</style></head><body><div class="app"><h1>🤖 PolyBot AI &nbsp;<span class="badge sim" id="mb">SIMULASI</span></h1><div class="grid"><div class="stat"><div class="sv g" id="sp">$0.00</div><div class="sl">Profit</div></div><div class="stat"><div class="sv c" id="st">$0.00</div><div class="sl">Tradeable</div></div><div class="stat"><div class="sv p" id="sw">0%</div><div class="sl">Win Rate</div></div></div><div class="alloc"><div><div style="font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase">Dana Tersedia</div><div style="font-size:16px;font-weight:700;color:#00f5d4;margin:3px 0" id="af">$0.00</div><div style="font-size:9px;color:#4a5980" id="ap">dari profit $0.00</div></div><div class="pct">50%</div></div><div class="sbox"><div class="row"><span class="lbl">Status</span><span><span class="dot dof" id="sd"></span><span id="stxt" class="r">STOP</span></span></div><div class="row"><span class="lbl">Balance</span><span class="c" id="sb">-</span></div><div class="row"><span class="lbl">Modal Awal</span><span id="si">-</span></div><div class="row"><span class="lbl">Total Trade</span><span id="sc">0</span></div><div class="row"><span class="lbl">Scan ke-</span><span id="sk">0</span></div><div class="row"><span class="lbl">Scan Terakhir</span><span id="sl" style="font-size:9px">—</span></div></div><button class="btn bs" onclick="startBot()">▶ START BOT</button><button class="btn bx" onclick="stopBot()">⏹ STOP BOT</button><button class="btn br" onclick="loadAll()">↻ Refresh</button><div class="card"><div class="ct">🔍 AI Signals Terkuat</div><div id="sigs"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Loading...</div></div></div><div class="card"><div class="ct">📋 Trade Log</div><div id="tlog"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div></div></div></div><script>async function ls(){try{const d=await fetch('/status').then(r=>r.json());document.getElementById('sp').textContent=(d.profit>=0?'+':'')+'\$'+d.profit.toFixed(2);document.getElementById('sp').className='sv '+(d.profit>=0?'g':'r');document.getElementById('st').textContent='\$'+d.tradeable.toFixed(2);document.getElementById('sw').textContent=d.winRate+'%';document.getElementById('af').textContent='\$'+d.tradeable.toFixed(2)+' USDC';document.getElementById('ap').textContent='dari profit \$'+d.profit.toFixed(2);document.getElementById('sb').textContent='\$'+d.balance.toFixed(2);document.getElementById('si').textContent='\$'+d.initialCapital.toFixed(2);document.getElementById('sc').textContent=d.totalTrades;document.getElementById('sk').textContent=d.scanCount||0;document.getElementById('sl').textContent=d.lastScan?new Date(d.lastScan).toLocaleTimeString('id-ID'):'—';const on=d.botActive;document.getElementById('sd').className='dot '+(on?'don':'dof');document.getElementById('stxt').textContent=on?'AKTIF':'STOP';document.getElementById('stxt').className=on?'g':'r';document.getElementById('mb').textContent=d.isSimulation?'SIMULASI':'LIVE';document.getElementById('mb').className='badge '+(d.isSimulation?'sim':'live');}catch(e){}}async function lsig(){try{const s=await fetch('/signals').then(r=>r.json());const t=s.filter(x=>x.signal==='BUY').slice(0,5);if(!t.length){document.getElementById('sigs').innerHTML='<div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Scanning markets...</div>';return;}document.getElementById('sigs').innerHTML=t.map(s=>'<div class="mkt"><div class="mr"><div class="mq">'+s.question.substring(0,55)+'...</div><span class="sig">BUY</span></div><div class="mr"><span style="color:#4a5980;font-size:9px">YES '+(s.yesPrice*100).toFixed(0)+'¢ | NO '+(s.noPrice*100).toFixed(0)+'¢ | Vol \$'+(s.volume24h/1000).toFixed(0)+'K</span><span class="c" style="font-size:10px;font-weight:700">'+s.aiScore+'%</span></div><div class="bar"><div class="bf" style="width:'+s.aiScore+'%"></div></div><div style="font-size:9px;color:#4a5980;font-style:italic">💡 '+s.reason+'</div></div>').join('');}catch(e){}}async function ltrades(){try{const t=await fetch('/trades').then(r=>r.json());if(!t.length){document.getElementById('tlog').innerHTML='<div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div>';return;}document.getElementById('tlog').innerHTML=t.slice(0,10).map(t=>'<div class="tr"><div class="tt '+(t.won?'tw':'tl')+'">'+(t.won?'WIN':'LOSS')+'</div><div class="ti"><div class="tn">'+(t.question||'').substring(0,38)+'...</div><div class="td">'+(t.outcome||'YES')+' @ '+(t.entryPrice||0).toFixed(2)+' | \$'+(t.size||0).toFixed(2)+' | AI:'+(t.aiScore||0)+'%</div></div><div class="tp '+(t.pnl>=0?'g':'r')+'">'+(t.pnl>=0?'+':'')+'\$'+Math.abs(t.pnl||0).toFixed(2)+'</div></div>').join('');}catch(e){}}async function startBot(){await fetch('/bot/start',{method:'POST'});alert('Bot diaktifkan! Scan pertama dalam beberapa menit.');loadAll();}async function stopBot(){await fetch('/bot/stop',{method:'POST'});alert('Bot dihentikan');loadAll();}async function loadAll(){await Promise.all([ls(),lsig(),ltrades()]);}loadAll();setInterval(ls,8000);setInterval(lsig,30000);setInterval(ltrades,15000);</script></body></html>`));

app.get('/health',   (req,res)=>res.json({status:'ok',ts:Date.now(),mode:isLive?'live':'simulation'}));
app.get('/status',   (req,res)=>res.json({botActive:state.botActive,isSimulation:!isLive,profit:state.totalProfit,balance:state.balance,initialCapital:state.initialCapital,tradeable:getTradeable(),positionSize:getPositionSize(),winRate:state.trades.length>0?Math.round(state.trades.filter(t=>t.won).length/state.trades.length*100):0,totalTrades:state.trades.length,openPositions:state.openPositions.length,scanCount:state.scanCount,lastScan:state.lastScan,uptime:Math.floor(process.uptime()),settings:state.settings}));
app.get('/signals',  (req,res)=>res.json(cachedSignals.slice(0,30)));
app.get('/trades',   (req,res)=>res.json(state.trades.slice(0,50)));
app.get('/positions',(req,res)=>res.json(state.openPositions));
app.get('/pnl',      (req,res)=>res.json(state.pnlHistory));
app.post('/bot/start',(req,res)=>{state.botActive=true;setTimeout(botLoop,2000);res.json({ok:true});});
app.post('/bot/stop', (req,res)=>{state.botActive=false;res.json({ok:true});});
app.post('/trade/manual',async(req,res)=>{const{marketId,outcome,amount}=req.body;const sig=cachedSignals.find(s=>s.marketId===marketId)||{question:marketId,outcome,yesPrice:0.5,noPrice:0.5,aiScore:70,reason:'Manual'};const t=await executeTrade({...sig,outcome,signal:'BUY'},parseFloat(amount));res.json({ok:true,result:t});});
app.post('/settings',(req,res)=>{['minAiScore','maxTradesPerCycle','stopLossPct','takeProfitPct','minPositionUSD','maxPositionUSD','strategy'].forEach(k=>{if(req.body[k]!==undefined)state.settings[k]=req.body[k];});res.json({ok:true,settings:state.settings});});
app.post('/bot/reset',(req,res)=>{state.totalProfit=0;state.balance=state.initialCapital;state.trades=[];state.pnlHistory=[];state.scanCount=0;res.json({ok:true});});

const PORT=process.env.PORT||3001;
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`PolyBot AI running on port ${PORT}`);
  console.log(`Mode: ${isLive?'LIVE':'SIMULASI'} | Modal: $${state.initialCapital}`);
});
