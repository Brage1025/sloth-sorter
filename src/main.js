'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.env.SLOTH_USER_DATA) app.setPath('userData', process.env.SLOTH_USER_DATA);

const ollama = require('./core/ollama');
const { DEFAULT_SETTINGS, DEFAULT_CATEGORIES, SUGGESTED_MODELS } = require('./core/config');
const { createClassifier } = require('./core/classify');
const { buildPlan, applyPlan, undoMoves } = require('./core/planner');
const { HistoryStore } = require('./core/history');
const { ResultCache } = require('./core/cache');
const { PdfRenderer } = require('./pdfrender');
const { createWatcher } = require('./core/watcher');

let win = null;
let tray = null;
let history = null;
let cache = null;
let pdfRenderer = null;
let scanAbort = null;
let pullAbort = null;
let watcher = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden');

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = null;

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    /* first run */
  }
  settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!settings.folder) settings.folder = process.env.SLOTH_FOLDER || app.getPath('downloads');
  if (process.env.SLOTH_OLLAMA_HOST) settings.host = process.env.SLOTH_OLLAMA_HOST;
  if (!Array.isArray(settings.categories) || !settings.categories.length) settings.categories = DEFAULT_CATEGORIES;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  if (patch.startAtLogin !== undefined) {
    app.setLoginItemSettings({ openAtLogin: !!settings.startAtLogin, args: ['--hidden'] });
  }
  return settings;
}

// ---------- helpers ----------
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

/** Per-file timing, printed in the terminal so slow setups can be diagnosed. */
function logStats(j) {
  const ms = (n) => Math.round((n || 0) / 1e6);
  console.log(
    `[sloth] ${j.file} (${j.kind}): total ${ms(j.total_duration)}ms | model load ${ms(j.load_duration)}ms | ` +
      `read ${j.prompt_eval_count || 0} tok in ${ms(j.prompt_eval_duration)}ms | write ${j.eval_count || 0} tok in ${ms(j.eval_duration)}ms`
  );
  if (process.env.SLOTH_DEBUG && j.snippet) console.log(`[sloth]   what the AI was shown:\n${j.snippet.replace(/^/gm, '[sloth]     ')}`);
}

/** Shrink pictures before handing them to a vision model: fast and light on memory. */
async function imageEncoder(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(1, 768 / Math.max(width, height));
  const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
  return small.toJPEG(80).toString('base64');
}

async function aiState() {
  const st = await ollama.status(settings.host);
  return { ...st, modelReady: st.running && ollama.hasModel(st.models, settings.model) };
}

const friendly = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    if (e && e.cancelled) return { cancelled: true };
    return { error: e && e.message ? e.message : String(e) };
  }
};

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('get-state', friendly(async () => ({
    settings,
    ai: await aiState(),
    platform: process.platform,
    version: app.getVersion(),
    suggestedModels: SUGGESTED_MODELS,
    defaultCategories: DEFAULT_CATEGORIES,
    quickFolders: [
      { label: 'Downloads', path: app.getPath('downloads') },
      { label: 'Desktop', path: app.getPath('desktop') },
      { label: 'Documents', path: app.getPath('documents') },
    ],
  })));

  ipcMain.handle('check-ai', friendly(aiState));

  ipcMain.handle('save-settings', friendly((_e, patch) => {
    saveSettings(patch);
    refreshTray();
    return settings;
  }));

  ipcMain.handle('choose-folder', friendly(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose the messy folder',
      properties: ['openDirectory'],
      defaultPath: settings.folder,
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    saveSettings({ folder: r.filePaths[0] });
    return { folder: r.filePaths[0] };
  }));

  ipcMain.handle('scan', friendly(async () => {
    scanAbort = new AbortController();
    let hinted = false;
    const onStats = (j) => {
      logStats(j);
      if (hinted) return;
      hinted = true; // check once per scan, after the model is loaded
      ollama.runsOnGpu(settings.host, settings.model).then((gpu) => send('perf-hint', { cpuOnly: gpu === false, model: settings.model }));
    };
    const classify = createClassifier(settings, { imageEncoder, pdfRenderer: (f) => pdfRenderer.render(f), signal: scanAbort.signal, onStats, cache });
    const items = await buildPlan(settings, classify, {
      signal: scanAbort.signal,
      onProgress: (p) => send('scan-progress', p),
    });
    return { items };
  }));
  ipcMain.handle('cancel-scan', () => scanAbort && scanAbort.abort());

  ipcMain.handle('apply', friendly((_e, choices) => {
    const { moves, failed } = applyPlan(settings, choices);
    const batch = moves.length ? history.add({ folder: settings.folder, moves }) : null;
    return { moved: moves.length, failed, batchId: batch && batch.id, firstTo: moves[0] && moves[0].to };
  }));

  ipcMain.handle('clear-cache', () => ({ cleared: cache.clear() }));
  ipcMain.handle('history', () => history.list());
  ipcMain.handle('undo', friendly((_e, id) => {
    const batch = history.get(id);
    if (!batch) throw new Error('That tidy-up is no longer in the history.');
    const r = undoMoves(batch.moves);
    history.markUndone(id);
    return r;
  }));

  ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('open-folder', (_e, p) => shell.openPath(p || settings.folder));

  // --- AI setup ---
  ipcMain.handle('ollama-download-page', () => shell.openExternal('https://ollama.com/download'));
  ipcMain.handle('ollama-start', friendly(async () => {
    if ((await ollama.status(settings.host)).running) return { running: true };
    const started = ollama.tryStart();
    for (let i = 0; i < 20 && started; i++) {
      await new Promise((r) => setTimeout(r, 750));
      if ((await ollama.status(settings.host)).running) return { running: true };
    }
    return { running: false };
  }));

  ipcMain.handle('pull-model', friendly(async (_e, model) => {
    const tag = model || settings.model;
    pullAbort = new AbortController();
    try {
      await ollama.pull(settings.host, tag, (p) => send('pull-progress', { model: tag, ...p }), pullAbort.signal);
    } catch (e) {
      if (pullAbort.signal.aborted) return { cancelled: true };
      throw e;
    }
    return { done: true };
  }));
  ipcMain.handle('cancel-pull', () => pullAbort && pullAbort.abort());

  ipcMain.handle('set-auto', friendly((_e, on) => {
    setAuto(!!on);
    return settings;
  }));
}

