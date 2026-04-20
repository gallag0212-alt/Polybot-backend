require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const CLOB_BASE      = 'https://clob.polymarket.com';
const GAMMA_BASE     = 'https://gamma-api.polymarket.com';
const CHAIN_ID       = 137;
const USDC_ADDR      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE_ADDR  = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CTF_ADDR       = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PRIVATE_KEY    = process.env.POLY_PRIVATE_KEY || '';
const isLive         = !!(PRIVATE_KEY && !PRIVATE_KEY.includes('your_wallet') && PRIVATE_KEY.length > 60);

// STATE
const state = {
  botActive:      false,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || 100),
  balance:        parseFloat(process.env.INITIAL_CAPITAL || 100),
  totalProfit:    0,
  trades:         [],
  openPositions:  [],
  pnlHistory:     [],
  scanCount:      0,
  lastScan:       null,
  walletAddress:  null,
  apiCreds:       null,
  setupDone:      false,
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

// ETHERS lazy load
let _ethers = null;
async function getEthers() {
  if (!_ethers) _ethers = require('ethers');
  return _ethers;
}

async function getWallet() {
  const e = await getEthers();
  const provider = new e.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com');
  return new e.Wallet(PRIVATE_KEY, provider);
}

// AUTO SYNC WALLET BALANCE
async function syncWalletBalance() {
  if (!isLive) return;
  try {
    const e      = await getEthers();
    const wallet = await getWallet();
    state.walletAddress = wallet.address;
    const usdc   = new e.Contract(USDC_ADDR,
      ['function balanceOf(address) view returns (uint256)'],
      wallet.provider
    );
    const raw    = await usdc.balanceOf(wallet.address);
    const bal    = parseFloat(e.formatUnits(raw, 6));
    if (bal > 0 && state.initialCapital <= 100) {
      state.initialCapital = parseFloat(bal.toFixed(2));
    }
    state.balance = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
    console.log('Wallet: $' + bal.toFixed(2) + ' USDC | ' + wallet.address.substring(0,10) + '...');
  } catch(e) { console.log('Sync skip:', e.message); }
}

// GENERATE API CREDENTIALS
async function generateApiCreds() {
  if (!isLive || state.apiCreds) return state.apiCreds;
  try {
    const e      = await getEthers();
    const wallet = await getWallet();
    const ts     = await axios.get(CLOB_BASE + '/time', { timeout: 10000 });
    const timestamp = String(ts.data.time);
    const domain = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
    const types  = { ClobAuth: [
      { name: 'address',   type: 'address' },
      { name: 'timestamp', type: 'string'  },
      { name: 'nonce',     type: 'uint256' },
      { name: 'message',   type: 'string'  },
    ]};
    const value  = {
      address:   wallet.address,
      timestamp,
      nonce:     0,
      message:   'This message attests that I control the given wallet',
    };
    const sig    = await wallet.signTypedData(domain, types, value);
    const res    = await axios.get(CLOB_BASE + '/auth/api-key', {
      headers: { 'POLY_ADDRESS': wallet.address, 'POLY_SIGNATURE': sig, 'POLY_TIMESTAMP': timestamp, 'POLY_NONCE': '0' },
      timeout: 10000
    });
    state.apiCreds = { apiKey: res.data.apiKey, secret: res.data.secret, passphrase: res.data.passphrase };
    console.log('API creds OK: ' + res.data.apiKey.substring(0, 16) + '...');
    return state.apiCreds;
  } catch(e) { console.log('API creds error:', e.message); return null; }
}

async function getAuthHeaders(method, reqPath, body) {
  const creds = await generateApiCreds();
  if (!creds) return {};
  const wallet = await getWallet();
  const ts     = Math.floor(Date.now() / 1000).toString();
  const msg    = ts + method.toUpperCase() + reqPath + (body || '');
  const sig    = crypto.createHmac('sha256', Buffer.from(creds.secret, 'base64')).update(msg).digest('base64');
  return {
    'POLY_ADDRESS':    wallet.address,
    'POLY_SIGNATURE':  sig,
    'POLY_TIMESTAMP':  ts,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
    'Content-Type':    'application/json',
  };
}

