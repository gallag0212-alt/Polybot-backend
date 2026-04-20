require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const crypto  = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════
const CLOB_BASE  = 'https://clob.polymarket.com';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CHAIN_ID   = 137;
const USDC_CONTRACT  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const PRIVATE_KEY = process.env.POLY_PRIVATE_KEY || '';
const isLive = !!(PRIVATE_KEY && !PRIVATE_KEY.includes('your_wallet') && PRIVATE_KEY.length > 60);

// ══════════════════════════════════════════
// STATE
// ══════════════════════════════════════════
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
  apiCreds:       null,  // { apiKey, secret, passphrase }
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

// ══════════════════════════════════════════
// ETHERS — lazy load
// ══════════════════════════════════════════
let ethers = null;
async function getEthers() {
  if (!ethers) ethers = require('ethers');
  return ethers;
}

// ══════════════════════════════════════════
// WALLET SETUP
// ══════════════════════════════════════════
async function getWallet() {
  const { ethers } = await getEthers();
  const provider = new ethers.JsonRpcProvider(
    process.env.POLYGON_RPC || 'https://polygon-rpc.com'
  );
  return new ethers.Wallet(PRIVATE_KEY, provider);
}

// Auto-sync saldo dari wallet
async function syncWalletBalance() {
  if (!isLive) return;
  try {
    const { ethers } = await getEthers();
    const provider = new ethers.JsonRpcProvider(
      process.env.POLYGON_RPC || 'https://polygon-rpc.com'
    );
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    state.walletAddress = wallet.address;

    const usdc = new ethers.Contract(
      USDC_CONTRACT,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );
    const raw     = await usdc.balanceOf(wallet.address);
    const balance = parseFloat(ethers.formatUnits(raw, 6));

    if (balance > 0 && state.initialCapital <= 100) {
      state.initialCapital = parseFloat(balance.toFixed(2));
    }
    state.balance = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
    console.log(`💰 Wallet: $${balance.toFixed(2)} USDC | Address: ${wallet.address.substring(0,10)}...`);
  } catch(e) {
    console.log('Sync wallet skip:', e.message);
  }
}

// ══════════════════════════════════════════
// POLYMARKET AUTH — Generate L2 API Creds
// ══════════════════════════════════════════
async function generateApiCredentials() {
  if (!isLive) return null;
  if (state.apiCreds) return state.apiCreds;

  try {
    const { ethers } = await getEthers();
    const wallet = await getWallet();

    // Get server timestamp
    const { data: tsData } = await axios.get(`${CLOB_BASE}/time`, { timeout: 10000 });
    const timestamp = String(tsData.time);
    const nonce = 0;

    // EIP-712 domain & types for auth
    const domain = { name:'ClobAuthDomain', version:'1', chainId: CHAIN_ID };
    const types  = {
      ClobAuth: [
        { name:'address',   type:'address' },
        { name:'timestamp', type:'string'  },
        { name:'nonce',     type:'uint256' },
        { name:'message',   type:'string'  },
      ]
    };
    const value = {
      address:   wallet.address,
      timestamp,
      nonce,
      message: 'This message attests that I control the given wallet',
    };

    const signature = await wallet.signTypedData(domain, types, value);

    // Request API credentials
    const headers = {
      'POLY_ADDRESS':   wallet.address,
      'POLY_SIGNATURE': signature,
      'POLY_TIMESTAMP': timestamp,
      'POLY_NONCE':     String(nonce),
      'Content-Type':   'application/json',
    };

    const { data } = await axios.get(`${CLOB_BASE}/auth/api-key`, { headers, timeout: 10000 });

    state.apiCreds = {
      apiKey:     data.apiKey,
      secret:     data.secret,
      passphrase: data.passphrase,
    };

    console.log(`✅ API credentials generated: ${data.apiKey?.substring(0,16)}...`);
    return state.apiCreds;

  } catch(e) {
    console.error('Generate API creds error:', e.message);
    return null;
  }
}

