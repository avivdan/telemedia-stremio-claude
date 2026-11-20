// Telemedia for Windows: a tray app around the same Node bootstrap the TV app
// runs (tv-app/node-bootstrap/main.js). That bootstrap does the Telegram setup
// (QR login, own API key), pairs the Stremio account and starts the addon on
// 127.0.0.1:7000. It runs in a utility process and reports through its
// control server; this file shows that state in a window and keeps it alive.

'use strict';

const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, nativeTheme, shell,
  utilityProcess,
} = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const QRCode = require('qrcode');

const HIDDEN = process.argv.includes('--hidden'); // started with Windows
const appData = app.getPath('appData');
// Shared with the command-line addon (addon/src/userConfig.ts), so one
// Telegram login serves both.
const CONFIG_PATH = path.join(appData, 'telemedia', 'config.json');
// Electron's own caches go one level down, out of the config folder. A run
// from source gets its own folder, so it can run next to the installed app
// (the single-instance lock goes by this folder).
app.setPath('userData', path.join(appData, 'telemedia', app.isPackaged ? 'app' : 'app-dev'));
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const LOG_PATH = path.join(app.getPath('userData'), 'logs', 'telemedia.log');
const NODE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'node')
  : path.join(__dirname, '..', 'node-staging', 'node');
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray.png');
const SETUP_PAGE = 'http://127.0.0.1:7002/'; // setup-server.js, this PC only
const STREMIO_DOWNLOAD = 'https://www.stremio.com/downloads';

let win = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------------------
// Small settings file (autostart choice, tray hint shown)
// ---------------------------------------------------------------------------
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
const settings = () => readJson(SETTINGS_PATH);
const saveSettings = (patch) => writeJson(SETTINGS_PATH, { ...settings(), ...patch });

// ---------------------------------------------------------------------------
// The Node part (utility process)
// ---------------------------------------------------------------------------
let child = null;
let controlPort = 0;
let restartNow = false;
let crashes = 0;

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// 7001 like the TV, else the next free one (7002 is the setup page).
async function chooseControlPort() {
  for (const port of [7001, 7003, 7004, 7005, 7006, 7007, 7008, 7009]) {
    if (await portIsFree(port)) return port;
  }
  throw new Error('no free local port for Telemedia');
}

function openLog() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  try {
    if (fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.old');
  } catch { /* no log yet */ }
  const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  log.write(`\n[app] ${new Date().toISOString()} Telemedia ${app.getVersion()} starting the addon\n`);
  return log;
}

// The end of the log file, for the log view in the window. Colour codes
// (gramjs) are stripped; the bootstrap never logs keys or sessions.
function logTail(maxBytes = 96 * 1024, maxLines = 400) {
  let text = '';
  try {
    const fd = fs.openSync(LOG_PATH, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the cut line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  return lines.slice(-maxLines).join('\n').trim();
}

function startNode() {
  const log = openLog();
  child = utilityProcess.fork(path.join(NODE_DIR, 'main.js'), [CONFIG_PATH], {
    cwd: NODE_DIR,
    stdio: 'pipe',
    serviceName: 'Telemedia addon',
    env: {
      ...process.env,
      TELEMEDIA_CONFIG_PATH: CONFIG_PATH,
      TELEMEDIA_CONTROL_PORT: String(controlPort),
      TELEMEDIA_SETUP_HOST: '127.0.0.1',
      // A PC has the memory for a bigger read-ahead than a TV box.
      STREAM_PREFETCH_KB: process.env.STREAM_PREFETCH_KB || '4096',
    },
  });
  child.stdout.on('data', (d) => log.write(d));
  child.stderr.on('data', (d) => log.write(d));
  child.on('exit', (code) => {
    log.end(`[app] addon process exited (${code})\n`);
    child = null;
    updateStatus({ state: 'offline' });
    if (quitting) return;
    // A restart asked for by the user (or by the bootstrap's own /exit) is
    // immediate; crashes back off up to 30 s.
    const delay = restartNow ? 0 : Math.min(30_000, 1000 * 2 ** crashes++);
    restartNow = false;
    setTimeout(() => { if (!quitting && !child) startNode(); }, delay);
  });
}

function restartNode() {
  if (child) {
    restartNow = true;
    child.kill();
  } else {
    startNode();
  }
}

function post(pathname, body = '', timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: controlPort, path: pathname, method: 'POST', timeout },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Status: polled from the control server, turned into what the window shows
// ---------------------------------------------------------------------------
let status = { state: 'offline' };
let view = {};
let stremioInstalled = false;
const qrCache = new Map();
let shownForSetup = false;

async function qrImage(text) {
  if (!text) return null;
  if (!qrCache.has(text)) {
    if (qrCache.size > 20) qrCache.clear();
    qrCache.set(text, await QRCode.toDataURL(text, {
      margin: 1, width: 440, errorCorrectionLevel: 'M',
      color: { dark: '#0E1621', light: '#FFFFFF' },
    }));
  }
  return qrCache.get(text);
}

function poll() {
  if (!controlPort) return;
  const req = http.get(
    { host: '127.0.0.1', port: controlPort, path: '/status', timeout: 1500 },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { updateStatus(JSON.parse(body)); } catch { /* half-written answer */ }
      });
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => updateStatus({ state: child ? 'starting' : 'offline' }));
}

const NEEDS_USER = new Set(['qr', 'need_password', 'need_config', 'error']);

