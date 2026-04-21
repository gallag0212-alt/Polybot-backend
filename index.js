require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const WS      = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const CLOB_BASE     = 'https://clob.polymarket.com';
const GAMMA_BASE    = 'https://gamma-api.polymarket.com';
const WSS_URL       = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CHAIN_ID      = 137;
const USDC_ADDR     = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE_ADDR = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CTF_ADDR      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const PRIVATE_KEY   = process.env.POLY_PRIVATE_KEY || '';
const isLive        = !!(PRIVATE_KEY && !PRIVATE_KEY.includes('your_wallet') && PRIVATE_KEY.length > 60);

const state = {
  botActive:      false,
  initialCapital: parseFloat(process.env.INITIAL_CAPITAL || 0),
  balance:        parseFloat(process.env.INITIAL_CAPITAL || 0),
  totalProfit:    0,
  trades:         [],
  openPositions:  [],
  pnlHistory:     [],
  scanCount:      0,
  lastScan:       null,
  walletAddress:  null,
  apiCreds:       null,
  apiCredsAt:     null,
  setupDone:      false,
  lastPriceAt:    null,
  priceUpdates:   0,
  markets:        {},
  balanceUSDCe:   0,
  balanceUSDC:    0,
  settings: {
    minAiScore:        75,
    maxTradesPerCycle: 2,
    maxConcurrent:     3,
    stopLossPct:       15,
    takeProfitPct:     25,
    minPositionUSD:    20,
    maxPositionUSD:    50,
    strategy:         'momentum',
    minPriceMovePct:   2,
    minVolume:         10000,
  }
};

var _ethers = null;
async function getEthers() {
  if (!_ethers) _ethers = require('ethers');
  return _ethers;
}
async function getWallet() {
  var e = await getEthers();
  var provider = new e.JsonRpcProvider(process.env.POLYGON_RPC || 'https://rpc.ankr.com/polygon');
  return new e.Wallet(PRIVATE_KEY, provider);
}

async function syncWalletBalance() {
  if (!isLive) return;
  try {
    var e = await getEthers();
    var wallet = await getWallet();
    state.walletAddress = wallet.address;
    var ABI = ['function balanceOf(address) view returns (uint256)'];
    var usdce = new e.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ABI, wallet.provider);
    var rawE  = await usdce.balanceOf(wallet.address);
    var balE  = parseFloat(e.formatUnits(rawE, 6));
    var usdcN = new e.Contract('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', ABI, wallet.provider);
    var rawN  = await usdcN.balanceOf(wallet.address);
    var balN  = parseFloat(e.formatUnits(rawN, 6));
    var total = parseFloat((balE + balN).toFixed(2));
    console.log('Wallet: USDC.e=$'+balE.toFixed(2)+' USDC=$'+balN.toFixed(2)+' Total=$'+total);
    if (total > 0) {
      state.initialCapital = total;
      state.balance = parseFloat((state.initialCapital + state.totalProfit).toFixed(2));
    }
    state.balanceUSDCe = balE;
    state.balanceUSDC  = balN;
  } catch(err) { console.log('Sync skip:', err.message); }
}

async function generateApiCreds() {
  if (!isLive) return null;
  if (state.apiCreds && state.apiCredsAt) {
    if (Date.now() - state.apiCredsAt < 23*60*60*1000) return state.apiCreds;
    console.log('API creds expired — regenerating...');
    state.apiCreds = null;
  }
  if (state.apiCreds) return state.apiCreds;
  try {
    var e = await getEthers();
    var wallet = await getWallet();
    var ts = await axios.get(CLOB_BASE+'/time', {timeout:10000});
    var timestamp = String(ts.data.time);
    var domain = {name:'ClobAuthDomain',version:'1',chainId:CHAIN_ID};
    var types  = {ClobAuth:[
      {name:'address',type:'address'},{name:'timestamp',type:'string'},
      {name:'nonce',type:'uint256'},{name:'message',type:'string'}
    ]};
    var value = {address:wallet.address,timestamp,nonce:0,
      message:'This message attests that I control the given wallet'};
    var sig = await wallet.signTypedData(domain,types,value);
    var res = await axios.get(CLOB_BASE+'/auth/api-key',{
      headers:{'POLY_ADDRESS':wallet.address,'POLY_SIGNATURE':sig,'POLY_TIMESTAMP':timestamp,'POLY_NONCE':'0'},
      timeout:10000
    });
    state.apiCreds   = {apiKey:res.data.apiKey,secret:res.data.secret,passphrase:res.data.passphrase};
    state.apiCredsAt = Date.now();
    console.log('API creds OK');
    return state.apiCreds;
  } catch(e) { console.log('API creds error:',e.message); return null; }
}

async function getAuthHeaders(method, reqPath, body) {
  var creds = await generateApiCreds();
  if (!creds) return {};
  var wallet = await getWallet();
  var ts  = Math.floor(Date.now()/1000).toString();
  var msg = ts+method.toUpperCase()+reqPath+(body||'');
  var sig = crypto.createHmac('sha256',Buffer.from(creds.secret,'base64')).update(msg).digest('base64');
  return {'POLY_ADDRESS':wallet.address,'POLY_SIGNATURE':sig,'POLY_TIMESTAMP':ts,
    'POLY_API_KEY':creds.apiKey,'POLY_PASSPHRASE':creds.passphrase,'Content-Type':'application/json'};
}

