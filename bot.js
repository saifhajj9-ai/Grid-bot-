// ============================================================
// Grid Bot for Binance — Single File
// Requirements: Node.js 18+ (fetch built-in)
// Run: node bot.js
// ============================================================

const crypto = require("crypto");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------- CONFIG ----------------
const CFG = {
  apiKey: process.env.BINANCE_API_KEY || "",
  apiSecret: process.env.BINANCE_API_SECRET || "",
  base: process.env.BINANCE_BASE || "https://testnet.binance.vision",
  symbol: process.env.SYMBOL || "ETHUSDT",
  totalQuote: Number(process.env.TOTAL_QUOTE || "4000"),
  levels: Number(process.env.LEVELS || "34"),
  lowerPct: Number(process.env.LOWER_PCT || "0.03"),
  upperPct: Number(process.env.UPPER_PCT || "0.03"),
  feeRate: Number(process.env.FEE_RATE || "0.00075"),
  paperMode: process.env.PAPER !== "false",
  pollMs: 3000,
  telegramToken: process.env.TELEGRAM_TOKEN || "",
  telegramChat: process.env.TELEGRAM_CHAT_ID || "",
};

// ---------------- STATE ----------------
let precision = null;
let levels = [];
let lower = 0, upper = 0;
let currentPrice = 0;
let balances = { base: 0, quote: 0 };
let stats = { startValue: 0, cycles: 0, wins: 0, losses: 0, totalProfit: 0 };
let running = true;
let lastTrail = 0;
let lastRecenter = 0;
let regime = "UNKNOWN";

// ---------------- BINANCE API ----------------
function sign(q) {
  return crypto.createHmac("sha256", CFG.apiSecret).update(q).digest("hex");
}

async function api(method, urlPath, params = {}, signed = false) {
  const all = signed ? { ...params, timestamp: Date.now(), recvWindow: 5000 } : params;
  const qs = new URLSearchParams(
    Object.entries(all).map(([k, v]) => [k, String(v)])
  ).toString();
  const sig = signed ? `&signature=${sign(qs)}` : "";
  const url = `${CFG.base}${urlPath}?${qs}${sig}`;

  const res = await fetch(url, {
    method,
    headers: signed ? { "X-MBX-APIKEY": CFG.apiKey } : {},
  });
  if (!res.ok) throw new Error(`${urlPath} ${res.status}: ${await res.text()}`);
  return res.json();
}

const getPrice = async () => +(await api("GET", "/api/v3/ticker/price", { symbol: CFG.symbol })).price;
const getInfo = () => api("GET", "/api/v3/exchangeInfo", { symbol: CFG.symbol });
const getAccount = () => api("GET", "/api/v3/account", {}, true);
const getOpenOrders = () => api("GET", "/api/v3/openOrders", { symbol: CFG.symbol }, true);
const getKlines = () => api("GET", "/api/v3/klines", { symbol: CFG.symbol, interval: "1m", limit: 200 });

const cancelAll = () => api("DELETE", "/api/v3/openOrders", { symbol: CFG.symbol }, true);
const cancelOrder = (orderId) =>
  api("DELETE", "/api/v3/order", { symbol: CFG.symbol, orderId }, true);

function placeBuy(price, qty, clientId) {
  return api("POST", "/api/v3/order", {
    symbol: CFG.symbol, side: "BUY", type: "LIMIT_MAKER",
    timeInForce: "GTC", price, quantity: qty, newClientOrderId: clientId,
  }, true);
}
function placeSell(price, qty, clientId) {
  return api("POST", "/api/v3/order", {
    symbol: CFG.symbol, side: "SELL", type: "LIMIT_MAKER",
    timeInForce: "GTC", price, quantity: qty, newClientOrderId: clientId,
  }, true);
}
function marketSell(qty) {
  return api("POST", "/api/v3/order", {
    symbol: CFG.symbol, side: "SELL", type: "MARKET", quantity: qty,
  }, true);
}

// ---------------- HELPERS ----------------
function extractPrecision(raw) {
  const pf = raw.filters.find((f) => f.filterType === "PRICE_FILTER");
  const lf = raw.filters.find((f) => f.filterType === "LOT_SIZE");
  const nf = raw.filters.find((f) => ["NOTIONAL", "MIN_NOTIONAL"].includes(f.filterType));
  return {
    tick: +pf.tickSize, step: +lf.stepSize, minQty: +lf.minQty,
    minNotional: +(nf?.minNotional ?? 5),
    priceDec: raw.quotePrecision ?? 8,
    qtyDec: raw.baseAssetPrecision ?? 8,
    baseAsset: raw.baseAsset, quoteAsset: raw.quoteAsset,
  };
}