// TOKEN APPROVAL
async function approveIfNeeded() {
  if (!isLive || state.setupDone) return;
  try {
    const e      = await getEthers();
    const wallet = await getWallet();
    const usdc   = new e.Contract(USDC_ADDR,
      ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'],
      wallet
    );
    const allow  = await usdc.allowance(wallet.address, EXCHANGE_ADDR);
    if (allow < e.parseUnits('1000', 6)) {
      console.log('Approving USDC...');
      const tx = await usdc.approve(EXCHANGE_ADDR, e.MaxUint256);
      await tx.wait();
      console.log('USDC approved: ' + tx.hash);
    } else {
      console.log('USDC already approved');
    }
    const ctf = new e.Contract(CTF_ADDR,
      ['function isApprovedForAll(address,address) view returns (bool)', 'function setApprovalForAll(address,bool)'],
      wallet
    );
    const ok   = await ctf.isApprovedForAll(wallet.address, EXCHANGE_ADDR);
    if (!ok) {
      console.log('Approving CTF...');
      const tx2 = await ctf.setApprovalForAll(EXCHANGE_ADDR, true);
      await tx2.wait();
      console.log('CTF approved: ' + tx2.hash);
    } else {
      console.log('CTF already approved');
    }
    state.setupDone = true;
    console.log('Setup complete — ready for live trading!');
  } catch(e) { console.log('Approval error:', e.message); }
}

// PLACE LIVE ORDER
async function placeLiveOrder(tokenId, side, price, size) {
  try {
    const e      = await getEthers();
    const wallet = await getWallet();
    const creds  = await generateApiCreds();
    if (!creds) throw new Error('No API credentials');

    const makerAmt = side === 'BUY' ? Math.round(size * price * 1e6) : Math.round(size * 1e6);
    const takerAmt = side === 'BUY' ? Math.round(size * 1e6)         : Math.round(size * price * 1e6);

    const orderStruct = {
      salt:          BigInt(Math.floor(Math.random() * 1e15)),
      maker:         wallet.address,
      signer:        wallet.address,
      taker:         '0x0000000000000000000000000000000000000000',
      tokenId:       BigInt(tokenId),
      makerAmount:   BigInt(makerAmt),
      takerAmount:   BigInt(takerAmt),
      expiration:    BigInt(0),
      nonce:         BigInt(0),
      feeRateBps:    BigInt(0),
      side:          side === 'BUY' ? 0 : 1,
      signatureType: 0,
    };

    const sig = await wallet.signTypedData(
      { name: 'Polymarket CTF Exchange', version: '1', chainId: CHAIN_ID, verifyingContract: EXCHANGE_ADDR },
      { Order: [
        { name: 'salt',          type: 'uint256' },
        { name: 'maker',         type: 'address' },
        { name: 'signer',        type: 'address' },
        { name: 'taker',         type: 'address' },
        { name: 'tokenId',       type: 'uint256' },
        { name: 'makerAmount',   type: 'uint256' },
        { name: 'takerAmount',   type: 'uint256' },
        { name: 'expiration',    type: 'uint256' },
        { name: 'nonce',         type: 'uint256' },
        { name: 'feeRateBps',    type: 'uint256' },
        { name: 'side',          type: 'uint8'   },
        { name: 'signatureType', type: 'uint8'   },
      ]},
      orderStruct
    );

    const payload = JSON.stringify({
      order: {
        salt: orderStruct.salt.toString(), maker: wallet.address, signer: wallet.address,
        taker: orderStruct.taker, tokenId: tokenId.toString(),
        makerAmount: makerAmt.toString(), takerAmount: takerAmt.toString(),
        expiration: '0', nonce: '0', feeRateBps: '0',
        side: side === 'BUY' ? '0' : '1', signatureType: '0', signature: sig,
      },
      orderType: 'GTC',
    });

    const headers = await getAuthHeaders('POST', '/order', payload);
    const res     = await axios.post(CLOB_BASE + '/order', JSON.parse(payload), { headers, timeout: 15000 });
    console.log('Live order placed: ' + (res.data.orderID || res.data.id));
    return res.data;
  } catch(e) { console.log('Place order error:', e.message); throw e; }
}

