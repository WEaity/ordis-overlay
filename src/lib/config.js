// lib/config.js —— 路径、模型与 API Key 管理
//
// 这里集中放“配置类”的东西：本地 MCP 服务怎么拉起、DeepSeek 用哪个地址/模型、
// API Key 从哪读、OpenAI 客户端怎么复用。改配置只动这一个文件。

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const OpenAI = require('openai');

/* ---------------- 本地 MCP 服务 ---------------- */

// ★ 工具全部随项目放在仓库根目录的 tools\ 下，不依赖本机其他目录
//   src/lib/ → 上两级才是仓库根
const ROOT = path.join(__dirname, '..', '..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const MCP_SERVER_PATH = path.join(TOOLS_DIR, 'wf-mcp-lite', 'server.mjs');

// AlecaFrame 库存服务（另一个 MCP，可执行文件）。库存数据依赖 AlecaFrame 的
// lastData.dat 缓存；缓存没生成时调用会返回明确错误，模型会按提示说“库存不可读”。
const MCP_INV_EXE = path.join(TOOLS_DIR, 'warframe-inv.exe');

const MCP_SERVERS = [
  {
    id: 'wf-market',
    label: 'warframe 数据服务',
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    cwd: path.dirname(MCP_SERVER_PATH),
    enabled: true,
  },
  {
    id: 'wf-inv',
    label: 'AlecaFrame 库存服务',
    command: MCP_INV_EXE,
    args: [],
    cwd: path.dirname(MCP_INV_EXE),
    enabled: true,
  },
];

// MCP SDK 是 ESM 包，server.js 是 CommonJS，所以用动态 import
const SDK_DIR = path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
const sdkModule = (rel) => import(pathToFileURL(path.join(SDK_DIR, rel)).href);

/* ---------------- AlecaFrame 凭据检查 ---------------- */

// warframe-inv.exe 只按固定顺序找 config.json：可执行文件同目录 → ~/.config/warframe-mcp/
// → 系统级配置目录，没有命令行参数也没有环境变量可改。
const INV_CONFIG_PATH = path.join(path.dirname(MCP_INV_EXE), 'config.json');

function inspectInvConfig() {
  const result = { ok: false, path: INV_CONFIG_PATH, userHash: '', publicToken: '', error: '' };
  try {
    if (!fs.existsSync(INV_CONFIG_PATH)) {
      result.error = 'config.json 不存在';
      return result;
    }
    const cfg = JSON.parse(fs.readFileSync(INV_CONFIG_PATH, 'utf8'));
    const userHash = String(cfg?.alecaframe?.userHash ?? '').trim();
    const publicToken = String(cfg?.alecaframe?.publicToken ?? '').trim();

    // 占位符识别：还没填的时候提前喊一声，比等工具报 500 好懂
    const looksPlaceholder = (v) => !v || /换成|粘贴|PASTE|YOUR_|xxx/i.test(v);

    result.userHash = userHash ? maskKey(userHash) : '';
    result.publicToken = publicToken ? maskKey(publicToken) : '';

    const problems = [];
    if (looksPlaceholder(userHash)) problems.push('userHash 没填');
    if (looksPlaceholder(publicToken)) problems.push('publicToken 没填');
    result.ok = problems.length === 0;
    result.error = problems.join('，');
    return result;
  } catch (err) {
    result.error = '解析失败：' + err.message;
    return result;
  }
}

/** 读明文凭据（只给设置面板用，不要写日志） */
function readInvCredentials() {
  const out = { userHash: '', publicToken: '', path: INV_CONFIG_PATH, error: '' };
  try {
    if (!fs.existsSync(INV_CONFIG_PATH)) return out;
    const cfg = JSON.parse(fs.readFileSync(INV_CONFIG_PATH, 'utf8'));
    out.userHash = String(cfg?.alecaframe?.userHash ?? '').trim();
    out.publicToken = String(cfg?.alecaframe?.publicToken ?? '').trim();
  } catch (err) {
    out.error = '读取 tools/config.json 失败：' + err.message;
  }
  return out;
}

/**
 * 写回 AlecaFrame 凭据。
 * 保留文件里原有的其它字段（cache.*、alecaframe 里将来可能多出来的键）。
 */
function saveInvCredentials({ userHash, publicToken }) {
  let cfg = {};
  try {
    if (fs.existsSync(INV_CONFIG_PATH)) {
      cfg = JSON.parse(fs.readFileSync(INV_CONFIG_PATH, 'utf8')) || {};
    }
  } catch (err) {
    // 文件坏了就当成空的，下面会写一份新的
    console.warn('[settings] tools/config.json 解析失败，将重写：', err.message);
    cfg = {};
  }

  cfg.alecaframe = { ...(cfg.alecaframe || {}) };
  if (typeof userHash === 'string') cfg.alecaframe.userHash = userHash.trim();
  if (typeof publicToken === 'string') cfg.alecaframe.publicToken = publicToken.trim();
  cfg.cache = { ...(cfg.cache || {}) };
  if (typeof cfg.cache.worldStateTTL !== 'number') cfg.cache.worldStateTTL = 300;
  if (typeof cfg.cache.marketDataTTL !== 'number') cfg.cache.marketDataTTL = 600;

  fs.mkdirSync(path.dirname(INV_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(INV_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

/* ---------------- DeepSeek ---------------- */

const API_KEY_FALLBACK = '';
const BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';

// ★★★ 视觉（看图）模型配置 ★★★
// 纯文字问答走上面的 MODEL；只要这轮带了图片，就换成 VISION_MODEL。
// DeepSeek 这边实测 deepseek-flash 能吃 image_url；deepseek-chat 不一定行。
// 换别家（OpenAI / 通义千问 / 智谱…）时把下面三行一起改。
const VISION_MODEL = process.env.VISION_MODEL || 'deepseek-flash';
const VISION_BASE_URL = process.env.VISION_BASE_URL || BASE_URL;
const VISION_API_KEY = process.env.VISION_API_KEY || '';

const CONFIG_PATH = path.join(ROOT, 'config.json');

let apiKey = '';

(function loadKey() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg && typeof cfg.apiKey === 'string') apiKey = cfg.apiKey.trim();
    }
  } catch (err) {
    console.warn('[settings] 读取 config.json 失败：', err.message);
  }
  if (!apiKey && process.env.DEEPSEEK_API_KEY) apiKey = process.env.DEEPSEEK_API_KEY.trim();
  if (!apiKey && API_KEY_FALLBACK) apiKey = API_KEY_FALLBACK.trim();
})();

const getApiKey = () => apiKey;
const keyNotConfigured = () => !apiKey || apiKey.length < 20;

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return '****';
  return k.slice(0, 5) + '…' + k.slice(-4);
}