function formatPrice(p) {
  return (Math.floor(p / precision.tick) * precision.tick).toFixed(precision.priceDec);
}
function formatQty(q) {
  return (Math.floor(q / precision.step) * precision.step).toFixed(precision.qtyDec);
}

// ---------------- TELEGRAM ----------------
async function tg(msg) {
  if (!CFG.telegramToken || !CFG.telegramChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CFG.telegramChat,
        text: msg,
        parse_mode: "HTML",
      }),
    });
  } catch {}
}

// ---------------- REGIME DETECTION ----------------
function ema(d, p) {
  const k = 2 / (p + 1);
  let e = d[0];
  for (let i = 1; i < d.length; i++) e = d[i] * k + e * (1 - k);
  return e;
}

function detectRegime(candles) {
  const c = candles.map((x) => +x[4]);
  const h = candles.map((x) => +x[2]);
  const l = candles.map((x) => +x[3]);
  if (c.length < 100) return "RANGING";

  const price = c[c.length - 1];
  const emaF = ema(c, 9);
  const emaS = ema(c, 50);

  let trSum = 0;
  for (let i = 1; i < 50; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i-1]), Math.abs(l[i] - c[i-1]));
    trSum += tr;
  }
  const atr = trSum / 50;
  const atrPct = atr / price;

  const slope = (emaF - emaS) / price;

  if (slope > 0.005 && price > emaS) return "UPTREND";
  if (slope < -0.005 && price < emaS) return "DOWNTREND";
  if (atrPct > 0.02) return "BREAKOUT";
  if (atrPct < 0.005) return "SQUEEZE";
  return "RANGING";
}

// ---------------- GRID ----------------
function buildGrid() {
  lower = currentPrice * (1 - CFG.lowerPct);
  upper = currentPrice * (1 + CFG.upperPct);
  const ratio = Math.pow(upper / lower, 1 / (CFG.levels - 1));
  const perLevel = CFG.totalQuote / CFG.levels;

  levels = [];
  for (let i = 0; i < CFG.levels; i++) {
    const price = lower * Math.pow(ratio, i);
    levels.push({
      index: i,
      price,
      side: price < currentPrice ? "BUY" : "SELL",
      qty: perLevel / price,
      clientId: `g${Date.now()}${i}`,
      orderId: null,
      status: "idle",
      entryPrice: null,
    });
  }
}

async function placeLevel(level) {
  const priceStr = formatPrice(level.price);
  const qtyStr = formatQty(level.qty);
  const p = +priceStr, q = +qtyStr;

  if (q < precision.minQty) return false;
  if (p * q < precision.minNotional) return false;
  if (level.side === "BUY" && balances.quote < p * q) return false;
  if (level.side === "SELL" && balances.base < q) return false;

  if (CFG.paperMode) {
    level.orderId = Math.floor(Math.random() * 1e9);
    level.status = "placed";
    return true;
  }

  try {
    const order = level.side === "BUY"
      ? await placeBuy(priceStr, qtyStr, level.clientId)
      : await placeSell(priceStr, qtyStr, level.clientId);
    level.orderId = order.orderId;
    level.status = "placed";
    if (level.side === "BUY") balances.quote -= p * q;
    else balances.base -= q;
    return true;
  } catch (e) {
    if (String(e.message).includes("-2010")) return false;
    console.error(`[place] ${level.side} @ ${priceStr}:`, String(e.message).slice(0, 80));
    return false;
  }
}

async function placeAll(pauseBuying = false, pauseSelling = false) {
  let count = 0;
  for (const l of levels) {
    if (l.status === "placed" || l.status === "filled") continue;
    if (l.side === "BUY" && pauseBuying) continue;
    if (l.side === "SELL" && pauseSelling) continue;
    if (await placeLevel(l)) count++;
  }
  console.log(`[grid] placed ${count}/${levels.length}`);
  return count;
}

async function cancelUnfilled() {
  if (CFG.paperMode) {
    for (const l of levels) { l.status = "idle"; l.orderId = null; }
    return;
  }
  for (const l of levels) {
    if (l.status === "placed" && l.orderId) {
      try { await cancelOrder(l.orderId); } catch {}
      l.status = "idle"; l.orderId = null;
    }
  }
}

// ---------------- FILL HANDLING ----------------
async function checkFills() {
  if (CFG.paperMode) {
    for (const l of levels) {
      if (l.status !== "placed") continue;
      const hit = l.side === "BUY" ? currentPrice <= l.price : currentPrice >= l.price;
      if (hit) await onFill(l);
    }
    return;
  }
  const open = await getOpenOrders();
  const openIds = new Set(open.map((o) => o.orderId));
  for (const l of levels) {
    if (l.status === "placed" && l.orderId && !openIds.has(l.orderId)) {
      await onFill(l);
    }
  }
}

