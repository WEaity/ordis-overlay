// lib/mcp.js —— MCP 客户端管理 + 工具裁剪
//
// 负责：拉起本地 MCP 子进程、把工具登记成 OpenAI 格式、按用户问题挑工具、执行工具。

const fs = require('node:fs');
const path = require('node:path');
const { MCP_SERVERS, sdkModule, inspectInvConfig, maskKey } = require('./config');

const mcp = {
  clients: new Map(), // serverId -> Client
  tools: new Map(), // 暴露给模型的工具名 -> { client, serverId, originalName, description, parameters }
  connected: false,
  lastError: '',
};

/** 把 MCP 的 inputSchema 收拾成 DeepSeek/OpenAI 能吃的 JSON Schema */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  delete clone.$id;
  if (!clone.type) clone.type = 'object';
  if (clone.type === 'object' && !clone.properties) clone.properties = {};

  // 递归去掉一些模型端可能不认的注解字段
  (function strip(node) {
    if (!node || typeof node !== 'object') return;
    delete node.$comment;
    delete node.examples;
    delete node.title;
    delete node.default;
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') strip(v);
    }
  })(clone);

  return clone;
}

/** 连接一个 MCP server，并把它提供的工具登记进来 */
async function connectOneServer(cfg) {
  const { Client } = await sdkModule('client/index.js');
  const { StdioClientTransport } = await sdkModule('client/stdio.js');

  const env = { ...process.env };
  // 子进程用 process.execPath 启动。如果 server.js 自己是被 electron.exe
  // 以 ELECTRON_RUN_AS_NODE=1 跑起来的（悬浮窗自动拉起的情况），process.execPath
  // 也是 electron.exe —— 这时必须把这个变量继续传下去，否则 electron.exe 会
  // 当 GUI 程序启动，MCP 立刻报 "Connection closed"。
  if (path.basename(process.execPath).toLowerCase().startsWith('electron')) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    cwd: cfg.cwd,
    env,
    stderr: 'pipe',
  });

  // MCP 子进程的 stderr 直接转出来，排错时能看到它自己打印的 ready/dataset loaded
  if (transport.stderr) {
    transport.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) console.log(`[mcp:${cfg.id}] ${line}`);
    });
  }

  const client = new Client({ name: 'overlay-agent', version: '1.0.0' }, { capabilities: {} });

  // 给连接加个超时，避免某个服务卡死时整个启动挂住
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => setTimeout(() => reject(new Error('连接超时（10 秒）')), 10_000)),
  ]);

  const { tools } = await client.listTools();
  mcp.clients.set(cfg.id, client);

  let added = 0;
  // 已知走不通的工具：全部依赖本机被墙 / 403 的上游，留着只会让模型拿到「失败」再重试一次。
  // 世界状态统一用 wf_market.world_state；遗物奖励与估值用 wf_market 的本地库 + market 现价。
  const BLOCKED = {
    'wf-inv': {
      get_worldstate: '改由 wf_market.world_state 提供',
      get_simaris_target: '依赖 warframestat.us（本机 403）',
      get_void_trader: '依赖 warframestat.us（本机超时），虚空商人见 world_state',
      get_relic_rewards: '依赖 raw.githubusercontent.com（本机被墙）',
      get_relic_value: '依赖 raw.githubusercontent.com（本机被墙）',
      get_farming_recommendation: '依赖 AlecaFrame 在线接口（本机 request failed）',
    },
  };
  for (const t of tools) {
    const why = BLOCKED[cfg.id]?.[t.name];
    if (why) {
      console.log(`[mcp:${cfg.id}] 跳过 ${t.name}（${why}）`);
      continue;
    }
    // 重名时加前缀，避免两个 server 的工具互相覆盖
    let name = t.name;
    if (mcp.tools.has(name)) name = `${cfg.id}__${t.name}`;
    mcp.tools.set(name, {
      client,
      serverId: cfg.id,
      originalName: t.name,
      description: t.description || '',
      parameters: cleanSchema(t.inputSchema),
    });
    added++;
  }

  console.log(`[mcp:${cfg.id}] ✅ 已连接「${cfg.label}」，拿到 ${added} 个工具：${tools.map((t) => t.name).join(', ')}`);
}

async function connectMcp() {
  console.log('[mcp] 开始连接本地 MCP 服务…');
  for (const cfg of MCP_SERVERS) {
    if (!cfg.enabled) {
      console.log(`[mcp:${cfg.id}] 已跳过（enabled=false）`);
      continue;
    }
    try {
      await connectOneServer(cfg);
    } catch (err) {
      mcp.lastError = err.message;
      console.error(`[mcp:${cfg.id}] ❌ 连接失败：${err.message}`);
      console.error(`[mcp:${cfg.id}]    检查路径是否存在：${cfg.args[0] || cfg.command}`);
    }
  }
  mcp.connected = mcp.clients.size > 0;
  if (mcp.connected) {
    console.log(`[mcp] 全部就绪，共 ${mcp.tools.size} 个工具可用。`);
    reportInventorySetup();
    warmUpTools();
  } else {
    console.warn('[mcp] ⚠️ 没有任何 MCP 服务连上，本次会话将退化成"纯聊天"（无工具）。');
  }
}

