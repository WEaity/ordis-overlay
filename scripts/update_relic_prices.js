#!/usr/bin/env node
// update_relic_prices.js —— 给"开核桃秒选"生成本地价格表 tools\relic_prices.json
//
// 防钓鱼策略：
//   1. 只看 sell 且可见的报价（优先 ingame 在线卖家）；
//   2. 取最便宜的 8 个，算中位数；
//   3. 把低于中位数 30% 的报价当成钓鱼单剔除；
//   4. 剩下的再取中位数，作为最终估值（同时保留最低价和剔除数量，便于排错）。
//
// 用法：
//   node update_relic_prices.js               全量
//   node update_relic_prices.js --limit 20    只跑前 20 条（写 relic_prices.sample.json）
//   node update_relic_prices.js --concurrency 6
//
// 输出：tools/relic_prices.json
//   { "_meta": {...}, "prices": { "Ash Prime Neuroptics": { platinum, lowest, sellers, outliers, ducats } } }

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');

dns.setDefaultResultOrder('ipv4first');

const MARKET = 'https://api.warframe.market/v2';
const DATA_DIR = path.join(__dirname, '..', 'data');
const PARTS_PATH = path.join(DATA_DIR, 'all_relics.json');
let OUT_PATH = path.join(DATA_DIR, 'relic_prices.json');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const LIMIT = argValue('--limit', 0);
const CONCURRENCY = Math.max(1, argValue('--concurrency', 6));
const TIMEOUT_MS = 20000;

if (LIMIT > 0) OUT_PATH = path.join(DATA_DIR, 'relic_prices.sample.json');

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function fetchJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 2 && /timeout|aborted|fetch failed/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
      return fetchJson(url, attempt + 1);
    }
    throw err;
  }
}

/* 防钓鱼估价：返回 { platinum, lowest, sellers, outliers } */
function robustPrice(orders) {
  const sells = (orders || [])
    .filter((o) => o.type === 'sell' && o.visible !== false && Number.isFinite(o.platinum))
    .map((o) => ({ platinum: o.platinum, ingame: o.user?.status === 'ingame' }));
  if (!sells.length) return null;

  const online = sells.filter((o) => o.ingame);
  const pool = (online.length ? online : sells).map((o) => o.platinum).sort((a, b) => a - b);
  const window = pool.slice(0, 8);
  const med = median(window);
  const clean = window.filter((p) => p >= med * 0.3);
  return {
    platinum: median(clean),
    lowest: pool[0],
    sellers: pool.length,
    outliers: window.length - clean.length,
  };
}

async function priceOne(item) {
  const slug = item.slug;
  if (!slug) return { error: 'no slug' };
  const json = await fetchJson(`${MARKET}/orders/item/${encodeURIComponent(slug)}`);
  const p = robustPrice(json.data);
  if (!p) return { error: 'no orders' };
  return p;
}

async function pool(tasks, n, onDone) {
  const results = new Array(tasks.length);
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = { error: err.message };
      }
      done++;
      if (onDone) onDone(done, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

async function main() {
  console.log('== 更新遗物价格表 ==');
  let parts;
  try {
    parts = JSON.parse(fs.readFileSync(PARTS_PATH, 'utf8'));
  } catch {
    console.error(`找不到 ${PARTS_PATH}，请先跑 node update_relic_parts.js`);
    process.exit(1);
  }
  // inMarket=false 的（Forma / Kuva / 星星等）market v2 没有条目页，不用白跑
  // 只有拿到 slug 的才查价（Forma / Kuva / 星星这类没有 market 条目页）
  let items = (parts.items || []).filter((x) => x.slug);
  if (LIMIT > 0) items = items.slice(0, LIMIT);
  console.log(`[1/2] 待询价 ${items.length} 条，并发 ${CONCURRENCY}`);

  const prices = {};
  const meta = {
    updatedAt: new Date().toISOString(),
    source: 'warframe.market v2（前 8 单，中位数，剔除 <30% 异常单）',
    count: items.length,
    priced: 0,
    noOrders: 0,
    errors: 0,
    outliers: 0,
    partsUpdatedAt: parts._meta?.updatedAt || null,
  };

  let lastLog = Date.now();
  const results = await pool(
    items.map((it) => () => priceOne(it)),
    CONCURRENCY,
    (done, total) => {
      if (Date.now() - lastLog > 2000 || done === total) {
        lastLog = Date.now();
        process.stdout.write(`\r      ${done}/${total} …`);
      }
    }
  );
  process.stdout.write('\n');

  items.forEach((it, i) => {
    const r = results[i] || {};
    if (r.error) {
      if (r.error === 'no orders') meta.noOrders++;
      else meta.errors++;
      return;
    }
    prices[it.name] = {
      platinum: r.platinum,
      lowest: r.lowest,
      sellers: r.sellers,
      outliers: r.outliers,
      ducats: it.ducats ?? null,
    };
    meta.priced++;
    meta.outliers += r.outliers;
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify({ _meta: meta, prices }, null, 2), 'utf8');
  console.log(`[2/2] 已写入 ${OUT_PATH}`);
  console.log(`      有价 ${meta.priced} / ${meta.count}，无卖单 ${meta.noOrders}，出错 ${meta.errors}，剔除异常单 ${meta.outliers} 个`);
}

main().catch((err) => {
  console.error('更新失败：', err);
  process.exitCode = 1;
});
