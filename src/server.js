// server.js —— 悬浮窗的本地 Agent 中枢（HTTP 入口）
//
// 结构：
//   悬浮窗 ──HTTP──> server.js（Express 路由）
//                        ├── lib/mcp.js    MCP 客户端（stdio）──> wf-mcp-lite / warframe-inv
//                        └── lib/config.js 路径、模型、API Key
//
// 启动：node server.js（平时由 main.js 自动拉起，不用手动开）
//
// API Key 优先级：config.json（悬浮窗 ☰ → 设置） > 环境变量 DEEPSEEK_API_KEY > API_KEY_FALLBACK

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const { spawn } = require('node:child_process');

const {
  MCP_SERVERS,
  INV_CONFIG_PATH,
  inspectInvConfig,
  readInvCredentials,
  saveInvCredentials,
  MODEL,
  VISION_MODEL,
  VISION_BASE_URL,
  VISION_API_KEY,
  getApiKey,
  keyNotConfigured,
  maskKey,
  saveKey,
  getClient,
  getVisionClient,
} = require('./lib/config');

const {
  mcp,
  connectMcp,
  reconnectServer,
  toolsForMessage,
  callMcpTool,
} = require('./lib/mcp');
const { runAgent, clearHistory } = require('./lib/agent');
const { pickRelic } = require('./lib/relic');

// 本机 IPv6 到 Cloudflare 常常连不上，强制先走 IPv4（不加这条 market 十次八次超时）
dns.setDefaultResultOrder('ipv4first');

const app = express();
const PORT = 3000;
/* ============================================================
   ④ 系统提示词
   ============================================================ */

// 提示词与工具循环在 lib\agent.js 里（runAgent / clearHistory）



/* ============================================================
   ⑤ Express 路由
   ============================================================ */

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 25mb：要收 base64 截图（前端已经压过一轮，正常 200KB~2MB，留足余量）
app.use(express.json({ limit: '25mb' }));

function friendlyError(err) {
  const status = err && err.status;
  if (status === 401) return 'DeepSeek 说密钥无效（401）。检查 API Key 有没有复制完整、有没有多余空格。';
  if (status === 402) return 'DeepSeek 账户余额不足（402）。去 platform.deepseek.com 充值后再试。';
  if (status === 429) return '请求太频繁（429），等几秒再发一次。';
  if (status >= 500) return 'DeepSeek 服务端暂时出错（' + status + '），通常过一会儿就好。';
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return '连不上 api.deepseek.com，检查一下网络或代理。';
  }
  if (/fetch failed|network/i.test(String(err && err.message))) return '网络请求失败，检查网络或代理。';
  if (status === 400 && /image|vision|multimodal|content/i.test(String(err && err.message))) {
    return (
      '这个模型不接受图片（400）。\n\n' +
      '去 lib\config.js 顶部的「视觉模型配置」改 VISION_MODEL：\n' +
      '  · 继续用 DeepSeek → 保持 deepseek-flash\n' +
      '  · 换别家 → 同时改 VISION_BASE_URL / VISION_API_KEY\n' +
      '改完重启悬浮窗即可。'
    );
  }
  return (err && err.message) || String(err);
}

app.get('/', (_req, res) => {
  res.type('text/plain; charset=utf-8').send('overlay agent server is running. POST /api/chat');
});

// 排错用：浏览器打开 http://127.0.0.1:3000/api/mcp 就能看到 MCP 状态
app.get('/api/mcp', (_req, res) => {
  res.json({
    connected: mcp.connected,
    servers: MCP_SERVERS.map((s) => ({
      id: s.id,
      label: s.label,
      enabled: s.enabled,
      connected: mcp.clients.has(s.id),
      path: s.args[0] || s.command,
    })),
    toolCount: mcp.tools.size,
    tools: [...mcp.tools.entries()].map(([name, v]) => ({ name, server: v.serverId, original: v.originalName })),
    invConfig: inspectInvConfig(),
    lastError: mcp.lastError,
  });
});

// ---------- 设置：DeepSeek Key + AlecaFrame 凭据 ----------

app.get('/api/settings', (_req, res) => {
  const inv = readInvCredentials();
  res.json({
    configured: !keyNotConfigured(),
    masked: maskKey(getApiKey()),
    // 面板要能直接改，所以这里回明文；服务只监听 127.0.0.1
    apiKey: getApiKey(),
    userHash: inv.userHash,
    publicToken: inv.publicToken,
    invPath: inv.path,
    invError: inv.error || '',
  });
});

