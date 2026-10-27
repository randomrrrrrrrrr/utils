// Live board: how much is still left to buy / sell through running TWAPs.
// One Discord message, edited on every run. State lives in pressure.json.

const fs = require("fs");
const path = require("path");

const WEBHOOK = process.env.DISCORD_PRESSURE_WEBHOOK_URL;
const DRY_RUN = process.env.DRY_RUN === "1" || !WEBHOOK;
const STATE_FILE = path.join(__dirname, "pressure.json");

const COINS = ["HYPE", "BTC", "ETH", "PURR"]; // board order
const SPOT_BASES = { UBTC: "BTC", UETH: "ETH", HYPE: "HYPE", PURR: "PURR" };
const STABLES = new Set(["USDC", "USDT0", "USDH", "USDE", "USDT"]);
const RECHECK_AFTER_MS = 20 * 60 * 60 * 1000; // older than this -> confirm with Hyperliquid it's still running
const MAX_USER_CHECKS = 40;

const TWAP_URL = "https://api.hypurrscan.io/twap/*";
const HL_INFO = "https://api.hyperliquid.xyz/info";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "user-agent": "utils/1.0" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// asset id -> { coin, kind, midKey }
function buildMarkets(meta, spotMeta) {
  const markets = new Map();
  meta.universe.forEach((u, i) => {
    if (COINS.includes(u.name) && !u.isDelisted) markets.set(i, { coin: u.name, kind: "perp", midKey: u.name });
  });
  for (const pair of spotMeta.universe) {
    const [b, q] = pair.tokens.map((t) => spotMeta.tokens[t]?.name);
    const coin = SPOT_BASES[b];
    if (coin && STABLES.has(q)) markets.set(10000 + pair.index, { coin, kind: "spot", midKey: pair.name });
  }
  return markets;
}

function fmtUsd(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(a / 1e3)}k`;
  return `$${Math.round(a)}`;
}
const signed = (n) => `${n >= 0 ? "+" : "-"}${fmtUsd(n)}`;

function bar(buy, sell) {
  const total = buy + sell;
  if (!total) return "";
  const g = Math.round((buy / total) * 10);
  return `${"🟩".repeat(g)}${"🟥".repeat(10 - g)} ${Math.round((buy / total) * 100)}% buys`;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { msgId: null, active: {} };
  }
}

// Ask Hyperliquid which of these wallets' older TWAPs are still running.
async function dropFinished(state, now) {
  const old = Object.entries(state.active).filter(([, x]) => now - x.t > RECHECK_AFTER_MS);
  const users = [...new Set(old.map(([, x]) => x.u))].slice(0, MAX_USER_CHECKS);
  for (const user of users) {
    let hist;
    try {
      hist = await getJson(HL_INFO, { type: "twapHistory", user });
    } catch {
      continue; // try again next run
    }
    const done = new Set(hist.filter((e) => e.status?.status !== "activated").map((e) => e.state?.timestamp));
    for (const [h, x] of old) if (x.u === user && done.has(x.t)) delete state.active[h];
    await sleep(250);
  }
}

function buildBoard(state, mids, markets, now) {
  const byKind = new Map([...markets.values()].map((m) => [`${m.coin}|${m.kind}|${m.midKey}`, m]));
  const stats = Object.fromEntries(
    COINS.map((c) => [c, { buy: 0, sell: 0, buyN: 0, sellN: 0, buyRate: 0, sellRate: 0, spot: 0, perp: 0, biggest: null }])
  );

  for (const x of Object.values(state.active)) {
    const m = byKind.get(`${x.coin}|${x.kind}|${x.mid}`);
    const price = Number(mids[x.mid]);
    if (!m || !price) continue;
    const durMs = x.m * 60_000;
    const left = Math.max(0, 1 - (now - x.t) / durMs);
    if (left <= 0) continue;
    const total = x.s * price;
    const remaining = total * left;
    const perHour = total / (x.m / 60);
    const st = stats[x.coin];
    if (x.b) {
      st.buy += remaining; st.buyN++; st.buyRate += perHour;
    } else {
      st.sell += remaining; st.sellN++; st.sellRate += perHour;
    }
    st[x.kind] += x.b ? remaining : -remaining;
    if (!st.biggest || remaining > st.biggest.remaining) st.biggest = { remaining, b: x.b, kind: x.kind, end: x.t + durMs };
  }

  const fields = COINS.map((coin) => {
    const s = stats[coin];
    const net = s.buy - s.sell;
    const gross = s.buy + s.sell;
    if (!gross) return { name: `${coin} · ⚪ quiet`, value: "no TWAPs running right now", inline: false };
    const lean = Math.abs(net) < gross * 0.1 ? "⚪ balanced" : net > 0 ? "🟢 BUY pressure" : "🔴 SELL pressure";
    const big = s.biggest;
    const lines = [
      `🟢 buying **${fmtUsd(s.buy)}** left · ${s.buyN} TWAP${s.buyN === 1 ? "" : "s"} · ${fmtUsd(s.buyRate)}/h`,
      `🔴 selling **${fmtUsd(s.sell)}** left · ${s.sellN} TWAP${s.sellN === 1 ? "" : "s"} · ${fmtUsd(s.sellRate)}/h`,
      `net **${signed(net)}** (${signed(s.buyRate - s.sellRate)}/h)`,
      bar(s.buy, s.sell),
      `spot ${signed(s.spot)} · perp ${signed(s.perp)}`,
      `biggest: ${big.b ? "🟢" : "🔴"} ${fmtUsd(big.remaining)} ${big.b ? "buy" : "sell"} · ${big.kind} · ends <t:${Math.floor(big.end / 1000)}:R>`,
    ];
    return { name: `${coin} · ${lean}`, value: lines.join("\n"), inline: false };
  });

  const hypeNet = stats.HYPE.buy - stats.HYPE.sell;
  return {
    title: "📊 TWAP pressure board",
    description: `what's still left to buy / sell through TWAPs on Hyperliquid\nupdated <t:${Math.floor(now / 1000)}:R>`,
    color: hypeNet >= 0 ? 0x2ecc71 : 0xe74c3c,
    fields,
    footer: { text: "ROT · updates every ~5 min · estimates assume TWAPs fill on schedule" },
    timestamp: new Date(now).toISOString(),
  };
}

