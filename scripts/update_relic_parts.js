#!/usr/bin/env node
// update_relic_parts.js —— 生成"开核桃秒选"用的全量部件表 tools\all_relics.json
//
// 数据来源：
//   1. 部件 + 杜卡德：项目自带的 warframe-items 离线库
//      （tools\warframe-mcp\node_modules\warframe-items）
//   2. market 上的 url_name（slug）：warframe.market v2 /items
//      —— 只用来给询价脚本用，拿不到也不影响部件表本身
//   3. 中文名：tools\relic_zh.json（由 build_zh_map.js 从灰机 wiki 生成）
//
// 用法：
//   node update_relic_parts.js
//
// 输出：tools/all_relics.json
//   { "_meta": {...}, "items": [ { name, base, part, ducats, slug, zh, category, tradable } ] }

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');

dns.setDefaultResultOrder('ipv4first');

const ROOT = path.join(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const DATA_DIR = path.join(ROOT, 'data');

const ITEMS_DIR = path.join(TOOLS_DIR, 'warframe-mcp', 'node_modules', 'warframe-items');
const ZH_PATH = path.join(DATA_DIR, 'relic_zh.json');
const OUT_PATH = path.join(DATA_DIR, 'all_relics.json');
const MARKET = 'https://api.warframe.market/v2';

// 遗物里常见、但不是 Prime 部件的东西（也要能查价）
const EXTRA_REWARDS = [
  'Forma Blueprint',
  'Forma',
  'Orokin Cell',
  'Kuva',
  'Ayatan Amber Star',
  'Ayatan Cyan Star',
  'Riven Sliver',
];

const TIMEOUT_MS = 20000;

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .trim();
}

function slugify(name) {
  return normalize(name)
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function fetchJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return fetchJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return JSON.parse(text);
  } catch (err) {
    if (attempt < 2 && /timeout|aborted|fetch failed/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return fetchJson(url, attempt + 1);
    }
    throw err;
  }
}

/* ---------- 1. 离线库：所有带杜卡德的部件 ---------- */