app.post('/api/settings', async (req, res) => {
  const body = req.body || {};
  const wantsKey = typeof body.apiKey === 'string';
  const wantsInv = typeof body.userHash === 'string' || typeof body.publicToken === 'string';
  if (!wantsKey && !wantsInv) {
    return res.status(400).json({ reply: '没有要保存的内容。' });
  }

  const result = { ok: true, keyUpdated: false, invUpdated: false, invReloaded: false, masked: maskKey(getApiKey()) };

  // 1) DeepSeek Key
  if (wantsKey) {
    const raw = body.apiKey.trim();
    if (!raw) return res.status(400).json({ reply: 'API Key 不能为空。' });
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(raw)) {
      return res.status(400).json({ reply: '这不像一个 DeepSeek API Key（应该以 sk- 开头，后面是很长一串字母数字）。' });
    }
    try {
      saveKey(raw);
      result.keyUpdated = true;
      result.masked = maskKey(getApiKey());
      console.log('[settings] API Key 已更新：', result.masked);
    } catch (err) {
      console.error('[settings] API Key 保存失败：', err.message);
      return res.status(500).json({ reply: 'API Key 保存失败：' + err.message });
    }
  }

  // 2) AlecaFrame 凭据 → tools/config.json
  if (wantsInv) {
    const userHash = typeof body.userHash === 'string' ? body.userHash.trim() : undefined;
    const publicToken = typeof body.publicToken === 'string' ? body.publicToken.trim() : undefined;
    if (userHash !== undefined && !userHash) {
      return res.status(400).json({ reply: 'UserHash 不能为空（在 AlecaFrame 的 Stats 页可以复制）。' });
    }
    if (publicToken !== undefined && !publicToken) {
      return res.status(400).json({ reply: 'PublicToken 不能为空（在 AlecaFrame 的 Stats 页可以复制）。' });
    }
    try {
      saveInvCredentials({ userHash, publicToken });
      result.invUpdated = true;
      console.log('[settings] AlecaFrame 凭据已写入', INV_CONFIG_PATH);
    } catch (err) {
      console.error('[settings] 凭据保存失败：', err.message);
      return res.status(500).json({ reply: '凭据保存失败：' + err.message });
    }

    // 3) 热重连 wf-inv，让新凭据立刻生效（连不上不算保存失败）
    try {
      const count = await reconnectServer('wf-inv');
      result.invReloaded = true;
      result.invTools = count;
      console.log(`[settings] wf-inv 已重连，${count} 个工具。`);
    } catch (err) {
      result.reloadError = err.message;
      console.warn('[settings] wf-inv 重连失败（需要重启程序才能生效）：', err.message);
    }
    result.invConfig = inspectInvConfig();
  }

  res.json(result);
});

/* ---------- 遗物速查数据（部件表 / 价格表，两张本地 JSON） ---------- */
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

const RELIC_ALL_PATH = path.join(DATA_DIR, 'all_relics.json');
const RELIC_PRICE_PATH = path.join(DATA_DIR, 'relic_prices.json');
const RELIC_ZH_PATH = path.join(DATA_DIR, 'relic_zh.json');