/* 单个 server 热重连：关掉旧子进程、清掉它的工具、按新配置重连。
   设置面板改完 AlecaFrame 凭据后调用，不用重启整个程序。 */
async function reconnectServer(serverId) {
  const cfg = MCP_SERVERS.find((c) => c.id === serverId);
  if (!cfg) throw new Error('未知的 MCP 服务：' + serverId);

  const old = mcp.clients.get(serverId);
  if (old) {
    try {
      await old.close();
    } catch (err) {
      console.warn(`[mcp:${serverId}] 关闭旧连接失败：${err.message}`);
    }
    mcp.clients.delete(serverId);
  }
  for (const [name, t] of [...mcp.tools]) {
    if (t.serverId === serverId) mcp.tools.delete(name);
  }

  await connectOneServer(cfg);
  mcp.connected = mcp.clients.size > 0;
  const count = [...mcp.tools.values()].filter((t) => t.serverId === serverId).length;
  console.log(`[mcp:${serverId}] 🔄 重连完成，现有 ${count} 个工具。`);
  return count;
}

/* 预热慢工具：wf-inv 第一次读 lastData.dat 要 1.5–20 秒（看杀软心情），
   在后台先跑一次，用户第一次问库存/配卡就不用干等。 */
async function warmUpTools() {
  setTimeout(async () => {
    for (const name of ['get_owned_inventory', 'get_alecaframe_inventory']) {
      if (!mcp.tools.has(name)) continue;
      const t0 = Date.now();
      try {
        await callMcpTool(name, {});
        console.log(`[warm] ${name} 预热完成（${Date.now() - t0}ms）`);
      } catch (err) {
        console.log(`[warm] ${name} 预热失败：${err.message}`);
      }
    }
  }, 800);
}

/** 单独把库存相关的状态打出来：凭据有没有填、哪些库存工具挂上了 */
function reportInventorySetup() {
  if (!mcp.clients.has('wf-inv')) {
    console.log('[mcp:wf-inv] ❌ 没有连上，库存类工具全部不可用。');
    return;
  }

  const cfg = inspectInvConfig();
  console.log('[mcp:wf-inv] 配置文件：' + cfg.path);
  if (cfg.ok) {
    console.log(`[mcp:wf-inv] 凭据：userHash=${cfg.userHash}，publicToken=${cfg.publicToken} ✅`);
  } else {
    console.log('[mcp:wf-inv] ⚠️ 凭据没准备好：' + cfg.error);
    console.log('[mcp:wf-inv]    去上面这个配置文件里填 "alecaframe.userHash" 和 "alecaframe.publicToken"。');
    console.log('[mcp:wf-inv]    没填之前，get_alecaframe_inventory / get_farming_recommendation 会报错；');
    console.log('[mcp:wf-inv]    但读本地缓存的 get_owned_inventory 不受影响，照样能用。');
  }

  const dataFile = path.join(process.env.LOCALAPPDATA || '', 'AlecaFrame', 'lastData.dat');
  if (fs.existsSync(dataFile)) {
    const stat = fs.statSync(dataFile);
    const kb = (stat.size / 1024).toFixed(0);
    console.log(`[mcp:wf-inv] 本地库存缓存：${dataFile}（${kb} KB，更新于 ${stat.mtime.toLocaleString()}）✅`);
  } else {
    console.log('[mcp:wf-inv] ⚠️ 找不到本地库存缓存：' + dataFile);
    console.log('[mcp:wf-inv]    先把 AlecaFrame 打开、进游戏待一会儿，让它写出 lastData.dat。');
  }

  const invTools = [...mcp.tools.entries()]
    .filter(([, info]) => info.serverId === 'wf-inv')
    .map(([name]) => name);
  console.log(`[mcp:wf-inv] 库存工具 ${invTools.length} 个：${invTools.join(', ')}`);
}

/** 转成 DeepSeek / OpenAI 的 tools 格式 */
function toOpenAITools() {
  return [...mcp.tools.entries()].map(([name, info]) => ({
    type: 'function',
    function: {
      name,
      description: (info.description || name).slice(0, 900),
      parameters: info.parameters,
    },
  }));
}

/* ------------------------------------------------------------------
   工具按意图裁剪
   32 个工具的完整描述每轮要发 20 KB 左右，光是首字延迟就得多几百毫秒。
   这里按关键词把工具分成几组，只发和本轮相关的；
   规则匹配不上（或匹配到的太少）时退回全部，宁慢勿错。
   ------------------------------------------------------------------ */