async function approveIfNeeded() {
  if (!isLive) return;
  if (state.setupDone) return;
  try {
    var e = await getEthers();
    var wallet = await getWallet();
    var ABI = ['function allowance(address,address) view returns (uint256)','function approve(address,uint256) returns (bool)'];
    var usdce = new e.Contract('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',ABI,wallet);
    var allowE = await usdce.allowance(wallet.address,EXCHANGE_ADDR);
    if (allowE < e.parseUnits('100',6)) {
      var tx1 = await usdce.approve(EXCHANGE_ADDR,e.MaxUint256);
      await tx1.wait();
      console.log('USDC.e approved: '+tx1.hash);
    } else { console.log('USDC.e already approved'); }
    var usdcN = new e.Contract('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',ABI,wallet);
    var allowN = await usdcN.allowance(wallet.address,EXCHANGE_ADDR);
    if (allowN < e.parseUnits('100',6)) {
      var tx2 = await usdcN.approve(EXCHANGE_ADDR,e.MaxUint256);
      await tx2.wait();
      console.log('USDC native approved: '+tx2.hash);
    } else { console.log('USDC native already approved'); }
    var ctf = new e.Contract(CTF_ADDR,
      ['function isApprovedForAll(address,address) view returns (bool)','function setApprovalForAll(address,bool)'],wallet);
    var ok = await ctf.isApprovedForAll(wallet.address,EXCHANGE_ADDR);
    if (!ok) {
      var tx3 = await ctf.setApprovalForAll(EXCHANGE_ADDR,true);
      await tx3.wait();
      console.log('CTF approved: '+tx3.hash);
    } else { console.log('CTF already approved'); }
    state.setupDone = true;
    console.log('Setup complete!');
  } catch(err) { console.log('Approval error:',err.message); }
}

async function placeLiveOrder(tokenId, side, price, size) {
  var e = await getEthers();
  var wallet = await getWallet();
  var creds = await generateApiCreds();
  if (!creds) throw new Error('No API credentials');
  var makerAmt = side==='BUY'?Math.round(size*price*1e6):Math.round(size*1e6);
  var takerAmt = side==='BUY'?Math.round(size*1e6):Math.round(size*price*1e6);
  var os = {
    salt:BigInt(Math.floor(Math.random()*1e15)),maker:wallet.address,signer:wallet.address,
    taker:'0x0000000000000000000000000000000000000000',tokenId:BigInt(tokenId),
    makerAmount:BigInt(makerAmt),takerAmount:BigInt(takerAmt),
    expiration:BigInt(0),nonce:BigInt(0),feeRateBps:BigInt(0),
    side:side==='BUY'?0:1,signatureType:0,
  };
  var sig = await wallet.signTypedData(
    {name:'Polymarket CTF Exchange',version:'1',chainId:CHAIN_ID,verifyingContract:EXCHANGE_ADDR},
    {Order:[
      {name:'salt',type:'uint256'},{name:'maker',type:'address'},{name:'signer',type:'address'},
      {name:'taker',type:'address'},{name:'tokenId',type:'uint256'},{name:'makerAmount',type:'uint256'},
      {name:'takerAmount',type:'uint256'},{name:'expiration',type:'uint256'},{name:'nonce',type:'uint256'},
      {name:'feeRateBps',type:'uint256'},{name:'side',type:'uint8'},{name:'signatureType',type:'uint8'},
    ]}, os
  );
  var payload = JSON.stringify({
    order:{salt:os.salt.toString(),maker:wallet.address,signer:wallet.address,taker:os.taker,
      tokenId:tokenId.toString(),makerAmount:makerAmt.toString(),takerAmount:takerAmt.toString(),
      expiration:'0',nonce:'0',feeRateBps:'0',side:side==='BUY'?'0':'1',signatureType:'0',signature:sig},
    orderType:'GTC'
  });
  var headers = await getAuthHeaders('POST','/order',payload);
  var res = await axios.post(CLOB_BASE+'/order',JSON.parse(payload),{headers,timeout:15000});
  return res.data;
}

function getTradeable() {
  return state.totalProfit>0 ? parseFloat((state.totalProfit*0.5).toFixed(2)) : 0;
}
function getPositionSize() {
  var avail = getTradeable();
  if (avail<state.settings.minPositionUSD) return 0;
  var slots = Math.max(1,state.settings.maxConcurrent-state.openPositions.length);
  return Math.min(state.settings.maxPositionUSD,Math.max(state.settings.minPositionUSD,parseFloat((avail/slots).toFixed(2))));
}

function scoreMarket(m) {
  var s=0;
  var ch=m.priceChange||0,absCh=Math.abs(ch);
  var v=m.volume24h||0;
  var d=Math.max(0,(new Date(m.endDate)-Date.now())/86400000);
  var yp=m.yesPrice||0.5,np=1-yp,mn=Math.min(yp,np),sp=m.spread||0.05;
  var rt=m.realtimeMove||0,absRt=Math.abs(rt);
  s += absCh>=0.15?28:absCh>=0.10?22:absCh>=0.05?16:absCh>=0.02?10:absCh>=0.01?5:2;
  s += v>=1000000?22:v>=500000?18:v>=200000?14:v>=100000?10:v>=50000?6:2;
  s += (d>=5&&d<=21)?18:(d>=3&&d<5)?14:(d>21&&d<=30)?12:(d>30&&d<=60)?8:d>60?4:1;
  s += mn<0.10?16:mn<0.20?13:mn<0.30?9:mn<0.40?5:2;
  s += sp<=0.01?10:sp<=0.02?8:sp<=0.03?6:sp<=0.05?3:1;
  s += absRt>=0.08?14:absRt>=0.05?11:absRt>=0.03?8:absRt>=0.01?4:0;
  if (ch>0&&rt>0) s+=8; else if (ch<0&&rt<0) s+=8; else if (ch!==0&&rt!==0) s-=3;
  var vel=mn>0?absRt/mn:0;
  s += vel>=0.3?6:vel>=0.15?4:vel>=0.05?2:0;
  return Math.min(99,Math.max(0,Math.round(s)));
}

function calcExpectedValue(entryPrice, outcome, market) {
  var curPrice=outcome==='YES'?market.yesPrice:market.noPrice;
  var ch=market.priceChange||0,rt=market.realtimeMove||0;
  var direction=outcome==='YES'?1:-1;
  var pWin=Math.min(0.90,Math.max(0.10,curPrice+(direction*ch>0?0.10:-0.05)+(direction*rt>0?0.08:-0.04)));
  return parseFloat((pWin*(1-entryPrice)-(1-pWin)*entryPrice).toFixed(4));
}