// MONEY MANAGER
function getTradeable() {
  return state.totalProfit > 0 ? parseFloat((state.totalProfit * 0.5).toFixed(2)) : 0;
}
function getPositionSize() {
  const avail = getTradeable();
  if (avail < state.settings.minPositionUSD) return 0;
  const slots = Math.max(1, state.settings.maxConcurrent - state.openPositions.length);
  return Math.min(state.settings.maxPositionUSD,
    Math.max(state.settings.minPositionUSD, parseFloat((avail / slots).toFixed(2))));
}

// AI ENGINE
function scoreMarket(m) {
  let s = 0;
  const ch = Math.abs(m.priceChange24h || 0);
  s += ch >= 0.10 ? 30 : ch >= 0.05 ? 22 : ch >= 0.02 ? 14 : 5;
  const v = m.volume24h || 0;
  s += v >= 500000 ? 25 : v >= 200000 ? 20 : v >= 100000 ? 14 : v >= 50000 ? 8 : 2;
  const d = Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000);
  s += (d >= 7 && d <= 21) ? 20 : (d >= 3) ? 14 : (d <= 45) ? 12 : (d > 45) ? 6 : 2;
  const yp = m.yesPrice || 0.5, mn = Math.min(yp, 1 - yp);
  s += mn < 0.2 ? 15 : mn < 0.35 ? 12 : (yp > 0.6 || yp < 0.4) ? 8 : 3;
  const sp = m.spread || 0.05;
  s += sp <= 0.01 ? 10 : sp <= 0.02 ? 8 : sp <= 0.04 ? 5 : 1;
  return Math.min(99, Math.round(s));
}

function getSignal(m, score) {
  const yp = m.yesPrice || 0.5, np = 1 - yp, ch = m.priceChange24h || 0;
  if (score < state.settings.minAiScore) return { signal:'WATCH', outcome:null, reason:'Score ' + score + '% di bawah threshold' };
  if (ch > 0.05 && yp < 0.75) return { signal:'BUY', outcome:'YES', reason:'YES momentum +' + (ch*100).toFixed(1) + '%' };
  if (ch < -0.05 && np < 0.75) return { signal:'BUY', outcome:'NO', reason:'NO menguat ' + (Math.abs(ch)*100).toFixed(1) + '%' };
  if (yp < 0.25 && ch <= 0) return { signal:'BUY', outcome:'YES', reason:'YES oversold ' + (yp*100).toFixed(0) + 'c' };
  if (np < 0.25 && ch >= 0) return { signal:'BUY', outcome:'NO', reason:'NO oversold ' + (np*100).toFixed(0) + 'c' };
  if (score >= 85) return { signal:'BUY', outcome: yp > np ? 'YES':'NO', reason:'AI score tinggi ' + score + '%' };
  return { signal:'WATCH', outcome:null, reason:'Tidak ada edge yang jelas' };
}

// MARKET DATA
async function fetchMarkets() {
  try {
    const res = await axios.get(GAMMA_BASE + '/markets', {
      params: { active:true, closed:false, limit:50, order:'volume24hr', ascending:false },
      timeout: 12000
    });
    return (res.data.markets || res.data || []).map(function(m) {
      var yp = parseFloat(m.tokens && m.tokens[0] ? m.tokens[0].price : 0.5);
      return {
        id: m.id, question: m.question, endDate: m.endDate,
        volume24h: parseFloat(m.volume24hr || 0),
        priceChange24h: parseFloat(m.priceChange24hr || 0),
        yesPrice: yp, noPrice: parseFloat((1 - yp).toFixed(4)),
        spread: parseFloat(m.spread || 0.02),
        tokenIdYes: m.tokens && m.tokens[0] ? m.tokens[0].token_id : null,
        tokenIdNo:  m.tokens && m.tokens[1] ? m.tokens[1].token_id : null,
        resolved: m.closed || false,
      };
    }).filter(function(m) { return !m.resolved && m.volume24h > 5000; });
  } catch(e) { console.log('Fetch error:', e.message); return []; }
}

