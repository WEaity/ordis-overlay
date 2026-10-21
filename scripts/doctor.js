#!/usr/bin/env node
// scripts/doctor.js —— 启动前体检：把「缺什么、怎么补、缺了会怎样」一次说清楚
//
// 用法：npm run doctor

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');
const DATA = path.join(ROOT, 'data');

const checks = [];

function check(name, ok, detail, fix, impact) {
  checks.push({ name, ok, detail, fix, impact });
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function dirSize(p) {
  try {
    let total = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    }
    return total;
  } catch {
    return 0;
  }
}

/* ---------- 必需：应用自身依赖 ---------- */

check(
  'Electron 运行时',
  exists(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')),
  'node_modules/electron/dist/electron.exe',
  'npm install',
  '没有它双击启动脚本只会闪一下'
);

check(
  '@modelcontextprotocol/sdk',
  exists(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk')),
  'node_modules/@modelcontextprotocol/sdk',
  'npm install',
  '连不上任何 MCP 工具，只剩纯聊天'
);

check(
  'express',
  exists(path.join(ROOT, 'node_modules', 'express')),
  'node_modules/express',
  'npm install',
  '后端起不来，面板会一直转圈'
);

check(
  'openai',
  exists(path.join(ROOT, 'node_modules', 'openai')),
  'node_modules/openai',
  'npm install',
  '无法调用 DeepSeek，对话全失败'
);

/* ---------- 必需：API Key ---------- */

let keyOk = false;
let keyHint = 'config.json 不存在';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const k = String(cfg.apiKey || '');
  keyOk = k.length > 20 && !k.includes('your-deepseek-key');
  keyHint = keyOk ? `已配置（${k.slice(0, 6)}…${k.slice(-4)}）` : '还是占位符';
} catch {
  /* 保持默认提示 */
}
check('DeepSeek API Key', keyOk, keyHint, 'cp config.example.json config.json，或面板菜单 → API 凭据', '所有对话都会提示「还没填 Key」');

/* ---------- 数据表 ---------- */

const tables = [
  ['all_relics.json', '部件表', 'npm run update:relic-parts'],
  ['relic_prices.json', '价格表', 'npm run update:relic-prices'],
  ['relic_rewards.json', '奖励库', 'npm run update:relic-rewards'],
  ['relic_zh.json', '中英对照', 'npm run update:zh'],
];
for (const [file, label, fix] of tables) {
  const p = path.join(DATA, file);
  const ok = exists(p);
  check(
    `data/${file}`,
    ok,
    ok ? `${(fs.statSync(p).size / 1024).toFixed(0)} KB` : '缺失',
    fix,
    '开核桃秒选会少一块数据（其余功能不受影响）'
  );
}

/* ---------- 可选：离线装备库 ---------- */

const itemsDir = path.join(TOOLS, 'warframe-mcp', 'node_modules', 'warframe-items');
const itemsOk = exists(itemsDir);
check(
  '离线装备库 warframe-items',
  itemsOk,
  itemsOk ? `${(dirSize(itemsDir) / 1024 / 1024).toFixed(0)} MB` : '未安装',
  'cd tools/warframe-mcp && npm install warframe-items',
  '属性/掉落/配卡/遗物奖励等大部分工具会失联，只剩市场价、世界状态、wiki 和开核桃秒选'
);

/* ---------- 可选：世界状态解析器 ---------- */

const wsDir = path.join(TOOLS, 'worldstate', 'node_modules');
const wsOk = exists(path.join(wsDir, 'warframe-worldstate-parser'));
check(
  '世界状态解析器',
  wsOk,
  wsOk ? '已安装' : '未安装',
  'cd tools/worldstate && npm install',
  'DE 官方源解析不了，会退回 tenno.tools 备用源（缺魔胎之境）'
);

/* ---------- 可选：AlecaFrame 库存 ---------- */

const invExe = path.join(TOOLS, 'warframe-inv.exe');
const invOk = exists(invExe);
check(
  '库存服务 warframe-inv.exe',
  invOk,
  invOk ? `${(fs.statSync(invExe).size / 1024 / 1024).toFixed(1)} MB` : '未放置',
  '自行构建后放到 tools/ 下（见 README「可选依赖」）',
  '问库存/白金/紫卡/配装会回「无法读取本地库存」'
);

let invCfgOk = false;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(TOOLS, 'config.json'), 'utf8'));
  // 兼容两种写法：顶层 userHash/publicToken，或嵌套在 alecaframe 下
  const af = cfg.alecaframe || cfg;
  invCfgOk = Boolean(af.userHash && af.publicToken);
} catch {
  /* 缺配置 */
}
check(
  'AlecaFrame 凭据',
  invCfgOk,
  invCfgOk ? 'userHash + publicToken 已填' : '未填或为空',
  '面板菜单 → API 凭据 → 填 userHash / publicToken',
  '即使有 exe 也读不到库存'
);

check(
  'AlecaFrame 本地缓存 lastData.dat',
  exists(path.join(process.env.LOCALAPPDATA || '', 'AlecaFrame', 'lastData.dat')),
  '来自 Overwolf + AlecaFrame 客户端',
  '打开 AlecaFrame 同步一次',
  '库存工具会返回「缓存未生成」'
);

/* ---------- 输出 ---------- */

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
let bad = 0;

console.log('');
console.log(' Warframe 本地助手 · 环境体检');
console.log(' ' + '─'.repeat(78));
for (const c of checks) {
  const mark = c.ok ? ' OK ' : ' 缺 ';
  if (!c.ok) bad += 1;
  console.log(`[${mark}] ${pad(c.name, 30)} ${c.detail}`);
  if (!c.ok) {
    console.log(`        ↳ 补救：${c.fix}`);
    console.log(`        ↳ 影响：${c.impact}`);
  }
}
console.log(' ' + '─'.repeat(78));
console.log(bad === 0 ? ' 全部就绪，可以直接双击 start-overlay.vbs。' : ` 有 ${bad} 项未就绪，按上面的「补救」逐条处理。`);
console.log('');
process.exit(0);