function analyzeExitSignal(pos, market) {
  if (!market) return {shouldExit:false,reason:null};
  var cur=pos.outcome==='YES'?market.yesPrice:market.noPrice;
  var ch=market.priceChange||0,rt=market.realtimeMove||0;
  var direction=pos.outcome==='YES'?1:-1;
  var pnlPct=(cur-pos.entryPrice)/pos.entryPrice*100;
  var daysLeft=Math.max(0,(new Date(market.endDate)-Date.now())/86400000);
  var heldHours=(Date.now()-pos.openedAt)/3600000;
  if ((direction*rt<-0.02)&&(direction*ch<0)&&pnlPct>0)
    return {shouldExit:true,reason:'MOMENTUM_REVERSED profit '+pnlPct.toFixed(1)+'%'};
  if (pnlPct>8&&direction*rt<-0.015)
    return {shouldExit:true,reason:'PEAK_DETECTED +'+pnlPct.toFixed(1)+'%'};
  if (heldHours>48&&Math.abs(pnlPct)<2&&getCachedSignals().filter(function(s){return s.aiScore>80&&s.signal==='BUY'&&s.marketId!==pos.marketId;}).length>0)
    return {shouldExit:true,reason:'OPPORTUNITY_COST held '+heldHours.toFixed(0)+'h'};
  if (daysLeft<2&&pnlPct>0) return {shouldExit:true,reason:'EXPIRY_EXIT +'+pnlPct.toFixed(1)+'%'};
  if (daysLeft<1) return {shouldExit:true,reason:'EXPIRY_FORCED '+pnlPct.toFixed(1)+'%'};
  if (pnlPct<-18) return {shouldExit:true,reason:'HARD_STOP '+pnlPct.toFixed(1)+'%'};
  return {shouldExit:false,reason:null};
}

function getSignal(m, score) {
  var yp=m.yesPrice||0.5,np=1-yp,ch=m.priceChange||0,rt=m.realtimeMove||0,sp=m.spread||0.05;
  if (score<state.settings.minAiScore)
    return {signal:'WATCH',outcome:null,reason:'Score '+score+'% di bawah threshold'};
  var evYes=calcExpectedValue(yp,'YES',m),evNo=calcExpectedValue(np,'NO',m);
  var bestOutcome=evYes>=evNo?'YES':'NO',bestEV=Math.max(evYes,evNo);
  var bestPrice=bestOutcome==='YES'?yp:np;
  if (bestEV<=0) return {signal:'WATCH',outcome:null,reason:'EV negatif ('+bestEV.toFixed(3)+')'};
  if (bestPrice>0.90) return {signal:'WATCH',outcome:null,reason:'Harga terlalu tinggi ('+( bestPrice*100).toFixed(0)+'c)'};
  if (sp>0.08) return {signal:'WATCH',outcome:null,reason:'Spread terlalu lebar ('+( sp*100).toFixed(1)+'%)'};
  var absRt=Math.abs(rt);
  var rtDir=(bestOutcome==='YES'&&rt>0)||(bestOutcome==='NO'&&rt<0);
  if (absRt>=0.03&&bestEV>0.02&&rtDir)
    return {signal:'BUY',outcome:bestOutcome,reason:'RT momentum '+(rt*100).toFixed(1)+'% EV='+bestEV.toFixed(3)};
  if (Math.abs(ch)>=0.05&&bestPrice<0.80&&bestEV>0.015)
    return {signal:'BUY',outcome:bestOutcome,reason:'Tren 24h '+(ch*100).toFixed(1)+'% ruang='+( (1-bestPrice)*100).toFixed(0)+'%'};
  if (bestPrice<0.35&&Math.abs(ch)>0.02&&bestEV>0.01)
    return {signal:'BUY',outcome:bestOutcome,reason:'Undervalued '+(bestPrice*100).toFixed(0)+'c EV='+bestEV.toFixed(3)};
  if (score>=85&&bestEV>0.01)
    return {signal:'BUY',outcome:bestOutcome,reason:'AI score='+score+' EV='+bestEV.toFixed(3)};
  if (bestEV>0.008&&score>=78&&sp<=0.04&&bestPrice<=0.75)
    return {signal:'BUY',outcome:bestOutcome,reason:'Semua faktor positif score='+score+' EV='+bestEV.toFixed(3)};
  return {signal:'WATCH',outcome:null,reason:'Belum ada keselarasan (score='+score+' EV='+bestEV.toFixed(3)+')'};
}
async function fetchAndCacheMarkets() {
  try {
    var res = await axios.get(GAMMA_BASE+'/markets',{
      params:{active:true,closed:false,limit:50,order:'volume24hr',ascending:false},
      timeout:12000
    });
    var markets = res.data.markets||res.data||[];
    markets.forEach(function(m){
      var yp=parseFloat(m.tokens&&m.tokens[0]?m.tokens[0].price:0.5);
      state.markets[m.id]={
        id:m.id,question:m.question,endDate:m.endDate,
        volume24h:parseFloat(m.volume24hr||0),
        priceChange:parseFloat(m.priceChange24hr||0),
        yesPrice:yp,noPrice:parseFloat((1-yp).toFixed(4)),
        spread:parseFloat(m.spread||0.02),
        tokenIdYes:m.tokens&&m.tokens[0]?m.tokens[0].token_id:null,
        tokenIdNo:m.tokens&&m.tokens[1]?m.tokens[1].token_id:null,
        prevYesPrice:yp,realtimeMove:0,resolved:m.closed||false,
      };
    });
    console.log('Markets loaded: '+Object.keys(state.markets).length);
  } catch(e){ console.log('Fetch markets error:',e.message); }
}

var wsClient=null,wsReconnectTimer=null,subscribedTokens=[];

