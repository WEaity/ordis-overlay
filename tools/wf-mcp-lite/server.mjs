#!/usr/bin/env node
/**
 * wf-mcp-lite — zero-dependency MCP (stdio, newline-delimited JSON-RPC) server for Warframe.
 *
 * Data sources
 *   - offline : `warframe-items` npm dataset (installed at ../warframe-mcp/node_modules)
 *   - live    : https://api.warframe.market/v2  (v1 is gone)
 *   - live    : https://api.warframe.com/cdn/worldState.php（世界状态）+ 灰机 wiki 桥接 127.0.0.1:3001
 *
 * Replaces @bbauti/warframe-mcp, whose upstreams (warframestat.us 403 / market v1 404) are dead.
 * Tool names match the old server; serverName is still `wf_market`.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as readline from 'node:readline';
import dns from 'node:dns';

// 本机 IPv6 到 Cloudflare/Akamai 不稳定，强制走 IPv4（market 的 30 秒超时就是靠这个修好的）
dns.setDefaultResultOrder('ipv4first');

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = dirname(__dirname);                    // ...\overlay-demo\tools
const DATA_DIR = join(TOOLS_DIR, '..', 'data');          // ...\overlay-demo\data（遗物表等）
const ITEMS_ROOT = join(TOOLS_DIR, 'warframe-mcp');      // 离线数据集（warframe-items）所在地
const CACHE_DIR = join(__dirname, 'data');
const CACHE_FILE = join(CACHE_DIR, 'market-items.json');
const CACHE_TTL = 12 * 60 * 60 * 1000;

const MARKET = 'https://api.warframe.market/v2';
const HEADERS = { 'User-Agent': 'wf-mcp-lite/2.0 (local)' };

const log = (...a) => { try { process.stderr.write('[wf-mcp-lite] ' + a.join(' ') + '\n'); } catch {} };

function send(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    // Downstream pipe closed (client gone); nothing useful left to do.
    if (e?.code === 'EPIPE') process.exit(0);
    throw e;
  }
}

process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0); });

function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(s) {
  return norm(s).replace(/\s+/g, '_');
}

function pct(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '?';
  const p = v * 100;
  return (p < 10 ? p.toFixed(2) : p.toFixed(1)).replace(/\.0+$/, '') + '%';
}

function n(v, d = 2) {
  if (typeof v !== 'number' || !isFinite(v)) return '?';
  return Number(v.toFixed(d)).toString();
}

function clean(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\|([A-Z_]+)\|/g, '[$1]')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url, { timeout = 20000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${url}`);
        err.status = res.status;
        err.body = text.slice(0, 200);
        throw err;
      }
      return JSON.parse(text);
    } catch (e) {
      // 网络抖动（fetch failed / 超时 / 5xx）重试一次；JSON 解析错不重试
      const retriable =
        e.name === 'TypeError' ||
        e.name === 'TimeoutError' ||
        e.name === 'AbortError' ||
        (typeof e.status === 'number' && e.status >= 500);
      if (attempt < retries && retriable) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw e;
    }
  }
}

/* ---------------- offline dataset (warframe-items) ---------------- */

let DB = null;
let BY_NAME = null;

function db() {
  if (DB) return DB;
  const req = createRequire(join(ITEMS_ROOT, 'package.json'));
  const WFItems = req('warframe-items');
  const all = [...new WFItems()];

  // Duplicate names (Flawed / Beginner / Intermediate / "Expert" variants of the same mod):
  // the canonical one is the entry backed by a wiki page (`wikiaUrl`); those variants don't have it.
  // Fall back to the highest fusionLimit, then the most levelStats.
  const score = (it) => [it.wikiaUrl ? 1 : 0, it.fusionLimit ?? 0, it.levelStats?.length ?? 0];
  const better = (a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i];
    return false;
  };
  const best = new Map();
  for (const it of all) {
    const key = it.type + '|' + it.name;
    const cur = best.get(key);
    if (!cur || better(it, cur)) best.set(key, it);
  }
  DB = [...best.values()];
  BY_NAME = new Map();
  for (const it of DB) {
    const k = norm(it.name);
    if (!BY_NAME.has(k)) BY_NAME.set(k, []);
    BY_NAME.get(k).push(it);
  }
  log(`dataset loaded: ${DB.length} items`);
  return DB;
}

const MOD_TYPES = /(Mod|Riven Mod|Arcane)$/;
const WEAPON_TYPES = /^(Rifle|Shotgun|Pistol|Melee|Bow|Throwing|Dual Pistols|Arch-Gun|Arch-Melee|Exalted Weapon|Companion Weapon)$/;

function findItem(name, { preferType } = {}) {
  const all = db();
  const q = norm(name);
  if (!q) return null;

  let cands = BY_NAME.get(q) || all.filter((x) => norm(x.name) === q);
  if (!cands.length) cands = all.filter((x) => norm(x.name).startsWith(q));
  if (!cands.length) cands = all.filter((x) => norm(x.name).includes(q));
  if (!cands.length) return null;

  if (preferType) {
    const p = cands.filter((x) => preferType.test(x.type));
    if (p.length) cands = p;
  }
  cands.sort((a, b) => {
    const ae = norm(a.name) === q ? 0 : 1;
    const be = norm(b.name) === q ? 0 : 1;
    return ae - be || a.name.length - b.name.length;
  });
  return cands[0];
}

function itemLine(it) {
  const bits = [it.name, '（' + it.type + (it.category && it.category !== it.type ? ' / ' + it.category : '') + '）'];
  if (it.masteryReq) bits.push(`MR${it.masteryReq}`);
  if (it.tradable) bits.push('可交易');
  return bits.join(' ');
}

function componentsText(it) {
  const comps = (it.components || []).filter((c) => c && c.name);
  if (!comps.length) return '';
  const lines = ['制作/部件:'];
  for (const c of comps) {
    const bits = [`  - ${c.name} x${c.itemCount ?? 1}`];
    if (c.ducats) bits.push(`(${c.ducats} ducats)`);
    if (c.tradable) bits.push('[可交易]');
    lines.push(bits.join(' '));

    // Merge relic variants: one row per relic, prefer the base (Intact) chance.
    const groups = new Map();
    for (const d of c.drops || []) {
      if (!d?.location) continue;
      const base = d.location.replace(/\s*\((Exceptional|Flawless|Radiant)\)\s*$/i, '').trim();
      const refined = base !== d.location;
      const cur = groups.get(base);
      if (!cur || (refined === false && cur.refined)) groups.set(base, { refined, chance: d.chance, rarity: d.rarity });
    }
    const drops = [...groups.entries()];
    if (drops.length) {
      const shown = drops.slice(0, 8).map(([loc, d]) => `${loc} ${n((d.chance ?? 0) * 100, 2)}%`).join('; ');
      lines.push('      掉落: ' + shown + (drops.length > 8 ? ` …共${drops.length}处` : ''));
    }
  }
  return lines.join('\n');
}

/* ---------------- market v2 ---------------- */

let marketCache = null;

async function marketItems(force = false) {
  if (!force && marketCache) return marketCache;
  if (!force && existsSync(CACHE_FILE)) {
    try {
      const st = statSync(CACHE_FILE);
      if (Date.now() - st.mtimeMs < CACHE_TTL) {
        marketCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
        return marketCache;
      }
    } catch { /* ignore broken cache */ }
  }
  log('fetching market item list…');
  const json = await fetchJson(`${MARKET}/items`, { timeout: 30000 });
  marketCache = json.data || [];
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(marketCache));
  } catch (e) { log('cache write failed: ' + e.message); }
  return marketCache;
}

function marketName(entry) {
  return entry?.i18n?.en?.name || entry?.slug || '';
}

async function resolveMarketItem(query) {
  const list = await marketItems();
  const q = norm(query);

  let hit = list.find((x) => norm(marketName(x)) === q);
  if (hit) return hit;

  const base = slugify(query);
  for (const s of [base, base + '_set', base.replace(/_prime$/, '') + '_prime_set']) {
    const bySlug = list.find((x) => x.slug === s);
    if (bySlug) return bySlug;
  }

  hit = list.find((x) => norm(marketName(x)).startsWith(q));
  if (hit) return hit;
  hit = list.find((x) => norm(marketName(x)).includes(q));
  return hit || null;
}

