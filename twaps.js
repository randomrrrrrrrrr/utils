function a() {
  if (x) {
    return [1, 2];
  }
}
// Runs once per call (scheduled every ~5 minutes). State lives in state.json.

const fs = require("fs");
const path = require("path");

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DRY_RUN = process.env.DRY_RUN === "1" || !WEBHOOK;
const STATE_FILE = path.join(__dirname, "state.json");

// Minimum order size in USD, per coin. Can be overridden with env vars, e.g. MIN_BTC=250000
const MIN_USD = {
  BTC: Number(process.env.MIN_BTC || 100_000),
  ETH: Number(process.env.MIN_ETH || 100_000),
  HYPE: Number(process.env.MIN_HYPE || 25_000),
  PURR: Number(process.env.MIN_PURR || 25_000),
};
// Spot tokens that count as each coin (UBTC/UETH are BTC/ETH on Hyperliquid spot)
const SPOT_BASES = { UBTC: "BTC", UETH: "ETH", HYPE: "HYPE", PURR: "PURR" };
const STABLES = new Set(["USDC", "USDT0", "USDH", "USDE", "USDT"]);
// The first time it runs, post at most this many of the TWAPs already live
const BACKFILL_MAX = Number(process.env.BACKFILL_MAX || 10);
const KEEP_MS = 26 * 60 * 60 * 1000; // HypurrScan only lists the last ~24h of TWAPs

const TWAP_URL = "https://api.hypurrscan.io/twap/*";
const HL_INFO = "https://api.hyperliquid.xyz/info";

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const GREY = 0x7f8c8d;

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

// asset id -> { coin, label, midKey }
function buildMarkets(meta, spotMeta) {
  const markets = new Map();
  meta.universe.forEach((u, i) => {
    if (MIN_USD[u.name] !== undefined && !u.isDelisted) {
      markets.set(i, { coin: u.name, label: `${u.name} perp`, midKey: u.name });
    }
  });
  for (const pair of spotMeta.universe) {
    const [b, q] = pair.tokens.map((t) => spotMeta.tokens[t]?.name);
    const coin = SPOT_BASES[b];
    if (coin && STABLES.has(q)) {
      markets.set(10000 + pair.index, { coin, label: `${coin} spot`, midKey: pair.name });
    }
  }
  return markets;
}

function fmtUsd(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

function fmtDuration(min) {
  if (min < 60) return `${min}m`;
  const h = min / 60;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
  const d = h / 24;
  return `${Number.isInteger(d) ? d : d.toFixed(1)}d`;
}

function fmtNum(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });
}