function connectWebSocket() {
  if (wsClient&&wsClient.readyState===WS.OPEN) return;
  console.log('Connecting WebSocket...');
  wsClient=new WS(WSS_URL);
  wsClient.on('open',function(){
    console.log('WebSocket connected');
    var tokens=[];
    var mkts=Object.values(state.markets)
      .filter(function(m){return !m.resolved&&m.volume24h>state.settings.minVolume;})
      .sort(function(a,b){return b.volume24h-a.volume24h;})
      .slice(0,20);
    mkts.forEach(function(m){
      if(m.tokenIdYes) tokens.push(m.tokenIdYes);
      if(m.tokenIdNo)  tokens.push(m.tokenIdNo);
    });
    subscribedTokens=tokens;
    if(tokens.length>0){
      wsClient.send(JSON.stringify({type:'subscribe',channel:'prices',assets_ids:tokens}));
      console.log('Subscribed to '+tokens.length+' tokens');
    }
  });
  wsClient.on('message',function(raw){
    try{
      var msgs=JSON.parse(raw.toString());
      var arr=Array.isArray(msgs)?msgs:[msgs];
      arr.forEach(function(msg){handlePriceUpdate(msg);});
    }catch(e){}
  });
  wsClient.on('close',function(){
    console.log('WebSocket disconnected — reconnecting in 5s...');
    wsReconnectTimer=setTimeout(connectWebSocket,5000);
  });
  wsClient.on('error',function(err){console.log('WebSocket error:',err.message);});
}

function handlePriceUpdate(msg) {
  if (!state.botActive) return;
  var tokenId=msg.asset_id||msg.token_id;
  var newPrice=parseFloat(msg.price||msg.midpoint||0);
  if (!tokenId||!newPrice) return;
  state.priceUpdates++;
  state.lastPriceAt=new Date().toISOString();
  var market=null,isYes=false;
  Object.values(state.markets).forEach(function(m){
    if(m.tokenIdYes===tokenId){market=m;isYes=true;}
    if(m.tokenIdNo===tokenId){market=m;isYes=false;}
  });
  if (!market) return;
  var oldPrice=isYes?market.yesPrice:market.noPrice;
  var move=newPrice-oldPrice;
  var movePct=oldPrice>0?move/oldPrice:0;
  if (isYes){
    market.prevYesPrice=market.yesPrice;
    market.yesPrice=newPrice;
    market.noPrice=parseFloat((1-newPrice).toFixed(4));
    market.realtimeMove=movePct;
  } else {
    market.noPrice=newPrice;
    market.yesPrice=parseFloat((1-newPrice).toFixed(4));
    market.realtimeMove=-movePct;
  }
  if (Math.abs(movePct)>=state.settings.minPriceMovePct/100){
    state.scanCount++;
    state.lastScan=new Date().toISOString();
    checkSignalAndTrade(market);
    monitorPositions();
  }
}

var tradingInProgress=false;

async function checkSignalAndTrade(market) {
  if (!state.botActive||tradingInProgress) return;
  if (state.openPositions.length>=state.settings.maxConcurrent) return;
  var score=scoreMarket(market);
  var signal=getSignal(market,score);
  if (signal.signal!=='BUY'||!signal.outcome) return;
  var size=getPositionSize();
  if (size<state.settings.minPositionUSD) return;
  var alreadyOpen=state.openPositions.find(function(p){return p.marketId===market.id;});
  if (alreadyOpen) return;
  tradingInProgress=true;
  try {
    await executeTrade(Object.assign({},market,{
      marketId:market.id,aiScore:score,
      signal:signal.signal,outcome:signal.outcome,reason:signal.reason,
    }),size);
  } finally { tradingInProgress=false; }
}

async function executeTrade(signal, size) {
  console.log('BUY: '+signal.outcome+' "'+( signal.question||'').substring(0,40)+'" $'+size+' AI:'+signal.aiScore+'%');
  var liveId=null;
  var tokenId=signal.outcome==='YES'?signal.tokenIdYes:signal.tokenIdNo;
  var entryPrice=signal.outcome==='YES'?signal.yesPrice:signal.noPrice;
  if (isLive&&state.setupDone&&tokenId){
    try{
      var order=await placeLiveOrder(tokenId,'BUY',entryPrice,size);
      liveId=order.orderID||order.id;
      console.log('BUY order: '+liveId);
    }catch(e){console.log('BUY failed:',e.message);}
  }
  var takeProfitPrice=Math.min(0.95,parseFloat((entryPrice*(1+state.settings.takeProfitPct/100)).toFixed(4)));
  var stopLossPrice=Math.max(0.05,parseFloat((entryPrice*(1-state.settings.stopLossPct/100)).toFixed(4)));
  var position={
    id:Date.now(),marketId:signal.marketId||signal.id,
    question:signal.question,outcome:signal.outcome,
    tokenId:tokenId,entryPrice:entryPrice,currentPrice:entryPrice,
    size:size,aiScore:signal.aiScore,reason:signal.reason,
    takeProfitPrice:takeProfitPrice,stopLossPrice:stopLossPrice,
    openedAt:Date.now(),liveOrderId:liveId,isLive:!!liveId,
    pnl:0,pnlPct:0,endDate:signal.endDate,peakPrice:entryPrice,
  };
  state.openPositions.push(position);
  state.trades.unshift({
    id:position.id,type:'OPEN',question:signal.question,
    outcome:signal.outcome,entryPrice:entryPrice,size:size,
    pnl:0,aiScore:signal.aiScore,reason:signal.reason,
    openedAt:Date.now(),isLive:!!liveId,liveOrderId:liveId,
    takeProfitPrice:takeProfitPrice,stopLossPrice:stopLossPrice,
  });
  if (state.trades.length>200) state.trades.pop();
  console.log('Position opened TP:'+takeProfitPrice.toFixed(3)+' SL:'+stopLossPrice.toFixed(3));
  setTimeout(syncWalletBalance,3000);
  return position;
}