// 两张表各自一个任务槽：可以同时跑，但同一种不能重复启动
const relicJobs = { parts: null, prices: null };

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 用当前进程的 node（electron 的 node 模式）跑更新脚本 */
function spawnUpdate(kind, scriptName) {
  const script = path.join(SCRIPTS_DIR, scriptName);
  if (!fs.existsSync(script)) throw new Error('找不到 ' + scriptName);

  const env = { ...process.env };
  // process.execPath 是 Electron 二进制（开发时的 electron.exe，打包后的 OrdisOverlay.exe），
  // 必须带 ELECTRON_RUN_AS_NODE=1 才会当 node 跑，否则会按 GUI 程序启动并立刻退出。
  env.ELECTRON_RUN_AS_NODE = '1';

  const startedAt = Date.now();
  const child = spawn(process.execPath, [script], { cwd: SCRIPTS_DIR, env, windowsHide: true });
  relicJobs[kind] = child;

  console.log(`[relic] ${kind} 更新已启动`);
  child.stdout.on('data', (b) => console.log(`[relic:${kind}]`, String(b).trim()));
  child.stderr.on('data', (b) => console.warn(`[relic:${kind}]`, String(b).trim()));
  child.on('error', (err) => {
    console.error(`[relic] ${kind} 进程出错：`, err.message);
    relicJobs[kind] = null;
  });
  child.on('exit', (code) => {
    console.log(`[relic] ${kind} 更新结束，退出码 ${code}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    relicJobs[kind] = null;
  });
  return child;
}

app.get('/api/relic/status', (_req, res) => {
  const parts = readJsonSafe(RELIC_ALL_PATH);
  const prices = readJsonSafe(RELIC_PRICE_PATH);
  const zh = readJsonSafe(RELIC_ZH_PATH);

  const partCount = parts?.items?.length || 0;
  const priceCount = prices ? Object.keys(prices.prices || {}).length : 0;

  res.json({
    ok: true,
    runningParts: !!relicJobs.parts,
    runningPrices: !!relicJobs.prices,
    running: !!(relicJobs.parts || relicJobs.prices), // 兼容旧前端
    parts: parts ? { count: partCount, updatedAt: parts._meta?.updatedAt || null, withZh: parts._meta?.withZh ?? null } : null,
    prices: prices
      ? { count: priceCount, priced: prices._meta?.priced ?? priceCount, updatedAt: prices._meta?.updatedAt || null }
      : null,
    zhNames: zh ? Object.keys(zh.names || {}).length : null,
  });
});

app.post('/api/update-relics', (_req, res) => {
  if (relicJobs.parts) return res.status(409).json({ reply: '部件表正在更新，等它跑完。' });
  try {
    spawnUpdate('parts', 'update_relic_parts.js');
    res.json({ ok: true, started: 'parts' });
  } catch (err) {
    res.status(500).json({ reply: '启动更新失败：' + err.message });
  }
});

app.post('/api/update-prices', (_req, res) => {
  if (relicJobs.prices) return res.status(409).json({ reply: '价格表正在更新，等它跑完。' });
  try {
    spawnUpdate('prices', 'update_relic_prices.js');
    res.json({ ok: true, started: 'prices' });
  } catch (err) {
    res.status(500).json({ reply: '启动更新失败：' + err.message });
  }
});

// 兼容旧接口：先补部件表，跑完若价格表为空再自动补价格
app.post('/api/relic/update', (_req, res) => {
  if (relicJobs.parts || relicJobs.prices) return res.status(409).json({ reply: '已经在更新了，等它跑完。' });
  try {
    const child = spawnUpdate('parts', 'update_relic_parts.js');
    child.on('exit', (code) => {
      if (code !== 0) return;
      const prices = readJsonSafe(RELIC_PRICE_PATH);
      const empty = !prices || !Object.keys(prices.prices || {}).length;
      if (empty && !relicJobs.prices) spawnUpdate('prices', 'update_relic_prices.js');
    });
    res.json({ ok: true, started: true });
  } catch (err) {
    res.status(500).json({ reply: '启动更新失败：' + err.message });
  }
});


app.post('/api/history/clear', (_req, res) => {
  const before = clearHistory();
  console.log(`[chat] 上下文已清空（清掉 ${before} 条历史消息）`);
  res.json({ ok: true, cleared: before });
});

// ---------- 开核桃秒选 ----------
// 收一张遗物奖励截图：视觉模型只负责“认字”，之后全查本地价目表，毫秒级出结论。
app.post('/api/relic-pick', async (req, res) => {
  const image = typeof req.body?.image === 'string' ? req.body.image : '';
  if (!image) return res.status(400).json({ reply: '没收到截图。' });
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)) {
    return res.status(400).json({ reply: '图片格式不支持，只接受 png / jpg / webp / gif 的 data URL。' });
  }
  if (keyNotConfigured()) {
    return res.status(500).json({ reply: '还没配置 DeepSeek API Key，先去 ☰ → 设置填一个。' });
  }

  const started = Date.now();
  try {
    const out = await pickRelic(image);
    console.log(`[relic] ${Date.now() - started}ms 识别 ${out.items.length} 个，推荐 ${out.recommended || '无'}`);
    res.json(out);
  } catch (err) {
    console.error('[relic] 识别失败：', err.message);
    res.status(500).json({ reply: '识别失败：' + friendlyError(err) });
  }
});
/* ============================================================
   安全红线（代码层硬拦截）
   ------------------------------------------------------------
   命中这些词直接返回固定警报，不走模型、不调工具：
   模型偶尔会"自由发挥"，而 RMT 这类话题不允许有任何变体。
   保持与 System Prompt 里第 3 条红线完全一致的措辞。
   ============================================================ */
const RMT_RE = /淘宝|闲鱼|代充|代练|代肝|代打|代刷|共享账号|租号|卖号|买号|黑金|买白金|刷白金/g;
const RMT_ALERT =
  '[系统红色警报] 检测到非法的 RMT 交易请求！Operator，这会导致您的账号被 Lotus 永久抹杀！Ordis 拒绝执行该指令！\n\n' +
  '请通过官方渠道。';

app.post('/api/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const image = typeof req.body?.image === 'string' ? req.body.image : '';
  console.log('[chat] 收到：', JSON.stringify(message.slice(0, 200)), image ? `（附图 ${Math.round(image.length / 1024)}KB base64）` : '');

  if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)) {
    return res.status(400).json({ reply: '⚠️ 图片格式不支持，只接受 png / jpg / webp / gif 的 data URL。' });
  }
  if (!message && !image) return res.status(400).json({ reply: '⚠️ 你发了个空消息。' });

  const hits = message.match(RMT_RE);
  if (hits) {
    console.log('[chat] 命中安全红线，直接拒绝：', hits.join('/'));
    return res.json({ reply: RMT_ALERT });
  }

  if (keyNotConfigured()) {
    return res.status(500).json({
      reply: '⚠️ 还没配置 DeepSeek API Key。\n\n在悬浮窗里右上角 ☰ → 设置，粘贴你的 key 保存即可，不用重启。',
    });
  }

  const started = Date.now();
  const wantStream = req.body?.stream === true;

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ }
    };

    try {
      const reply = await runAgent(message, image, (delta) => send({ type: 'delta', text: delta }));
      console.log(`[chat] 完成（流式），总耗时 ${Date.now() - started}ms`);
      send({ type: 'done', reply: reply || '' });
    } catch (err) {
      console.error('[chat] 流式调用失败：', err && err.status, err && err.message);
      send({ type: 'error', message: friendlyError(err) });
    } finally {
      res.end();
    }
    return;
  }

  try {
    const reply = await runAgent(message, image);
    console.log(`[chat] 完成，总耗时 ${Date.now() - started}ms`);
    if (!reply) return res.status(502).json({ reply: '⚠️ 模型没有返回内容，再发一次试试。' });
    res.json({ reply });
  } catch (err) {
    console.error('[chat] 调用失败：', err && err.status, err && err.message);
    res.status(502).json({ reply: '⚠️ 调用失败：' + friendlyError(err) });
  }
});

/* ============================================================
   ⑥ 启动
   ============================================================ */

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log('==============================================');
    console.log('[overlay-server] 监听 http://127.0.0.1:' + PORT);
    console.log('[overlay-server] 模型：' + MODEL + '，Key：' + (keyNotConfigured() ? '未配置 ⚠️' : maskKey(getApiKey())));
    console.log('[overlay-server] 排错入口：http://127.0.0.1:3000/api/mcp');
    console.log('==============================================');
    if (keyNotConfigured()) {
      console.log('[overlay-server] ⚠️ 还没配置 API Key —— 悬浮窗右上角 ☰ → 设置里填。');
    }
  });

  // 服务先起来，MCP 慢慢连（连不上也不影响聊天）
  connectMcp().catch((err) => {
    console.error('[mcp] 初始化异常：', err.message);
  });

  // Ctrl+C 时顺手把 MCP 子进程收掉，不然它们会变成孤儿进程堆在后台
  const shutdown = async (sig) => {
    console.log('');
    console.log('[overlay-server] 收到 ' + sig + '，正在断开 MCP 子进程…');
    for (const server of MCP_SERVERS) {
      const mcpClient = mcp.clients.get(server.id);
      if (!mcpClient) continue;
      try {
        await mcpClient.close();
        console.log('[mcp:' + server.id + '] 已断开');
      } catch (err) {
        console.log('[mcp:' + server.id + '] 断开失败：' + err.message);
      }
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { app, runAgent, connectMcp, mcp, callMcpTool };