function fmtPrice(p) {
  return `$${p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 5 : p < 100 ? 3 : 0 })}`;
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// One post per group: a wallet often splits one big order into several
// identical TWAPs placed seconds apart, so those are merged into one alert.
function buildEmbed(g) {
  const first = g.recs[0];
  const t = first.action.twap;
  const buy = !!t.b;
  const reduce = !!t.r;
  const n = g.recs.length;
  const endSec = Math.floor((g.time + t.m * 60_000) / 1000);

  let vibe;
  if (reduce) vibe = buy ? `closing a short 🔒 **${fmtUsd(g.usd)}**` : `closing a long 🔒 **${fmtUsd(g.usd)}**`;
  else vibe = buy ? `slowly scooping **${fmtUsd(g.usd)}**` : `slowly dumping **${fmtUsd(g.usd)}**`;
  const split = n > 1 ? `\nsplit into **${n}** orders of ${fmtUsd(g.usd / n)} each` : "";

  return {
    title: `${buy ? "🟢 BUY" : "🔴 SELL"} TWAP · ${g.mkt.label}`,
    url: `https://hypurrscan.io/address/${first.user}`,
    color: buy ? GREEN : RED,
    description: `someone's ${vibe} of ${g.mkt.coin} over **${fmtDuration(t.m)}** 👀${split}`,
    fields: [
      { name: "size", value: `${fmtNum(g.size)} ${g.mkt.coin}`, inline: true },
      { name: "price", value: fmtPrice(g.price), inline: true },
      { name: "ends", value: `<t:${endSec}:R>`, inline: true },
      { name: "wallet", value: `[${short(first.user)}](https://hypurrscan.io/address/${first.user})`, inline: true },
      {
        name: "tx",
        value: g.recs
          .slice(0, 5)
          .map((r, i) => `[${n > 1 ? `#${i + 1}` : "view on HypurrScan"}](https://hypurrscan.io/tx/${r.hash})`)
          .join(" ") + (n > 5 ? ` +${n - 5} more` : ""),
        inline: true,
      },
    ],
    footer: { text: "ROT · TWAP tracker" },
    timestamp: new Date(g.time).toISOString(),
  };
}

function stoppedEmbed(embed, stopped, total) {
  const all = stopped >= total;
  return {
    ...embed,
    title: all ? `⛔ STOPPED · ${embed.title}` : embed.title,
    color: all ? GREY : embed.color,
    fields: [
      ...embed.fields,
      {
        name: "status",
        value: all
          ? `stopped early <t:${Math.floor(Date.now() / 1000)}:R>`
          : `${stopped} of ${total} orders stopped early`,
        inline: false,
      },
    ],
  };
}

async function discord(method, url, payload) {
  if (DRY_RUN) {
    console.log(`[dry-run] ${method}`, JSON.stringify(payload.embeds[0].title), payload.embeds[0].description);
    return { id: "dry-run" };
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await sleep(Math.ceil((j.retry_after || 2) * 1000) + 250);
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${method} -> HTTP ${res.status}: ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }
  throw new Error("Discord rate limit: gave up after 5 tries");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
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
  const saved = loadState();
  const firstRun = !saved;
  const state = saved || { seen: {}, posts: [] };
  const byHash = new Map(twaps.map((r) => [r.hash, r]));

  // 1) new TWAPs on our coins, grouped by wallet + market + side + duration
  const groups = new Map();
  for (const rec of twaps) {
    if (!rec?.hash || state.seen[rec.hash]) continue;
    state.seen[rec.hash] = rec.time || now;
    const t = rec.action?.twap;
    if (!t || rec.error || rec.ended) continue;
    if (now >= rec.time + t.m * 60_000) continue; // already over
    const mkt = markets.get(Number(t.a));
    if (!mkt) continue;
    const price = Number(mids[mkt.midKey]);
    if (!price) continue;
    const key = `${rec.user}|${t.a}|${t.b}|${t.r}|${t.m}`;
    const g = groups.get(key) || { recs: [], mkt, price, size: 0, usd: 0, time: rec.time };
    g.recs.push(rec);
    g.size += Math.abs(Number(t.s));
    g.usd += Math.abs(Number(t.s) * price);
    g.time = Math.min(g.time, rec.time);
    groups.set(key, g);
  }
  const fresh = [...groups.values()].filter((g) => g.usd >= MIN_USD[g.mkt.coin]);
  for (const g of fresh) g.recs.sort((a, b) => a.time - b.time);

  // oldest first so the channel reads in order; on the first run only the biggest few
  let toPost = [...fresh];
  if (firstRun) toPost = toPost.sort((a, b) => b.usd - a.usd).slice(0, BACKFILL_MAX);
  toPost.sort((a, b) => a.time - b.time);

  let posted = 0;
  for (const g of toPost) {
    const embed = buildEmbed(g);
    const msg = await discord("POST", `${WEBHOOK}?wait=true`, { embeds: [embed] });
    state.posts.push({ id: msg.id, embed, hashes: g.recs.map((r) => r.hash), time: g.time, stopped: 0 });
    posted++;
    await sleep(1200);
  }

  // 2) posted TWAPs that got stopped early -> edit the post
  let edited = 0;
  for (const p of state.posts) {
    const stopped = p.hashes.filter((h) => byHash.get(h)?.ended).length;
    if (stopped > p.stopped && p.id && p.id !== "dry-run") {
      await discord("PATCH", `${WEBHOOK}/messages/${p.id}`, {
        embeds: [stoppedEmbed(p.embed, stopped, p.hashes.length)],
      });
      p.stopped = stopped;
      edited++;
      await sleep(1200);
    }
  }

  // 3) forget anything older than the feed covers
  for (const [h, t] of Object.entries(state.seen)) if (now - t > KEEP_MS) delete state.seen[h];
  state.posts = state.posts.filter((p) => now - p.time <= KEEP_MS);

  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(
    `checked ${twaps.length} TWAPs · ${fresh.length} new alerts · posted ${posted} · updated ${edited} stopped${firstRun ? " (first run)" : ""}${DRY_RUN ? " [dry run]" : ""}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