async function marketDetail(slug) {
  try {
    const j = await fetchJson(`${MARKET}/items/${encodeURIComponent(slug)}`);
    return j.data || null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function marketOrders(slug) {
  const j = await fetchJson(`${MARKET}/orders/item/${encodeURIComponent(slug)}`, { timeout: 30000 });
  return j.data || [];
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function orderBlock(orders, name) {
  const sells = orders.filter((o) => o.type === 'sell' && o.visible !== false);
  const buys = orders.filter((o) => o.type === 'buy' && o.visible !== false);
  const online = sells.filter((o) => o.user?.status === 'ingame');
  const pool = online.length ? online : sells;

  const prices = pool.map((o) => o.platinum).filter((x) => typeof x === 'number');
  const lines = [];
  if (!prices.length) {
    lines.push('市场价格: 暂无挂单');
  } else {
    const sorted = [...pool].filter((o) => typeof o.platinum === 'number').sort((a, b) => a.platinum - b.platinum);
    lines.push(`市场价格: 最低 ${sorted[0].platinum}p｜中位(在线) ${n(median(prices), 1)}p｜在线卖家 ${online.length}/${sells.length}｜收购单 ${buys.length}`);
    lines.push('最低卖单:');
    for (const o of sorted.slice(0, 6)) {
      const who = o.user?.ingameName || '?';
      const st = o.user?.status || '?';
      const rep = o.user?.reputation ?? 0;
      const rank = o.rank != null ? ` R${o.rank}` : '';
      lines.push(`  ${o.platinum}p x${o.quantity}${rank} — ${who} (${st}, 信誉${rep})`);
    }
    const b = sorted[0];
    lines.push(`私聊模板: /w ${b.user?.ingameName} Hi! I want to buy: "${name}" for ${b.platinum} platinum. (warframe.market)`);
  }
  if (buys.length) {
    const bp = buys.map((o) => o.platinum).sort((a, b) => b - a).slice(0, 3);
    lines.push(`最高收购: ${bp.map((p) => p + 'p').join(' / ')}`);
  }
  return lines.join('\n');
}

/* ---------------- tools ---------------- */

async function tGetItem({ query }) {
  const item = findItem(query);
  const m = await resolveMarketItem(query).catch(() => null);
  if (!item && !m) return `未找到「${query}」。可尝试英文名（如 Ash Prime Set / Serration / Braton）。`;

  const out = [];
  if (m) {
    out.push(`## ${marketName(m)}`);
    const detail = await marketDetail(m.slug).catch(() => null);
    const tags = (m.tags || []).join(', ');
    out.push(`slug: ${m.slug}${tags ? '｜tags: ' + tags : ''}`);
    if (detail?.i18n?.en?.description) out.push('', clean(detail.i18n.en.description));
    const meta = [];
    if (m.ducats) meta.push(`${m.ducats} ducats`);
    if (m.vaulted) meta.push('已入库(Vaulted)');
    if (detail?.reqMasteryRank != null) meta.push(`MR${detail.reqMasteryRank}`);
    if (detail?.tradable != null) meta.push(detail.tradable ? '可交易' : '不可交易');
    if (m.maxRank != null) meta.push(`最高 Rank ${m.maxRank}`);
    if (meta.length) out.push('', meta.join('｜'));
    if (detail?.i18n?.en?.wikiLink) out.push('wiki: ' + detail.i18n.en.wikiLink);

    if (detail?.setParts?.length) {
      const list = await marketItems();
      const byId = new Map(list.map((x) => [x.id, x]));
      out.push('', '套装部件:');
      for (const id of detail.setParts) {
        const p = byId.get(id);
        if (!p) continue;
        out.push(`  - ${marketName(p)}${p.vaulted ? ' [Vaulted]' : ''}${p.ducats ? ` (${p.ducats}d)` : ''}`);
      }
    }
  }
  if (item) {
    out.push('', `## 本地数据: ${itemLine(item)}`);
    if (item.description) out.push(clean(item.description));
    const comp = componentsText(item);
    if (comp) out.push('', comp);
  }
  return out.join('\n');
}

async function tGetWarframe({ name }) {
  const it = findItem(name, { preferType: /^Warframe$/ });
  if (!it) return `未找到战甲「${name}」。`;
  const out = [`## ${it.name}`];
  out.push(`生命 ${it.health}｜护盾 ${it.shield}｜护甲 ${it.armor}｜能量 ${it.power ?? '?'}｜冲刺 ${it.sprint ?? '?'}｜MR ${it.masteryReq ?? 0}`);
  if (it.polarities?.length) out.push(`极性: ${it.polarities.join(', ')}`);
  if (it.description) out.push('', clean(it.description));
  if (it.passiveDescription) out.push('', `被动: ${clean(it.passiveDescription)}`);
  if (it.abilities?.length) {
    out.push('', '技能:');
    for (const a of it.abilities) out.push(`  - ${a.name}: ${clean(a.description)}`);
  }
  const comp = componentsText(it);
  if (comp) out.push('', comp);
  return out.join('\n');
}

async function tGetWeapon({ name }) {
  const it = findItem(name, { preferType: WEAPON_TYPES });
  if (!it) return `未找到武器「${name}」。`;
  const out = [`## ${it.name}（${it.category && it.category !== it.type ? it.type + ' / ' + it.category : it.type}）`];
  const meta = [`MR ${it.masteryReq ?? 0}`];
  if (it.disposition != null) meta.push(`紫卡倾向 ${it.disposition}/5`);
  if (it.tradable) meta.push('可交易');
  out.push(meta.join('｜'));
  if (it.description) out.push('', clean(it.description));

  const d = it.damage || {};
  const kinds = Object.entries(d).filter(([k, v]) => typeof v === 'number' && v > 0 && k !== 'total');
  if (kinds.length) {
    out.push('', `伤害 ${n(d.total, 1)}：` + kinds.map(([k, v]) => `${k} ${n(v, 1)}`).join(' / '));
  }
  const stats = [];
  if (it.criticalChance != null) stats.push(`暴击 ${pct(it.criticalChance)} x${n(it.criticalMultiplier, 1)}`);
  if (it.procChance != null) stats.push(`触发 ${pct(it.procChance)}`);
  if (it.fireRate != null) stats.push(`射速 ${n(it.fireRate, 2)}/s`);
  if (it.magazineSize) stats.push(`弹匣 ${it.magazineSize}`);
  if (it.reloadTime) stats.push(`装填 ${n(it.reloadTime, 2)}s`);
  if (it.multishot) stats.push(`多重 ${n(it.multishot, 2)}`);
  if (it.accuracy != null) stats.push(`精度 ${n(it.accuracy, 1)}`);
  if (stats.length) out.push(stats.join('｜'));

  if (it.attacks?.length) {
    out.push('', '攻击模式:');
    for (const a of it.attacks.slice(0, 4)) {
      const bits = [a.name];
      const dmgTotal = a.damage ? Object.values(a.damage).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
      if (dmgTotal) bits.push(`伤害 ${n(dmgTotal, 1)}`);
      if (a.crit_chance != null) bits.push(`暴击 ${n(a.crit_chance, 1)}% x${n(a.crit_mult ?? 1, 1)}`);
      if (a.status_chance != null) bits.push(`触发 ${n(a.status_chance, 1)}%`);
      if (a.speed) bits.push(`速度 ${n(a.speed, 2)}`);
      out.push('  - ' + bits.join('｜'));
    }
  }
  const comp = componentsText(it);
  if (comp) out.push('', comp);
  return out.join('\n');
}

async function tGetMod({ name }) {
  const it = findItem(name, { preferType: MOD_TYPES });
  if (!it) return `未找到 Mod「${name}」。`;
  const out = [`## ${it.name}（${it.type}）`];
  out.push(`${it.rarity || '?'}｜极性 ${it.polarity || '?'}｜基础消耗 ${it.baseDrain ?? '?'}｜最高 Rank ${it.fusionLimit ?? '?'}${it.tradable ? '｜可交易' : ''}`);
  if (it.compatName) out.push(`适配: ${it.compatName}`);
  if (it.description) out.push('', clean(it.description));
  if (it.levelStats?.length) {
    out.push('', '各等级:');
    const L = it.levelStats;
    L.forEach((s, i) => {
      if (i === 0 || i === L.length - 1) out.push(`  R${i}: ${(s.stats || []).join(', ')}`);
      else if (i === 1) out.push(`  R${i}: ${(s.stats || []).join(', ')} …`);
    });
  }
  return out.join('\n');
}

async function tCheckMarket({ item, rank }) {
  const m = await resolveMarketItem(item);
  if (!m) return `market 上找不到「${item}」。`;
  const name = marketName(m);
  // Non-tradable items (e.g. base Braton) aren't listed; make the substitution explicit instead of silently pricing a different item.
  const approx = norm(name) !== norm(item) ? `（market 无「${item}」，已按最接近的 ${name} 查询）` : '';
  let orders = await marketOrders(m.slug);

  // Mods: default to max-rank orders, otherwise rank-0 copies (sold as fodder) dominate the "lowest price".
  let rankNote = '';
  const wantsRank = rank != null ? rank : (m.maxRank != null ? m.maxRank : null);
  if (wantsRank != null) {
    const sells = orders.filter((o) => o.type === 'sell' && o.visible !== false && (o.rank ?? 0) === wantsRank);
    const buys = orders.filter((o) => o.type === 'buy');
    if (sells.length) {
      orders = [...sells, ...buys];
      rankNote = `（已按 R${wantsRank} 过滤卖单；低等级单未计入）`;
    } else {
      rankNote = `（没有 R${wantsRank} 的卖单，以下为全部等级）`;
    }
  }

  const block = orderBlock(orders, name);
  return `## ${name}（${m.slug}）${rankNote}${approx}\n${m.vaulted ? '⚠ 已入库(Vaulted)，仅能通过交易获得\n' : ''}${block}`;
}

async function tSearchDrops({ query }) {
  const all = db();
  const q = norm(query);

  const render = (title, drops) => {
    // Relic rewards appear once per refinement (Intact/Exceptional/Flawless/Radiant) with the same
    // location and different chances — merge them, keeping the best chance.
    const groups = new Map();
    for (const d of drops) {
      const loc = String(d.location).replace(/\s*\((Exceptional|Flawless|Radiant)\)\s*$/i, '').trim();
      const key = `${loc}|${d.part || ''}`;
      const chance = d.chance ?? 0;
      const cur = groups.get(key);
      if (!cur) groups.set(key, { loc, part: d.part || null, chance, rarity: d.rarity, variants: 1 });
      else {
        cur.variants++;
        if (chance > cur.chance) { cur.chance = chance; cur.rarity = d.rarity; }
      }
    }
    const out = [`## ${title}`];
    for (const g of groups.values()) {
      out.push(`  - ${g.loc}${g.part ? ' [' + g.part + ']' : ''}: ${n(g.chance * 100, 2)}% ${g.rarity || ''}${g.variants > 1 ? '（已合并精炼档，取最高）' : ''}`);
    }
    out.push('');
    return out;
  };

  // 1) item-name matches
  const hits = all.filter((x) => norm(x.name).includes(q)).slice(0, 6);
  const out = [];
  for (const it of hits) {
    const drops = (it.drops || []).filter((d) => d?.location).map((d) => ({ ...d, part: null }));
    for (const c of it.components || []) {
      for (const d of c.drops || []) if (d?.location) drops.push({ ...d, part: c.name });
    }
    if (!drops.length) continue;
    out.push(...render(`${it.name}（${it.type}）`, drops));
  }

  // 2) component-name matches, e.g. "Ash Prime Neuroptics".
  //    Component names are bare ("Neuroptics"), so match on item name + component name together.
  if (!out.length) {
    let found = 0;
    for (const it of all) {
      const itemName = norm(it.name);
      for (const c of it.components || []) {
        if (!c?.name) continue;
        const compName = norm(c.name);
        const combined = norm(it.name + ' ' + c.name);
        const qWords = q.split(' ').filter(Boolean);
        const matched = qWords.every((w) => combined.includes(w));
        if (!matched) continue;
        const drops = (c.drops || []).filter((d) => d?.location).map((d) => ({ ...d, part: `${it.name} ${c.name}` }));
        if (!drops.length) continue;
        out.push(...render(`${it.name} · ${c.name}（${it.name} 的部件）`, drops));
        found++;
        if (found >= 3) return out.join('\n').trim();
      }
    }
  }

  return out.length ? out.join('\n').trim() : `「${query}」相关物品没有记录掉落来源（可能是商店/活动/交易物品）。`;
}

async function tCompareWeapons({ weapons }) {
  const rows = [];
  for (const w of (weapons || []).slice(0, 4)) {
    const it = findItem(w, { preferType: WEAPON_TYPES });
    if (!it) { rows.push({ name: w, missing: true }); continue; }
    const dmg = it.damage?.total ?? 0;
    const cc = it.criticalChance ?? 0;
    const cm = it.criticalMultiplier ?? 1;
    const ms = it.multishot ?? 1;
    const fr = it.fireRate ?? 0;
    const dps = dmg * ms * fr * (1 + cc * (cm - 1));
    rows.push({ name: it.name, type: it.type, dmg, cc, cm, sc: it.procChance ?? 0, fr, mag: it.magazineSize, reload: it.reloadTime, mr: it.masteryReq, dps });
  }
  const out = ['武器对比（DPS 为基础估算：总伤害×多重×射速×暴击期望，未计元素/状态/紫卡）:', ''];
  for (const r of rows) {
    if (r.missing) { out.push(`- ${r.name}: 未找到`); continue; }
    out.push(`- ${r.name} [${r.type}] 伤害${n(r.dmg, 1)} 暴击${pct(r.cc)}x${n(r.cm, 1)} 触发${pct(r.sc)} 射速${n(r.fr, 2)} 弹匣${r.mag ?? '?'} 装填${n(r.reload, 2)}s MR${r.mr} → 基础DPS ≈ ${n(r.dps, 0)}`);
  }
  return out.join('\n');
}

async function tFarmGuide({ item }) {
  const it = findItem(item);
  if (!it) return `本地数据里没有「${item}」。`;
  const out = [`## ${it.name}（${it.type}）获取途径`];
  const merged = new Map();
  const add = (d, part) => {
    const base = String(d.location).replace(/\s*\((Exceptional|Flawless|Radiant)\)\s*$/i, '').trim();
    const refined = base !== String(d.location).trim();
    const key = `${base}|${part || ''}`;
    const cur = merged.get(key);
    if (!cur || (refined === false && cur.refined)) merged.set(key, { refined, base, part, chance: d.chance, rarity: d.rarity });
  };
  for (const d of it.drops || []) if (d?.location) add(d, null);
  for (const c of it.components || []) for (const d of c.drops || []) if (d?.location) add(d, c.name);
  if (merged.size) {
    for (const v of [...merged.values()].slice(0, 40)) {
      out.push(`  - ${v.base}${v.part ? ' [' + v.part + ']' : ''}: ${n((v.chance ?? 0) * 100, 2)}% ${v.rarity || ''}`);
    }
  } else {
    out.push('  本地数据没有记录掉落来源。');
  }

  const m = await resolveMarketItem(it.name).catch(() => null);
  if (m) {
    try {
      const orders = await marketOrders(m.slug);
      const sells = orders.filter((o) => o.type === 'sell' && o.visible !== false && typeof o.platinum === 'number');
      const online = sells.filter((o) => o.user?.status === 'ingame');
      const pool = (online.length ? online : sells).map((o) => o.platinum);
      if (pool.length) out.push('', `market: 最低 ${Math.min(...pool)}p｜中位 ${n(median(pool), 1)}p（在线卖家 ${online.length}）`);
    } catch { /* ignore */ }
  }
  out.push('', '建议: 掉率低/已入库的部件直接 market 购买通常更省时间。');
  return out.join('\n');
}

async function tSearchItems({ query, limit = 15 }) {
  const q = norm(query);
  if (!q) return '请提供关键词。';
  const all = db();
  const scored = [];
  const mainTypes = new Set(['Warframe', 'Rifle', 'Shotgun', 'Pistol', 'Melee', 'Primary Mod', 'Warframe Mod', 'Secondary Mod', 'Melee Mod', 'Shotgun Mod']);
  for (const it of all) {
    const nm = norm(it.name);
    if (!nm.includes(q)) continue;
    let s = nm === q ? 0 : nm.startsWith(q) ? 1 : 2;
    if (!mainTypes.has(it.type)) s += 3;
    scored.push([s, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length);
  if (!scored.length) return `没有匹配「${query}」的物品。`;
  return scored.slice(0, limit).map(([, it]) => `- ${it.name}（${it.type}${it.category && it.category !== it.type ? ' / ' + it.category : ''}）`).join('\n');
}

/* ---------------- 灰机中文 wiki（经悬浮窗桥接） ---------------- */
// warframe.huijiwiki.com 有 Cloudflare 人机校验，本进程直接 fetch 会拿到 403 挑战页。
// 悬浮窗（main.js）里开了个隐藏窗口过一次校验，并把请求能力暴露在 127.0.0.1:3001。
// 悬浮窗没启动时这里会连接失败 → 回退到本地 warframe-items 数据。
const WIKI_BRIDGE = 'http://127.0.0.1:3001';

async function huijiBridge(path, timeout = 25000) {
  const res = await fetch(WIKI_BRIDGE + path, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function tSearchWiki({ query }) {
  const q = String(query).trim();

  // 1) 灰机中文 wiki：搜索 → 取前 3 条 → 逐条拉正文摘要
  try {
    const search = await huijiBridge('/search?q=' + encodeURIComponent(q) + '&limit=4');
    const hits = Array.isArray(search.results) ? search.results : [];
    if (search.ok && hits.length) {
      const parts = [
        `## 灰机 wiki：${q}`,
        '',
        '> 数据源：warframe.huijiwiki.com（中文 wiki，实时抓取）',
        '',
      ];
      for (const hit of hits.slice(0, 3)) {
        parts.push(`### ${hit.title}`);
        try {
          const page = await huijiBridge('/page?title=' + encodeURIComponent(hit.title));
          const text = String(page.page?.text || '').trim();
          if (text) {
            parts.push('', text.slice(0, 1400) + (text.length > 1400 ? '\n…（正文截断，完整内容见下方链接）' : ''));
          } else if (hit.snippet) {
            parts.push('', String(hit.snippet).replace(/<[^>]+>/g, '').trim());
          }
        } catch {
          if (hit.snippet) parts.push('', String(hit.snippet).replace(/<[^>]+>/g, '').trim());
        }
        parts.push('');
      }
      parts.push(`链接：https://warframe.huijiwiki.com/wiki/${encodeURIComponent(hits[0].title)}`);
      return parts.join('\n');
    }
  } catch { /* 桥接不可用（悬浮窗没开）→ 走下面的回退 */ }

  // 2) 回退：本地离线库的结构化数据
  const it = findItem(q);
  if (!it) {
    return `灰机 wiki 桥接不可用（悬浮窗没启动？），本地数据里也没有「${q}」。\n启动悬浮窗后可重新尝试 wiki 搜索，或换一个更具体的物品名。`;
  }
  const note = '> 灰机 wiki 桥接不可用（悬浮窗没启动），以下为本地 warframe-items 结构化数据。\n';
  let body;
  if (/^Warframe$/.test(it.type)) body = await tGetWarframe({ name: it.name });
  else if (WEAPON_TYPES.test(it.type)) body = await tGetWeapon({ name: it.name });
  else if (MOD_TYPES.test(it.type)) body = await tGetMod({ name: it.name });
  else {
    const out = [`## ${it.name}（${it.type}）`];
    if (it.description) out.push(clean(it.description));
    const comp = componentsText(it);
    if (comp) out.push('', comp);
    body = out.join('\n');
  }
  const link = it.wikiaUrl;
  return body + (link ? `\n\nwiki 链接: ${link}` : '') + '\n\n' + note;
}

async function tRecommendBuild({ weapon }) {
  const it = findItem(weapon, { preferType: WEAPON_TYPES });
  if (!it) return `未找到武器「${weapon}」。`;
  const cls = it.type;
  const core = {
    Rifle: ['Serration', 'Split Chamber', 'Vital Sense', 'Point Strike', 'Infected Clip', 'Stormbringer'],
    Shotgun: ['Point Blank', "Hell's Chamber", 'Blaze', 'Blunderbuss', 'Charged Shell', 'Incendiary Coat'],
    Pistol: ['Hornet Strike', 'Barrel Diffusion', 'Lethal Torrent', 'Primed Pistol Gambit', 'Primed Target Cracker'],
    Bow: ['Serration', 'Split Chamber', 'Vital Sense', 'Point Strike', 'Speed Trigger'],
    Melee: ['Pressure Point', 'Blood Rush', 'Weeping Wounds', 'Organ Shatter', 'Berserker Fury', 'Condition Overload'],
  }[cls] || ['Serration', 'Split Chamber', 'Vital Sense'];
  const out = [`## ${it.name} 配装建议（本地启发式，非社区最优）`];
  out.push(`武器类型 ${cls}｜基础伤害 ${n(it.damage?.total ?? 0, 1)}｜暴击 ${pct(it.criticalChance ?? 0)} x${n(it.criticalMultiplier ?? 1, 1)}｜触发 ${pct(it.procChance ?? 0)}`);
  out.push('', '通用核心卡:');
  for (const m of core) {
    const mod = findItem(m, { preferType: MOD_TYPES });
    if (mod) out.push(`  - ${mod.name}（${mod.rarity || '?'}，最高 R${mod.fusionLimit ?? '?'}，基础消耗 ${mod.baseDrain ?? '?'}）`);
    else out.push(`  - ${m}`);
  }
  out.push('', '说明: 精确配装（含紫卡/元素组合）需要 Overframe 社区数据，当前网络无法访问；以上为该类武器通用框架。');
  return out.join('\n');
}

/* ---------------- world state (DE 官方接口，不再依赖 warframestat) ---------------- */

const WS_SOURCES = [
  'https://api.warframe.com/cdn/worldState.php',
  'https://content.warframe.com/dynamic/worldState.php',
];
const TENNO_WS = 'https://api.tenno.tools/worldstate';
const WS_TTL = 60 * 1000;
const WS_CACHE_FILE = join(TOOLS_DIR, 'worldstate-cache.json');
const WS_STALE_MAX = 6 * 60 * 60 * 1000;   // 实时接口全挂时，最多用 6 小时前的快照
const WS_RETRY_COOLDOWN = 30 * 1000;       // 全部失败后 30 秒内不再重试，直接走缓存
let wsMod = null;
let wsCache = { at: 0, text: '' };
let wsFailAt = 0;

async function loadWorldStateParser() {
  if (wsMod) return wsMod;
  // 解析器装在 tools/worldstate，和本文件同属 tools/ 下
  const entry = join(TOOLS_DIR, 'worldstate', 'entry.mjs');
  wsMod = await import(pathToFileURL(entry).href);
  return wsMod;
}

/* 世界状态在几个镜像之间轮询：任意一个能通就用，全都不通就用磁盘快照 */
async function fetchWorldStateRaw() {
  let lastErr = null;
  for (const url of WS_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await fetchJson(url, { timeout: 6000 });
        if (raw && typeof raw === 'object' && (raw.WorldState || raw.CetusCycle || raw.TimeNow)) {
          return { raw, url };
        }
        lastErr = new Error(`${url} 返回的不是 worldState 结构`);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error(`所有世界状态源都不可达（最后一次：${lastErr?.message || '未知'}）`);
}

const TIER_ORDER = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
const TIER_CN = { Lith: '古纪', Meso: '中纪', Neo: '前纪', Axi: '后纪', Requiem: '安魂', Omnia: '全能' };
const MISSION_CN = {
  Capture: '捕获', Sabotage: '破坏', Defense: '防御', Survival: '生存', Interception: '拦截',
  Rescue: '救援', Spy: '间谍', Extermination: '歼灭', Exterminate: '歼灭', 'Mobile Defense': '移动防御',
  Disruption: '中断', Excavation: '挖掘', Hijack: '劫持', Defection: '叛逃', Assassination: '刺杀',
  Pursuit: '追击', Arena: '竞技场', Conclave: '决斗', Skirmish: '前哨战', Volatile: '爆破',
  'Void Cascade': '虚空瀑流', 'Void Flood': '虚空洪流', 'Void Armageddon': '虚空末日', Alchemy: '炼金',
  'Mirror Defense': '镜像防御', Ascension: '登升', Orphix: '奥菲克斯', Infested: '感染',
  'Sanctuary Onslaught': '圣殿突袭', Hive: '巢穴', 'Hive Sabotage': '巢穴破坏', 'Void Rush': '虚空冲刺',
  'Landscape': '开放地形', 'Bounty': '赏金', 'Railjack': '飞船', 'Confrontation': '对抗',
};
const mt = (name) => (name ? `${MISSION_CN[name] || name}` : '');

function left(expiry) {
  const ms = new Date(expiry).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '已结束';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分';
  if (m >= 1440) return `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return `${m} 分`;
}

function clock(d) {
  return new Date(d).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderDeWorldState(ws, sourceHost) {
  const out = [`## 世界实况 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`];

  // 昼夜周期
  const cycles = [];
  const cycleLeft = (c) => left(c.expiry);
  if (ws.cetusCycle) cycles.push(`希图斯 ${ws.cetusCycle.isDay ? '白天' : '夜晚'}（剩 ${cycleLeft(ws.cetusCycle)}）`);
  if (ws.vallisCycle) cycles.push(`福尔图娜 ${ws.vallisCycle.isWarm ? '温暖' : '寒冷'}（剩 ${cycleLeft(ws.vallisCycle)}）`);
  if (ws.cambionCycle) cycles.push(`魔胎之境 ${String(ws.cambionCycle.state || '').toUpperCase()}（剩 ${cycleLeft(ws.cambionCycle)}）`);
  if (cycles.length) out.push('', '**昼夜周期**', ...cycles.map((c) => `- ${c}`));

  // 虚空裂缝
  const fissures = (ws.fissures || []).filter((f) => f && f.expiry && new Date(f.expiry) > new Date());
  const byTier = new Map();
  for (const f of fissures) {
    const key = f.tier || '未知';
    if (!byTier.has(key)) byTier.set(key, []);
    byTier.get(key).push(f);
  }
  out.push('', `**虚空裂缝**（${fissures.length} 个进行中）`);
  if (!fissures.length) out.push('- 现在没有裂缝，等下一次轮换');
  const tiers = [...byTier.keys()].sort((a, b) => {
    const ia = TIER_ORDER.indexOf(a); const ib = TIER_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const tier of tiers) {
    const list = byTier.get(tier).slice(0, 4);
    out.push(`- ${TIER_CN[tier] || tier}（${tier}）：` + list.map((f) =>
      `${f.node} · ${mt(f.missionType)} · 剩 ${left(f.expiry)}${f.isHard ? ' · 钢铁' : ''}${f.isStorm ? ' · 虚空风暴' : ''}`
    ).join('；'));
  }

  // 突击
  if (ws.sortie && ws.sortie.variants) {
    const s = ws.sortie;
    out.push('', `**突击**（剩 ${left(s.expiry)}）`);
    s.variants.slice(0, 3).forEach((v, i) => {
      out.push(`${i + 1}. ${v.node || ''} · ${mt(v.missionType)}${v.modifier ? ` · ${v.modifier}` : ''}`);
    });
  }

  // 虚空商人
  const vt = ws.voidTrader;
  if (vt && vt.activation) {
    const now = Date.now();
    const start = new Date(vt.activation).getTime();
    const end = new Date(vt.expiry).getTime();
    if (now >= start && now <= end) {
      out.push('', `**虚空商人**：正在 ${vt.location} 驻留，剩 ${left(vt.expiry)}`);
      if (vt.inventory?.length) out.push(`- 本次带货 ${vt.inventory.length} 件（详细清单请游戏内查看）`);
    } else if (now < start) {
      out.push('', `**虚空商人**：${clock(start)} 抵达 ${vt.location}（还有 ${left(vt.activation)}）`);
    }
  }

  // 入侵
  const inv = (ws.invasions || []).filter((i) => i && !i.completed);
  if (inv.length) {
    const rewardOf = (side) => {
      const items = side?.reward?.countedItems || [];
      return items.length ? items.map((it) => `${it.type}${it.count > 1 ? ` x${it.count}` : ''}`).join(' + ') : '';
    };
    out.push('', `**入侵**（${inv.length} 个进行中）`);
    for (const i of inv.slice(0, 4)) {
      const atk = i.attacker?.faction || '?';
      const def = i.defender?.faction || '?';
      const rA = rewardOf(i.attacker);
      const rD = rewardOf(i.defender);
      const pctDone = Number(i.completion || 0).toFixed(1);
      const rewards = [rA && `进攻方 ${rA}`, rD && `防守方 ${rD}`].filter(Boolean).join(' / ');
      out.push(`- ${i.node}：${atk} vs ${def}（${pctDone}%）${rewards ? `｜${rewards}` : ''}`);
    }
  }

  // 警报（现在游戏里基本只剩活动警报，没有就跳过）
  const alerts = (ws.alerts || []).filter((a) => a && a.mission?.node);
  if (alerts.length) {
    out.push('', `**限时警报**（${alerts.length} 个）`);
    for (const a of alerts.slice(0, 3)) {
      out.push(`- ${a.mission.node} · ${mt(a.mission.type)} · 剩 ${left(a.expiry)}`);
    }
  }

  out.push('', `> 数据源：DE 官方 \`worldState.php\`（${sourceHost}），缓存 60 秒。`);
  return out.join('\n');
}

/* tenno.tools 的世界状态：字段名和 DE 不同，自己转一遍再渲染 */
/* tenno.tools 只要开始时刻、总长和白昼区间，白昼 = [dayStart, dayEnd)：
   - 白天：剩余 = dayEnd - pos
   - 夜晚且还没到 dayStart（循环开头的黑夜段）：剩余 = dayStart - pos
   - 夜晚且已过 dayEnd（循环结尾的黑夜段）：剩余 = (length - pos) + dayStart */
function tennoCycle(entry, now, { dayStart, dayEnd, length }) {
  const t = now / 1000 - entry.start;
  const pos = ((t % length) + length) % length;
  const ds = Number(dayStart) || 0;
  const de = Number(dayEnd) || length;
  const isDay = pos >= ds && pos < de;
  let remain;
  if (isDay) remain = de - pos;
  else if (pos < ds) remain = ds - pos;
  else remain = length - pos + ds;
  return { isDay, remainSec: Math.max(0, Math.round(remain)), phasePos: pos };
}

function renderTennoWorldState(j) {
  // 优先用上游给的服务器时间，避免本机时钟偏差把倒计时算歪
  const rawTime = Number(j.time);
  const now = rawTime > 1e12 ? rawTime : rawTime > 1e9 ? rawTime * 1000 : Date.now();
  const out = [`## 世界实况 · ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`];

  const dn = j.daynight?.data || [];
  const cycles = [];
  const cetus = dn.find((d) => d.id === 'cetus');
  if (cetus) {
    const c = tennoCycle(cetus, now, { dayStart: cetus.dayStart, dayEnd: cetus.dayEnd, length: cetus.length });
    cycles.push(`希图斯 ${c.isDay ? '白天' : '夜晚'}（剩 ${left(now + c.remainSec * 1000)}）`);
  }
  const fortuna = dn.find((d) => d.id === 'fortuna');
  if (fortuna) {
    const c = tennoCycle(fortuna, now, { dayStart: fortuna.dayStart, dayEnd: fortuna.dayEnd, length: fortuna.length });
    cycles.push(`福尔图娜 ${c.isDay ? '温暖' : '寒冷'}（剩 ${left(now + c.remainSec * 1000)}）`);
  }
  // 这个备用源没有魔胎之境数据，别硬编，直说
  if (!dn.some((d) => d.id === 'cambion' || d.id === 'deimos')) {
    cycles.push('魔胎之境：备用源不提供（DE 官方源可用时会自动补上）');
  }
  if (cycles.length) out.push('', '**昼夜周期**', ...cycles.map((c) => `- ${c}`));

  const fissures = (j.fissures?.data || []).filter((f) => f.end * 1000 > now);
  const byTier = new Map();
  for (const f of fissures) {
    const key = f.tier || '未知';
    if (!byTier.has(key)) byTier.set(key, []);
    byTier.get(key).push(f);
  }
  if (fissures.length) {
    out.push('', `**虚空裂缝**（${fissures.length} 个进行中）`);
    for (const tier of TIER_ORDER) {
      const list = byTier.get(tier);
      if (!list?.length) continue;
      out.push('', `**${TIER_CN[tier] || tier}（${tier}）**`);
      for (const f of list.slice(0, 4)) {
        const node = String(f.location || '').replace('/', ' ');
        const flags = [f.hard ? '钢铁' : '', f.storm ? '虚空风暴' : ''].filter(Boolean).join('·');
        out.push(`- ${node} · ${mt(f.missionType)}${flags ? ` · ${flags}` : ''} · 剩 ${left(f.end * 1000)}`);
      }
    }
  }

  const sortie = (j.sorties?.data || [])[0];
  if (sortie) {
    out.push('', `**突击**：${sortie.bossName || '?'}（${sortie.faction || '?'}）· 剩 ${left(sortie.end * 1000)}`);
    out.push('- 该源不提供三段任务详情，进游戏看节点即可');
  }

  const vt = (j.voidtraders?.data || []).find((v) => v.end * 1000 > now);
  if (vt) {
    const start = vt.start * 1000;
    if (now >= start) out.push('', `**虚空商人**：正在 ${String(vt.location || '').replace('/', ' ')} 驻留，剩 ${left(vt.end * 1000)}`);
    else out.push('', `**虚空商人**：${clock(start)} 抵达 ${String(vt.location || '').replace('/', ' ')}（还有 ${left(start)}）`);
  }

  const inv = (j.invasions?.data || []).filter((i) => i && i.score < i.endScore);
  if (inv.length) {
    const rewardText = (side) => {
      const items = side?.countedItems || [];
      return items.length ? items.map((it) => `${it.type}${it.count > 1 ? ` x${it.count}` : ''}`).join(' + ') : '';
    };
    out.push('', `**入侵**（${inv.length} 个进行中）`);
    for (const i of inv.slice(0, 4)) {
      const raw = (i.score / i.endScore) * 100;
      const state = raw <= 0 ? '防守方领先' : `${Math.min(100, raw).toFixed(1)}%`;
      const rA = rewardText(i.rewardsAttacker);
      const rD = rewardText(i.rewardsDefender);
      const rewards = [rA && `进攻 ${rA}`, rD && `防守 ${rD}`].filter(Boolean).join(' / ');
      out.push(
        `- ${String(i.location || '').replace('/', ' ')}：${i.factionAttacker || '?'} vs ${i.factionDefender || '?'}（${state}）${rewards ? `｜${rewards}` : ''}`,
      );
    }
  }

  const alerts = (j.alerts?.data || []).filter((a) => a && a.end * 1000 > now);
  if (alerts.length) {
    out.push('', `**限时警报**（${alerts.length} 个）`);
    for (const a of alerts.slice(0, 3)) {
      out.push(`- ${String(a.location || '').replace('/', ' ')} · ${mt(a.missionType)} · 剩 ${left(a.end * 1000)}`);
    }
  }

  out.push('', '> 数据源：api.tenno.tools（DE 官方数据的第三方转述），缓存 60 秒。');
  return out.join('\n');
}

/* 最近一次成功渲染的文本落盘，接口全挂时还能给出「X 分钟前」的快照 */
function readTextCache() {
  try {
    const d = JSON.parse(readFileSync(WS_CACHE_FILE, 'utf8'));
    if (d && d.at && d.text) return d;
  } catch {}
  return null;
}

function writeTextCache(text, source) {
  try {
    writeFileSync(WS_CACHE_FILE, JSON.stringify({ at: Date.now(), text, source }), 'utf8');
  } catch (err) {
    console.warn('[worldstate] 写缓存失败：', err.message);
  }
}

async function fetchJsonWithRetry(url, tries = 3, timeout = 9000) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url, { timeout });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function loadWorldState() {
  if (wsCache.text && Date.now() - wsCache.at < WS_TTL) return wsCache.text;

  // 刚全部失败过就别再让用户干等，直接给缓存
  const cooling = wsFailAt && Date.now() - wsFailAt < WS_RETRY_COOLDOWN;

  if (!cooling) {
    // DE 官方和 tenno.tools 同时开跑，谁先回来用谁 —— 避免 DE 超时把整次调用拖到半分钟
    const fromDe = (async () => {
      const mod = await loadWorldStateParser();
      const got = await fetchWorldStateRaw();
      const ws = new mod.WorldState(got.raw, { locale: 'en' });
      return { text: renderDeWorldState(ws, got.url.split('/')[2]), source: got.url };
    })();

    const fromTenno = (async () => {
      const j = await fetchJsonWithRetry(TENNO_WS, 1, 6000);
      return { text: renderTennoWorldState(j), source: TENNO_WS };
    })();

    const race = Promise.any([fromDe, fromTenno]);
    const commit = (got) => {
      wsFailAt = 0;
      wsCache = { at: Date.now(), text: got.text };
      writeTextCache(got.text, got.source);
      return got.text;
    };

    try {
      // 冷启动时两个源都可能要 10 秒以上；先等 7 秒，超了就先用旧快照，让赢家稍后自己回填
      const got = await Promise.race([
        race,
        new Promise((_, reject) => setTimeout(() => reject(new Error('等源超过 7 秒')), 7000).unref?.()),
      ]);
      const text = commit(got);
      // 备用源没有魔胎之境：如果这次是 tenno 先回来，等 DE 也回来后再悄悄换成 DE 版本
      fromDe
        .then((g) => {
          if (g.text && g.text !== text) {
            wsCache = { at: Date.now(), text: g.text };
            writeTextCache(g.text, g.source);
            console.log('[worldstate] DE 版本已回填（含魔胎之境）');
          }
        })
        .catch(() => {});
      return text;
    } catch (err) {
      const reasons = err?.errors?.map((e) => e?.message).filter(Boolean) || [err.message];
      console.warn('[worldstate] 实时源未及时返回：', reasons.join(' / '));
      race.then(commit).catch(() => {});
    }

    wsFailAt = Date.now();
  }

  // 3) 全都挂了 → 用 6 小时内的快照（注意：不要把带警告的文本塞进 wsCache，
  //    否则下次调用会误以为是新鲜数据、跳过重试）
  const cached = readTextCache();
  if (cached && Date.now() - cached.at < WS_STALE_MAX) {
    const mins = Math.max(0, Math.round((Date.now() - cached.at) / 60000));
    return [
      `> ⚠️ 实时接口暂时不可达，以下为 ${clock(cached.at)} 的快照（约 ${mins} 分钟前）。`,
      '> 昼夜/裂缝这类会随时间变化，请以游戏内为准；接口恢复后会自动变回实时。',
      '',
      cached.text,
    ].join('\n');
  }

  throw new Error('世界状态三个来源都连不上，本地也没有 6 小时内的快照。稍后再试，或开代理后重启。');
}

/* 同一时刻只允许一次真实拉取：工具调用与后台预热共用同一个 Promise */
let wsInflight = null;
function refreshWorldStateInBackground() {
  if (wsInflight) return;
  wsInflight = loadWorldState()
    .catch((err) => console.warn('[worldstate] 后台刷新失败：', err.message))
    .finally(() => {
      wsInflight = null;
    });
}

async function tWorldState() {
  const age = Date.now() - wsCache.at;
  if (wsCache.text && age < WS_TTL) return wsCache.text;

  // 过期但手里还有旧数据：先把旧的给出去，后台刷新，别让用户等网络
  if (wsCache.text) {
    refreshWorldStateInBackground();
    const mins = Math.round(age / 60000);
    return mins >= 2
      ? `${wsCache.text}\n\n> 注：以上数据约 ${mins} 分钟前抓取，正在后台刷新。`
      : wsCache.text;
  }

  if (wsInflight) return wsInflight;
  wsInflight = loadWorldState().finally(() => {
    wsInflight = null;
  });
  return wsInflight;
}

/* tenno.tools 单次要 5–12 秒，等用户点开再拉就太慢了，后台每 60 秒刷一次 */
function startWorldStateWarmup() {
  const refresh = () => {
    tWorldState().catch((err) => console.warn('[worldstate] 预热失败：', err.message));
  };
  setTimeout(refresh, 1500).unref?.();
  // 比 60 秒的 TTL 稍早一点刷新，保证工具调用时手里总有新鲜数据
  setInterval(refresh, WS_TTL - 5000).unref?.();
}

/* ---------------- degraded features (no inventory / no wiki) ---------------- */


const STARTER_FRAMES = [
  ['Excalibur', '近战/爆发路线，显赫刀剑可远程剑气，容错最高，适合先熟悉战斗节奏与连段。'],
  ['Mag', '磁力控场，靠 Polarize / Magnetize 处理护盾与成群敌人；更吃能量管理与走位。'],
  ['Volt', '电系速度与护盾，跑图最快、团队增益强；本体偏脆，需要靠位移规避伤害。'],
];

function topDropOf(comp) {
  const groups = new Map();
  for (const d of comp.drops || []) {
    if (!d?.location) continue;
    const base = String(d.location).replace(/\s*\((Exceptional|Flawless|Radiant)\)\s*$/i, '').trim();
    const refined = base !== String(d.location).trim();
    const cur = groups.get(base);
    if (!cur || (refined === false && cur.refined)) groups.set(base, { refined, chance: d.chance ?? 0 });
  }
  const arr = [...groups.entries()].sort((a, b) => b[1].chance - a[1].chance);
  return arr[0] ? `${arr[0][0]} ${n(arr[0][1].chance * 100, 2)}%` : null;
}

async function tBeginnerGuide({ topic } = {}) {
  const t = String(topic || 'all').toLowerCase();
  const want = (k) => t === 'all' || t === k;
  const out = ['## 新手路线建议'];

  if (want('start')) {
    out.push('', '### 1. 先开图（最高优先）');
    out.push('星图节点是所有内容的门禁：新星球、刺杀、裂隙、入侵、集团、钢铁之路，都要求前置节点已通。');
    out.push('做法：按星球顺序推节点，每个至少通一次；卡住了先回头升 MOD，而不是急着换武器。');
  }

  if (want('warframe')) {
    out.push('', '### 2. 初始战甲怎么选（属性取自本地 warframe-items）');
    for (const [name, role] of STARTER_FRAMES) {
      const it = findItem(name, { preferType: /^Warframe$/ });
      if (!it) { out.push(`- **${name}** — 本地库未收录`); continue; }
      out.push(`- **${it.name}** — 生命 ${it.health}｜护盾 ${it.shield}｜护甲 ${it.armor}｜能量 ${it.power ?? '?'}`);
      out.push(`  ${role}`);
    }
    out.push('结论：三者都能通主线，差别在风格不在强度——Excalibur 容错最高，Volt 跑图最快，Mag 最吃操作。');
  }

  if (want('platinum')) {
    out.push('', '### 3. 白金怎么花');
    out.push('- **槽位优先**：战甲槽、武器槽是硬瓶颈，先买槽位（价格以游戏内商城为准）。');
    out.push('- **不加速建造**：加速建造的白金性价比极低，等就行。');
    out.push('- **不买成品战甲**：普通战甲都能刷；Prime 套只在市场价低于你刷取的时间成本时才值得买。');
    out.push('- 紫卡、外观、宠物属于后期消费，前期不要碰。');
  }

  if (want('clan')) {
    out.push('', '### 4. 尽早加活跃氏族');
    out.push('道场研究台提供大量武器/战甲图纸（其中一部分只能靠研究解锁），还有交易站与实验室；这是前期性价比最高的一步。');
    out.push('判断是否活跃：道场有人、研究台解锁进度高、问话有人回。');
  }

  if (want('mod')) {
    out.push('', '### 5. 优先升 MOD，而不是换武器');
    const ser = findItem('Serration', { preferType: MOD_TYPES });
    const vs = findItem('Vital Sense', { preferType: MOD_TYPES });
    out.push('同一把武器，MOD 齐不齐能差一个数量级；武器本体只是底盘。');
    if (ser?.levelStats?.length) {
      const a = ser.levelStats[0]?.stats?.[0], b = ser.levelStats[ser.levelStats.length - 1]?.stats?.[0];
      if (a && b) out.push(`例（本地数据）：${ser.name} R0 ${a} → R${ser.fusionLimit} ${b}（最高 Rank）。`);
    }
    if (vs) out.push(`例：${vs.name} 提升暴击伤害倍率，是暴击流的核心卡之一。`);
    out.push('顺序：把核心伤害卡升满 → 补齐多重/暴击/元素 → 再考虑换武器。');
  }

  return out.join('\n');
}

async function priceTable(names) {
  return Promise.all(names.map(async (name) => {
    try {
      const m = await resolveMarketItem(name);
      if (!m) return { ok: false, name };
      const orders = await marketOrders(m.slug);
      const sells = orders.filter((o) => o.type === 'sell' && o.visible !== false);
      // Mods: rank-0 copies are fodder and would fake a "1p core mod"; rank the price at max rank.
      const atMax = m.maxRank != null ? sells.filter((o) => (o.rank ?? 0) === m.maxRank) : [];
      const rankPool = atMax.length ? atMax : sells;
      const online = rankPool.filter((o) => o.user?.status === 'ingame');
      const pool = (online.length ? online : rankPool).filter((o) => typeof o.platinum === 'number');
      if (!pool.length) return { ok: false, name: marketName(m) };
      pool.sort((a, b) => a.platinum - b.platinum);
      return {
        ok: true, name: marketName(m), slug: m.slug, price: pool[0].platinum,
        online: online.length, total: rankPool.length,
        rank: atMax.length ? m.maxRank : null,
      };
    } catch { return { ok: false, name }; }
  }));
}

const STAPLE_MODS = ['Serration', 'Split Chamber', 'Vital Sense', "Hell's Chamber"];
const HOT_SETS = ['Ash Prime Set', 'Mesa Prime Set', 'Saryn Prime Set'];

async function tDailyPicks() {
  const out = ['## 今日推荐（市场与掉落速览）', ''];

  // 直接用世界状态缓存判断可用性，别再单开一次网络请求（那会让 6 秒超时拖慢整个工具）
  const wsAge = Date.now() - wsCache.at;
  const wsFresh = Boolean(wsCache.text) && wsAge < 3 * 60 * 1000;
  if (!wsCache.text || wsAge >= WS_TTL) refreshWorldStateInBackground();

  const [mods, sets] = await Promise.all([priceTable(STAPLE_MODS), priceTable(HOT_SETS)]);

  out.push(wsFresh ? '实时状态：可用（需要细节可调 world_state）' : '实时状态：接口当前不稳，world_state 会给出带时间戳的快照');
  out.push('');

  const goodMods = mods.filter((r) => r.ok).sort((a, b) => a.price - b.price);
  const goodSets = sets.filter((r) => r.ok).sort((a, b) => b.price - a.price);

  let idx = 0;
  if (goodMods.length) {
    idx += 1;
    const m = goodMods[0];
    out.push(`### ${idx}. 补卡：${m.name} — 最低 ${m.price}p（在线 ${m.online}/${m.total}）`);
    out.push('依据：warframe.market 实时最低在线卖单。核心卡是一次投入长期生效，价格低时补最划算。');
    if (goodMods.length > 1) out.push('其余核心卡参考：' + goodMods.slice(1).map((x) => `${x.name} ${x.price}p`).join('｜'));
    out.push('');
  }

  for (const s of goodSets.slice(0, 2)) {
    idx += 1;
    const base = s.name.replace(/\s*Set$/, '');
    const it = findItem(base, { preferType: /^Warframe$/ }) || findItem(base);
    const parts = (it?.components || [])
      .filter((c) => /Blueprint|Chassis|Neuroptics|Systems/.test(c.name))
      .map((c) => {
        const d = topDropOf(c);
        return d ? `${c.name.replace(base + ' ', '')} → ${d}` : null;
      })
      .filter(Boolean);

    out.push(`### ${idx}. 刷还是买：${s.name} — 最低 ${s.price}p（在线 ${s.online}/${s.total}）`);
    if (parts.length) out.push('依据：本地掉落数据 ' + parts.slice(0, 4).join('；'));
    else out.push('依据：本地掉落数据未记录该套部件来源。');
    let verdict;
    if (s.price <= 40) verdict = '直接买更划算：价格已经低于刷取的时间成本。';
    else if (s.price >= 80) verdict = '自刷更划算：市场价偏高，按上面遗物清单去刷。';
    else verdict = '中间档：缺 1–2 个部件就刷，缺 3 个以上直接买。';
    out.push('判断：' + verdict);
    out.push('');
  }

  if (!idx) {
    out.push('market 接口本次全部失败，无法给出基于价格的建议；可稍后重试 check_market。');
  }

  return out.join('\n').trimEnd();
}

/* ---------------- registry ---------------- */

/* ---------------- 遗物奖励库（drop.wf.wiki，本地缓存） ---------------- */

const RELIC_REWARDS_FILE = join(DATA_DIR, 'relic_rewards.json');
let relicRewardsCache = { mtime: 0, data: null };

function relicRewards() {
  if (!existsSync(RELIC_REWARDS_FILE)) return null;
  const st = statSync(RELIC_REWARDS_FILE);
  if (!relicRewardsCache.data || relicRewardsCache.mtime !== st.mtimeMs) {
    try {
      relicRewardsCache = {
        mtime: st.mtimeMs,
        data: JSON.parse(readFileSync(RELIC_REWARDS_FILE, 'utf8')),
      };
    } catch {
      return null;
    }
  }
  return relicRewardsCache.data;
}

const RELIC_TIER_CN = { Lith: '古纪', Meso: '中纪', Neo: '前纪', Axi: '后纪', Requiem: '安魂', Vanguard: '先驱' };
const RARITY_CN = { 'Very Common': '常见', Common: '常见', Uncommon: '罕见', Rare: '稀有', Legendary: '传说' };
const REF_CN = { Intact: '完好', Exceptional: '卓越', Flawless: '无瑕', Radiant: '光辉' };

/** "Axi A1" / "后纪 A1" / "A1" → 归一化 key */
function findRelic(db, q) {
  const s = String(q || '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^([A-Za-z\u4e00-\u9fa5]+)\s*([A-Za-z0-9]+)$/);
  if (!m) return null;
  let tier = m[1];
  const cn = Object.entries(RELIC_TIER_CN).find(([, v]) => v === tier);
  if (cn) tier = cn[0];
  tier = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  const key = `${tier} ${m[2].toUpperCase()}`;
  return db.relics[key] ? { key, relic: db.relics[key] } : null;
}

/** 查遗物出什么，或查某个奖励在哪些遗物里 */
function tRelicDrops({ query } = {}) {
  const db = relicRewards();
  if (!db) return '本地还没有遗物奖励库。请先运行 `npm run update:relic-rewards`（或 `node update_relic_rewards.js`）。';
  const q = String(query || '').trim();
  if (!q) return '请给我一个遗物编号（如 "Axi A1"）或奖励名（如 "Trinity Prime Systems Blueprint"）。';

  const hit = findRelic(db, q);
  if (hit) {
    const { key, relic } = hit;
    const out = [`## ${key}（${RELIC_TIER_CN[relic.tier] || relic.tier} ${relic.code}）`, ''];
    out.push('| 奖励 | 稀有度 | 完好 | 卓越 | 无瑕 | 光辉 |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of relic.rewards) {
      const c = r.chance || {};
      const cell = (k) => (c[k] == null ? '—' : `${c[k]}%`);
      out.push(`| ${r.item} | ${RARITY_CN[r.rarity] || r.rarity || '—'} | ${cell('Intact')} | ${cell('Exceptional')} | ${cell('Flawless')} | ${cell('Radiant')} |`);
    }
    out.push('', `> 数据源：drop.wf.wiki（更新于 ${db._meta?.updatedAt?.slice(0, 10) || '未知'}），共 ${Object.keys(db.relics).length} 个遗物。`);
    return out.join('\n');
  }

  // 按奖励名反查：这个部件在哪些遗物里
  const needle = q.toLowerCase();
  const rows = [];
  for (const [key, relic] of Object.entries(db.relics)) {
    for (const r of relic.rewards) {
      if (r.item.toLowerCase().includes(needle)) {
        rows.push({ key, relic, r });
        break;
      }
    }
  }
  if (!rows.length) {
    return `本地奖励库里没有匹配「${q}」的奖励。可以先用 search_items 确认英文名，或跑一次 \`npm run update:relic-rewards\` 更新数据。`;
  }
  rows.sort((a, b) => (RELIC_TIER_CN[a.relic.tier] || '').localeCompare(RELIC_TIER_CN[b.relic.tier] || '') || a.key.localeCompare(b.key));
  const out = [`## 「${q}」出现在 ${rows.length} 个遗物里`, ''];
  out.push('| 遗物 | 稀有度 | 完好 | 光辉 |');
  out.push('| --- | --- | --- | --- |');
  for (const { key, relic, r } of rows.slice(0, 25)) {
    const c = r.chance || {};
    out.push(`| ${key} | ${RARITY_CN[r.rarity] || r.rarity || '—'} | ${c.Intact == null ? '—' : c.Intact + '%'} | ${c.Radiant == null ? '—' : c.Radiant + '%'} |`);
  }
  if (rows.length > 25) out.push('', `> 只列了前 25 个，共 ${rows.length} 个。`);
  return out.join('\n');
}

const TOOLS = [
  {
    name: 'get_item',
    description: '查询 Warframe 物品（战甲/武器/Mod/Prime 套装）的基础信息：描述、ducats、是否入库、MR、套装部件、制作材料。数据源：warframe.market v2 + 本地 warframe-items。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '物品名，如 "Ash Prime Set"、"Serration"' } }, required: ['query'] },
    handler: tGetItem,
  },
  {
    name: 'get_warframe',
    description: '查询战甲详细属性：生命/护盾/护甲/能量、极性、被动、技能、制作材料。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '战甲名，如 "Excalibur"、"Ash Prime"' } }, required: ['name'] },
    handler: tGetWarframe,
  },
  {
    name: 'get_weapon',
    description: '查询武器详细属性：伤害类型、暴击、触发、射速、弹匣、装填、多重、紫卡倾向、攻击模式、制作材料。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '武器名，如 "Braton"、"Rubico Prime"' } }, required: ['name'] },
    handler: tGetWeapon,
  },
  {
    name: 'get_mod',
    description: '查询 Mod：稀有度、极性、消耗、最高 Rank、各等级数值、适配类型。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Mod 名，如 "Serration"' } }, required: ['name'] },
    handler: tGetMod,
  },
  {
    name: 'check_market',
    description: '查询 warframe.market 实时价格：最低价、中位价、在线卖家、收购单、私聊模板。',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '物品名，如 "Ash Prime Set"' },
        rank: { type: 'number', description: '可选：只看该 Rank 的 Mod 卖单' },
      },
      required: ['item'],
    },
    handler: tCheckMarket,
  },
  {
    name: 'search_drops',
    description: '查询物品掉落来源（遗物/地点/概率/稀有度），支持 Prime 部件。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '物品或部件名' } }, required: ['query'] },
    handler: tSearchDrops,
  },
  {
    name: 'farm_guide',
    description: '综合刷取指南：掉落来源清单 + market 当前价格，判断自刷还是直接买。',
    inputSchema: { type: 'object', properties: { item: { type: 'string', description: '物品名' } }, required: ['item'] },
    handler: tFarmGuide,
  },
  {
    name: 'compare_weapons',
    description: '横向对比 2-4 把武器的基础属性与估算 DPS。',
    inputSchema: {
      type: 'object',
      properties: { weapons: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 } },
      required: ['weapons'],
    },
    handler: tCompareWeapons,
  },
  {
    name: 'search_items',
    description: '按关键词模糊搜索物品名（本地 1.5 万条），用于确认准确名称。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'number', description: '默认 15' } },
      required: ['query'],
    },
    handler: tSearchItems,
  },
  {
    name: 'search_wiki',
    description: '查询灰机中文 wiki（warframe.huijiwiki.com）：搜索词条并返回中文正文摘要。悬浮窗未启动或网络不通时自动退回本地结构化数据（描述/掉落/制作）。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '词条或物品名' } }, required: ['query'] },
    handler: tSearchWiki,
  },
  {
    name: 'recommend_build',
    description: '给出武器配装框架（按武器类型的通用核心卡，非社区最优）。',
    inputSchema: { type: 'object', properties: { weapon: { type: 'string' } }, required: ['weapon'] },
    handler: tRecommendBuild,
  },
  {
    name: 'world_state',
    description: '查询实时世界状态：昼夜周期（希图斯/福尔图娜/魔胎之境）、虚空裂缝、突击、虚空商人、入侵、警报。数据来自 DE 官方接口，连不上时自动切 tenno.tools 备用源，都失败时给 6 小时内快照并标注；缓存 60 秒。',
    inputSchema: { type: 'object', properties: { category: { type: 'string' } } },
    handler: () => tWorldState(),
  },
  {
    name: 'beginner_guide',
    description: '新手路线建议：开图优先 / 初始战甲对比 / 白金用途 / 氏族 / MOD 优先。纯本地数据，不联网检索。topic 可选 start|warframe|platinum|clan|mod，默认全部。',
    inputSchema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'start | warframe | platinum | clan | mod，默认 all' } },
    },
    handler: tBeginnerGuide,
  },
  {
    name: 'daily_picks',
    description: '通用今日推荐：基于 market 实时最低价 + 本地掉落给最多 3 条「今天刷还是买」建议。**不读库存**；需要个性化建议时先调库存工具。',
    inputSchema: { type: 'object', properties: {} },
    handler: tDailyPicks,
  },
  {
    name: 'relic_drops',
    description: '查遗物内容物：传入遗物编号（如 "Axi A1"、"后纪 A1"）返回四个精炼档的奖励与概率；传入奖励名（如 "Trinity Prime Systems Blueprint"）则反查它在哪些遗物里。数据源：drop.wf.wiki 本地缓存（tools/relic_rewards.json）。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '遗物编号或奖励物品名' } },
      required: ['query'],
    },
    handler: tRelicDrops,
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * 模型偶尔会把参数名记混（比如给 check_market 传 query）。
 * 这里按 schema 把常见别名归一，并在必填项缺失时给出明确错误，
 * 免得用一个 undefined 去模糊匹配、最后返回一个完全不相干的物品价格。
 */
