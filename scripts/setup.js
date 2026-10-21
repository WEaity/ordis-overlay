#!/usr/bin/env node
// scripts/setup.js —— 一键安装「可选依赖」
//
// 用法：npm run setup
//
// 做三件事：
//   1. tools/warframe-mcp → npm install（离线装备库 warframe-items，约 80 MB）
//   2. tools/worldstate  → npm install（DE 世界状态解析器，约 32 MB）
//   3. 检查 tools/warframe-inv.exe 是否存在（二进制不随仓库发布，只能手动放）
// 最后自动跑一次 doctor，把结果汇总出来。任何一步失败都不中断，继续往下走。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const steps = [];

function log(msg) {
  console.log(msg);
}

/** 找到 npm 的调用方式：优先用当前 npm 进程的 cli.js，其次退回 npm.cmd */
function npmCommand() {
  const execpath = process.env.npm_execpath;
  if (execpath && fs.existsSync(execpath)) {
    return { cmd: process.execPath, baseArgs: [execpath], shell: false };
  }
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', baseArgs: [], shell: true };
}

function runNpm(cwd, args) {
  const { cmd, baseArgs, shell } = npmCommand();
  log(`\n$ npm ${args.join(' ')}    (${path.relative(ROOT, cwd) || '.'})`);
  const res = spawnSync(cmd, [...baseArgs, ...args], {
    cwd,
    stdio: 'inherit',
    shell,
    env: { ...process.env },
  });
  return res.status === 0;
}

function hasPackage(dir, name) {
  return fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'));
}

/* ---------------- 1. 离线装备库 ---------------- */

function setupOfflineData() {
  const dir = path.join(ROOT, 'tools', 'warframe-mcp');
  if (hasPackage(dir, 'warframe-items')) {
    log('[1/3] 离线装备库已存在，跳过');
    return true;
  }
  fs.mkdirSync(dir, { recursive: true });
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) {
    fs.writeFileSync(
      pkg,
      JSON.stringify(
        {
          name: 'wf-offline-data',
          version: '1.0.0',
          private: true,
          dependencies: { 'warframe-items': '^1.1269.87' },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }
  log('[1/3] 安装离线装备库（warframe-items，约 80 MB）');
  return runNpm(dir, ['install', '--no-audit', '--no-fund']);
}

/* ---------------- 2. 世界状态解析器 ---------------- */

function setupWorldState() {
  const dir = path.join(ROOT, 'tools', 'worldstate');
  if (hasPackage(dir, 'warframe-worldstate-parser')) {
    log('[2/3] 世界状态解析器已存在，跳过');
    return true;
  }
  fs.mkdirSync(dir, { recursive: true });
  log('[2/3] 安装世界状态解析器（约 32 MB）');
  return runNpm(dir, ['install', '--no-audit', '--no-fund']);
}

/* ---------------- 3. 库存服务二进制 ---------------- */

function checkInventoryExe() {
  const exe = path.join(ROOT, 'tools', 'warframe-inv.exe');
  if (fs.existsSync(exe)) {
    log('[3/3] 库存服务 warframe-inv.exe 已存在');
    return true;
  }
  log('[3/3] 未找到 tools/warframe-inv.exe');
  log('      这是 AlecaFrame 库存 MCP 的二进制，不随仓库发布。');
  log('      不影响其他功能：没有它，库存类提问会提示「无法读取本地库存」。');
  log('      需要的话按 README「可选依赖」一节自行构建后放到 tools/ 下。');
  return false;
}

/* ---------------- 汇总 ---------------- */

const results = {
  offline: setupOfflineData(),
  worldstate: setupWorldState(),
  inventory: checkInventoryExe(),
};

log('\n' + '─'.repeat(60));
log('安装结果：');
log(`  离线装备库      ${results.offline ? 'OK' : '失败（可重新执行 npm run setup）'}`);
log(`  世界状态解析器  ${results.worldstate ? 'OK' : '失败（可重新执行 npm run setup）'}`);
log(`  库存服务        ${results.inventory ? 'OK' : '未放置（可选）'}`);
log('─'.repeat(60));

log('\n下面跑一次体检，确认整体状态：');
const res = spawnSync(process.execPath, [path.join(__dirname, 'doctor.js')], {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(res.status === 0 ? 0 : 0);