const TOOL_ROUTES = [
  {
    // 「今天做什么/推荐/该练什么」这类必须落到真实库存 + 实时状态上
    test: /今天|今日|today|\/today|推荐|该做|做什么|练什么|该练|水经验|升段|下一步|接下来|规划|目标|计划|安排|路线|优先级/i,
    tools: ['get_alecaframe_inventory', 'get_owned_inventory', 'world_state', 'get_mastery_fodder', 'get_frame_build', 'check_market', 'search_drops'],
  },
  {
    test: /价格|多少钱|几p|白金|收购|出售|买卖|market|最低价|值不值/i,
    tools: ['check_market', 'search_market_item', 'get_item', 'search_items', 'get_alecaframe_inventory'],
  },
  {
    test: /刷|掉率|掉落|遗物|在哪儿|在哪出|哪里出|farm|relic|核桃|出什么|出啥|内容物/i,
    tools: ['search_drops', 'relic_drops', 'farm_guide', 'get_item'],
  },
  {
    test: /属性|伤害|面板|暴击|触发|配卡|配装|mod|武器|战甲|极性|紫卡|build|dps/i,
    tools: ['get_alecaframe_inventory', 'get_warframe', 'get_weapon', 'get_mod', 'get_item', 'recommend_build', 'compare_weapons', 'get_frame_build'],
  },
  {
    test: /世界状态|世界|裂缝|突击|商人|baro|昼夜|白天|晚上|夜灵|eidolon|入侵|警报|平原|希图斯|福尔图娜|魔胎|金星|火卫二|cetus|fortuna|cambion|zariman|扎里曼/i,
    tools: ['world_state', 'daily_picks'],
  },
  {
    // 只有明确要「分析我这套/我现在的配卡」才给 analyze_build（它要读库存，单次 20 秒）
    test: /分析.*(配卡|build)|我这套|我现在的?(配卡|build)|这套.*怎么样/i,
    tools: ['analyze_build', 'get_frame_build', 'get_owned_inventory'],
  },
  {
    test: /库存|我有|我的|精通|段位|集团|声望|riven|紫卡|遗物.*(有|多少)/i,
    tools: ['get_alecaframe_inventory', 'get_owned_inventory', 'get_mastery_fodder', 'get_focus_progress', 'get_syndicate_standings', 'get_riven_mods', 'get_riven_auctions'],
  },
  {
    test: /wiki|背景|剧情|被动|怎么玩|攻略|新手|入门/i,
    tools: ['search_wiki', 'beginner_guide', 'get_warframe', 'get_weapon', 'recommend_build'],
  },
  {
    test: /制作|材料|锻造|合成|能做|craft/i,
    tools: ['can_craft', 'get_item', 'search_drops'],
  },
];

const ALWAYS_TOOLS = ['get_item', 'search_items'];

function toolsForMessage(message) {
  const all = toOpenAITools();
  const text = String(message || '');
  const picked = new Set(ALWAYS_TOOLS);

  for (const route of TOOL_ROUTES) {
    if (route.test.test(text)) route.tools.forEach((t) => picked.add(t));
  }

  // 命中太少说明这句话没表达清楚意图，别赌，发全量
  if (picked.size < 4) return { tools: all, note: '全量（意图不明）' };

  const subset = all.filter((t) => picked.has(t.function.name));
  if (subset.length < 4) return { tools: all, note: '全量（子集太小）' };
  return { tools: subset, note: subset.map((t) => t.function.name).join(',') };
}

/** 库存类工具很慢（3–20 秒），短时间内的重复查询直接复用结果 */
const TOOL_CACHE_TTL = new Map([
  ['get_alecaframe_inventory', 45_000],
  ['get_owned_inventory', 45_000],
  ['get_mastery_fodder', 300_000],
  ['get_frame_build', 30_000],
]);
const toolCache = new Map();

/** 执行一个 MCP 工具，返回给模型的文本 */
async function callMcpTool(name, args) {
  const info = mcp.tools.get(name);
  if (!info) throw new Error('未知工具：' + name);

  const ttl = TOOL_CACHE_TTL.get(name) || 0;
  const cacheKey = name + '|' + JSON.stringify(args || {});
  if (ttl) {
    const hit = toolCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl) {
      return { ...hit.value, ms: 0, cached: true };
    }
  }

  const started = Date.now();
  const res = await info.client.callTool(
    { name: info.originalName, arguments: args || {} },
    undefined,
    { timeout: 90_000 }
  );

  const text = (res.content || [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();

  const body = res.isError ? '工具返回错误：\n' + text : text || '(工具没有返回文本内容)';
  const result = {
    text: body.length > 12_000 ? body.slice(0, 12_000) + '\n…（内容过长已截断）' : body,
    ms: Date.now() - started,
    isError: !!res.isError,
    cached: false,
  };

  // 只缓存成功结果，报错不缓存（下次还要重试）
  if (ttl && !result.isError) toolCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

module.exports = {
  mcp,
  cleanSchema,
  connectOneServer,
  connectMcp,
  reconnectServer,
  warmUpTools,
  reportInventorySetup,
  toOpenAITools,
  TOOL_ROUTES,
  ALWAYS_TOOLS,
  toolsForMessage,
  callMcpTool,
};
