// lib/relic.js —— “开核桃秒选”：截图 → 极简 OCR → 只查本地两张表 → 出结论
//
// 数据（都由 update_*.js 生成）：
//   data\all_relics.json    全量部件表（名称 / 杜卡德 / 中文名 / market slug）
//   data\relic_prices.json  防钓鱼后的市场价（前 8 单中位数，剔除 <30% 异常单）
//
// 设计要点：
//   · 识别只让视觉模型做一件事：把奖励名读成英文 JSON 数组（提示词极短，1–2 秒）
//   · 拿到名字后不发任何网络请求，全部在内存 Map 里查，毫秒级
//   · 中英对照优先用截图里的中文原文，其次用表里的中文名

const fs = require('node:fs');
const path = require('node:path');
const { MODEL, getClient } = require('./config');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

const ALL_PATH = path.join(DATA_DIR, 'all_relics.json');
const PRICES_PATH = path.join(DATA_DIR, 'relic_prices.json');
const ZH_PATH = path.join(DATA_DIR, 'relic_zh.json');

// 认字用主模型就够，速度比视觉模型快
const RELIC_MODEL = process.env.RELIC_MODEL || MODEL;

/* ---------------- 名称归一化 ---------------- */

function normalize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .trim();
}

/* ---------------- 本地部件表（带 mtime 缓存） ---------------- */

let partsCache = { mtime: 0, map: null, meta: null };
let pricesCache = { mtime: 0, map: null, meta: null };
let zhCache = null;

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function loadParts() {
  const mtime = statMtime(ALL_PATH);
  if (partsCache.map && partsCache.mtime === mtime) return partsCache;

  const map = new Map();
  let meta = null;
  try {
    const raw = JSON.parse(fs.readFileSync(ALL_PATH, 'utf8'));
    meta = raw._meta || null;
    for (const it of raw.items || []) {
      if (!it || !it.name) continue;
      map.set(normalize(it.name), it);
    }
  } catch {
    /* 还没生成：map 空，下面会提示去更新 */
  }
  partsCache = { mtime, map, meta };
  return partsCache;
}

function loadPrices() {
  const mtime = statMtime(PRICES_PATH);
  if (pricesCache.map && pricesCache.mtime === mtime) return pricesCache;

  const map = new Map();
  let meta = null;
  try {
    const raw = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));
    meta = raw._meta || null;
    for (const [name, v] of Object.entries(raw.prices || {})) {
      map.set(normalize(name), { name, ...v });
    }
  } catch {
    /* 同上 */
  }
  pricesCache = { mtime, map, meta };
  return pricesCache;
}

// 少数常见名 wiki 给错了（例如 Forma 被搜成「魅影」），这里人工钉死，优先级最高
const ZH_OVERRIDES = {
  Forma: '福马',
  'Forma Blueprint': '福马蓝图',
  'Orokin Cell': '奥罗金电池',
  Kuva: '赤毒',
  'Ayatan Amber Star': '阿耶檀琥珀星',
  'Ayatan Cyan Star': '阿耶檀蔚蓝星',
  'Riven Sliver': '裂罅碎块',
};

function zhTable() {
  if (zhCache !== null) return zhCache;
  try {
    zhCache = JSON.parse(fs.readFileSync(ZH_PATH, 'utf8'));
  } catch {
    zhCache = { names: {}, reverse: {}, parts: {} };
  }
  zhCache.names = zhCache.names || {};
  zhCache.reverse = zhCache.reverse || {};
  for (const [en, cn] of Object.entries(ZH_OVERRIDES)) {
    zhCache.names[en] = cn;
    zhCache.reverse[cn] = en;
  }
  return zhCache;
}

/* ---------------- 视觉识别（极简提示词，只要名字） ---------------- */

const RELIC_PROMPT = `这是 Warframe 遗物奖励选择界面。把每张奖励卡片底部那行名字**原样**读出来。
要求：
- 屏幕上是什么语言就输出什么语言，**不要翻译、不要改写成英文**。中文客户端就输出「瓦德雅 Prime 蓝图」这样的原文；
- 数字前缀（如「2 Forma 蓝图」的 2）不要输出；
- 忽略「目前拥有数量」、玩家 ID、"已收集"等界面文字，也忽略叠在上面的聊天窗口文字；
- 只输出你确实看清的卡片（2–4 个），不要凑数，不要编造；看不清的字不要猜。
只输出 JSON 字符串数组，例如 ["瓦德雅 Prime 蓝图","Forma 蓝图"]，不要任何解释。`;

