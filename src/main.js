// main.js —— 主进程：窗口尺寸/位置、置顶、点击穿透、后端子进程、wiki 桥接
// 交互约定：收起态是一个可拖动、可缩放的透明图标；点它展开面板，鼠标离开面板 1 秒后自动收回。

const { app, BrowserWindow, ipcMain, screen, globalShortcut, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

// 程序根目录（src/ 的上一级）：日志、用户数据、后端脚本都放在这里
const ROOT = path.join(__dirname, '..');

// 排查日志：启动到哪一步都记一笔，窗口没出来时能看出卡在哪
const LOG = path.join(ROOT, 'debug.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  console.log(line.trim());
}
log('main.js loaded, electron', process.versions.electron, 'chrome', process.versions.chrome);

// ★ 这台机器的坑：Electron 默认把用户数据写到 %APPDATA%（在 O: 盘），
//   在那上面初始化会直接 0xc0000005 崩掉。显式改到程序目录下就正常了。
//   必须在 app ready 之前设置，所以放在文件最前面。
app.setPath('userData', path.join(ROOT, 'userdata'));

// 两种形态的窗口尺寸
const EXPANDED = { width: 384, height: 400 };  // 图标 + 左侧面板 + 两侧留白
const MIN_SIZE = { width: 300, height: 240 };  // 手动拉伸时允许的最小窗口
const MARGIN = 16;                             // 离屏幕边缘的距离
const LEAVE_MS = 1000;                         // 光标离开面板多久收回

// 收起态那个全息图标：用户可以拖右下角把手等比缩放
const BUBBLE = { min: 80, max: 150, def: 90 };
const BUBBLE_SIZE_FILE = path.join(app.getPath('userData'), 'bubble-size.json');

function loadBubbleSize() {
  try {
    const raw = JSON.parse(fs.readFileSync(BUBBLE_SIZE_FILE, 'utf8'));
    const n = Math.round(Number(raw.size));
    if (Number.isFinite(n)) return clamp(n, BUBBLE.min, BUBBLE.max);
  } catch { /* 第一次跑没有这个文件，用默认值 */ }
  return BUBBLE.def;
}

function saveBubbleSize() {
  try {
    fs.mkdirSync(path.dirname(BUBBLE_SIZE_FILE), { recursive: true });
    fs.writeFileSync(BUBBLE_SIZE_FILE, JSON.stringify({ size: bubbleSize }), 'utf8');
  } catch (e) {
    log('save bubble size failed', e.message);
  }
}

let bubbleSize = loadBubbleSize();

let win = null;
let expanded = false;
let leaveTimer = null;
let watchTimer = null;
let leaveWatchTimer = null;
let lastMoveAt = 0;

// 用户手动拉大过窗口后，记住这个尺寸：下次展开还用这个大小，不会被重置回 384x400
let expandedSize = { width: EXPANDED.width, height: EXPANDED.height };

// 气泡那一角的屏幕坐标（窗口右下角）。展开/收起都以它为锚点，
// 这样你把窗口拖到哪儿，展开就朝哪儿长、收起就缩回哪儿，不会跳回屏幕角落。
let anchor = null;

// 图标停在屏幕右半边（面板往左开）还是左半边（面板往右开）
let dockSide = 'right';

// 当前窗口是不是"鼠标穿透"状态。收起态平时穿透（不挡游戏点击），
// 但光标压在全息图标上时要临时关掉，缩放手柄才能被按住。
let ignoring = true;

// 遗物模式（页面 🎁 高亮）时为 true：面板常驻展开，鼠标移出也不收回。
// 开核桃时要一边看游戏一边看结论，自动收起会打断。
let relicLocked = false;

function setIgnore(next) {
  if (!win || ignoring === next) return;
  ignoring = next;
  win.setIgnoreMouseEvents(next, { forward: true });
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

/* ============================================================
   后端子进程：双击悬浮窗就把 server.js 一起拉起来，不用再开黑窗口
   ------------------------------------------------------------
   - 用 process.execPath（就是 electron.exe）+ ELECTRON_RUN_AS_NODE=1，
     等于拿 Electron 自带的 Node 跑 server.js，不用管系统里 node 在不在 PATH。
   - windowsHide: true 保证不弹黑窗口；stdout/stderr 重定向进 server.log。
   - 退出时用 taskkill /T 连它的 MCP 子进程（wf-mcp-lite、warframe-inv）一起收掉，
     否则会留下孤儿进程，下次启动端口还占着。
   ============================================================ */

const SERVER_JS = path.join(__dirname, 'server.js');
const SERVER_LOG = path.join(ROOT, 'server.log');
const SERVER_PORT = 3000;
let serverProc = null;

/** 端口被占用就说明后端已经在跑了（比如你手动开的），不重复启动 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(600);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function startBackend() {
  if (await isPortBusy(SERVER_PORT)) {
    log('backend already listening on', SERVER_PORT, '- skip spawn');
    return;
  }

  const out = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
  out.write(`\n===== backend started by overlay ${new Date().toISOString()} =====\n`);

  serverProc = spawn(process.execPath, [SERVER_JS], {
    cwd: ROOT,
    windowsHide: true,                 // ★ 不弹黑窗口
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // 让 electron.exe 当 node 用
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.pipe(out);
  serverProc.stderr.pipe(out);

  serverProc.on('error', (err) => log('backend spawn FAILED:', err.message));
  serverProc.on('exit', (code, signal) => {
    log('backend exited', 'code=' + code, 'signal=' + signal);
    serverProc = null;
  });

  log('backend spawned, pid', serverProc.pid);
}

function stopBackend() {
  if (!serverProc || serverProc.exitCode !== null) return;
  const pid = serverProc.pid;
  log('stopping backend pid', pid);
  try {
    // /T 连子孙进程一起杀：server.js 还会拉起 wf-mcp-lite 和 warframe-inv
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } catch (err) {
    log('taskkill failed:', err.message);
  }
  serverProc = null;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// 图标贴着屏幕哪一半：right = 面板往左开，left = 面板往右开
function sideFromBounds(b) {
  const area = screen.getDisplayMatching(b).workArea;
  return (b.x + b.width / 2) > (area.x + area.width / 2) ? 'right' : 'left';
}

// 由锚点算出某个尺寸下的窗口位置。
// 图标在右半边：右下角固定，窗口往左上长；
// 图标在左半边：左下角固定，窗口往右上长（面板从右边出来）。
// 这台机器是 125% 缩放：DIP 坐标乘 1.25 会出现半像素，Windows 每次移动都会
// 把窗口尺寸多取整 1px，拖几次图标就一点点变大。把位置对齐到「物理像素整数」
// 对应的 DIP 步长上，尺寸就不会漂了。
function snapStep() {
  const s = (screen.getPrimaryDisplay() || {}).scaleFactor || 1;
  const n = Math.round(s * 4);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  return Math.max(1, 4 / gcd(n, 4));
}

function snapPos(v) {
  const q = snapStep();
  return Math.round(v / q) * q;
}

function boundsAt(size) {
  const area = workArea();
  const y = clamp(anchor.bottom - size.height, area.y, area.y + area.height - size.height);
  const x = dockSide === 'left'
    ? clamp(anchor.left, area.x, area.x + area.width - size.width)
    : clamp(anchor.right - size.width, area.x, area.x + area.width - size.width);
  return { x, y, width: size.width, height: size.height };
}

// 以窗口当前的真实位置为准刷新锚点。
// 这样即使 'moved' 事件在某些情况下没来（比如被系统 / 别家工具搬动），
// 展开和收起也永远贴着气泡那一角，不会跳回屏幕角落。
function syncAnchorFromWindow() {
  if (!win) return;
  const b = win.getBounds();
  anchor = { left: b.x, right: b.x + b.width, bottom: b.y + b.height };
  if (!expanded) dockSide = sideFromBounds(b);
}

// 设置窗口大小并同步锚点（boundsAt 已经做过屏幕边界 clamp）
function setWinBounds(size) {
  const b = boundsAt(size);
  const snapped = { x: snapPos(b.x), y: snapPos(b.y), width: b.width, height: b.height };
  win.setBounds(snapped);
  anchor = { left: b.x, right: b.x + b.width, bottom: b.y + b.height };
  return b;
}

// 把「图标多大 / 停在哪半边」告诉页面。
// side=right → 图标在右半边，面板往左开、机头朝左；
// side=left  → 图标在左半边，面板往右开、机头朝右。
function sendBubbleConf() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('overlay:bubble-conf', { size: bubbleSize, side: dockSide });
}

// ★ 另一个坑：页面一旦被 Ctrl+滚轮 / Ctrl+加号缩放过，CSS 的 380px 就装不进
//   380px 的窗口，右侧输入框、发送按钮和右下角图标会整块被切掉。
//   这里把缩放锁死在 1.0，并在任何缩放事件后强制拉回。
function lockZoom(w) {
  w.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  w.webContents.setZoomFactor(1);
  w.webContents.on('zoom-changed', () => w.webContents.setZoomFactor(1));
  w.webContents.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (input.control && (k === '+' || k === '-' || k === '=' || k === '0')) {
      event.preventDefault();
    }
  });
}

function createWindow() {
  const area = workArea();
  anchor = {
    left: area.x + area.width - MARGIN - bubbleSize,
    right: area.x + area.width - MARGIN,
    bottom: area.y + area.height - MARGIN,
  };
  dockSide = 'right';       // 默认停在右下角，面板往左开

  win = new BrowserWindow({
    ...boundsAt({ width: bubbleSize, height: bubbleSize }),
    frame: false,            // 无边框
    transparent: true,       // 透明背景（配合 CSS 出圆形）
    backgroundColor: '#00000000',
    resizable: true,         // 允许手动拉大（面板右下角有把手，见 overlay:resize）
    // 注意：这里不要设 minWidth/minHeight —— Electron 会拿它去约束收起态的小窗口，
    // 导致收起后窗口还是 300x240。最小尺寸只在拉伸时自己 clamp。
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,       // 不在任务栏显示
    hasShadow: false,
    focusable: true,         // 展开后要能输入，必须可聚焦
    webPreferences: {
      // 为了保持"只有 4 个文件"，这里直接开放 node 给页面用（只加载本地页面，风险可控）
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // 第二参数 'screen-saver' 是较高的置顶层级，能压住大多数全屏/无边框游戏窗口
  win.setAlwaysOnTop(true, 'screen-saver');
  lockZoom(win);
  win.loadFile(path.join(__dirname, 'index.html'));

  // ★ 默认鼠标穿透：收起态不挡游戏点击。
  //   forward: true 让页面仍能收到鼠标移动事件；光标压在图标/把手上时，
  //   startCursorWatch 会临时关掉穿透，否则图标点不到、把手也拖不动。
  setIgnore(true);

  win.on('closed', () => {
    win = null;
    // 隐藏的 wiki 窗口也算"窗口"，会让 app 的 window-all-closed 不再触发，
    // 所以这里手动收掉它并显式退出，保证关掉悬浮窗就是真的关掉。
    if (wikiWin && !wikiWin.isDestroyed()) wikiWin.destroy();
    app.quit();
  });

  // 原生拖动（-webkit-app-region: drag）会把窗口搬走，这里把锚点同步到新的右下角，
  // 于是"拖到哪就在哪展开 / 收回"，不会被拉回屏幕角落。
  win.on('moved', () => {
    if (!win) return;
    const b = win.getBounds();
    anchor = { left: b.x, right: b.x + b.width, bottom: b.y + b.height };
    // 只有收起态才重新判定"停在哪半边"；展开态窗口是长方形，用它的中心会误判
    if (!expanded) dockSide = sideFromBounds(b);
    lastMoveAt = Date.now();
    sendBubbleConf();                        // 位置变了 → 面板开向和机头朝向都要重算
    log('moved', JSON.stringify(b));
  });

  // 原生拉边 / JS 把手两种方式都会触发 resize。展开状态下记住这个尺寸，
  // 收起再展开时沿用，不会每回都缩回 384x400。
  // 收起态被系统拉边时强制回正方形（图标只允许等比缩放）。
  win.on('resize', () => {
    if (!win) return;
    const b = win.getBounds();
    if (!expanded) {
      if (b.width !== b.height) {
        const side = clamp(Math.max(b.width, b.height), BUBBLE.min, BUBBLE.max);
        bubbleSize = side;
        setWinBounds({ width: side, height: side });
      }
      lastMoveAt = Date.now();
      return;
    }
    expandedSize = { width: b.width, height: b.height };
    anchor = { left: b.x, right: b.x + b.width, bottom: b.y + b.height };
    lastMoveAt = Date.now();
    sendBubbleConf();                      // 面板拉大后重算一次（尺寸没变，位置可能变了）
  });

  win.webContents.on('did-finish-load', () => {
    log('page loaded');
    win.webContents.setZoomFactor(1);   // 兜底：加载完成再校一次
    sendBubbleConf();                   // 初次加载就把图标尺寸和朝向告诉页面
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('page FAILED', code, desc, url));
  win.webContents.on('render-process-gone', (_e, details) => log('renderer gone', JSON.stringify(details)));
}

function doExpand() {
  if (!win || expanded) return;
  expanded = true;
  clearTimeout(leaveTimer); leaveTimer = null;
  syncAnchorFromWindow();                   // 你拖到哪，就从哪展开
  setIgnore(false);                         // 取消穿透，允许点击输入框
  const b = setWinBounds(expandedSize);     // 用记住的尺寸（默认 384x400），以气泡那角为锚点展开
  win.setAlwaysOnTop(true, 'screen-saver'); // 某些游戏切前台后会被压下去，再抬一次
  win.focus();                              // 让输入框能直接打字
  win.webContents.send('overlay:state', 'expanded');
  log('expanded', JSON.stringify(b));
}

function doCollapse() {
  if (!win || !expanded) return;
  expanded = false;
  win.webContents.send('overlay:state', 'collapsed');
  // 等 CSS 收回动画播完（约 240ms）再缩窗口，否则面板会被瞬间裁掉，看起来"跳"一下
  setTimeout(() => {
    if (expanded || !win) return;
    syncAnchorFromWindow();
    const b = setWinBounds({ width: bubbleSize, height: bubbleSize });
    setIgnore(true);                        // 先恢复穿透，光标若还压在图标上，下一轮轮询会再关掉
    sendBubbleConf();
    log('collapsed', JSON.stringify(b));
  }, 240);
}

function inRect(p, r) {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

// 收起态窗口是正方形，但图标四周有留白。命中判定往里收 10%，
// 免得鼠标还在透明留白里就把"能不能点"当成能点。
function iconZone(b) {
  const pad = b.width * 0.10;
  return { x: b.x + pad, y: b.y + pad, width: b.width - pad * 2, height: b.height - pad * 2 };
}

// 缩放手柄的命中区（对应 CSS 里 .bubble-grip 的位置）
// 贴右半边时把手在右下角，贴左半边时镜像到左下角
function gripZone(b) {
  const s = Math.max(18, b.width * 0.18);
  const x = dockSide === 'left' ? b.x : b.x + b.width - s;
  return { x, y: b.y + b.height - s, width: s, height: s };
}

// 轮询鼠标位置，只做两件事：
//   1) 收起态：光标是否压在图标/把手上 → 决定要不要关掉"点击穿透"；
//   2) 展开态：光标离开整个窗口超过 1 秒 → 自动收回面板。
// 为什么不用页面的 mouseenter：透明穿透窗口靠转发事件在部分机器/游戏窗口上不可靠，
// 主进程直接问系统要光标坐标最稳。
function startCursorWatch() {
  watchTimer = setInterval(() => {
    if (!win || expanded) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = inRect(p, iconZone(b));
    const onGrip = inRect(p, gripZone(b));
    setIgnore(!(inside || onGrip));
  }, 100);

  leaveWatchTimer = setInterval(() => {
    if (!win || !expanded) return;
    // 遗物模式常驻：不进"离开就收"的计时，面板一直开着
    if (relicLocked) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      return;
    }
    const p = screen.getCursorScreenPoint();
    if (inRect(p, win.getBounds())) {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      return;
    }
    const justMoved = Date.now() - lastMoveAt < 800;
    if (!leaveTimer && !justMoved) {
      leaveTimer = setTimeout(() => { leaveTimer = null; doCollapse(); }, LEAVE_MS);
    }
  }, 150);
}


// 页面也可以主动请求收回（比如按 Esc）
ipcMain.on('overlay:request', (_event, action) => {
  if (action === 'collapse') {
    // 常驻模式下 Esc 先只取消锁定，不直接收面板（避免误操作把结论关掉）
    if (relicLocked) {
      relicLocked = false;
      win?.webContents.send('overlay:relic-lock', false);
      return;
    }
    doCollapse();
  }
  if (action === 'expand') doExpand();
});

// 遗物模式开关：页面点 🎁 时发过来，开启后面板不再自动收起
ipcMain.on('overlay:relic-lock', (_event, locked) => {
  relicLocked = !!locked;
  log('relic lock', relicLocked);
  if (relicLocked) {
    if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  }
});

// 右键菜单里的「退出」：页面发消息过来，主进程真正关掉整个应用
ipcMain.on('overlay:quit', () => {
  log('quit requested from menu');
  app.quit();
});

// ============================================================
// 拖动收起态图标（页面用 mouse 事件驱动）
// ------------------------------------------------------------
// 图标设了 no-drag，点击/拖动都由页面判断后发 IPC 过来：
//   位移 ≤ 5px → 页面当成点击 → 请求展开；超过 5px → 发 move 搬窗口。
// 这里只负责按位移 clamp 到工作区，并且只调 setPosition（不改尺寸）。
// ============================================================
let dragStart = null;

ipcMain.on('overlay:drag', (_event, msg) => {
  if (!win || !msg) return;
  const phase = msg.phase;

  if (phase === 'start') {
    dragStart = { bounds: win.getBounds() };
    lastMoveAt = Date.now();
    return;
  }

  if (phase === 'move') {
    if (!dragStart) return;
    const area = workArea();
    const b = dragStart.bounds;
    // 尺寸用我们自己记的值：getBounds() 会把透明窗口那圈不可见边框算进去，
    // 直接用它会越拖越大（实测 90 → 92 → 95）。
    const w = expanded ? b.width : bubbleSize;
    const h = expanded ? b.height : bubbleSize;
    // clamp：拖到屏幕边上就停住，别把面板拖出去找不回来
    const x = clamp(b.x + (msg.dx || 0), area.x, area.x + area.width - w);
    const y = clamp(b.y + (msg.dy || 0), area.y, area.y + area.height - h);
    // 只挪位置、不动尺寸：setBounds 会带上透明窗口那圈边框的取整误差，
    // 每拖一次图标就胖一点点（实测 90 → 94 → 97）。setPosition 不会改尺寸。
    win.setPosition(snapPos(x), snapPos(y));
    anchor = { left: x, right: x + w, bottom: y + h };
    lastMoveAt = Date.now();
    return;
  }

  // end
  dragStart = null;
  syncAnchorFromWindow();
  lastMoveAt = Date.now();
  log('drag end', JSON.stringify({ x: anchor.left, bottom: anchor.bottom, size: anchor.right - anchor.left }));
});

// ============================================================
// 手动拉伸面板：拖右下角/左下角把手时由主进程改窗口大小
// ------------------------------------------------------------
// 为什么不让 CSS resize 或系统边框：透明无边框窗口在 Windows 上边框很难抓，
// 而 CSS resize 只能改 DOM、改不了 BrowserWindow，面板会被窗口裁掉。
// 这里按下时记下 bounds，移动时按位移算新宽高，clamp 到最小尺寸和工作区，
// 再把结果写回窗口；贴图标那一侧的边保持不动。
// ============================================================
let resizeStart = null;

ipcMain.on('overlay:resize', (_event, msg) => {
  if (!win || !msg) return;
  const phase = msg.phase;

  if (phase === 'start') {
    resizeStart = win.getBounds();
    lastMoveAt = Date.now();
    return;
  }

  if (phase === 'move') {
    if (!resizeStart) return;
    const area = workArea();
    const right = resizeStart.x + resizeStart.width;
    const bottom = resizeStart.y + resizeStart.height;

    // 尺寸：往图标的反方向拖变大。高度总是向上长（图标在下面，往下没空间）。
    const width = Math.round(clamp(resizeStart.width + (dockSide === 'left' ? (msg.dx || 0) : -(msg.dx || 0)), MIN_SIZE.width, area.width));
    const height = Math.round(clamp(resizeStart.height - (msg.dy || 0), MIN_SIZE.height, area.height));

    // 位置：图标那一侧的边固定不动。
    // dockSide=right → 面板在左，右边（贴图标）固定；dockSide=left → 左边固定。
    const x = dockSide === 'left'
      ? Math.max(area.x, resizeStart.x)
      : Math.max(area.x, right - width);
    const y = Math.max(area.y, bottom - height);
    win.setBounds({ x, y, width, height });
    expandedSize = { width, height };
    anchor = { left: x, right: x + width, bottom: y + height };
    lastMoveAt = Date.now();
    return;
  }

  // end
  resizeStart = null;
  syncAnchorFromWindow();
  const b = win.getBounds();
  expandedSize = { width: b.width, height: b.height };
  log('resized', JSON.stringify(b));
});

// ============================================================
// 收起态图标：拖右下角把手等比缩放（80 ~ 150）
// ------------------------------------------------------------
// 和面板拉伸一样由主进程改窗口大小；区别是这里锁定 1:1，且以右下角为锚点，
// 所以图标变大是往左上"长"，不会把右下角那个把手指到屏幕外面去。
// ============================================================
let bubbleResize = null;

ipcMain.on('overlay:bubble-resize', (_event, msg) => {
  if (!win || !msg || expanded) return;
  const phase = msg.phase;

  if (phase === 'start') {
    bubbleResize = { size: bubbleSize, x: msg.x, y: msg.y };
    lastMoveAt = Date.now();
    return;
  }

  if (phase === 'move') {
    if (!bubbleResize) return;
    // 图标贴在屏幕右下角，右下角没有空间可长，所以反过来：
    // 往"远离图标"的方向拖 = 变大。
    // 贴右半边：把手在右下，往左上 → dx、dy 都是负；贴左半边：把手在左下，往右上 → dx 正、dy 负。
    const dx = msg.x - bubbleResize.x;
    const dy = msg.y - bubbleResize.y;
    const d = (dockSide === 'left' ? dx - dy : -(dx + dy)) / 2;
    const size = clamp(Math.round(bubbleResize.size + d), BUBBLE.min, BUBBLE.max);
    if (size !== bubbleSize) {
      bubbleSize = size;
      syncAnchorFromWindow();                        // 锚点 = 窗口贴图标那侧 + 底边
      setWinBounds({ width: size, height: size });   // 让图标那侧的角保持不动
    }
    lastMoveAt = Date.now();
    return;
  }

  // end
  bubbleResize = null;
  saveBubbleSize();
  sendBubbleConf();                        // 新尺寸同步给页面（CSS 变量）
  log('bubble resized', bubbleSize);
});

/* ============================================================
   灰机中文 wiki 桥接（warframe.huijiwiki.com）

   为什么需要它：
     这个站挂了 Cloudflare 人机校验，普通 fetch / curl 一律 403，
     返回的是"请稍候…"那段挑战页，拿不到正文。

   做法：
     在本进程里开一个隐藏窗口（不显示、不进任务栏），让它正常过一次
     人机校验；之后所有 wiki 请求都"在这个窗口里"用同源 fetch 发出，
     自动带上校验后的 Cookie。最后通过 http://127.0.0.1:3001 暴露给
     MCP 数据服务（tools\wf-mcp-lite\server.mjs）使用。

   接口：
     GET /health                       → { ok, ready }
     GET /search?q=xxx&limit=5         → { ok, results:[{title,snippet,size}] }
     GET /page?title=xxx               → { ok, page:{title,text} }
   ============================================================ */
const WIKI_BRIDGE_PORT = 3001;
const WIKI_ORIGIN = 'https://warframe.huijiwiki.com';

let wikiWin = null;
let wikiReady = false;
let wikiWarmPromise = null;

const wikiLog = (...a) => log('[wiki]', ...a);

async function wikiTitle(w) {
  return w.webContents.executeJavaScript('document.title').catch(() => '');
}

// 等 Cloudflare 挑战自己过去（正常 3–8 秒，最多等 24 秒）
async function waitChallengePassed(w) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const t = await wikiTitle(w);
    if (t && !t.includes('请稍候')) return true;
  }
  return false;
}