async function sellPosition(position, currentPrice, reason) {
  console.log('SELL: "'+( position.question||'').substring(0,40)+'" @ '+currentPrice+' | '+reason);
  var liveId=null;
  if (isLive&&state.setupDone&&position.tokenId){
    try{
      var order=await placeLiveOrder(position.tokenId,'SELL',currentPrice,position.size);
      liveId=order.orderID||order.id;
      console.log('SELL order: '+liveId);
    }catch(e){console.log('SELL failed:',e.message);}
  }
  var pnl=parseFloat(((currentPrice-position.entryPrice)*position.size/position.entryPrice).toFixed(2));
  var pnlPct=parseFloat(((currentPrice-position.entryPrice)/position.entryPrice*100).toFixed(2));
  state.totalProfit=parseFloat((state.totalProfit+pnl).toFixed(2));
  state.balance=parseFloat((state.initialCapital+state.totalProfit).toFixed(2));
  state.pnlHistory.push({ts:Date.now(),profit:state.totalProfit,delta:pnl});
  if (state.pnlHistory.length>200) state.pnlHistory.shift();
  state.openPositions=state.openPositions.filter(function(p){return p.id!==position.id;});
  state.trades.unshift({
    id:Date.now(),type:'CLOSE',question:position.question,
    outcome:position.outcome,entryPrice:position.entryPrice,
    exitPrice:currentPrice,size:position.size,
    pnl:pnl,pnlPct:pnlPct,aiScore:position.aiScore,
    reason:reason,openedAt:position.openedAt,closedAt:Date.now(),
    won:pnl>0,isLive:position.isLive,liveOrderId:liveId,
  });
  if (state.trades.length>200) state.trades.pop();
  console.log((pnl>=0?'PROFIT':'LOSS')+' $'+pnl+' ('+pnlPct+'%) | '+reason+' | Total:$'+state.totalProfit);
  setTimeout(syncWalletBalance,3000);
  return pnl;
}

async function monitorPositions() {
  if (state.openPositions.length===0) return;
  var positions=state.openPositions.slice();
  for (var i=0;i<positions.length;i++){
    var pos=positions[i],market=state.markets[pos.marketId];
    if (!market) continue;
    var cur=pos.outcome==='YES'?market.yesPrice:market.noPrice;
    if (!cur) continue;
    pos.currentPrice=cur;
    pos.pnl=parseFloat(((cur-pos.entryPrice)*pos.size/pos.entryPrice).toFixed(2));
    pos.pnlPct=parseFloat(((cur-pos.entryPrice)/pos.entryPrice*100).toFixed(2));
    var exit=analyzeExitSignal(pos,market);
    if (exit.shouldExit){await sellPosition(pos,cur,exit.reason);continue;}
    if (!pos.peakPrice||cur>pos.peakPrice) pos.peakPrice=cur;
    if (pos.peakPrice&&pos.pnlPct>5){
      var dropFromPeak=(pos.peakPrice-cur)/pos.peakPrice*100;
      if (dropFromPeak>5){
        await sellPosition(pos,cur,'PEAK_REVERSAL -'+dropFromPeak.toFixed(1)+'% profit='+pos.pnlPct.toFixed(1)+'%');
        continue;
      }
    }
    if (pos.pnlPct<-5){
      var better=getCachedSignals().filter(function(s){
        return s.signal==='BUY'&&s.aiScore>=85&&s.marketId!==pos.marketId&&
               !state.openPositions.find(function(p){return p.marketId===s.marketId;});
      });
      if (better.length>=2){
        await sellPosition(pos,cur,'REALLOCATE '+better.length+' sinyal lebih kuat loss='+pos.pnlPct.toFixed(1)+'%');
        continue;
      }
    }
  }
}

setInterval(async function(){
  await fetchAndCacheMarkets();
  if (wsClient&&wsClient.readyState===WS.OPEN) connectWebSocket();
},3*60*1000);

setInterval(syncWalletBalance,30*1000);

setInterval(async function(){
  if (state.setupDone) return;
  console.log('Auto-retry setup...');
  await generateApiCreds();
  await approveIfNeeded();
},2*60*1000);

setInterval(async function(){
  console.log('Auto-refresh API credentials...');
  state.apiCreds=null;
  await generateApiCreds();
},22*60*60*1000);

setInterval(function(){
  if (!wsClient||wsClient.readyState===WS.CLOSED||wsClient.readyState===WS.CLOSING){
    console.log('WebSocket down — reconnecting...');
    connectWebSocket();
  }
},30*1000);

setInterval(async function(){
  if (!state.botActive) return;
  await monitorPositions();
  var mkts=Object.values(state.markets)
    .filter(function(m){return !m.resolved&&m.volume24h>state.settings.minVolume;})
    .map(function(m){
      var score=scoreMarket(m);
      var sig=getSignal(m,score);
      return Object.assign({},m,{marketId:m.id,aiScore:score,signal:sig.signal,outcome:sig.outcome,reason:sig.reason});
    }).sort(function(a,b){return b.aiScore-a.aiScore;});
  for (var i=0;i<Math.min(mkts.length,state.settings.maxTradesPerCycle);i++){
    if (mkts[i].signal==='BUY') await checkSignalAndTrade(mkts[i]);
  }
},60*1000);

setInterval(async function(){
  if (!state.botActive) return;
  await monitorPositions();
},10*1000);

async function initialize() {
  console.log('Starting initialization...');
  try {
    await syncWalletBalance();
    await generateApiCreds();
    await approveIfNeeded();
    await syncWalletBalance();
    await fetchAndCacheMarkets();
    connectWebSocket();
    console.log('Init complete! Balance:$'+state.balance+' Setup:'+state.setupDone);
  } catch(e) {
    console.log('Init error:',e.message,'— retry in 60s');
    setTimeout(initialize,60*1000);
  }
}

setTimeout(initialize,5000);