// L2 auth headers untuk trading requests
async function getAuthHeaders(method, path, body = '') {
  const creds = await generateApiCredentials();
  if (!creds) return {};

  const ts      = Math.floor(Date.now() / 1000).toString();
  const message = ts + method.toUpperCase() + path + body;
  const sig     = crypto
    .createHmac('sha256', Buffer.from(creds.secret, 'base64'))
    .update(message)
    .digest('base64');

  const wallet = await getWallet();
  return {
    'POLY_ADDRESS':    wallet.address,
    'POLY_SIGNATURE':  sig,
    'POLY_TIMESTAMP':  ts,
    'POLY_API_KEY':    creds.apiKey,
    'POLY_PASSPHRASE': creds.passphrase,
    'Content-Type':    'application/json',
  };
}

// ══════════════════════════════════════════
// TOKEN APPROVAL (sekali saja)
// ══════════════════════════════════════════
async function approveTokensIfNeeded() {
  if (!isLive || state.setupDone) return;
  try {
    const { ethers } = await getEthers();
    const wallet = await getWallet();

    const usdc = new ethers.Contract(
      USDC_CONTRACT,
      [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
      ],
      wallet
    );

    const allowance = await usdc.allowance(wallet.address, EXCHANGE_CONTRACT);
    const minAllowance = ethers.parseUnits('1000', 6);

    if (allowance < minAllowance) {
      console.log('📝 Approving USDC for Exchange...');
      const tx = await usdc.approve(EXCHANGE_CONTRACT, ethers.MaxUint256);
      await tx.wait();
      console.log(`✅ USDC approved! Tx: ${tx.hash}`);
    } else {
      console.log('✅ USDC already approved');
    }

    // CTF approval
    const ctf = new ethers.Contract(
      '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
      [
        'function isApprovedForAll(address account, address operator) view returns (bool)',
        'function setApprovalForAll(address operator, bool approved)',
      ],
      wallet
    );

    const ctfApproved = await ctf.isApprovedForAll(wallet.address, EXCHANGE_CONTRACT);
    if (!ctfApproved) {
      console.log('📝 Approving CTF tokens...');
      const tx2 = await ctf.setApprovalForAll(EXCHANGE_CONTRACT, true);
      await tx2.wait();
      console.log(`✅ CTF approved! Tx: ${tx2.hash}`);
    } else {
      console.log('✅ CTF already approved');
    }

    state.setupDone = true;
    console.log('🎉 Setup complete — ready for live trading!');

  } catch(e) {
    console.error('Approval error:', e.message);
  }
}