const ARG_ALIASES = {
  item: ['item', 'query', 'name', 'weapon', 'keyword', 'text'],
  query: ['query', 'item', 'name', 'weapon', 'keyword', 'text'],
  name: ['name', 'item', 'query', 'weapon', 'keyword', 'text'],
  weapon: ['weapon', 'item', 'query', 'name', 'keyword', 'text'],
  weapons: ['weapons', 'items', 'list'],
};

function normalizeArgs(tool, rawArgs) {
  const args = { ...(rawArgs || {}) };
  for (const key of Object.keys(args)) {
    if (typeof args[key] === 'string') args[key] = args[key].trim();
  }
  const schema = tool.inputSchema || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};

  for (const field of required) {
    if (args[field] != null && args[field] !== '') continue;
    const alias = (ARG_ALIASES[field] || []).find((k) => k !== field && args[k] != null && args[k] !== '');
    if (alias) args[field] = args[alias];
  }

  const missing = required.filter((f) => args[f] == null || args[f] === '' || (Array.isArray(args[f]) && !args[f].length));
  if (missing.length) {
    const hint = missing.map((f) => `${f}（${(props[f] && props[f].description) || '必填'}）`).join('、');
    throw new Error(`缺少必填参数 ${hint}；请按工具的参数名重新调用。`);
  }
  return args;
}