let client = null;
let clientKey = '';
function getClient() {
  if (!client || clientKey !== apiKey) {
    client = new OpenAI({ apiKey, baseURL: BASE_URL, timeout: 90_000, maxRetries: 1 });
    clientKey = apiKey;
  }
  return client;
}

/* 看图专用客户端：只有 VISION_BASE_URL / VISION_API_KEY 跟默认不同时才另建一个 */
let visionClient = null;
let visionKey = '';
function getVisionClient() {
  const url = VISION_BASE_URL || BASE_URL;
  const key = VISION_API_KEY || apiKey;
  if (url === BASE_URL && !VISION_API_KEY) return getClient();
  if (!visionClient || visionKey !== url + '|' + key) {
    visionClient = new OpenAI({ apiKey: key, baseURL: url, timeout: 120_000, maxRetries: 1 });
    visionKey = url + '|' + key;
  }
  return visionClient;
}

function saveKey(nextKey) {
  apiKey = nextKey.trim();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiKey }, null, 2), 'utf8');
  client = null;
  clientKey = '';
}

module.exports = {
  TOOLS_DIR,
  MCP_SERVER_PATH,
  MCP_INV_EXE,
  MCP_SERVERS,
  SDK_DIR,
  sdkModule,
  INV_CONFIG_PATH,
  inspectInvConfig,
  readInvCredentials,
  saveInvCredentials,
  BASE_URL,
  MODEL,
  VISION_MODEL,
  VISION_BASE_URL,
  VISION_API_KEY,
  CONFIG_PATH,
  getApiKey,
  keyNotConfigured,
  maskKey,
  saveKey,
  getClient,
  getVisionClient,
};
