/**
 * 拉取 drop.wf.wiki 的遗物奖励表，合并精炼档位并去重，写入本地数据库
 *
 *   数据源：https://drop.wf.wiki/relicRewards
 *          实际数据接口 https://drop.wf.wiki/api/d?f=sections/relicRewards.json
 *          （服务端返回 gzip 字节流，需要自己解压；缺 Referer 会被 403）
 *
 *   输出：tools/relic_rewards.json
 *         {
 *           _meta: { updatedAt, source, groups, relics, rewards, deduped },
 *           tiers: ["Lith", ...],
 *           refinements: ["Intact", ...],
 *           relics: {
 *             "Axi A1": {
 *               tier, code,
 *               rewards: [ { item, rarity, chance: { Intact: 2, Radiant: 10 } } ]
 *             }
 *           }
 *         }
 *
 * 去重规则：同一个遗物里，同一个奖励物品只保留一条，四个精炼档的概率合并进 chance 字段。
 *
 * 用法：
 *   node update_relic_rewards.js          # 写入 tools/relic_rewards.json
 *   node update_relic_rewards.js --dry    # 只打印统计，不写文件
 */

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');

// 本机 IPv6 到 Cloudflare 不通，强制 IPv4
dns.setDefaultResultOrder('ipv4first');

const URL_DATA = 'https://drop.wf.wiki/api/d?f=sections/relicRewards.json';
const OUT_PATH = path.join(__dirname, '..', 'data', 'relic_rewards.json');

const TIER_ORDER = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Vanguard'];
const REFINEMENTS = ['Intact', 'Exceptional', 'Flawless', 'Radiant'];

const HEADERS = {
  Referer: 'https://drop.wf.wiki/relicRewards',
  Origin: 'https://drop.wf.wiki',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 取数据：服务端给的是 gzip 字节流，用 DecompressionStream 解开 */
async function fetchJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 有 gzip 魔数就解压，没有就当纯文本（接口以后改成明文也能用）
      let text;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = buf.toString('utf8');
      }
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`拉取失败：${lastErr?.message || 'unknown'}`);
}

/** "Axi A1 Relic (Intact)" → { tier:'Axi', code:'A1', refinement:'Intact' } */
function parseGroupName(name) {
  const m = String(name).match(/^([A-Za-z]+)\s+([A-Za-z0-9]+)\s+Relic\s*\(([^)]+)\)\s*$/);
  if (!m) return null;
  const tier = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return { tier, code: m[2].toUpperCase(), refinement: m[3] };
}

function tierIndex(t) {
  const i = TIER_ORDER.indexOf(t);
  return i < 0 ? 99 : i;
}

async function main() {
  const dry = process.argv.includes('--dry');
  console.log('== 更新遗物奖励库（drop.wf.wiki）==');
  const raw = await fetchJson(URL_DATA);
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  console.log(`[1/3] 收到 ${groups.length} 个（遗物 × 精炼档）分组`);

  const relics = new Map(); // "Axi A1" → { tier, code, rewards: Map }
  let skipped = 0;
  let deduped = 0;

  for (const g of groups) {
    const parsed = parseGroupName(g.name);
    if (!parsed) {
      skipped++;
      continue;
    }
    const key = `${parsed.tier} ${parsed.code}`;
    if (!relics.has(key)) {
      relics.set(key, { tier: parsed.tier, code: parsed.code, rewards: new Map() });
    }
    const relic = relics.get(key);

    for (const r of g.rewards || []) {
      const item = String(r.item || '').trim();
      if (!item) continue;
      const rarity = r.rarity || 'Unknown';
      const chance = Number(r.chance) || 0;

      if (relic.rewards.has(item)) {
        // 去重：同一遗物内同一个奖励只留一条，概率按精炼档合并
        const row = relic.rewards.get(item);
        const prev = row.chance[parsed.refinement];
        if (prev == null) {
          row.chance[parsed.refinement] = chance;
        } else if (prev !== chance) {
          deduped++;
        }
        if (!row.rarity || row.rarity === 'Unknown') row.rarity = rarity;
      } else {
        relic.rewards.set(item, { item, rarity, chance: { [parsed.refinement]: chance } });
      }
    }
  }

  // 排序 + 展平
  const out = {};
  let rewardCount = 0;
  const sortedKeys = [...relics.keys()].sort((a, b) => {
    const A = relics.get(a);
    const B = relics.get(b);
    return tierIndex(A.tier) - tierIndex(B.tier) || A.code.localeCompare(B.code, 'en', { numeric: true });
  });

  for (const key of sortedKeys) {
    const r = relics.get(key);
    const rewards = [...r.rewards.values()]
      .map((x) => {
        // 概率按固定顺序排，方便前端直接渲染
        const chance = {};
        for (const ref of REFINEMENTS) {
          if (x.chance[ref] != null) chance[ref] = x.chance[ref];
        }
        return { item: x.item, rarity: x.rarity, chance };
      })
      .sort((a, b) => {
        const maxA = Math.max(...Object.values(a.chance), 0);
        const maxB = Math.max(...Object.values(b.chance), 0);
        return maxB - maxA || a.item.localeCompare(b.item, 'en');
      });
    rewardCount += rewards.length;
    out[key] = { tier: r.tier, code: r.code, rewards };
  }

  const payload = {
    _meta: {
      updatedAt: new Date().toISOString(),
      source: 'https://drop.wf.wiki/relicRewards',
      groups: groups.length,
      relics: sortedKeys.length,
      rewards: rewardCount,
      skippedGroups: skipped,
      dedupedEntries: deduped,
      tiers: TIER_ORDER,
      refinements: REFINEMENTS,
    },
    tiers: TIER_ORDER,
    refinements: REFINEMENTS,
    relics: out,
  };

  console.log(
    `[2/3] 合并完成：${sortedKeys.length} 个遗物 / ${rewardCount} 条奖励` +
      `（跳过 ${skipped} 组，去重 ${deduped} 条）`
  );
  // 抽一个遗物自检
  const sample = out['Axi A1'];
  if (sample) {
    console.log(`[check] Axi A1 有 ${sample.rewards.length} 条奖励，示例：`);
    for (const x of sample.rewards.slice(0, 3)) {
      console.log(`         ${x.item} | ${x.rarity} | ${JSON.stringify(x.chance)}`);
    }
  }

  if (dry) {
    console.log('[3/3] --dry，未写文件');
    return;
  }

  if (!fs.existsSync(path.dirname(OUT_PATH))) fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  const size = fs.statSync(OUT_PATH).size;
  console.log(`[3/3] 已写入 ${OUT_PATH}（${(size / 1024).toFixed(0)} KB）`);
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exitCode = 1;
});
