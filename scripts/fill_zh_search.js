/* eslint-disable */
/**
 * fill_zh_search.js —— 用灰机 wiki 的搜索接口补全「英文基础名 → 中文名」
 *
 * 为什么不用 /pages：wiki 的装备页面标题就是中文（伯斯顿Prime），
 * 英文名找不到对应页面，但搜索 "Burston" 能直接命中中文条目。
 *
 * 用法（悬浮窗要开着，wiki 桥接在 127.0.0.1:3001）：
 *   node tools/fill_zh_search.js
 *   node tools/fill_zh_search.js --limit 20     // 只补 20 个，调试用
 */

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = 'http://127.0.0.1:3001';
const DATA_DIR = path.join(__dirname, '..', 'data');
const ZH_PATH = path.join(DATA_DIR, 'relic_zh.json');
const ALL_PATH = path.join(DATA_DIR, 'all_relics.json');
const CACHE_PATH = path.join(__dirname, '.wiki_zh_cache.json');

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > 0 ? Number(process.argv[i + 1]) || 0 : 0;
})();

const HAS_CN = /[\u4e00-\u9fa5]/;

async function bridge(pathname, timeout = 30000) {
  const res = await fetch(BRIDGE + pathname, { signal: AbortSignal.timeout(timeout) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'bridge error');
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 搜索一个英文基础名，返回中文名（找不到返回 null） */
async function lookupBase(base) {
  const query = base.replace(/ Prime$/, '');
  const wantPrime = / Prime$/.test(base);
  const { results } = await bridge('/search?q=' + encodeURIComponent(query) + '&limit=6');
  const list = results || [];

  // 候选：标题里带中文的条目
  const cnHits = list.filter((r) => HAS_CN.test(r.title));
  if (!cnHits.length) return null;

  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const baseCn = norm(query);

  if (wantPrime) {
    // 优先「xxxPrime」这种条目
    const prime = cnHits.find((r) => /Prime$/i.test(r.title));
    if (prime) return prime.title.trim();
  }
  // 其次：标题里包含英文名的中文译名（取第一个）
  return cnHits[0].title.trim();
}

async function main() {
  const zh = readJson(ZH_PATH);
  if (!zh || !zh.names) throw new Error('缺少 tools/relic_zh.json，先跑 build_zh_map.js');
  const all = readJson(ALL_PATH);
  if (!all) throw new Error('缺少 tools/all_relics.json');

  const bases = [...new Set((all.items || []).map((x) => x.base).filter(Boolean))];
  const cache = readJson(CACHE_PATH) || {};

  const todo = bases.filter((b) => !zh.names[b]);
  console.log(`基础名 ${bases.length}，已有中文 ${bases.length - todo.length}，待补 ${todo.length}`);

  let done = 0;
  let added = 0;
  for (const base of (LIMIT ? todo.slice(0, LIMIT) : todo)) {
    done++;
    try {
      const cn = cache['search:' + base] || (await lookupBase(base));
      if (cn) {
        cache['search:' + base] = cn;
        zh.names[base] = cn;
        if (!zh.reverse[cn]) zh.reverse[cn] = base;
        added++;
      }
    } catch (err) {
      console.warn(`\n  ! ${base} 失败：${err.message}`);
    }
    if (done % 5 === 0 || done === todo.length) {
      process.stdout.write(`\r  ${done}/${todo.length}，新增 ${added} …`);
    }
    await sleep(120);
  }
  process.stdout.write('\n');

  zh._meta = {
    ...(zh._meta || {}),
    updatedAt: new Date().toISOString(),
    source: (zh._meta && zh._meta.source ? zh._meta.source + ' + ' : '') + 'wiki 搜索补全',
    names: Object.keys(zh.names).length,
    fromSearch: added,
  };

  fs.writeFileSync(ZH_PATH, JSON.stringify(zh, null, 2), 'utf8');
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`已写入 ${ZH_PATH}：名称 ${zh._meta.names} 条（本次新增 ${added}）`);
}

main().catch((err) => {
  console.error('补全失败：', err.message);
  process.exitCode = 1;
});