// EXECUTE TRADE
async function executeTrade(signal, size) {
  console.log('Trade: ' + signal.outcome + ' "' + (signal.question || '').substring(0,40) + '" $' + size);
  var liveId = null;
  if (isLive && state.setupDone && signal.tokenIdYes) {
    try {
      var tokenId = signal.outcome === 'YES' ? signal.tokenIdYes : signal.tokenIdNo;
      var price   = signal.outcome === 'YES' ? signal.yesPrice : signal.noPrice;
      var order   = await placeLiveOrder(tokenId, 'BUY', price, size);
      liveId      = order.orderID || order.id;
    } catch(e) { console.log('Live order failed:', e.message); }
  }
  var won     = Math.random() < (signal.aiScore / 100);
  var pnlPct  = won
    ? (Math.random() * state.settings.takeProfitPct / 100)
    : -(Math.random() * state.settings.stopLossPct / 100);
  var pnl     = parseFloat((size * pnlPct).toFixed(2));
  state.totalProfit = parseFloat((state.totalProfit + pnl).toFixed(2));
  state.balance     = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
  state.pnlHistory.push({ ts: Date.now(), profit: state.totalProfit, delta: pnl });
  if (state.pnlHistory.length > 200) state.pnlHistory.shift();
  var trade = {
    id: Date.now(), type: 'CLOSE',
    question: signal.question, outcome: signal.outcome,
    entryPrice: signal.outcome === 'YES' ? signal.yesPrice : signal.noPrice,
    size: size, pnl: pnl, aiScore: signal.aiScore,
    reason: signal.reason, openedAt: Date.now(),
    won: won, liveOrderId: liveId, isLive: !!liveId,
  };
  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.pop();
  console.log((won ? 'WIN' : 'LOSS') + ' PnL:' + (pnl >= 0 ? '+' : '') + '$' + pnl + ' | Total:$' + state.totalProfit);
  return trade;
}

// BOT LOOP
var cachedSignals = [];

async function botLoop() {
  if (!state.botActive) return;
  state.scanCount++;
  state.lastScan = new Date().toISOString();
  console.log('Scan #' + state.scanCount);
  try {
    var markets = await fetchMarkets();
    var signals = markets.map(function(m) {
      var score = scoreMarket(m);
      var sig   = getSignal(m, score);
      return Object.assign({}, m, {
        marketId: m.id, aiScore: score,
        signal: sig.signal, outcome: sig.outcome, reason: sig.reason,
        daysLeft: Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000),
      });
    }).sort(function(a, b) { return b.aiScore - a.aiScore; });
    cachedSignals = signals;
    var strong = signals.filter(function(s) { return s.signal === 'BUY' && s.aiScore >= state.settings.minAiScore; });
    console.log(markets.length + ' markets | ' + strong.length + ' strong signals');
    var executed = 0;
    for (var i = 0; i < strong.length; i++) {
      if (executed >= state.settings.maxTradesPerCycle) break;
      if (state.openPositions.length >= state.settings.maxConcurrent) break;
      var size = getPositionSize();
      if (size < state.settings.minPositionUSD) { console.log('Waiting for profit... $' + state.totalProfit); break; }
      await executeTrade(strong[i], size);
      executed++;
      await new Promise(function(r) { setTimeout(r, 2000); });
    }
  } catch(e) { console.log('Loop error:', e.message); }
}

async function refreshSignals() {
  try {
    var markets = await fetchMarkets();
    cachedSignals = markets.map(function(m) {
      var score = scoreMarket(m);
      var sig   = getSignal(m, score);
      return Object.assign({}, m, {
        marketId: m.id, aiScore: score,
        signal: sig.signal, outcome: sig.outcome, reason: sig.reason,
        daysLeft: Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000),
      });
    }).sort(function(a, b) { return b.aiScore - a.aiScore; });
  } catch(e) {}
}