// warframe-items 里有个命名 bug：Kavasa Prime 的部件被拼成了
// "Kavasa Prime Kubrow Collar Kavasa Prime Band"，这里修回正常名字。
function cleanName(raw) {
  return String(raw)
    .replace(/^Kavasa Prime Kubrow Collar Kavasa Prime /i, 'Kavasa Prime ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 部件词（用于把 "Yareli Prime Chassis Blueprint" 拆成 base=Yareli Prime + part=Chassis Blueprint）
const PART_WORDS = new Set([
  'blueprint', 'barrel', 'receiver', 'stock', 'magazine', 'handle', 'hilt', 'grip', 'blade',
  'gauntlet', 'link', 'core', 'helmet', 'head', 'neuroptics', 'cerebrum', 'carapace', 'chassis',
  'systems', 'upper limb', 'lower limb', 'limb', 'band', 'kubrow collar', 'ornament', 'disc',
  'stars', 'blade', 'wings', 'set', 'neuroptic', 'string', 'pouch', 'buckle', 'boot', 'guard',
]);

function splitName(name) {
  const words = String(name).trim().split(/\s+/);
  const tail = [];
  while (words.length > 1) {
    const last = words[words.length - 1].toLowerCase();
    const last2 = words.length > 1 ? (words[words.length - 2] + ' ' + words[words.length - 1]).toLowerCase() : '';
    if (PART_WORDS.has(last2)) {
      tail.unshift(words.pop(), words.pop());
      continue;
    }
    if (PART_WORDS.has(last)) {
      tail.unshift(words.pop());
      continue;
    }
    break;
  }
  return { base: words.join(' '), part: tail.join(' ') || null };
}

// 英文部件词 → 中文（用于拼完整中文名：瓦德雅 Prime 蓝图）
const PART_CN = {
  Blueprint: '蓝图',
  Barrel: '枪管',
  Receiver: '枪机',
  Stock: '枪托',
  Magazine: '弹匣',
  Handle: '握柄',
  Hilt: '握柄',
  Grip: '弓把',
  Blade: '刀刃',
  Gauntlet: '拳套',
  'Upper Limb': '弓臂',
  'Lower Limb': '弓弦',
  Link: '连接器',
  Core: '核心',
  Helmet: '头盔',
  Head: '头部',
  Neuroptics: '头部神经光元',
  Cerebrum: '大脑',
  Carapace: '甲壳',
  Chassis: '机体',
  Systems: '系统',
  'Chassis Blueprint': '机体蓝图',
  'Systems Blueprint': '系统蓝图',
  'Neuroptics Blueprint': '头部神经光元蓝图',
  'Cerebrum Blueprint': '大脑蓝图',
  'Carapace Blueprint': '甲壳蓝图',
  'Blueprint Blueprint': '蓝图',
  Band: '环',
  String: '弓弦',
  Pouch: '箭袋',
  Buckle: '扣具',
  Boot: '靴',
  Guard: '护手',
  Set: '一套',
  'Kubrow Collar': '库狛项圈',
  Ornament: '饰件',
  Disc: '圆盘',
};

// 杜卡德经验值：铜（25.33% 档）15、银（11% 档）45、金（2% 档）100。
// 少数老奖励是 25 / 65，这一层猜不到，所以标 ducatsEstimated 交给上层标注"估算"。
function estimateDucats(chance) {  const c = Number(chance);
  if (!Number.isFinite(c)) return null;
  if (c >= 20) return 15;
  if (c >= 6) return 45;
  return 100;
}

function collectParts() {
  const Items = require(ITEMS_DIR);
  const all = new Items();
  const map = new Map();

  for (const item of all) {
    for (const comp of item.components || []) {
      if (!comp || !(comp.ducats > 0)) continue;
      const name = cleanName(`${item.name} ${comp.name}`);
      if (map.has(name)) continue;
      map.set(name, {
        name,
        // 基础名统一按「去掉尾部部件词」算，战甲的 "Chassis Blueprint" 也算部件
        base: splitName(name).base || item.name,
        part: splitName(name).part || comp.name,
        ducats: comp.ducats,
        category: item.category || item.type || '',
      });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- 2. market 物品清单：name → slug ---------- */

async function loadSlugMap() {
  console.log('[1/3] 拉取 market 物品清单（名称 → url_name）…');
  const json = await fetchJson(`${MARKET}/items`);
  const map = new Map();
  for (const it of json.data || []) {
    const name = it?.i18n?.en?.name;
    if (name && it.slug) map.set(name, it.slug);
  }
  console.log(`      ${map.size} 条物品`);
  return map;
}

/* ---------- 3. 组装 ---------- */

function loadZh() {
  try {
    return JSON.parse(fs.readFileSync(ZH_PATH, 'utf8'));
  } catch {
    console.warn('      ⚠️ 没有 tools\\relic_zh.json，本次不带中文名');
    return { names: {} };
  }
}

// 少数常见名 wiki 给错了（Forma 被搜成「魅影」），与 lib/relic.js 保持一致
const ZH_OVERRIDES = {
  Forma: '福马',
  'Forma Blueprint': '福马蓝图',
  'Orokin Cell': '奥罗金电池',
  Kuva: '赤毒',
  'Ayatan Amber Star': '阿耶檀琥珀星',
  'Ayatan Cyan Star': '阿耶檀蔚蓝星',
  'Riven Sliver': '裂罅碎块',
};
function zhFor(name, zh) {
  if (ZH_OVERRIDES[name]) return ZH_OVERRIDES[name];
  if (zh.names?.[name]) return zh.names[name];
  // 拼「基础中文名 + 部件中文」：瓦德雅 Prime + 蓝图 → 瓦德雅 Prime 蓝图
  const { base, part } = splitName(name);
  const baseCn = zh.names?.[base] || ZH_OVERRIDES[base] || null;
  if (!baseCn) return null;
  const partCn = part ? PART_CN[part] : null;
  return partCn ? `${baseCn} ${partCn}` : baseCn;
}

async function main() {
  console.log('== 更新遗物部件表 ==');
  const parts = collectParts();
  console.log(`[0/3] 离线库：${parts.length} 个带杜卡德的部件`);

  let slugs = new Map();
  try {
    slugs = await loadSlugMap();
  } catch (err) {
    console.warn(`      ⚠️ 拿不到 market 清单（${err.message}），slug 先用猜的`);
  }

  const zh = loadZh();
  const items = [];
  let withZh = 0;
  let withSlug = 0;

  for (const p of parts) {
    // 战甲套装的 Chassis / Neuroptics / Systems 在 market 上叫 "... Blueprint"，
    // 直接拿部件名去找会 404，这里退一步试带 Blueprint 的名字。
    const exact = slugs.get(p.name);
    const bpName = p.name + " Blueprint";
    const bpSlug = slugs.get(bpName);
    const name = exact ? p.name : bpSlug ? bpName : p.name;
    const slug = exact || bpSlug || slugify(p.name);
    const cn = zhFor(name, zh) || zhFor(p.name, zh);
    if (cn) withZh++;
    if (slug) withSlug++;
    items.push({
      name,
      base: p.base,
      part: p.part,
      ducats: p.ducats,
      slug: slug || "",
      inMarket: Boolean(exact || bpSlug),
      zh: cn || null,
      category: p.category,
    });
  }

  for (const name of EXTRA_REWARDS) {
    const exact = slugs.get(name);
    const slug = exact || slugify(name);
    items.push({
      name,
      base: name,
      part: null,
      ducats: null,
      slug,
      inMarket: Boolean(exact),
      zh: zhFor(name, zh) || null,
      category: 'Extra',
    });
  }

  // 离线库（warframe-items）比游戏版本落后时，新 Prime 的部件它没有。
  // 这里用遗物奖励库（drop.wf.wiki）把缺的奖励补进来，不然秒选会"不认识"。
  let fromRewards = 0;
  try {
    const rrPath = path.join(DATA_DIR, 'relic_rewards.json');
    if (fs.existsSync(rrPath)) {
      const rr = JSON.parse(fs.readFileSync(rrPath, 'utf8'));
      const known = new Set(items.map((x) => x.name));
      for (const relic of Object.values(rr.relics || {})) {
        for (const reward of relic.rewards || []) {
          const raw = cleanName(reward.item);
          if (!raw) continue;
          const exact = slugs.get(raw);
          const bpName = raw + ' Blueprint';
          const bpSlug = exact ? null : slugs.get(bpName);
          const name = bpSlug ? bpName : raw;
          if (known.has(name)) continue;
          known.add(name);
          const words = name.split(' ');
          const part = words.length > 1 ? words[words.length - 1] : null;
          const base = splitName(name).base || (part ? words.slice(0, -1).join(' ') : name);
          const partName = splitName(name).part || part;
          const slug = exact || bpSlug || slugify(raw);
          if (slug) withSlug++;
          const cn = zhFor(name, zh) || null;
          if (cn) withZh++;
          items.push({
            name,
            base,
            part: partName,
            // 离线库没有这条，按"铜 15 / 银 45 / 金 100"的经验值估一个，
            // 用该奖励在完好遗物里的基础概率区分档位（25.33% 铜、11% 银、2% 金）。
            ducats: estimateDucats(reward.chance && reward.chance.Intact),
            ducatsEstimated: true,
            slug: slug || '',
            inMarket: Boolean(exact || bpSlug),
            zh: cn,
            category: 'Reward',
          });
          fromRewards++;
        }
      }
    }
  } catch (err) {
    console.warn(`      ⚠️ 读取遗物奖励库失败（${err.message}），跳过补全`);
  }

  // 后面还有兜底补中文的步骤，计数以最终结果为准，别用中间变量
  const withZhFinal = items.filter((x) => x.zh).length;
  const out = {
    _meta: {
      updatedAt: new Date().toISOString(),
      source: 'warframe-items（部件/杜卡德）+ warframe.market v2（url_name）+ 灰机 wiki（中文名）+ drop.wf.wiki（遗物奖励补全）',
      count: items.length,
      withZh: withZhFinal,
      withSlug,
      fromOffline: items.length - fromRewards,
      fromRewardDb: fromRewards,
      estimatedDucats: items.filter((x) => x.ducatsEstimated).length,
    },
    items,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[2/3] 已写入 ${OUT_PATH}`);
  console.log(`[3/3] 共 ${items.length} 条（离线库 ${items.length - fromRewards} + 奖励库补全 ${fromRewards}；带中文名 ${withZhFinal}，带 slug ${withSlug}）`);
}

main().catch((err) => {
  console.error('更新失败：', err);
  process.exitCode = 1;
});