async function ensureWikiWindow() {
  if (wikiReady && wikiWin && !wikiWin.isDestroyed()) return wikiWin;
  if (wikiWarmPromise) return wikiWarmPromise;

  wikiWarmPromise = (async () => {
    if (!wikiWin || wikiWin.isDestroyed()) {
      wikiWin = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        skipTaskbar: true,
        webPreferences: {
          session: session.fromPartition('persist:huiji'),
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      wikiWin.on('closed', () => { wikiWin = null; wikiReady = false; });
    }
    try {
      await wikiWin.loadURL(`${WIKI_ORIGIN}/wiki/Mainpage`, { timeout: 45000 });
      wikiReady = await waitChallengePassed(wikiWin);
      wikiLog('ready =', wikiReady, 'title =', await wikiTitle(wikiWin));
    } catch (e) {
      wikiReady = false;
      wikiLog('load failed:', e && e.message);
    }
    return wikiReady ? wikiWin : null;
  })().finally(() => { wikiWarmPromise = null; });

  return wikiWarmPromise;
}

// 在 wiki 页面里执行一段 async 代码（同源 fetch，自动带 Cookie）
async function wikiEval(body) {
  const w = await ensureWikiWindow();
  if (!w) throw new Error('wiki 人机校验未通过（页面仍停在 Cloudflare 挑战页）');
  return w.webContents.executeJavaScript(`(async () => { ${body} })()`, true);
}

function wikiSearchRemote(q, limit) {
  return wikiEval(`
    const r = await fetch('/api.php?action=query&list=search&srsearch=' + encodeURIComponent(${JSON.stringify(q)}) + '&srlimit=${Number(limit) || 5}&format=json');
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    return (j.query && j.query.search ? j.query.search : []).map((s) => ({
      title: s.title,
      snippet: String(s.snippet || '').replace(/<[^>]+>/g, ''),
      size: s.size,
      wordcount: s.wordcount,
    }));
  `);
}

function wikiPageRemote(title) {
  return wikiEval(`
    const r = await fetch('/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=' + encodeURIComponent(${JSON.stringify(title)}));
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    const pages = (j.query && j.query.pages) || {};
    const first = Object.values(pages)[0];
    if (!first) return { error: 'not found' };
    if (first.missing !== undefined) return { error: 'missing' };
    return { title: first.title, text: first.extract || '' };
  `);
}

// 取词条原始维基文本：部件表、杜卡德、英文名都在模板里，纯文本 extract 拿不到
function wikiRawRemote(title) {
  return wikiEval(`
    const r = await fetch('/api.php?action=parse&prop=wikitext&redirects=1&format=json&formatversion=2&page=' + encodeURIComponent(${JSON.stringify(title)}));
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    if (!j.parse) return { error: 'missing' };
    return { title: j.parse.title, text: j.parse.wikitext || '' };
  `);
}

// 一次取多个词条的原始文本（批量：MediaWiki 单次最多 50 个标题）
function wikiPagesRemote(titles) {
  return wikiEval(`
    const titles = ${JSON.stringify(titles)};
    const r = await fetch('/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1&format=json&formatversion=2&titles=' + encodeURIComponent(titles.join('|')));
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const j = await r.json();
    const pages = (j.query && j.query.pages) || [];
    return pages
      .filter((p) => !p.missing)
      .map((p) => ({
        title: p.title,
        text: (p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main && p.revisions[0].slots.main.content) || '',
      }));
  `);
}

function startWikiBridge() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };
    try {
      if (u.pathname === '/health') return send(200, { ok: true, ready: wikiReady });
      if (u.pathname === '/search') {
        const q = (u.searchParams.get('q') || '').trim();
        const limit = Math.min(10, Number(u.searchParams.get('limit')) || 5);
        if (!q) return send(400, { ok: false, error: 'missing q' });
        const results = await wikiSearchRemote(q, limit);
        if (results && results.error) return send(502, { ok: false, error: results.error });
        return send(200, { ok: true, results });
      }
      if (u.pathname === '/page') {
        const title = (u.searchParams.get('title') || '').trim();
        if (!title) return send(400, { ok: false, error: 'missing title' });
        const page = await wikiPageRemote(title);
        if (page && page.error) return send(502, { ok: false, error: page.error });
        return send(200, { ok: true, page });
      }
      if (u.pathname === '/raw') {
        const title = (u.searchParams.get('title') || '').trim();
        if (!title) return send(400, { ok: false, error: 'missing title' });
        const page = await wikiRawRemote(title);
        if (page && page.error) return send(502, { ok: false, error: page.error });
        return send(200, { ok: true, page });
      }
      if (u.pathname === '/pages') {
        const raw = (u.searchParams.get('titles') || '').trim();
        if (!raw) return send(400, { ok: false, error: 'missing titles' });
        const titles = raw.split('|').map((t) => t.trim()).filter(Boolean).slice(0, 50);
        const pages = await wikiPagesRemote(titles);
        if (pages && pages.error) return send(502, { ok: false, error: pages.error });
        return send(200, { ok: true, pages });
      }
      return send(404, { ok: false, error: 'not found' });
    } catch (e) {
      wikiLog('bridge error:', e && e.message);
      return send(502, { ok: false, error: String((e && e.message) || e) });
    }
  });
  server.on('error', (e) => wikiLog('bridge listen failed:', e.message));
  server.listen(WIKI_BRIDGE_PORT, '127.0.0.1', () => wikiLog('bridge listening on', WIKI_BRIDGE_PORT));
}