function getCachedSignals() {
  return Object.values(state.markets)
    .filter(function(m){return !m.resolved;})
    .map(function(m){
      var score=scoreMarket(m);
      var sig=getSignal(m,score);
      return Object.assign({},m,{
        marketId:m.id,aiScore:score,signal:sig.signal,outcome:sig.outcome,reason:sig.reason,
        daysLeft:Math.max(0,(new Date(m.endDate)-Date.now())/86400000),
      });
    }).sort(function(a,b){return b.aiScore-a.aiScore;});
}
var DASH = '<!DOCTYPE html><html lang="id"><head>'
  + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">'
  + '<title>PolyBot AI</title>'
  + '<style>'
  + '*{margin:0;padding:0;box-sizing:border-box}body{font-family:monospace;background:#05070f;color:#dce8ff;padding:12px}'
  + '.app{max-width:440px;margin:0 auto}h1{font-size:20px;color:#00f5d4;margin-bottom:14px}'
  + '.badge{font-size:10px;padding:3px 8px;border-radius:6px;margin-left:6px}'
  + '.sim{background:rgba(255,209,102,.15);color:#ffd166;border:1px solid rgba(255,209,102,.3)}'
  + '.live{background:rgba(0,230,118,.15);color:#00e676;border:1px solid rgba(0,230,118,.3)}'
  + '.ok{background:rgba(155,93,229,.15);color:#9b5de5;border:1px solid rgba(155,93,229,.3)}'
  + '.rt{background:rgba(0,229,255,.15);color:#00e5ff;border:1px solid rgba(0,229,255,.3)}'
  + '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}'
  + '.stat{background:#0f1526;border:1px solid #1a2340;border-radius:10px;padding:10px;text-align:center}'
  + '.sv{font-size:18px;font-weight:700;margin-bottom:2px}'
  + '.sl{font-size:9px;color:#4a5980;letter-spacing:1px;text-transform:uppercase}'
  + '.g{color:#00e676}.c{color:#00f5d4}.p{color:#9b5de5}.r{color:#ff4058}.y{color:#ffd166}'
  + '.alloc{display:flex;justify-content:space-between;align-items:center;background:rgba(0,245,212,.05);border:1px solid rgba(0,245,212,.2);border-radius:10px;padding:12px;margin-bottom:10px}'
  + '.pct{font-size:36px;font-weight:700;color:#00f5d4;opacity:.7}'
  + '.sbox{background:#05070f;border:1px solid #1a2340;border-radius:10px;padding:12px;margin-bottom:10px;font-size:11px;line-height:2.2}'
  + '.row{display:flex;justify-content:space-between;border-bottom:1px solid #0f1526;padding:3px 0}'
  + '.row:last-child{border-bottom:none}.lbl{color:#4a5980}'
  + '.btn{display:block;width:100%;padding:13px;margin:7px 0;border:none;border-radius:10px;font-family:monospace;font-size:13px;font-weight:700;cursor:pointer}'
  + '.bs{background:linear-gradient(135deg,#00c853,#00e676);color:#000}'
  + '.bx{background:linear-gradient(135deg,#c62828,#ff4058);color:#fff}'
  + '.br{background:#1a2340;color:#dce8ff;border:1px solid #243060}'
  + '.card{background:#0f1526;border:1px solid #1a2340;border-radius:12px;padding:14px;margin-bottom:10px}'
  + '.ct{font-size:10px;color:#00f5d4;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px}'
  + '.mkt{padding:8px 0;border-bottom:1px solid #1a2340;font-size:10px}.mkt:last-child{border-bottom:none}'
  + '.mq{font-size:11px;margin-bottom:4px;line-height:1.4}'
  + '.mr{display:flex;justify-content:space-between;align-items:center;margin-bottom:2px}'
  + '.sig{font-size:9px;padding:2px 7px;border-radius:5px;font-weight:700;background:rgba(0,230,118,.2);color:#00e676}'
  + '.bar{height:4px;background:#1a2340;border-radius:2px;margin:3px 0;overflow:hidden}'
  + '.bf{height:100%;background:linear-gradient(90deg,#9b5de5,#00f5d4);border-radius:2px}'
  + '.tr{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #1a2340;font-size:10px;align-items:center}'
  + '.tr:last-child{border-bottom:none}'
  + '.tt{width:36px;text-align:center;padding:2px 4px;border-radius:4px;font-size:9px;font-weight:700;flex-shrink:0}'
  + '.tw{background:rgba(0,230,118,.15);color:#00e676}.tl{background:rgba(255,64,88,.15);color:#ff4058}'
  + '.ti{flex:1;min-width:0}.tn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '.td{color:#4a5980;font-size:9px;margin-top:1px}.tp{font-weight:700;flex-shrink:0}'
  + '.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}'
  + '.don{background:#00e676;box-shadow:0 0 6px #00e676;animation:p 1s infinite}.dof{background:#ff4058}'
  + '.note{background:rgba(255,209,102,.05);border:1px solid rgba(255,209,102,.2);border-radius:8px;padding:10px;margin-bottom:10px;font-size:10px;color:#ffd166;line-height:1.8}'
  + '.rtbox{background:rgba(0,229,255,.04);border:1px solid rgba(0,229,255,.2);border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:10px;display:flex;justify-content:space-between;align-items:center}'
  + '@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}'
  + '</style></head><body>'
  + '<div class="app">'
  + '<h1>PolyBot AI <span class="badge sim" id="mb">...</span><span class="badge ok" id="sb2">Setup...</span><span class="badge rt" id="wsb">WS...</span></h1>'
  + '<div class="note" id="note">50% Profit Rule: Bot hanya trade dari profit. Modal awal tidak disentuh.</div>'
  + '<div class="rtbox"><div><div style="font-size:9px;color:#4a5980">REAL-TIME FEED</div><div style="color:#00e5ff;font-weight:700" id="rtStatus">Connecting...</div></div>'
  + '<div style="text-align:right"><div style="font-size:9px;color:#4a5980">Price Updates</div><div style="color:#00f5d4;font-weight:700" id="rtCount">0</div></div></div>'
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
  + '<div class="row"><span class="lbl">USDC.e</span><span id="suce">-</span></div>'
  + '<div class="row"><span class="lbl">USDC native</span><span id="sucn">-</span></div>'
  + '<div class="row"><span class="lbl">Wallet</span><span style="font-size:9px;color:#4a5980" id="sw2">-</span></div>'
  + '<div class="row"><span class="lbl">Setup</span><span id="ssetup" class="y">Initializing...</span></div>'
  + '<div class="row"><span class="lbl">Markets Tracked</span><span id="smkts" class="c">0</span></div>'
  + '<div class="row"><span class="lbl">Open Positions</span><span id="spos" class="y">0</span></div>'
  + '<div class="row"><span class="lbl">Total Trade</span><span id="sc">0</span></div>'
  + '<div class="row"><span class="lbl">Scan/Trigger ke-</span><span id="sk">0</span></div>'
  + '<div class="row"><span class="lbl">Last Activity</span><span id="sl" style="font-size:9px">-</span></div>'
  + '</div>'
  + '<button class="btn bs" onclick="startBot()">START BOT</button>'
  + '<button class="btn bx" onclick="stopBot()">STOP BOT</button>'
  + '<button class="btn br" onclick="loadAll()">Refresh</button>'
  + '<div class="card"><div class="ct">Posisi Terbuka</div><div id="poslist"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Tidak ada posisi terbuka</div></div></div>'
  + '<div class="card"><div class="ct">AI Signals Terkuat (Real-Time)</div><div id="sigs"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Loading...</div></div></div>'
  + '<div class="card"><div class="ct">Trade Log</div><div id="tlog"><div style="color:#4a5980;font-size:11px;text-align:center;padding:10px">Belum ada trade</div></div></div>'
  + '</div>'
  + '<script>'
  + 'async function ls(){try{var d=await fetch("/status").then(function(r){return r.json();});'
  + 'document.getElementById("sp").textContent=(d.profit>=0?"+":"")+"$"+d.profit.toFixed(2);'
  + 'document.getElementById("sp").className="sv "+(d.profit>=0?"g":"r");'
  + 'document.getElementById("st").textContent="$"+d.tradeable.toFixed(2);'
  + 'document.getElementById("sw").textContent=d.winRate+"%";'
  + 'document.getElementById("af").textContent="$"+d.tradeable.toFixed(2)+" USDC";'
  + 'document.getElementById("ap").textContent="dari profit $"+d.profit.toFixed(2);'
  + 'document.getElementById("sbal").textContent="$"+d.balance.toFixed(2);'
  + 'document.getElementById("sic").textContent="$"+d.initialCapital.toFixed(2);'
  + 'document.getElementById("suce").textContent="$"+(d.balanceUSDCe||0).toFixed(2);'
  + 'document.getElementById("sucn").textContent="$"+(d.balanceUSDC||0).toFixed(2);'
  + 'document.getElementById("sw2").textContent=d.walletAddress?d.walletAddress.substring(0,8)+"..."+d.walletAddress.slice(-6):"-";'
  + 'document.getElementById("sc").textContent=d.totalTrades;'
  + 'document.getElementById("sk").textContent=d.scanCount||0;'
  + 'document.getElementById("sl").textContent=d.lastScan?new Date(d.lastScan).toLocaleTimeString("id-ID"):"-";'
  + 'document.getElementById("smkts").textContent=d.marketsTracked||0;'
  + 'document.getElementById("spos").textContent=d.openPositions||0;'
  + 'document.getElementById("ssetup").textContent=d.setupDone?"Ready":"Setting up...";'
  + 'document.getElementById("ssetup").className=d.setupDone?"g":"y";'
  + 'var on=d.botActive;'
  + 'document.getElementById("sd").className="dot "+(on?"don":"dof");'
  + 'document.getElementById("stxt").textContent=on?"AKTIF":"STOP";'
  + 'document.getElementById("stxt").className=on?"g":"r";'
  + 'document.getElementById("mb").textContent=d.isSimulation?"SIMULASI":"LIVE";'
  + 'document.getElementById("mb").className="badge "+(d.isSimulation?"sim":"live");'
  + 'document.getElementById("sb2").textContent=d.setupDone?"Setup OK":"Setup...";'
  + 'document.getElementById("rtStatus").textContent=d.wsConnected?"Connected":"Connecting...";'
  + 'document.getElementById("rtCount").textContent=d.priceUpdates||0;'
  + 'document.getElementById("wsb").textContent=d.wsConnected?"WS LIVE":"WS...";'
  + 'if(d.profit>0)document.getElementById("note").style.display="none";'
  + '}catch(e){}}'
  + 'async function lpos(){try{var d=await fetch("/status").then(function(r){return r.json();});'
  + 'var p=d.openPositionsData||[];'
  + 'if(!p.length){document.getElementById("poslist").innerHTML="<div style=\'color:#4a5980;font-size:11px;text-align:center;padding:10px\'>Tidak ada posisi terbuka</div>";return;}'
  + 'var html="";for(var i=0;i<p.length;i++){var pos=p[i];var pc=pos.pnl>=0?"#00e676":"#ff4058";'
  + 'html+="<div style=\'padding:9px 0;border-bottom:1px solid #1a2340;font-size:10px\'>"'
  + '+"<div style=\'display:flex;justify-content:space-between;margin-bottom:3px\'>"'
  + '+"<div style=\'font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\'>"+pos.question.substring(0,40)+"...</div>"'
  + '+"<span style=\'color:"+pc+";font-weight:700\'>"+(pos.pnl>=0?"+":"")+"$"+pos.pnl.toFixed(2)+"</span></div>"'
  + '+"<div style=\'display:flex;gap:8px;color:#4a5980\'>"'
  + '+"<span>"+pos.outcome+"</span><span>E:"+pos.entryPrice.toFixed(3)+"</span>"'
  + '+"<span>N:"+pos.currentPrice.toFixed(3)+"</span>"'
  + '+"<span style=\'color:#00e676\'>TP:"+pos.takeProfitPrice.toFixed(3)+"</span>"'
  + '+"<span style=\'color:#ff4058\'>SL:"+pos.stopLossPrice.toFixed(3)+"</span>"'
  + '+"</div></div>";}document.getElementById("poslist").innerHTML=html;'
  + '}catch(e){}}'
  + 'async function lsig(){try{var s=await fetch("/signals").then(function(r){return r.json();});'
  + 'var t=s.filter(function(x){return x.signal==="BUY";}).slice(0,5);'
  + 'if(!t.length){document.getElementById("sigs").innerHTML="<div style=\'color:#4a5980;font-size:11px;text-align:center;padding:10px\'>Scanning...</div>";return;}'
  + 'var html="";for(var i=0;i<t.length;i++){var sig=t[i];'
  + 'html+="<div class=\'mkt\'><div class=\'mr\'><div class=\'mq\'>"+sig.question.substring(0,55)+"...</div><span class=\'sig\'>BUY</span></div>"'
  + '+"<div class=\'mr\'><span style=\'color:#4a5980;font-size:9px\'>YES "+(sig.yesPrice*100).toFixed(0)+"c | NO "+(sig.noPrice*100).toFixed(0)+"c | $"+(sig.volume24h/1000).toFixed(0)+"K</span>"'
  + '+"<span class=\'c\' style=\'font-size:10px;font-weight:700\'>"+sig.aiScore+"%</span></div>"'
  + '+"<div class=\'bar\'><div class=\'bf\' style=\'width:"+sig.aiScore+"%\'></div></div>"'
  + '+"<div style=\'font-size:9px;color:#4a5980;font-style:italic\'>"+sig.reason+"</div></div>";}'
  + 'document.getElementById("sigs").innerHTML=html;}catch(e){}}'
  + 'async function ltrades(){try{var t=await fetch("/trades").then(function(r){return r.json();});'
  + 'if(!t.length){document.getElementById("tlog").innerHTML="<div style=\'color:#4a5980;font-size:11px;text-align:center;padding:10px\'>Belum ada trade</div>";return;}'
  + 'var html="";for(var i=0;i<Math.min(t.length,10);i++){var tr=t[i];'
  + 'html+="<div class=\'tr\'><div class=\'tt "+(tr.won?"tw":"tl")+"\'>"+(tr.type==="OPEN"?"BUY":(tr.won?"WIN":"LOSS"))+"</div>"'
  + '+"<div class=\'ti\'><div class=\'tn\'>"+(tr.question||"").substring(0,38)+"...</div>"'
  + '+"<div class=\'td\'>"+(tr.outcome||"YES")+" @ "+(tr.entryPrice||0).toFixed(2)+" | $"+(tr.size||0).toFixed(2)+" | "+(tr.isLive?"LIVE":"SIM")+"</div></div>"'
  + '+"<div class=\'tp "+(tr.pnl>=0?"g":"r")+"\'>"+(tr.pnl>=0?"+":"")+"$"+Math.abs(tr.pnl||0).toFixed(2)+"</div></div>";}'
  + 'document.getElementById("tlog").innerHTML=html;}catch(e){}}'
  + 'async function startBot(){await fetch("/bot/start",{method:"POST"});alert("Bot aktif!");loadAll();}'
  + 'async function stopBot(){await fetch("/bot/stop",{method:"POST"});alert("Bot dihentikan");loadAll();}'
  + 'async function loadAll(){await Promise.all([ls(),lpos(),lsig(),ltrades()]);}'
  + 'loadAll();setInterval(ls,5000);setInterval(lpos,5000);setInterval(lsig,10000);setInterval(ltrades,10000);'
  + '<\/script></body></html>';

app.get('/', function(req,res){ res.send(DASH); });
app.get('/health', function(req,res){ res.json({status:'ok',ts:Date.now(),mode:isLive?'live':'simulation'}); });
app.get('/status', function(req,res){ res.json({
  botActive:state.botActive, isSimulation:!isLive,
  profit:state.totalProfit, balance:state.balance,
  initialCapital:state.initialCapital, tradeable:getTradeable(),
  positionSize:getPositionSize(), walletAddress:state.walletAddress,
  setupDone:state.setupDone, apiReady:!!state.apiCreds,
  wsConnected:!!(wsClient&&wsClient.readyState===WS.OPEN),
  priceUpdates:state.priceUpdates, lastPriceAt:state.lastPriceAt,
  marketsTracked:Object.keys(state.markets).length,
  balanceUSDCe:state.balanceUSDCe||0, balanceUSDC:state.balanceUSDC||0,
  winRate:state.trades.length>0?Math.round(state.trades.filter(function(t){return t.won;}).length/state.trades.length*100):0,
  totalTrades:state.trades.length, openPositions:state.openPositions.length,
  openPositionsData:state.openPositions,
  scanCount:state.scanCount, lastScan:state.lastScan,
  uptime:Math.floor(process.uptime()), settings:state.settings,
}); });
app.get('/signals',   function(req,res){ res.json(getCachedSignals().slice(0,30)); });
app.get('/trades',    function(req,res){ res.json(state.trades.slice(0,50)); });
app.get('/positions', function(req,res){ res.json(state.openPositions); });
app.get('/pnl',       function(req,res){ res.json(state.pnlHistory); });
app.post('/bot/start', function(req,res){ state.botActive=true; setTimeout(function(){checkSignalAndTrade(Object.values(state.markets)[0]);},2000); res.json({ok:true}); });
app.post('/bot/stop',  function(req,res){ state.botActive=false; res.json({ok:true}); });
app.post('/bot/reset', function(req,res){
  state.totalProfit=0; state.balance=state.initialCapital;
  state.trades=[]; state.pnlHistory=[]; state.scanCount=0;
  res.json({ok:true});
});
app.post('/settings', function(req,res){
  var keys=['minAiScore','maxTradesPerCycle','stopLossPct','takeProfitPct','minPositionUSD','maxPositionUSD','strategy','minPriceMovePct','minVolume'];
  keys.forEach(function(k){ if(req.body[k]!==undefined) state.settings[k]=req.body[k]; });
  res.json({ok:true,settings:state.settings});
});
app.post('/trade/manual', async function(req,res){
  var sigs=getCachedSignals();
  var sig=sigs.find(function(s){return s.marketId===req.body.marketId;});
  if (!sig) sig={question:req.body.marketId,outcome:req.body.outcome,yesPrice:0.5,noPrice:0.5,aiScore:70,reason:'Manual'};
  var t=await executeTrade(Object.assign({},sig,{outcome:req.body.outcome,signal:'BUY'}),parseFloat(req.body.amount));
  res.json({ok:true,result:t});
});

var PORT=process.env.PORT||3001;
app.listen(PORT,'0.0.0.0',function(){
  console.log('PolyBot AI running on port '+PORT);
  console.log('Mode: '+(isLive?'LIVE':'SIMULASI'));
  console.log('RPC: '+(process.env.POLYGON_RPC||'https://rpc.ankr.com/polygon'));
});
