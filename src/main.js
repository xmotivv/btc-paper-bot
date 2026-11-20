'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { Engine } = require('./core/engine');
const { Store } = require('./core/store');

log.transports.file.level = 'info';
autoUpdater.logger = log;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let engine = null;
let store = null;
let blockerId = null;
let updateState = { status: 'idle', message: '' };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0b0f14',
    title: `BTC Paper Bot ${app.getVersion()}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function setKeepAwake(on) {
  if (on && blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && blockerId != null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

// ------------------------------------------------------------------ updates
function setUpdate(status, message = '', extra = {}) {
  updateState = { status, message, ...extra };
  send('update-status', updateState);
}

function initUpdater() {
  if (!app.isPackaged) {
    setUpdate('dev', 'Auto-update is off in development mode');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate('checking', 'Checking for updates…'));
  autoUpdater.on('update-available', (i) => setUpdate('downloading', `Downloading v${i.version}…`, { version: i.version }));
  autoUpdater.on('update-not-available', () => setUpdate('current', 'Up to date'));
  autoUpdater.on('download-progress', (p) => setUpdate('downloading', `Downloading update… ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', (i) => setUpdate('ready', `v${i.version} ready — restart to install`, { version: i.version, notes: i.releaseNotes || '' }));
  autoUpdater.on('error', (e) => setUpdate('error', `Update error: ${e.message}`));
  const check = () => autoUpdater.checkForUpdates().catch((e) => setUpdate('error', e.message));
  setTimeout(check, 5000);
  setInterval(check, 30 * 60 * 1000);
}

// --------------------------------------------------------- live credentials
// The Polymarket US API key is kept encrypted with the operating system's own
// credential protection (Windows DPAPI), in a file separate from the bot's
// data folder. It is never written in plain text, never logged, and never sent
// to the window after it has been entered.
const credsFile = () => path.join(app.getPath('userData'), 'polymarket-us-key.bin');

function saveCredentials(creds) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(credsFile(), safeStorage.encryptString(JSON.stringify(creds)));
  return true;
}

function loadCredentials() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(credsFile())));
  } catch {
    return null;
  }
}

function forgetCredentials() {
  try { fs.unlinkSync(credsFile()); } catch { /* nothing saved */ }
}

// ---------------------------------------------------------------------- IPC
function initIpc() {
  ipcMain.handle('state', () => ({ ...engine.view(), version: app.getVersion(), update: updateState, keepAwake: blockerId != null }));
  ipcMain.handle('start', () => { engine.start(); setKeepAwake(!!engine.settings.keepAwake); return true; });
  ipcMain.handle('stop', () => { engine.stop(); setKeepAwake(false); return true; });
  ipcMain.handle('set-strategy-enabled', (_e, id, on) => engine.setStrategyEnabled(String(id), !!on));
  ipcMain.handle('set-strategy-params', (_e, id, params) => engine.setStrategyParams(String(id), params));
  ipcMain.handle('close-position', (_e, id) => (engine.isLivePosition(String(id)) ? engine.closeLivePosition(String(id)) : engine.closePosition(String(id))));
  ipcMain.handle('close-all-positions', async () => {
    const paper = engine.closeAllPositions();
    const live = await engine.closeAllLivePositions();
    return { closed: paper.closed + live.closed, failed: paper.failed + live.failed };
  });
  ipcMain.handle('live-connect', async (_e, keyId, secretKey) => {
    const creds = { keyId: String(keyId || '').trim(), secretKey: String(secretKey || '').trim() };
    const r = await engine.connectLive(creds);
    if (r.ok) r.remembered = saveCredentials(creds);
    return r;
  });
  ipcMain.handle('live-disconnect', () => { forgetCredentials(); return engine.disconnectLive(); });
  ipcMain.handle('live-arm', () => engine.armLive());
  ipcMain.handle('live-disarm', () => engine.disarmLive());
  ipcMain.handle('live-kill', () => engine.killLive());
  ipcMain.handle('live-limits', (_e, patch) => engine.setLiveLimits(patch || {}));
  ipcMain.handle('set-strategy-live', (_e, id, on) => engine.setStrategyLive(String(id), !!on));
  ipcMain.handle('update-settings', (_e, patch) => {
    if (patch && 'keepAwake' in patch) {
      engine.settings.keepAwake = !!patch.keepAwake;
      setKeepAwake(engine.running && engine.settings.keepAwake);
    }
    if (patch && 'autoStart' in patch) engine.settings.autoStart = !!patch.autoStart;
    engine.updateSettings(patch);
    return true;
  });
  ipcMain.handle('reset', (_e, cash) => { engine.reset(cash); return true; });
  ipcMain.handle('export-csv', async () => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `paper-trades-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, engine.tradesCsv());
    return r.filePath;
  });
  ipcMain.handle('open-data-folder', () => shell.openPath(store.dir));
  ipcMain.handle('open-url', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('check-update', () => {
    if (!app.isPackaged) return setUpdate('dev', 'Auto-update is off in development mode');
    return autoUpdater.checkForUpdates().catch((e) => setUpdate('error', e.message));
  });
  ipcMain.handle('install-update', () => {
    engine.stop();
    store.close();
    autoUpdater.quitAndInstall();
  });
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'bot-data'));
  engine = new Engine({ store });
  engine.settings.autoStart ??= true;
  engine.settings.keepAwake ??= false;
  engine.on('update', (view) => send('engine', view));
  initIpc();
  createWindow();
  initUpdater();
  if (engine.settings.autoStart) {
    engine.start();
    setKeepAwake(!!engine.settings.keepAwake);
  }
  // Reconnect a saved key so balances show up, but live trading always starts switched off.
  const saved = loadCredentials();
  if (saved) engine.connectLive(saved, { switchVenue: false }).then((r) => { if (r.error) log.warn(`Saved Polymarket US key could not connect: ${r.error}`); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('before-quit', () => {
  if (engine) engine.stop();
  if (store) store.close();
});

app.on('window-all-closed', () => app.quit());