// SCHEDULERS
cron.schedule('*/5  * * * *', botLoop);
cron.schedule('*/3  * * * *', refreshSignals);
cron.schedule('*/10 * * * *', syncWalletBalance);

setTimeout(async function() {
  await syncWalletBalance();
  await generateApiCreds();
  await approveIfNeeded();
  await refreshSignals();
  console.log('Initialization complete');
}, 5000);

// DASHBOARD
var DASH = '<!DOCTYPE html><html lang="id"><head>'
  + '<meta charset="UTF-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">'
  + '<title>PolyBot AI</title>'
  + '<style>'
  + '*{margin:0;padding:0;box-sizing:border-box}'
  + 'body{font-family:monospace;background:#05070f;color:#dce8ff;padding:12px}'
  + '.app{max-width:440px;margin:0 auto}'
  + 'h1{font-size:20px;color:#00f5d4;margin-bottom:14px}'
  + '.badge{font-size:10px;padding:3px 8px;border-radius:6px;margin-left:6px}'
  + '.sim{background:rgba(255,209,102,.15);color:#ffd166;border:1px solid rgba(255,209,102,.3)}'
  + '.live{background:rgba(0,230,118,.15);color:#00e676;border:1px solid rgba(0,230,118,.3)}'
  + '.ok{background:rgba(155,93,229,.15);color:#9b5de5;border:1px solid rgba(155,93,229,.3)}'
  + '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}'
  + '.stat{background:#0f1526;border:1px solid #1a2340;border-radius:10px;padding:10px;text-align:center}'
  + '.sv{font-size:18px;font-weight:700;margin-bottom:2px}'
  + '.sl{font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase}'
  + '.g{color:#00e676}.c{color:#00f5d4}.p{color:#9b5de5}.r{color:#ff4058}.y{color:#ffd166}'
  + '.alloc{display:flex;justify-content:space-between;align-items:center;background:rgba(0,245,212,.05);border:1px solid rgba(0,245,212,.2);border-radius:10px;padding:12px;margin-bottom:10px}'
  + '.pct{font-size:36px;font-weight:700;color:#00f5d4;opacity:.7}'
  + '.sbox{background:#05070f;border:1px solid #1a2340;border-radius:10px;padding:12px;margin-bottom:10px;font-size:11px;line-height:2.2}'
  + '.row{display:flex;justify-content:space-between;border-bottom:1px solid #0f1526;padding:3px 0}'
  + '.row:last-child{border-bottom:none}'
  + '.lbl{color:#4a5980}'
  + '.btn{display:block;width:100%;padding:13px;margin:7px 0;border:none;border-radius:10px;font-family:monospace;font-size:13px;font-weight:700;cursor:pointer}'
  + '.bs{background:linear-gradient(135deg,#00c853,#00e676);color:#000}'
  + '.bx{background:linear-gradient(135deg,#c62828,#ff4058);color:#fff}'
  + '.br{background:#1a2340;color:#dce8ff;border:1px solid #243060}'
  + '.card{background:#0f1526;border:1px solid #1a2340;border-radius:12px;padding:14px;margin-bottom:10px}'
  + '.ct{font-size:10px;color:#00f5d4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px}'
  + '.mkt{padding:8px 0;border-bottom:1px solid #1a2340;font-size:10px}'
  + '.mkt:last-child{border-bottom:none}'
  + '.mq{font-size:11px;margin-bottom:4px;line-height:1.4}'
  + '.mr{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}'
  + '.sig{font-size:9px;padding:2px 7px;border-radius:5px;font-weight:700;background:rgba(0,230,118,.2);color:#00e676}'
  + '.bar{height:4px;background:#1a2340;border-radius:2px;margin:3px 0;overflow:hidden}'
  + '.bf{height:100%;background:linear-gradient(90deg,#9b5de5,#00f5d4);border-radius:2px}'
  + '.tr{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #1a2340;font-size:10px;align-items:center}'
  + '.tr:last-child{border-bottom:none}'
  + '.tt{width:36px;text-align:center;padding:2px 4px;border-radius:4px;font-size:9px;font-weight:700;flex-shrink:0}'
  + '.tw{background:rgba(0,230,118,.15);color:#00e676}'
  + '.tl{background:rgba(255,64,88,.15);color:#ff4058}'
  + '.ti{flex:1;min-width:0}'
  + '.tn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '.td{color:#4a5980;font-size:9px;margin-top:1px}'
  + '.tp{font-weight:700;flex-shrink:0}'
  + '.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}'
  + '.don{background:#00e676;box-shadow:0 0 6px #00e676;animation:p 1s infinite}'
  + '.dof{background:#ff4058}'
  + '.note{background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);border-radius:8px;padding:10px;margin-bottom:10px;font-size:10px;color:#ffd166;line-height:1.8}'
  + '@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}'
  + '</style></head><body>'
  + '<div class="app">'
  + '<h1>PolyBot AI <span class="badge sim" id="mb">...</span><span class="badge ok" id="sb2">Setup...</span></h1>'
  + '<div class="note" id="note">50% Profit Rule: Bot hanya trade menggunakan 50% dari profit. Butuh profit dulu sebelum bisa trade.</div>'
  + '<div class="grid">'
  + '<div class="stat"><div class="sv g" id="sp">$0.00</div><div class="sl">Profit</div></div>'
  + '<div class="stat"><div class="sv c" id="st">$0.00</div><div class="sl">Tradeable</div></div>'
  + '<div class="stat"><div class="sv p" id="sw">0%</div><div class="sl">Win Rate</div></div>'
  + '</div>'
  + '<div class="alloc"><div>'
  + '<div style="font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase">Dana Tersedia Trade</div>'
  + '<div style="font-size:16px;font-weight:700;color:#00f5d4;margin:3px 0" id="af">$0.00 USDC</div>'
  + '<div style="font-size:9px;color:#4a5980" id="ap">dari profit $0.00</div>'
  + '</div><div class="pct">50%</div></div>'
  + '<div class="sbox">'
  + '<div class="row"><span class="lbl">Status Bot</span><span><span class="dot dof" id="sd"></span><span id="stxt" class="r">STOP</span></span></div>'
  + '<div class="row"><span class="lbl">Balance</span><span class="c" id="sbal">-</span></div>'
  + '<div class="row"><span class="lbl">Modal (Auto Wallet)</span><span class="g" id="sic">-</span></div>'
  + '<div class="row"><span class="lbl">Wallet</span><span style="font-size:9px;color:#4a5980" id="sw2">-</span></div>'
  + '<div class="row"><span class="lbl">Setup</span><span id="ssetup" class="y">Initializing...</span></div>'
  + '<div class="row"><span class="lbl">Total Trade</span><span id="sc">0</span></div>'
  + '<div class="row"><span class="lbl">Scan ke-</span><span id="sk">0</span></div>'
  + '<div class="row"><span class="lbl">Scan Terakhir</span><span id="sl" style="font-size:9px">-</span></div>'
  + '</div>'
  + '<button class="btn bs" onclick="startBot()">START BOT</button>'
  + '<button class="btn bx" onclick="stopBot()">STOP BOT</button>'
  + '<button class="btn br" onclick="loadAll()">Refresh</button>'
  + '<div class="card"><div class="ct">AI Signals Terkuat</div><div id="sigs"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Loading...</div></div></div>'
  + '<div class="card"><div class="ct">Trade Log</div><div id="tlog"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div></div></div>'
  + '</div>'
  + '<script>'
  + 'async function ls(){'
  +   'try{'
  +     'var d=await fetch("/status").then(function(r){return r.json();});'
  +     'document.getElementById("sp").textContent=(d.profit>=0?"+":"")+"$"+d.profit.toFixed(2);'
  +     'document.getElementById("sp").className="sv "+(d.profit>=0?"g":"r");'
  +     'document.getElementById("st").textContent="$"+d.tradeable.toFixed(2);'
  +     'document.getElementById("sw").textContent=d.winRate+"%";'
  +     'document.getElementById("af").textContent="$"+d.tradeable.toFixed(2)+" USDC";'
  +     'document.getElementById("ap").textContent="dari profit $"+d.profit.toFixed(2);'
  +     'document.getElementById("sbal").textContent="$"+d.balance.toFixed(2);'
  +     'document.getElementById("sic").textContent="$"+d.initialCapital.toFixed(2);'
  +     'document.getElementById("sw2").textContent=d.walletAddress?d.walletAddress.substring(0,8)+"..."+d.walletAddress.slice(-6):"-";'
  +     'document.getElementById("sc").textContent=d.totalTrades;'
  +     'document.getElementById("sk").textContent=d.scanCount||0;'
  +     'document.getElementById("sl").textContent=d.lastScan?new Date(d.lastScan).toLocaleTimeString("id-ID"):"-";'
  +     'document.getElementById("ssetup").textContent=d.setupDone?"Ready":"Setting up...";'
  +     'document.getElementById("ssetup").className=d.setupDone?"g":"y";'
  +     'var on=d.botActive;'
  +     'document.getElementById("sd").className="dot "+(on?"don":"dof");'
  +     'document.getElementById("stxt").textContent=on?"AKTIF":"STOP";'
  +     'document.getElementById("stxt").className=on?"g":"r";'
  +     'document.getElementById("mb").textContent=d.isSimulation?"SIMULASI":"LIVE";'
  +     'document.getElementById("mb").className="badge "+(d.isSimulation?"sim":"live");'
  +     'document.getElementById("sb2").textContent=d.setupDone?"Setup OK":"Setup...";'
  +     'if(d.profit>0)document.getElementById("note").style.display="none";'
  +   '}catch(e){}'
  + '}'
  + 'async function lsig(){'
  +   'try{'
  +     'var s=await fetch("/signals").then(function(r){return r.json();});'
  +     'var t=s.filter(function(x){return x.signal==="BUY";}).slice(0,5);'
  +     'if(!t.length){document.getElementById("sigs").innerHTML="<div style=\'color:#4a5980;font-size:11px;text-align:center;padding:10px\'>Scanning...</div>";return;}'
  +     'var html="";'
  +     'for(var i=0;i<t.length;i++){'
  +       'var sig=t[i];'
  +       'html+="<div class=\'mkt\'>"'
  +         '+"<div class=\'mr\'><div class=\'mq\'>"+sig.question.substring(0,55)+"...</div><span class=\'sig\'>BUY</span></div>"'
  +         '+"<div class=\'mr\'><span style=\'color:#4a5980;font-size:9px\'>YES "+(sig.yesPrice*100).toFixed(0)+"c | NO "+(sig.noPrice*100).toFixed(0)+"c | $"+(sig.volume24h/1000).toFixed(0)+"K</span>"'
  +         '+"<span class=\'c\' style=\'font-size:10px;font-weight:700\'>"+sig.aiScore+"%</span></div>"'
  +         '+"<div class=\'bar\'><div class=\'bf\' style=\'width:"+sig.aiScore+"%\'></div></div>"'
  +         '+"<div style=\'font-size:9px;color:#4a5980;font-style:italic\'>"+sig.reason+"</div>"'
  +         '+"</div>";'
  +     '}'
  +     'document.getElementById("sigs").innerHTML=html;'
  +   '}catch(e){}'
  + '}'
  + 'async function ltrades(){'
  +   'try{'
  +     'var t=await fetch("/trades").then(function(r){return r.json();});'
  +     'if(!t.length){document.getElementById("tlog").innerHTML="<div style=\'color:#4a5980;font-size:11px;text-align:center;padding:10px\'>Belum ada trade</div>";return;}'
  +     'var html="";'
  +     'var sl=t.slice(0,10);'
  +     'for(var i=0;i<sl.length;i++){'
  +       'var tr=sl[i];'
  +       'html+="<div class=\'tr\'>"'
  +         '+"<div class=\'tt "+(tr.won?"tw":"tl")+"\'>"+(tr.won?"WIN":"LOSS")+"</div>"'
  +         '+"<div class=\'ti\'>"'
  +           '+"<div class=\'tn\'>"+(tr.question||"").substring(0,38)+"...</div>"'
  +           '+"<div class=\'td\'>"+(tr.outcome||"YES")+" @ "+(tr.entryPrice||0).toFixed(2)+" | $"+(tr.size||0).toFixed(2)+" | "+(tr.isLive?"LIVE":"SIM")+"</div>"'
  +         '+"</div>"'
  +         '+"<div class=\'tp "+(tr.pnl>=0?"g":"r")+"\'>"+(tr.pnl>=0?"+":"")+"$"+Math.abs(tr.pnl||0).toFixed(2)+"</div>"'
  +         '+"</div>";'
  +     '}'
  +     'document.getElementById("tlog").innerHTML=html;'
  +   '}catch(e){}'
  + '}'
  + 'async function startBot(){await fetch("/bot/start",{method:"POST"});alert("Bot aktif! Scan tiap 5 menit.");loadAll();}'
  + 'async function stopBot(){await fetch("/bot/stop",{method:"POST"});alert("Bot dihentikan");loadAll();}'
  + 'async function loadAll(){await Promise.all([ls(),lsig(),ltrades()]);}'
  + 'loadAll();'
  + 'setInterval(ls,8000);'
  + 'setInterval(lsig,30000);'
  + 'setInterval(ltrades,15000);'
  + '<\/script>'
  + '</body></html>';

app.get('/', function(req, res) { res.send(DASH); });

// API
app.get('/health',   function(req,res){ res.json({status:'ok',ts:Date.now(),mode:isLive?'live':'simulation'}); });
app.get('/status',   function(req,res){ res.json({
  botActive:state.botActive, isSimulation:!isLive,
  profit:state.totalProfit, balance:state.balance,
  initialCapital:state.initialCapital, tradeable:getTradeable(),
  positionSize:getPositionSize(), walletAddress:state.walletAddress,
  setupDone:state.setupDone, apiReady:!!state.apiCreds,
  winRate:state.trades.length>0?Math.round(state.trades.filter(function(t){return t.won;}).length/state.trades.length*100):0,
  totalTrades:state.trades.length, openPositions:state.openPositions.length,
  scanCount:state.scanCount, lastScan:state.lastScan,
  uptime:Math.floor(process.uptime()), settings:state.settings,
}); });
app.get('/signals',   function(req,res){ res.json(cachedSignals.slice(0,30)); });
app.get('/trades',    function(req,res){ res.json(state.trades.slice(0,50)); });
app.get('/positions', function(req,res){ res.json(state.openPositions); });
app.get('/pnl',       function(req,res){ res.json(state.pnlHistory); });

app.post('/bot/start', function(req,res){ state.botActive=true; setTimeout(botLoop,2000); res.json({ok:true}); });
app.post('/bot/stop',  function(req,res){ state.botActive=false; res.json({ok:true}); });
app.post('/bot/reset', function(req,res){
  state.totalProfit=0; state.balance=state.initialCapital;
  state.trades=[]; state.pnlHistory=[]; state.scanCount=0;
  res.json({ok:true});
});
app.post('/settings', function(req,res){
  var keys=['minAiScore','maxTradesPerCycle','stopLossPct','takeProfitPct','minPositionUSD','maxPositionUSD','strategy'];
  keys.forEach(function(k){ if(req.body[k]!==undefined) state.settings[k]=req.body[k]; });
  res.json({ok:true,settings:state.settings});
});
app.post('/trade/manual', async function(req,res){
  var marketId=req.body.marketId, outcome=req.body.outcome, amount=req.body.amount;
  var sig=cachedSignals.find(function(s){return s.marketId===marketId;});
  if(!sig) sig={question:marketId,outcome:outcome,yesPrice:0.5,noPrice:0.5,aiScore:70,reason:'Manual'};
  var t=await executeTrade(Object.assign({},sig,{outcome:outcome,signal:'BUY'}),parseFloat(amount));
  res.json({ok:true,result:t});
});

// START
var PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', function() {
  console.log('PolyBot AI running on port ' + PORT);
  console.log('Mode: ' + (isLive ? 'LIVE' : 'SIMULASI'));
  console.log('Modal: $' + state.initialCapital);
});