async function onFill(level) {
  level.status = "filled";
  const fillPrice = level.side === "BUY" ? level.price : level.price;
  console.log(`[FILL] ${level.side} @ ${fillPrice.toFixed(4)}`);

  stats.cycles++;
  let profit;
  if (level.side === "SELL" && level.entryPrice) {
    const gross = (fillPrice - level.entryPrice) * level.qty;
    const fees = (fillPrice + level.entryPrice) * level.qty * CFG.feeRate;
    profit = gross - fees;
    stats.totalProfit += profit;
    if (profit > 0) stats.wins++; else stats.losses++;
    await tg(`${level.side === "BUY" ? "🟢" : "🔴"} <b>${level.side}</b> ${level.qty.toFixed(4)} @ ${fillPrice.toFixed(2)}\n💰 ${profit.toFixed(4)}`);
  } else {
    await tg(`${level.side === "BUY" ? "🟢" : "🔴"} <b>${level.side}</b> ${level.qty.toFixed(4)} @ ${fillPrice.toFixed(2)}`);
  }

  await refreshBalances();

  // Counter order
  const idx = levels.indexOf(level);
  const ci = level.side === "BUY" ? idx + 1 : idx - 1;
  if (ci >= 0 && ci < levels.length) {
    const counter = levels[ci];
    if (counter.status === "idle") {
      counter.qty = level.qty;
      counter.side = level.side === "BUY" ? "SELL" : "BUY";
      counter.clientId = `g${Date.now()}${ci}`;
      counter.entryPrice = level.side === "BUY" ? level.price : level.entryPrice;
      if (await placeLevel(counter)) {
        console.log(`[auto] ${counter.side} @ ${counter.price.toFixed(4)}`);
      }
    }
  }
  await saveState();
}

// ---------------- BALANCES ----------------
async function refreshBalances() {
  if (CFG.paperMode) {
    if (stats.startValue === 0) {
      balances.quote = CFG.totalQuote;
      stats.startValue = CFG.totalQuote;
    }
    return;
  }
  const acc = await getAccount();
  const b = acc.balances.find((x) => x.asset === precision.baseAsset);
  const q = acc.balances.find((x) => x.asset === precision.quoteAsset);
  balances.base = +(b?.free ?? 0);
  balances.quote = +(q?.free ?? 0);
  const value = balances.quote + balances.base * currentPrice;
  if (stats.startValue === 0) stats.startValue = value;
}

// ---------------- TRAILING & RECENTER ----------------
async function checkTrailing() {
  const range = upper - lower;
  const trigger = upper - range * 0.02;
  if (currentPrice < trigger) return;
  const sells = levels.filter((l) => l.side === "SELL" && l.status === "filled").length;
  if (sells === 0) return;
  if (Date.now() - lastTrail < 120000) return;
  lastTrail = Date.now();
  console.log(`[trail] shifting up`);
  await replan("UPTREND");
}

async function checkRecenter() {
  const out = currentPrice < lower * 0.98 || currentPrice > upper * 1.02;
  if (!out) return;
  if (Date.now() - lastRecenter < 60000) return;
  lastRecenter = Date.now();
  console.log(`[recenter]`);
  await replan(regime);
}

async function replan(newRegime) {
  let lp = 0.03, up = 0.03, n = 34;
  if (newRegime === "UPTREND") { lp = 0.015; up = 0.06; n = 20; }
  else if (newRegime === "DOWNTREND") { lp = 0.06; up = 0.015; n = 12; }
  else if (newRegime === "SQUEEZE") { lp = 0.01; up = 0.01; n = 40; }
  else if (newRegime === "RANGING") { lp = 0.03; up = 0.03; n = 34; }

  await cancelUnfilled();
  const oldL = CFG.lowerPct, oldU = CFG.upperPct, oldN = CFG.levels;
  CFG.lowerPct = lp; CFG.upperPct = up; CFG.levels = n;
  buildGrid();
  CFG.lowerPct = oldL; CFG.upperPct = oldU; CFG.levels = oldN;

  await refreshBalances();
  const pauseBuy = newRegime === "DOWNTREND";
  const pauseSell = newRegime === "UPTREND";
  await placeAll(pauseBuy, pauseSell);
  await saveState();
}

// ---------------- STATE ----------------
function saveState() {
  try {
    fs.writeFileSync(
      path.resolve("./state.json"),
      JSON.stringify({ levels, lower, upper, stats, savedAt: Date.now() }, null, 2)
    );
  } catch {}
}