/* ---------------- MCP plumbing ---------------- */

async function handle(msg) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wf_market', version: '2.2.0' },
        instructions: 'Warframe 数据服务：离线 warframe-items + 实时 warframe.market v2 + DE 官方世界状态（world_state：昼夜/裂缝/突击/虚空商人/入侵/警报）+ 灰机中文 wiki（search_wiki：经悬浮窗桥接，返回中文正文）+ 遗物奖励库（relic_drops：遗物出什么 / 部件在哪个遗物）。含通用版 beginner_guide / daily_picks（库存不可读时使用）。',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = TOOL_MAP.get(params?.name);
      if (!tool) throw new Error(`Unknown tool: ${params?.name}`);
      try {
        const text = await tool.handler(normalizeArgs(tool, params?.arguments || {}));
        return { content: [{ type: 'text', text: String(text) }], isError: false };
      } catch (e) {
        log('tool error: ' + (e?.stack || e));
        return { content: [{ type: 'text', text: `工具执行失败: ${e?.message || e}` }], isError: true };
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log('bad json: ' + raw.slice(0, 120));
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  try {
    const result = await handle(msg);
    send({ jsonrpc: '2.0', id: msg.id, result });
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: String(e.message || e) } });
  }
});

// Do not force-exit when stdin closes: let pending tool calls finish; the process exits when the loop drains.
process.on('uncaughtException', (e) => log('uncaught: ' + (e?.stack || e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + (e?.stack || e)));

log('wf-mcp-lite ready (pid ' + process.pid + ')');

// 预热：先把离线库和 market 物品清单在后台加载好，
// 用户第一次查价时就不用再等 3–5 秒的清单下载。
setTimeout(() => {
  try { db(); } catch (e) { log('warm db failed: ' + e.message); }
  marketItems().then(
    (list) => log('warm market list ok: ' + list.length + ' items'),
    (e) => log('warm market list skipped: ' + e.message)
  );
  startWorldStateWarmup();
}, 300);