function parseNames(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => {
        if (typeof x === 'string') return x.trim();
        if (x && typeof x === 'object') return String(x.market || x.text || x.name || '').trim();
        return '';
      })
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function recognizeRewards(image) {
  const api = getClient();
  // 推理模型偶尔把 token 花在思考上导致正文空，给第二次机会
  for (const maxTokens of [400, 800]) {
    const res = await api.chat.completions.create({
      model: RELIC_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: RELIC_PROMPT },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    });
    const names = parseNames(res.choices?.[0]?.message?.content);
    if (names.length) return names;
  }
  return [];
}

/* ---------------- 本地匹配 ---------------- */

// 同一个中文部件在不同武器上叫法不同，查不到时换词再试一次
const PART_ALIASES = {
  蓝图: ['Blueprint'],
  系统: ['Systems'],
  机体: ['Chassis'],
  头部神经光元: ['Neuroptics'],
  神经光元: ['Neuroptics'],
  枪管: ['Barrel'],
  机匣: ['Receiver'],
  枪机: ['Receiver'],
  枪托: ['Stock'],
  刀刃: ['Blade'],
  头部: ['Neuroptics', 'Cerebrum', 'Head'],
  握柄: ['Handle', 'Hilt', 'Grip'],
  握把: ['Grip', 'Handle'],
  剑柄: ['Hilt', 'Handle'],
  弓弦: ['String'],
  弓身: ['Limb'],
  护手: ['Gauntlet'],
  外壳: ['Carapace'],
  大脑: ['Cerebrum'],
  连接器: ['Link'],
  装饰: ['Ornament'],
  护盾: ['Guard'],
  圆盘: ['Disc'],
  星: ['Star'],
};

/** 中文部件词 → 英文部件名（支持「系统蓝图」这类组合） */
function partToEnglish(partKey, parts) {
  const exact = parts[partKey];
  if (exact) return exact;
  if (partKey.endsWith('蓝图')) {
    const head = partKey.slice(0, -2).trim();
    const headEn = head ? parts[head] : null;
    if (headEn) return headEn.map((h) => `${h} Blueprint`);
    return ['Blueprint'];
  }
  return null;
}

/** 中文奖励名 → 英文候选（走 wiki 名称表 + 部件词表） */
function translateReward(text) {
  const zh = zhTable();
  let s = String(text || '').trim();
  if (!s) return [];
  // 「2 Forma 蓝图」这种数量前缀
  s = s.replace(/^\s*\d+\s*[x×]?\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!/[\u4e00-\u9fa5]/.test(s)) return [];

  const parts = { ...PART_ALIASES, ...(zh.parts || {}) };
  const partKeys = Object.keys(parts).sort((a, b) => b.length - a.length);

  // 中英对照：两边都去掉空格再比，避免「瓦德雅Prime / 瓦德雅 Prime」这种差异
  const squash = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  const rev = zh.reverse || {};
  const revSquash = new Map();
  for (const [cn, en] of Object.entries(rev)) revSquash.set(squash(cn), en);
  const namesSquash = new Map();
  for (const [en, cn] of Object.entries(zh.names || {})) namesSquash.set(squash(en), en);

  const lookupBase = (raw) => {
    const stem = raw.replace(/\s*prime$/i, '').trim();
    return (
      revSquash.get(squash(raw)) ||
      namesSquash.get(squash(raw)) ||
      revSquash.get(squash(stem)) ||
      namesSquash.get(squash(stem + ' Prime')) ||
      namesSquash.get(squash(stem)) ||
      null
    );
  };

  // 从尾部剥部件词，最多剥两个（「系统蓝图」= 系统 + 蓝图）
  const cut = [];
  let base = s;
  for (let round = 0; round < 2; round++) {
    const k = partKeys.find((key) => base.length > key.length && base.endsWith(key));
    if (!k) break;
    const head = base.slice(0, -k.length).replace(/\s+/g, ' ').trim();
    if (!head) break;
    // 剥掉之后剩下的部分必须能认出来，才认为这是部件词
    if (!lookupBase(head) && round === 0) {
      // 第一刀先无条件剥（Name + 部件），后续再看
      cut.unshift(k);
      base = head;
      continue;
    }
    cut.unshift(k);
    base = head;
    break;
  }
  if (!base) return [];

  const en = lookupBase(base);
  if (!en) return [];

  // 中文写「XX Prime」但英文表里没有 Prime 后缀时补上
  const wantsPrime = /prime$/i.test(base);
  const enBase = wantsPrime && !/prime$/i.test(en) ? `${en} Prime` : en;

  const out = [];
  if (cut.length) {
    const partEn = partToEnglish(cut[0], parts) || [];
    if (cut.length === 2 && cut[1] === '蓝图') {
      for (const p of partEn) out.push(`${enBase} ${p} Blueprint`);
    } else {
      for (const p of partEn) out.push(`${enBase} ${p}`);
    }
  }
  out.push(enBase);
  return out;
}