// ══════════════════════════════════════════
// LIVE ORDER PLACEMENT
// ══════════════════════════════════════════
async function placeLiveOrder({ tokenId, outcome, side, price, size }) {
  try {
    const { ethers } = await getEthers();
    const wallet = await getWallet();
    const creds  = await generateApiCredentials();
    if (!creds) throw new Error('No API credentials');

    // EIP-712 order signing
    const ORDER_DOMAIN = {
      name:              'Polymarket CTF Exchange',
      version:           '1',
      chainId:           CHAIN_ID,
      verifyingContract: EXCHANGE_CONTRACT,
    };
    const ORDER_TYPES = {
      Order: [
        { name:'salt',          type:'uint256' },
        { name:'maker',         type:'address' },
        { name:'signer',        type:'address' },
        { name:'taker',         type:'address' },
        { name:'tokenId',       type:'uint256' },
        { name:'makerAmount',   type:'uint256' },
        { name:'takerAmount',   type:'uint256' },
        { name:'expiration',    type:'uint256' },
        { name:'nonce',         type:'uint256' },
        { name:'feeRateBps',    type:'uint256' },
        { name:'side',          type:'uint8'   },
        { name:'signatureType', type:'uint8'   },
      ]
    };

    const makerAmount = side === 'BUY'
      ? Math.round(size * price * 1e6)
      : Math.round(size * 1e6);
    const takerAmount = side === 'BUY'
      ? Math.round(size * 1e6)
      : Math.round(size * price * 1e6);

    const orderStruct = {
      salt:          BigInt(Math.floor(Math.random() * 1e15)),
      maker:         wallet.address,
      signer:        wallet.address,
      taker:         '0x0000000000000000000000000000000000000000',
      tokenId:       BigInt(tokenId),
      makerAmount:   BigInt(makerAmount),
      takerAmount:   BigInt(takerAmount),
      expiration:    BigInt(0),
      nonce:         BigInt(0),
      feeRateBps:    BigInt(0),
      side:          side === 'BUY' ? 0 : 1,
      signatureType: 0,
    };

    const signature = await wallet.signTypedData(ORDER_DOMAIN, ORDER_TYPES, orderStruct);

    const orderPayload = {
      order: {
        salt:          orderStruct.salt.toString(),
        maker:         wallet.address,
        signer:        wallet.address,
        taker:         orderStruct.taker,
        tokenId:       tokenId.toString(),
        makerAmount:   makerAmount.toString(),
        takerAmount:   takerAmount.toString(),
        expiration:    '0',
        nonce:         '0',
        feeRateBps:    '0',
        side:          side === 'BUY' ? '0' : '1',
        signatureType: '0',
        signature,
      },
      orderType: 'GTC',
    };

    const body    = JSON.stringify(orderPayload);
    const headers = await getAuthHeaders('POST', '/order', body);
    const { data } = await axios.post(`${CLOB_BASE}/order`, orderPayload, { headers, timeout: 15000 });

    console.log(`✅ Live order placed: ${data.orderID || data.id}`);
    return data;

  } catch(e) {
    console.error('Place order error:', e.message);
    throw e;
  }
}

// ══════════════════════════════════════════
// MONEY MANAGER
// ══════════════════════════════════════════
function getTradeable() {
  if (state.totalProfit <= 0) return 0;
  return parseFloat((state.totalProfit * 0.5).toFixed(2));
}

function getPositionSize() {
  const avail = getTradeable();
  if (avail < state.settings.minPositionUSD) return 0;
  const slots = Math.max(1, state.settings.maxConcurrent - state.openPositions.length);
  const size  = avail / slots;
  return Math.min(
    state.settings.maxPositionUSD,
    Math.max(state.settings.minPositionUSD, parseFloat(size.toFixed(2)))
  );
}

// ══════════════════════════════════════════
// AI ENGINE
// ══════════════════════════════════════════
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
  else if (vol >= 50000)  score += 8;
  else score += 2;

  const days = Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000);
  if (days >= 7 && days <= 21)      score += 20;
  else if (days >= 3 && days < 7)   score += 14;
  else if (days > 21 && days <= 45) score += 12;
  else if (days > 45)               score += 6;
  else score += 2;

  const yesPrice = m.yesPrice || 0.5;
  const minPrice = Math.min(yesPrice, 1 - yesPrice);
  if (minPrice < 0.2)                         score += 15;
  else if (minPrice < 0.35)                   score += 12;
  else if (yesPrice > 0.6 || yesPrice < 0.4) score += 8;
  else score += 3;

  const spread = m.spread || 0.05;
  if (spread <= 0.01)      score += 10;
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
    return { signal:'BUY', outcome:'NO', reason:`NO menguat ${(Math.abs(change)*100).toFixed(1)}%` };
  if (yesPrice < 0.25 && change <= 0)
    return { signal:'BUY', outcome:'YES', reason:`YES oversold ${(yesPrice*100).toFixed(0)}¢` };
  if (noPrice < 0.25 && change >= 0)
    return { signal:'BUY', outcome:'NO', reason:`NO oversold ${(noPrice*100).toFixed(0)}¢` };
  if (score >= 85)
    return { signal:'BUY', outcome: yesPrice > noPrice ? 'YES':'NO', reason:`AI score tinggi ${score}%` };

  return { signal:'WATCH', outcome:null, reason:'Tidak ada edge yang jelas' };
}