async function send(method, url, payload) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${method}\n` + payload.embeds[0].fields.map((f) => `${f.name}\n${f.value}`).join("\n\n"));
    return { status: 200, json: { id: "dry-run" } };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil((j.retry_after || 2) * 1000) + 250);
      continue;
    }
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  throw new Error("Discord rate limit: gave up after 5 tries");
}

async function main() {
  const now = Date.now();
  const [twaps, meta, spotMeta, mids] = await Promise.all([
    getJson(TWAP_URL),
    getJson(HL_INFO, { type: "meta" }),
    getJson(HL_INFO, { type: "spotMeta" }),
    getJson(HL_INFO, { type: "allMids" }),
  ]);
  if (!Array.isArray(twaps)) throw new Error("HypurrScan returned something unexpected");
  const markets = buildMarkets(meta, spotMeta);
  const state = loadState();

  // 1) add new TWAPs on our coins, drop ones HypurrScan marks as ended
  for (const rec of twaps) {
    const t = rec?.action?.twap;
    if (!rec?.hash || !t) continue;
    const mkt = markets.get(Number(t.a));
    if (!mkt) continue;
    if (rec.ended || rec.error) {
      delete state.active[rec.hash];
      continue;
    }
    if (!state.active[rec.hash]) {
      state.active[rec.hash] = {
        u: rec.user, coin: mkt.coin, kind: mkt.kind, mid: mkt.midKey,
        b: !!t.b, s: Math.abs(Number(t.s)), m: Number(t.m), t: Number(rec.time),
      };
    }
  }

  // 2) drop ones whose time is up, and confirm long-running ones with Hyperliquid
  for (const [h, x] of Object.entries(state.active)) if (now >= x.t + x.m * 60_000) delete state.active[h];
  await dropFinished(state, now);

  // 3) post or edit the board
  const payload = { embeds: [buildBoard(state, mids, markets, now)] };
  let res = state.msgId ? await send("PATCH", `${WEBHOOK}/messages/${state.msgId}`, payload) : null;
  if (!res || res.status === 404) {
    res = await send("POST", `${WEBHOOK}?wait=true`, payload);
    state.msgId = res.json.id;
  }
  if (res.status >= 300) throw new Error(`Discord -> HTTP ${res.status}: ${JSON.stringify(res.json)}`);

  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`tracking ${Object.keys(state.active).length} running TWAPs on ${COINS.join("/")}${DRY_RUN ? " [dry run]" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