// 允许「少写/多写一个部件词」的容错，必须正好是这些词，避免 "caliban prime" 撞上 "caliban prime neuroptics blueprint"
const PART_WORDS = new Set([
  'blueprint', 'barrel', 'receiver', 'stock', 'magazine', 'handle', 'hilt', 'grip', 'blade',
  'gauntlet', 'link', 'core', 'helmet', 'head', 'neuroptics', 'cerebrum', 'carapace', 'chassis',
  'systems', 'upper limb', 'lower limb', 'limb', 'band', 'ornament', 'disc', 'wings', 'set',
]);

function isPartWord(word) {
  return PART_WORDS.has(String(word || '').toLowerCase());
}

/** 在 Map 里按「完全一致 → 只差一个部件词」逐级找 */
function lookupIn(map, name) {
  const key = normalize(name);
  if (!key) return null;
  if (map.has(key)) return map.get(key);

  for (const [k, v] of map) {
    if (k.startsWith(key + ' ') && isPartWord(k.slice(key.length + 1))) return v;
    if (key.startsWith(k + ' ') && isPartWord(key.slice(k.length + 1))) return v;
  }

  // 模型偶尔把 Blueprint 漏掉/多加：只有在缺的那个词是部件词时才认
  const words = key.split(' ');
  if (words.length > 1 && isPartWord(words[words.length - 1])) {
    const short = words.slice(0, -1).join(' ');
    if (map.has(short)) return map.get(short);
  }
  return null;
}

function resolve(name) {
  const parts = loadParts();
  const prices = loadPrices();

  let hit = null;
  // 中文先翻译成英文再查（避免「caliban prime 蓝图」直接前缀撞车）
  if (/[\u4e00-\u9fa5]/.test(String(name))) {
    for (const c of translateReward(name)) {
      hit = lookupIn(parts.map, c);
      if (hit) break;
    }
  }
  if (!hit) hit = lookupIn(parts.map, name);

  const price = hit ? prices.map.get(normalize(hit.name)) : lookupIn(prices.map, name);
  return { hit, price };
}

/* ---------------- 排序 ---------------- */

const isForma = (name) => /^forma\b/i.test(name);

/**
 * 排序规则（用户定的硬规则）：
 *   1. 有 Forma 且其余物品都 < 10p → 先推 Forma（硬通货）
 *   2. 否则白金降序；差价 ≤ 2p 时按杜卡德降序
 */
function rank(items) {
  const scored = items.map((it) => ({
    ...it,
    platinum: typeof it.platinum === 'number' ? it.platinum : null,
    ducats: typeof it.ducats === 'number' ? it.ducats : null,
  }));

  const others = scored.filter((it) => !isForma(it.name));
  const hasForma = scored.some((it) => isForma(it.name));
  const othersMax = Math.max(0, ...others.map((it) => it.platinum ?? 0));
  const formaWins = hasForma && othersMax < 10;

  const value = (it) => (isForma(it.name) ? (formaWins ? 9999 : 0) : it.platinum ?? 0);

  return scored.slice().sort((a, b) => {
    const d = value(b) - value(a);
    if (Math.abs(d) > 2) return d;
    const dd = (b.ducats ?? 0) - (a.ducats ?? 0);
    if (dd !== 0) return dd;
    return value(b) - value(a);
  });
}