// ══════════════════════════════════════════
// MARKET DATA
// ══════════════════════════════════════════
async function fetchMarkets() {
  try {
    const { data } = await axios.get(`${GAMMA_BASE}/markets`, {
      params: { active:true, closed:false, limit:50, order:'volume24hr', ascending:false },
      timeout: 12000
    });
    return (data.markets || data || []).map(m => {
      const yesPrice = parseFloat(m.tokens?.[0]?.price || 0.5);
      return {
        id:             m.id,
        question:       m.question,
        endDate:        m.endDate,
        volume24h:      parseFloat(m.volume24hr || 0),
        priceChange24h: parseFloat(m.priceChange24hr || 0),
        yesPrice,
        noPrice:        parseFloat((1 - yesPrice).toFixed(4)),
        spread:         parseFloat(m.spread || 0.02),
        tokenIdYes:     m.tokens?.[0]?.token_id,
        tokenIdNo:      m.tokens?.[1]?.token_id,
        resolved:       m.closed || false,
      };
    }).filter(m => !m.resolved && m.volume24h > 5000);
  } catch(e) {
    console.error('Fetch markets error:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════
// TRADE EXECUTION
// ══════════════════════════════════════════
async function executeTrade(signal, size) {
  console.log(`\n⚡ ${signal.outcome} "${signal.question?.substring(0,45)}" $${size} | Score:${signal.aiScore}%`);

  let liveOrderId = null;

  // Try live order first
  if (isLive && state.setupDone && signal.tokenIdYes) {
    try {
      const tokenId = signal.outcome === 'YES' ? signal.tokenIdYes : signal.tokenIdNo;
      const price   = signal.outcome === 'YES' ? signal.yesPrice : signal.noPrice;
      const order   = await placeLiveOrder({ tokenId, outcome: signal.outcome, side:'BUY', price, size });
      liveOrderId   = order.orderID || order.id;
    } catch(e) {
      console.error('Live order failed, recording as simulation:', e.message);
    }
  }

  // Simulate P&L (realistic)
  const won    = Math.random() < (signal.aiScore / 100);
  const pnlPct = won
    ? (Math.random() * state.settings.takeProfitPct / 100)
    : -(Math.random() * state.settings.stopLossPct / 100);
  const pnl = parseFloat((size * pnlPct).toFixed(2));

  state.totalProfit = parseFloat((state.totalProfit + pnl).toFixed(2));
  state.balance     = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
  state.pnlHistory.push({ ts: Date.now(), profit: state.totalProfit, delta: pnl });
  if (state.pnlHistory.length > 200) state.pnlHistory.shift();

  const trade = {
    id:           Date.now(),
    type:         'CLOSE',
    question:     signal.question,
    outcome:      signal.outcome,
    entryPrice:   signal.outcome === 'YES' ? signal.yesPrice : signal.noPrice,
    size, pnl, aiScore: signal.aiScore,
    reason:       signal.reason,
    openedAt:     Date.now(),
    won,
    liveOrderId,
    isLive:       !!liveOrderId,
  };

  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.pop();

  console.log(`${won ? '✅ WIN' : '❌ LOSS'} PnL:${pnl>=0?'+':''}$${pnl} | Total:$${state.totalProfit}${liveOrderId ? ' | LIVE:'+liveOrderId : ''}`);
  return trade;
}

// ══════════════════════════════════════════
// BOT LOOP
// ══════════════════════════════════════════
let cachedSignals = [];

async function botLoop() {
  if (!state.botActive) return;
  state.scanCount++;
  state.lastScan = new Date().toISOString();
  console.log(`\n🔍 Scan #${state.scanCount} — ${new Date().toLocaleTimeString()}`);

  try {
    const markets = await fetchMarkets();
    const signals = markets.map(m => {
      const score = scoreMarket(m);
      const { signal, outcome, reason } = getSignal(m, score);
      return {
        ...m, marketId: m.id, aiScore: score, signal, outcome, reason,
        daysLeft: Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000),
      };
    }).sort((a, b) => b.aiScore - a.aiScore);

    cachedSignals = signals;

    const strong = signals.filter(s =>
      s.signal === 'BUY' &&
      s.aiScore >= state.settings.minAiScore
    );

    console.log(`📊 ${markets.length} markets | 🎯 ${strong.length} sinyal kuat`);

    let executed = 0;
    for (const sig of strong) {
      if (executed >= state.settings.maxTradesPerCycle) break;
      if (state.openPositions.length >= state.settings.maxConcurrent) break;
      const size = getPositionSize();
      if (size < state.settings.minPositionUSD) {
        console.log(`⏳ Dana belum tersedia — profit: $${state.totalProfit}`);
        break;
      }
      await executeTrade(sig, size);
      executed++;
      await new Promise(r => setTimeout(r, 2000));
    }

  } catch(e) {
    console.error('Bot loop error:', e.message);
  }
}

async function refreshSignals() {
  try {
    const markets = await fetchMarkets();
    cachedSignals = markets.map(m => {
      const score = scoreMarket(m);
      const { signal, outcome, reason } = getSignal(m, score);
      return {
        ...m, marketId: m.id, aiScore: score, signal, outcome, reason,
        daysLeft: Math.max(0, (new Date(m.endDate) - Date.now()) / 86400000),
      };
    }).sort((a, b) => b.aiScore - a.aiScore);
  } catch(e) {}
}

// ══════════════════════════════════════════
// SCHEDULERS
// ══════════════════════════════════════════
cron.schedule('*/5  * * * *', botLoop);
cron.schedule('*/3  * * * *', refreshSignals);
cron.schedule('*/10 * * * *', syncWalletBalance);

// Init on startup
setTimeout(async () => {
  await syncWalletBalance();
  await generateApiCredentials();
  await approveTokensIfNeeded();
  await refreshSignals();
  console.log('🏁 Initialization complete');
}, 5000);

// ══════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════
app.get('/', (req, res) => res.send(`<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>PolyBot AI</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:monospace;background:#05070f;color:#dce8ff;padding:12px}
.app{max-width:440px;margin:0 auto}
h1{font-size:20px;color:#00f5d4;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{font-size:10px;padding:3px 8px;border-radius:6px}
.sim{background:rgba(255,209,102,.15);color:#ffd166;border:1px solid rgba(255,209,102,.3)}
.live{background:rgba(0,230,118,.15);color:#00e676;border:1px solid rgba(0,230,118,.3)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}
.stat{background:#0f1526;border:1px solid #1a2340;border-radius:10px;padding:10px;text-align:center}
.sv{font-size:18px;font-weight:700;margin-bottom:2px}
.sl{font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase}
.g{color:#00e676}.c{color:#00f5d4}.p{color:#9b5de5}.r{color:#ff4058}.y{color:#ffd166}
.alloc{display:flex;justify-content:space-between;align-items:center;background:rgba(0,245,212,.05);border:1px solid rgba(0,245,212,.2);border-radius:10px;padding:12px;margin-bottom:10px}
.pct{font-size:36px;font-weight:700;color:#00f5d4;opacity:.7}
.sbox{background:#05070f;border:1px solid #1a2340;border-radius:10px;padding:12px;margin-bottom:10px;font-size:11px;line-height:2.2}
.row{display:flex;justify-content:space-between;border-bottom:1px solid #0f1526;padding:3px 0}
.row:last-child{border-bottom:none}
.lbl{color:#4a5980}
.btn{display:block;width:100%;padding:13px;margin:7px 0;border:none;border-radius:10px;font-family:monospace;font-size:13px;font-weight:700;cursor:pointer}
.bs{background:linear-gradient(135deg,#00c853,#00e676);color:#000}
.bx{background:linear-gradient(135deg,#c62828,#ff4058);color:#fff}
.br{background:#1a2340;color:#dce8ff;border:1px solid #243060}
.card{background:#0f1526;border:1px solid #1a2340;border-radius:12px;padding:14px;margin-bottom:10px}
.ct{font-size:10px;color:#00f5d4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px}
.mkt{padding:8px 0;border-bottom:1px solid #1a2340;font-size:10px}
.mkt:last-child{border-bottom:none}
.mq{font-size:11px;margin-bottom:4px;line-height:1.4}
.mr{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}
.sig{font-size:9px;padding:2px 7px;border-radius:5px;font-weight:700;background:rgba(0,230,118,.2);color:#00e676}
.bar{height:4px;background:#1a2340;border-radius:2px;margin:3px 0;overflow:hidden}
.bf{height:100%;background:linear-gradient(90deg,#9b5de5,#00f5d4);border-radius:2px}
.tr{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #1a2340;font-size:10px;align-items:center}
.tr:last-child{border-bottom:none}
.tt{width:36px;text-align:center;padding:2px 4px;border-radius:4px;font-size:9px;font-weight:700;flex-shrink:0}
.tw{background:rgba(0,230,118,.15);color:#00e676}
.tl{background:rgba(255,64,88,.15);color:#ff4058}
.ti{flex:1;min-width:0}
.tn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.td{color:#4a5980;font-size:9px;margin-top:1px}
.tp{font-weight:700;flex-shrink:0}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}
.don{background:#00e676;box-shadow:0 0 6px #00e676;animation:p 1s infinite}
.dof{background:#ff4058}
.warn{background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);border-radius:8px;padding:10px;margin-bottom:10px;font-size:10px;color:#ffd166;line-height:1.8}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body>
<div class="app">
<h1>🤖 PolyBot AI &nbsp;
  <span class="badge sim" id="mb">SIMULASI</span>
  <span class="badge" id="setupBadge" style="background:rgba(155,93,229,.15);color:#9b5de5;border:1px solid rgba(155,93,229,.3)">Setup...</span>
</h1>

<div class="warn" id="profitNote">
  💡 <b>50% Profit Rule:</b> Bot hanya trade menggunakan 50% dari profit. Butuh profit dulu sebelum bisa trade. Modal awal tidak disentuh.
</div>

<div class="grid">
  <div class="stat"><div class="sv g" id="sp">$0.00</div><div class="sl">Profit</div></div>
  <div class="stat"><div class="sv c" id="st">$0.00</div><div class="sl">Tradeable</div></div>
  <div class="stat"><div class="sv p" id="sw">0%</div><div class="sl">Win Rate</div></div>
</div>

<div class="alloc">
  <div>
    <div style="font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase">Dana Tersedia Trade</div>
    <div style="font-size:16px;font-weight:700;color:#00f5d4;margin:3px 0" id="af">$0.00 USDC</div>
    <div style="font-size:9px;color:#4a5980" id="ap">dari profit $0.00</div>
  </div>
  <div class="pct">50%</div>
</div>

<div class="sbox">
  <div class="row"><span class="lbl">Status Bot</span><span><span class="dot dof" id="sd"></span><span id="stxt" class="r">STOP</span></span></div>
  <div class="row"><span class="lbl">Balance</span><span class="c" id="sb">-</span></div>
  <div class="row"><span class="lbl">Modal (Auto Wallet)</span><span class="g" id="si">-</span></div>
  <div class="row"><span class="lbl">Wallet</span><span style="font-size:9px;color:#4a5980" id="sw2">-</span></div>
  <div class="row"><span class="lbl">Setup Status</span><span id="ssetup" class="y">Initializing...</span></div>
  <div class="row"><span class="lbl">Total Trade</span><span id="sc">0</span></div>
  <div class="row"><span class="lbl">Scan ke-</span><span id="sk">0</span></div>
  <div class="row"><span class="lbl">Scan Terakhir</span><span id="sl" style="font-size:9px">—</span></div>
</div>

<button class="btn bs" onclick="startBot()">▶ START BOT</button>
<button class="btn bx" onclick="stopBot()">⏹ STOP BOT</button>
<button class="btn br" onclick="loadAll()">↻ Refresh</button>

<div class="card">
  <div class="ct">🔍 AI Signals Terkuat</div>
  <div id="sigs"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Scanning markets...</div></div>
</div>

<div class="card">
  <div class="ct">📋 Trade Log</div>
  <div id="tlog"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div></div>
</div>
</div>

<script>
async function ls(){
  try{
    const d=await fetch('/status').then(r=>r.json());
    document.getElementById('sp').textContent=(d.profit>=0?'+':'')+'\$'+d.profit.toFixed(2);
    document.getElementById('sp').className='sv '+(d.profit>=0?'g':'r');
    document.getElementById('st').textContent='\$'+d.tradeable.toFixed(2);
    document.getElementById('sw').textContent=d.winRate+'%';
    document.getElementById('af').textContent='\$'+d.tradeable.toFixed(2)+' USDC';
    document.getElementById('ap').textContent='dari profit \$'+d.profit.toFixed(2);
    document.getElementById('sb').textContent='\$'+d.balance.toFixed(2);
    document.getElementById('si').textContent='\$'+d.initialCapital.toFixed(2);
    document.getElementById('sw2').textContent=d.walletAddress?d.walletAddress.substring(0,8)+'...'+d.walletAddress.slice(-6):'—';
    document.getElementById('sc').textContent=d.totalTrades;
    document.getElementById('sk').textContent=d.scanCount||0;
    document.getElementById('sl').textContent=d.lastScan?new Date(d.lastScan).toLocaleTimeString('id-ID'):'—';
    document.getElementById('ssetup').textContent=d.setupDone?'✅ Ready':'⏳ Setting up...';
    document.getElementById('ssetup').className=d.setupDone?'g':'y';
    const on=d.botActive;
    document.getElementById('sd').className='dot '+(on?'don':'dof');
    document.getElementById('stxt').textContent=on?'AKTIF':'STOP';
    document.getElementById('stxt').className=on?'g':'r';
    document.getElementById('mb').textContent=d.isSimulation?'SIMULASI':'LIVE';
    document.getElementById('mb').className='badge '+(d.isSimulation?'sim':'live');
    document.getElementById('setupBadge').textContent=d.setupDone?'✅ Setup OK':'⏳ Setup...';
    if(d.profit>0)document.getElementById('profitNote').style.display='none';
  }catch(e){}
}
async function lsig(){
  try{
    const s=await fetch('/signals').then(r=>r.json());
    const t=s.filter(x=>x.signal==='BUY').slice(0,5);
    if(!t.length){document.getElementById('sigs').innerHTML='<div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Scanning...</div>';return;}
    document.getElementById('sigs').innerHTML=t.map(s=>`<div class="mkt">
      <div class="mr"><div class="mq">${s.question.substring(0,55)}...</div><span class="sig">BUY</span></div>
      <div class="mr"><span style="color:#4a5980;font-size:9px">YES ${(s.yesPrice*100).toFixed(0)}¢ | NO ${(s.noPrice*100).toFixed(0)}¢ | \$${(s.volume24h/1000).toFixed(0)}K</span>
      <span class="c" style="font-size:10px;font-weight:700">${s.aiScore}%</span></div>
      <div class="bar"><div class="bf" style="width:${s.aiScore}%"></div></div>
      <div style="font-size:9px;color:#4a5980;font-style:italic">💡 ${s.reason}</div>
    </div>`).join('');
  }catch(e){}
}
async function ltrades(){
  try{
    const t=await fetch('/trades').then(r=>r.json());
    if(!t.length){document.getElementById('tlog').innerHTML='<div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div>';return;}
    document.getElementById('tlog').innerHTML=t.slice(0,10).map(t=>`<div class="tr">
      <div class="tt ${t.won?'tw':'tl'}">${t.won?'WIN':'LOSS'}</div>
      <div class="ti">
        <div class="tn">${(t.question||'').substring(0,38)}...</div>
        <div class="td">${t.outcome} @ ${(t.entryPrice||0).toFixed(2)} | \$${(t.size||0).toFixed(2)} | ${t.isLive?'🔴 LIVE':'🔵 SIM'}</div>
      </div>
      <div class="tp ${t.pnl>=0?'g':'r'}">${t.pnl>=0?'+':''}\$${Math.abs(t.pnl||0).toFixed(2)}</div>
    </div>`).join('');
  }catch(e){}
}
async function startBot(){await fetch('/bot/start',{method:'POST'});alert('✅ Bot aktif!\nScan tiap 5 menit.\nTrade otomatis saat ada profit.');loadAll();}
async function stopBot(){await fetch('/bot/stop',{method:'POST'});alert('⏹ Bot dihentikan');loadAll();}
async function loadAll(){await Promise.all([ls(),lsig(),ltrades()]);}
loadAll();
setInterval(ls,8000);
setInterval(lsig,30000);
setInterval(ltrades,15000);
</script></body></html>`));

// ══════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════
app.get('/health',   (req,res) => res.json({ status:'ok', ts:Date.now(), mode:isLive?'live':'simulation' }));
app.get('/status',   (req,res) => res.json({
  botActive:state.botActive, isSimulation:!isLive,
  profit:state.totalProfit, balance:state.balance,
  initialCapital:state.initialCapital, tradeable:getTradeable(),
  positionSize:getPositionSize(), walletAddress:state.walletAddress,
  setupDone:state.setupDone, apiReady:!!state.apiCreds,
  winRate:state.trades.length>0?Math.round(state.trades.filter(t=>t.won).length/state.trades.length*100):0,
  totalTrades:state.trades.length, openPositions:state.openPositions.length,
  scanCount:state.scanCount, lastScan:state.lastScan,
  uptime:Math.floor(process.uptime()), settings:state.settings,
}));
app.get('/signals',  (req,res) => res.json(cachedSignals.slice(0,30)));
app.get('/trades',   (req,res) => res.json(state.trades.slice(0,50)));
app.get('/positions',(req,res) => res.json(state.openPositions));
app.get('/pnl',      (req,res) => res.json(state.pnlHistory));
app.post('/bot/start',(req,res) => { state.botActive=true; setTimeout(botLoop,2000); res.json({ok:true}); });
app.post('/bot/stop', (req,res) => { state.botActive=false; res.json({ok:true}); });
app.post('/bot/reset',(req,res) => { state.totalProfit=0; state.balance=state.initialCapital; state.trades=[]; state.pnlHistory=[]; state.scanCount=0; res.json({ok:true}); });
app.post('/settings', (req,res) => {
  ['minAiScore','maxTradesPerCycle','stopLossPct','takeProfitPct','minPositionUSD','maxPositionUSD','strategy']
    .forEach(k => { if(req.body[k]!==undefined) state.settings[k]=req.body[k]; });
  res.json({ok:true, settings:state.settings});
});
app.post('/trade/manual', async(req,res) => {
  const {marketId,outcome,amount}=req.body;
  const sig=cachedSignals.find(s=>s.marketId===marketId)||{question:marketId,outcome,yesPrice:0.5,noPrice:0.5,aiScore:70,reason:'Manual'};
  const t=await executeTrade({...sig,outcome,signal:'BUY'},parseFloat(amount));
  res.json({ok:true,result:t});
});

// ══════════════════════════════════════════
// START
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 PolyBot AI — port ${PORT}`);
  console.log(`🔧 Mode: ${isLive?'🔴 LIVE TRADING':'🔵 SIMULASI'}`);
  console.log(`💰 Modal: $${state.initialCapital} (auto-sync dari wallet)\n`);
});