// ★ 单实例：重复双击 bat/vbs 时不再开第二个悬浮窗（只把已有的那个叫出来）
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  log('app ready');
  await startBackend();          // 先把后端拉起来（不等它就绪，先让窗口出来）
  createWindow();
  log('window created', JSON.stringify(win.getBounds()));
  startCursorWatch();

  app.on('child-process-gone', (_e, details) => log('child process gone', JSON.stringify(details)));

  // wiki 桥接：先开监听，再在后台预热（过 Cloudflare 校验要几秒，不挡窗口显示）
  startWikiBridge();
  setTimeout(() => {
    ensureWikiWindow()
      .then((w) => wikiLog('prewarm done', !!w))
      .catch((e) => wikiLog('prewarm failed', e && e.message));
  }, 4000);

  // 没有边框就没有关闭按钮，给你留一个全局快捷键退出：Ctrl+Shift+Q
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((e) => log('whenReady FAILED', e && e.stack));

app.on('window-all-closed', () => {
  log('all windows closed -> quit');
  app.quit();
});

app.on('before-quit', () => {
  clearInterval(watchTimer);
  clearInterval(leaveWatchTimer);
  if (leaveTimer) clearTimeout(leaveTimer);
  log('before-quit');
  stopBackend();                 // ★ 关悬浮窗时把后端（含 MCP 子进程）一起收掉
});

app.on('will-quit', () => {
  log('will-quit');
  globalShortcut.unregisterAll();
});

process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack));
process.on('exit', (code) => { log('process exit', code); stopBackend(); });