async function updateStatus(next) {
  status = next;
  if (next.state === 'running') crashes = 0;
  const stremio = next.stremio || { state: 'idle' };
  const nextView = {
    ...next,
    stremio,
    telegramQr: next.state === 'qr' ? await qrImage(next.qrUrl) : null,
    stremioQr: stremio.state === 'waiting' ? await qrImage(stremio.link) : null,
    stremioInstalled,
    autostart: autostartEnabled(),
    canAutostart: app.isPackaged,
    version: app.getVersion(),
  };
  delete nextView.qrUrl; // the window gets the picture, not the login token
  const changed = JSON.stringify(nextView) !== JSON.stringify(view);
  view = nextView;
  if (changed && win) win.webContents.send('status', view);
  if (tray) tray.setToolTip(trayText(next));
  // Started with Windows: stay in the tray unless setup needs the user.
  if (NEEDS_USER.has(next.state) && !shownForSetup && win && !win.isVisible()) {
    shownForSetup = true;
    showWindow();
  }
}

function trayText(s) {
  if (s.state === 'running') return 'Telemedia is running';
  if (NEEDS_USER.has(s.state)) return 'Telemedia needs you: open it to finish';
  return 'Telemedia is starting';
}

// Stremio for Windows registers the stremio:// link type.
function checkStremio() {
  execFile('reg', ['query', 'HKCR\\stremio'], { windowsHide: true }, (err) => {
    const installed = !err;
    if (installed !== stremioInstalled) {
      stremioInstalled = installed;
      updateStatus(status);
    }
  });
}

// ---------------------------------------------------------------------------
// Start with Windows (installed app only; in development it would register
// electron.exe)
// ---------------------------------------------------------------------------
function autostartEnabled() {
  return app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}
function setAutostart(on) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  saveSettings({ autostartChosen: true });
}

// ---------------------------------------------------------------------------
// Window and tray
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: 'Telemedia',
    icon: ICON_PATH,
    backgroundColor: '#0E1621',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  // The window only shows our own page; links go through the main process.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // closing the window keeps the addon running
    win.hide();
    if (!settings().trayHintShown) {
      saveSettings({ trayHintShown: true });
      tray.displayBalloon({
        iconType: 'info',
        title: 'Telemedia keeps running',
        content: 'Stremio still gets Telemedia streams. Right-click the tray icon to quit.',
      });
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openStremio() {
  shell.openExternal(stremioInstalled ? 'stremio:///' : STREMIO_DOWNLOAD);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
  tray.setToolTip('Telemedia is starting');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Telemedia', click: showWindow },
    { label: 'Open Stremio', click: openStremio },
    { label: 'Restart addon', click: restartNode },
    { type: 'separator' },
    { label: 'Quit Telemedia', click: quit },
  ]));
}

function quit() {
  quitting = true;
  if (child) child.kill();
  app.quit();
}

// ---------------------------------------------------------------------------
// What the window can ask for
// ---------------------------------------------------------------------------
function clearTelegramAccount() {
  const cfg = readJson(CONFIG_PATH);
  delete cfg.session;
  delete cfg.apiId;
  delete cfg.apiHash;
  writeJson(CONFIG_PATH, cfg);
}

function registerIpc() {
  ipcMain.on('ready', (e) => e.sender.send('status', view));
  ipcMain.handle('password', (_e, pw) => post('/password', String(pw || '')));
  ipcMain.handle('restart', () => restartNode());
  ipcMain.handle('logout', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Log out', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Log out of Telegram',
      message: 'Log this PC out of Telegram?',
      detail: 'Stremio stops getting Telemedia streams until you scan a new Telegram code. ' +
        'You can then log in with any account.',
    });
    if (response !== 0) return false;
    // The bootstrap ends the session at Telegram and forgets the keys; if it
    // doesn't answer, forget them here.
    if (!(await post('/logout', '', 15_000))) clearTelegramAccount();
    restartNode();
    return true;
  });
  ipcMain.handle('connect-stremio', () => {
    const link = status.stremio && status.stremio.link;
    if (typeof link === 'string' && link.startsWith('https://link.stremio.com/')) shell.openExternal(link);
  });
  ipcMain.handle('open-stremio', () => openStremio());
  ipcMain.handle('copy-address', () => {
    if (status.manifestUrl) clipboard.writeText(status.manifestUrl);
    return !!status.manifestUrl;
  });
  ipcMain.handle('open-setup', () => shell.openExternal(SETUP_PAGE));
  ipcMain.handle('set-autostart', (_e, on) => { setAutostart(on); updateStatus(status); });
  ipcMain.handle('open-logs', () => shell.openPath(LOG_PATH));
  ipcMain.handle('get-log', () => logTail());
  ipcMain.handle('copy-log', () => clipboard.writeText(logTail(512 * 1024, 5000)));
}

// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    if (child) child.kill();
  });
  app.on('window-all-closed', () => { /* stay in the tray */ });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    app.setAppUserModelId('community.telemedia.pc');
    // Start with Windows by default, like the TV app starts with the TV.
    if (app.isPackaged && !settings().autostartChosen) setAutostart(true);
    registerIpc();
    createTray();
    createWindow();
    controlPort = await chooseControlPort();
    startNode();
    checkStremio();
    setInterval(poll, 1000);
    setInterval(() => { if (!stremioInstalled) checkStremio(); }, 30_000);
  }).catch((err) => {
    dialog.showErrorBox('Telemedia could not start', String(err && err.message ? err.message : err));
    app.exit(1);
  });
}