// ---------- auto ("sleep") mode ----------
function setAuto(on) {
  saveSettings({ autoMode: on });
  refreshTray();
  if (on && watcher) setTimeout(() => watcher.tick(), 1500); // don't make people wait a full minute
}

async function autoTidy() {
  const s = settings;
  if (s.useAI) {
    const st = await aiState();
    if (!st.running) {
      ollama.tryStart();
      return { moved: 0 }; // wait for the AI rather than sorting badly
    }
    if (!st.modelReady) return { moved: 0 };
  }
  const classify = createClassifier(s, { imageEncoder, pdfRenderer: (f) => pdfRenderer.render(f), onStats: logStats, cache });
  const items = await buildPlan(s, classify, { minAgeMs: Math.max(1, s.autoMinutes) * 60000 });
  if (!items.length) return { moved: 0 };
  const { moves } = applyPlan(s, items.map((i) => ({ from: i.from, category: i.category, newName: i.newName })));
  if (moves.length) history.add({ folder: s.folder, moves, auto: true });
  return { moved: moves.length };
}

// ---------- window & tray ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    show: !startHidden,
    title: 'Sloth Sorter',
    backgroundColor: '#f6f1e7',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting && settings.autoMode && tray) {
      e.preventDefault(); // keep sleeping in the tray
      win.hide();
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Sloth Sorter', click: showWindow },
      {
        label: 'Sleep mode (tidy automatically)',
        type: 'checkbox',
        checked: !!settings.autoMode,
        click: (item) => {
          setAuto(item.checked);
          send('state-changed');
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function createTray() {
  // macOS wants a black "template" image that it recolours for light/dark menu bars.
  const isMac = process.platform === 'darwin';
  const iconPath = path.join(__dirname, 'renderer', 'assets', isMac ? 'trayTemplate.png' : 'tray.png');
  if (!fs.existsSync(iconPath)) return;
  const icon = nativeImage.createFromPath(iconPath);
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Sloth Sorter');
  tray.on('click', showWindow);
  refreshTray();
}

// ---------- boot ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    loadSettings();
    history = new HistoryStore(path.join(app.getPath('userData'), 'history.json'));
    pdfRenderer = new PdfRenderer();
    cache = new ResultCache(path.join(app.getPath('userData'), 'cache.json'));
    registerIpc();
    createWindow();
    createTray();
    watcher = createWatcher({
      getSettings: () => settings,
      tidy: autoTidy,
      onResult: ({ moved }) => {
        send('auto-ran', { moved });
        if (Notification.isSupported()) {
          new Notification({
            title: 'Sloth Sorter',
            body: `Tidied ${moved} file${moved === 1 ? '' : 's'} while you were busy. Undo any time from History.`,
          }).show();
        }
      },
      onError: (e) => console.error('auto tidy failed:', e.message),
    });
    watcher.start();
    app.on('activate', showWindow);
  });
  app.on('before-quit', () => { quitting = true; if (cache) cache.flush(); });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !(settings && settings.autoMode && tray)) app.quit();
  });
}
