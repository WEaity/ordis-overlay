/* eslint-disable */
/**
 * build_zh_map.js —— 从灰机 wiki 抓中英名称对照，生成 tools\relic_zh.json
 *
 * 两个数据源：
 *   1. Data:DictCY.tabx —— wiki 维护的全量中英名称表（一次拿完，最快）
 *   2. 各装备的 /Prime 子页 —— 国际服中文名（"搬运者Prime" 这种），
 *      从 wikitext 的 `| name = xxx` 里取，用来补 tabx 里没有的 Prime 名
 *
 * 用法（悬浮窗要开着，wiki 桥接在 127.0.0.1:3001）：
 *   node tools\build_zh_map.js
 *   node tools\build_zh_map.js --no-wiki-pages   // 只跑 tabx，不逐个翻页面
 */

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE = 'http://127.0.0.1:3001';
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(DATA_DIR, 'relic_zh.json');
const ALL_PATH = path.join(DATA_DIR, 'all_relics.json');
const CACHE_PATH = path.join(__dirname, '.wiki_zh_cache.json');

const NO_PAGES = process.argv.includes('--no-wiki-pages');

/** 部件中文 → 英文（OCR 里常见的叫法都收进来） */
const PART_ALIASES = {
  蓝图: ['Blueprint'],
  枪管: ['Barrel'],
  枪机: ['Receiver'],
  机匣: ['Receiver'],
  枪托: ['Stock'],
  枪身: ['Receiver', 'Stock'],
  弹匣: ['Magazine'],
  握柄: ['Handle', 'Hilt', 'Grip'],
  刀刃: ['Blade'],
  刀身: ['Blade'],
  刀柄: ['Hilt', 'Handle'],
  护手: ['Gauntlet'],
  拳套: ['Gauntlet'],
  弓臂: ['Upper Limb'],
  弓弦: ['Lower Limb'],
  弓把: ['Grip'],
  头部: ['Neuroptics', 'Cerebrum', 'Head'],
  大脑: ['Cerebrum', 'Neuroptics'],
  神经: ['Neuroptics'],
  头盔: ['Neuroptics', 'Helmet'],
  外壳: ['Carapace', 'Chassis'],
  甲壳: ['Carapace'],
  机体: ['Chassis'],
  系统: ['Systems'],
  连接器: ['Link'],
  核心: ['Core'],
};

async function bridge(pathname) {
  const res = await fetch(BRIDGE + pathname, { signal: AbortSignal.timeout(30000) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'bridge error');
  return json;
}

/** 1. 全量中英表 */
async function loadDict() {
  const { page } = await bridge('/raw?title=' + encodeURIComponent('Data:DictCY.tabx'));
  const data = JSON.parse(page.text);
  const rows = data.data || [];
  const map = new Map();
  for (const row of rows) {
    const en = (row[0] || '').trim();
    const cn = (row[1] || '').trim();
    if (!en || !cn) continue;
    // 只收「保留」的行（两边同名同物），暂无/待定的跳过
    if (row[2] && row[2] !== '保留') continue;
    if (!map.has(en)) map.set(en, cn);
  }
  return map;
}

/** 2. 逐个装备子页补 Prime 名 */
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function fillFromPages(bases, cache) {
  // 基础名 → wiki 页面：
  //   "Ash Prime"   → ["Ash/Prime", "Ash"]   （Prime 页给「Ash Prime」的中文名，本体页给「Ash」的）
  //   "Vadarya Prime" → ["Vadarya/Prime", "Vadarya"]
  //   "Forma"       → ["Forma"]
  const titles = [];
  const seen = new Set();
  for (const base of bases) {
    const prime = / Prime$/.test(base);
    const basePage = prime ? base.replace(/ Prime$/, '') : base;
    const primePage = prime ? basePage + '/Prime' : null;
    for (const t of [primePage, basePage]) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      titles.push(t);
    }
  }
  const todo = titles.filter((t) => !cache[t]);
  console.log(`[wiki] 需要翻页补名 ${todo.length} / ${titles.length} 个（批量，每批 40）…`);

  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    try {
      const { pages } = await bridge('/pages?titles=' + encodeURIComponent(batch.join('|')));
      for (const page of pages) {
        const m = page.text.match(/\|\s*name\s*=\s*([^\n|]+)/);
        if (!m) continue;
        cache[page.title] = m[1].trim();
      }
    } catch (err) {
      console.warn(`  ! 批次 ${i / 40 + 1} 失败：${err.message}`);
    }
    process.stdout.write(`\r      ${Math.min(i + 40, todo.length)}/${todo.length} …`);
  }
  process.stdout.write('\n');
  return cache;
}

async function main() {
  console.log('== 生成中英名称对照表 ==');
  const dict = await loadDict();
  console.log(`[1/3] DictCY.tabx 拿到 ${dict.size} 条中英对照`);

  // 基础名来自 all_relics.json（部件表，覆盖新 Prime）
  let bases = [];
  try {
    const all = JSON.parse(fs.readFileSync(ALL_PATH, 'utf8'));
    const set = new Set();
    for (const it of all.items || []) {
      if (it.base) set.add(it.base);
    }
    bases = [...set].sort();
    console.log(`      all_relics.json 里有 ${bases.length} 个基础名`);
  } catch {
    console.warn('      （没有 all_relics.json，先跑 update_relic_parts.js）');
  }

  const cache = readCache();
  if (!NO_PAGES && bases.length) await fillFromPages(bases, cache);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');

  // 3. 合并：tabx 优先，页面名兜底
  const names = {};
  for (const [en, cn] of dict) names[en] = cn;
  let fromPages = 0;
  for (const en of bases) {
    if (names[en]) continue;
    // Prime 名优先取 "X/Prime" 页的 name，其次取本体页
    const primeKey = / Prime$/.test(en) ? en.replace(/ Prime$/, '') + '/Prime' : null;
    const cn = (primeKey && cache[primeKey]) || cache[en];
    if (cn) {
      names[en] = cn;
      fromPages++;
    }
  }

  // 中→英反向表（给 OCR 用）
  const reverse = {};
  for (const [en, cn] of Object.entries(names)) {
    if (!reverse[cn]) reverse[cn] = en;
  }

  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      source: '灰机 wiki：Data:DictCY.tabx + 各 Prime 子页',
      names: Object.keys(names).length,
      fromPages,
      parts: Object.keys(PART_ALIASES).length,
    },
    names,
    reverse,
    parts: PART_ALIASES,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[3/3] 已写入 ${OUT_PATH}`);
  console.log(`      名称 ${out._meta.names} 条（其中 Prime 页补了 ${fromPages} 条）`);
}

main().catch((err) => {
  console.error('生成失败：', err.message);
  process.exitCode = 1;
});