function formatPick(sorted, unknown) {
  const best = sorted[0];
  if (!best) return '没认出奖励，Operator。再截一次，把奖励卡片都框进去。';

  // 中英对照：优先用表里的中文名；OCR 原文是中文时也带上（便于核对）
  const tidy = (s) => String(s || '').replace(/([\u4e00-\u9fa5])(Prime)/g, '$1 $2');
  const label = (it) => {
    const zh = tidy(it.zh);
    const text = tidy(String(it.text || '').trim());
    if (zh && /[\u4e00-\u9fa5]/.test(zh)) {
      return text && normalize(text) !== normalize(zh) && /[\u4e00-\u9fa5]/.test(text)
        ? `${it.name}（${zh}）`
        : `${it.name}（${zh}）`;
    }
    if (text && /[\u4e00-\u9fa5]/.test(text)) return `${it.name}（${text}）`;
    return it.name;
  };

  const valueText = (it) => {
    if (isForma(it.name)) return it.platinum != null ? `估值 ${it.platinum}p，硬通货` : '硬通货（无报价）';
    if (it.platinum == null && it.ducats == null) return '未知';
    const bits = [];
    if (it.platinum != null) bits.push(`估值 ${it.platinum}p`);
    if (it.ducats != null) {
      bits.push(it.ducatsEstimated ? `约 ${it.ducats} 杜卡德（估算）` : `${it.ducats} 杜卡德`);
    }
    return bits.join(' / ');
  };

  const rest = sorted.slice(1).map((it) => `${label(it)} ${valueText(it)}`).join('，');
  const tail = unknown && unknown.length ? `（本地表里没有：${unknown.join('、')}）` : '';
  return `**推荐选：${label(best)}**（${valueText(best)}）。其余：${rest || '无'}。${tail}`;
}

/* ---------------- 对外入口 ---------------- */

async function pickRelic(image) {
  const t0 = Date.now();
  const { map: partMap, meta: partsMeta } = loadParts();
  const { map: priceMap, meta: priceMeta } = loadPrices();

  if (!partMap.size) {
    return {
      ok: false,
      reply: '本地还没有部件表。先打开 ☰ → 设置 → 遗物速查数据更新，点一次「更新部件信息」。',
      items: [],
    };
  }

  const names = await recognizeRewards(image);
  const tOcr = Date.now() - t0;
  if (!names.length) {
    return { ok: false, reply: '没认出奖励，Operator。再截一次，把奖励卡片都框进去。', items: [] };
  }

  // 模型可能把同一张卡读两遍
  const seen = new Set();
  const uniq = names.filter((n) => {
    const k = normalize(n);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const items = uniq.slice(0, 6).map((raw) => {
    const { hit, price } = resolve(raw);
    const name = price?.name || hit?.name || raw;
    return {
      name,
      text: /[\u4e00-\u9fa5]/.test(raw) ? raw : '',
      zh: hit?.zh || null,
      ducats: price?.ducats ?? hit?.ducats ?? null,
      ducatsEstimated: Boolean(hit?.ducatsEstimated),
      platinum: price?.platinum ?? null,
      known: !!(price || hit),
      priced: !!price,
    };
  });

  const sorted = rank(items);
  // 只有"连部件表都没查到"才算未知；查到部件但没价格，在正文里体现（显示杜卡德/暂无价）
  const unknown = items.filter((it) => !it.known).map((it) => it.text || it.name);
  const knownCount = items.filter((it) => it.known).length;

  console.log(
    `[relic] OCR ${tOcr}ms，本地匹配 ${Date.now() - t0 - tOcr}ms` +
      `（部件表 ${partMap.size} 条 @${partsMeta?.updatedAt || '?'}，价格表 ${priceMap.size} 条 @${priceMeta?.updatedAt || '?'}）`
  );

  if (!knownCount) {
    return {
      ok: true,
      reply:
        `这 ${items.length} 个奖励本地表里都没有：${items.map((it) => it.name).join('、')}。` +
        '可能是新出的 Prime，或截图名字没认准 —— 可以先去「遗物速查数据更新」点一次「更新部件信息」。',
      items: [],
    };
  }

  let reply = formatPick(sorted, unknown);
  if (!priceMap.size) {
    reply += '\n\n> 价格表还没生成，现在只能看杜卡德。去「遗物速查数据更新」点一次「更新价格信息」。';
  }

  return {
    ok: true,
    reply,
    items: sorted,
    recommended: sorted[0]?.name || '',
    missing: unknown,
    timings: { ocr: tOcr, total: Date.now() - t0 },
  };
}

module.exports = { pickRelic, parseNames, normalize, rank, translateReward, loadParts, loadPrices };