// ---------------- DASHBOARD ----------------
function startDashboard() {
  const html = `<!DOCTYPE html>
<html dir="rtl"><head><meta charset="utf-8"><title>Grid Bot</title>
<style>
body{font-family:system-ui;background:#0a0a0a;color:#eee;margin:0;padding:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:20px}
.l{font-size:12px;color:#888;text-transform:uppercase}
.v{font-size:24px;font-weight:600;margin-top:8px}
.g{color:#22c55e}.r{color:#ef4444}
.lv{max-height:500px;overflow-y:auto;background:#1a1a1a;border-radius:12px;padding:12px}
.row{display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid #222;font-size:13px;font-family:monospace}
.buy{border-right:3px solid #22c55e}.sell{border-right:3px solid #ef4444}
.f{opacity:0.4}
</style></head><body>
<h1>Grid Bot — ${CFG.symbol}</h1>
<div class="grid" id="stats"></div>
<h3>Levels</h3><div class="lv" id="levels"></div>
<script>
async function r(){
  const s = await fetch('/api').then(r=>r.json());
  const pc = s.pnlPct>=0?'g':'r';
  document.getElementById('stats').innerHTML = \`
    <div class="card"><div class="l">Price</div><div class="v">\${s.price.toFixed(4)}</div></div>
    <div class="card"><div class="l">Value</div><div class="v">\${s.value.toFixed(2)}</div></div>
    <div class="card"><div class="l">PnL</div><div class="v \${pc}">\${s.pnlPct.toFixed(2)}%</div></div>
    <div class="card"><div class="l">Regime</div><div class="v" style="font-size:16px">\${s.regime}</div></div>
    <div class="card"><div class="l">Trades</div><div class="v">\${s.cycles}</div></div>
    <div class="card"><div class="l">Wins/Losses</div><div class="v">\${s.wins}/\${s.losses}</div></div>
    <div class="card"><div class="l">Open</div><div class="v">\${s.open}</div></div>
    <div class="card"><div class="l">Profit</div><div class="v \${s.totalProfit>=0?'g':'r'}">\${s.totalProfit.toFixed(2)}</div></div>
  \`;
  document.getElementById('levels').innerHTML = s.levels.map(l =>
    \`<div class="row \${l.side.toLowerCase()} \${l.status==='filled'?'f':''}">
      <span>\${l.side}</span><span>\${l.price.toFixed(2)}</span>
      <span>\${l.qty.toFixed(4)}</span><span>\${l.status}</span></div>\`
  ).join('');
}
r(); setInterval(r, 3000);
</script></body></html>`;

  http.createServer((req, res) => {
    if (req.url === "/api") {
      const value = balances.quote + balances.base * currentPrice;
      const pnlPct = stats.startValue > 0 ? ((value - stats.startValue) / stats.startValue) * 100 : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        price: currentPrice, value, pnlPct, regime,
        cycles: stats.cycles, wins: stats.wins, losses: stats.losses,
        totalProfit: stats.totalProfit,
        open: levels.filter((l) => l.status === "placed").length,
        levels,
      }));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    }
  }).listen(3000, () => console.log(`[dashboard] http://localhost:3000`));
}

// ---------------- MAIN LOOP ----------------
async function main() {
  console.log(`\n=== Grid Bot ===`);
  console.log(`Symbol: ${CFG.symbol}`);
  console.log(`Capital: ${CFG.totalQuote} USDT`);
  console.log(`Grids: ${CFG.levels} levels, ±${(CFG.lowerPct*100).toFixed(1)}%`);
  console.log(`Mode: ${CFG.paperMode ? "PAPER (safe)" : "LIVE"}\n`);

  if (!CFG.paperMode && !CFG.apiKey) {
    console.error("Missing BINANCE_API_KEY");
    process.exit(1);
  }

  const info = await getInfo();
  precision = extractPrecision(info.symbols[0]);
  currentPrice = await getPrice();
  await refreshBalances();

  console.log(`[init] ${CFG.symbol} @ ${currentPrice.toFixed(2)}`);
  console.log(`[init] base=${balances.base.toFixed(4)} quote=${balances.quote.toFixed(2)}`);

  buildGrid();
  if (!CFG.paperMode) await cancelAll().catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  await refreshBalances();
  await placeAll();

  startDashboard();

  // Main loop
  setInterval(async () => {
    if (!running) return;
    try {
      currentPrice = await getPrice();
      await checkFills();
      await checkTrailing();
      await checkRecenter();
    } catch (e) {
      console.error("[loop]", e.message);
    }
  }, CFG.pollMs);

  // Regime loop
  setInterval(async () => {
    try {
      const candles = await getKlines();
      const newRegime = detectRegime(candles);
      if (newRegime !== regime) {
        console.log(`[regime] ${regime} -> ${newRegime}`);
        regime = newRegime;
        await tg(`📊 <b>${newRegime}</b>`);
      }
    } catch {}
  }, 60000);

  process.on("SIGINT", async () => {
    console.log("\n[stop]");
    running = false;
    if (!CFG.paperMode) await cancelAll().catch(() => {});
    saveState();
    process.exit(0);
  });
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
