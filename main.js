const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { pathToFileURL } = require('url');

const API_URL = 'https://api.sorcerytcg.com/api/cards';

/* -------------------------------------------------------------------------
 * Paths
 * -------------------------------------------------------------------------
 * - The bundled default card database and the images folder are read-only
 *   assets shipped with the app (you drop card images into ./images before
 *   running `npm run dist`).
 * - The "live" card database the app actually reads/writes lives in the
 *   user's per-app data folder, so updates never require touching files
 *   inside the installed app itself.
 * ---------------------------------------------------------------------- */

function resourceDir(...segments) {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(base, ...segments);
}

const DEFAULT_DB_PATH = resourceDir('data', 'sorcery-card-database.json');
const IMAGES_DIR = resourceDir('images');

function userDataDir() { return app.getPath('userData'); }
function currentDbPath() { return path.join(userDataDir(), 'card-database.json'); }
function currentDeckPath() { return path.join(userDataDir(), 'current-deck.json'); }

/* -------------------------------------------------------------------------
 * Card database: seed / read / write
 * ---------------------------------------------------------------------- */

function extractCardArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.cards)) return json.cards;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && typeof json === 'object') {
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  throw new Error('Unrecognized card data shape');
}

function ensureUserDb() {
  const dest = currentDbPath();
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(userDataDir(), { recursive: true });
  try {
    const raw = fs.readFileSync(DEFAULT_DB_PATH, 'utf-8');
    const cards = extractCardArray(JSON.parse(raw));
    fs.writeFileSync(dest, JSON.stringify({ fetchedAt: null, source: 'bundled', cards }));
  } catch (err) {
    console.error('Could not seed the default card database:', err);
    fs.writeFileSync(dest, JSON.stringify({ fetchedAt: null, source: 'none', cards: [] }));
  }
}

function readCurrentDb() {
  ensureUserDb();
  try {
    return JSON.parse(fs.readFileSync(currentDbPath(), 'utf-8'));
  } catch (err) {
    console.error('Could not read the card database:', err);
    return { fetchedAt: null, source: 'none', cards: [] };
  }
}

function writeCurrentDb(payload) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(currentDbPath(), JSON.stringify(payload));
}

/* -------------------------------------------------------------------------
 * Talking to the Sorcery API
 * -------------------------------------------------------------------------
 * This runs in the main process (plain Node), not a browser page, so the
 * lack of CORS headers on api.sorcerytcg.com doesn't matter here — CORS is
 * a restriction browsers place on *renderer* JavaScript, not on Node's own
 * HTTP client.
 * ---------------------------------------------------------------------- */

function fetchCardsFromApi(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      API_URL,
      { headers: { Accept: 'application/json', 'User-Agent': 'Grimoire-desktop/1.0' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out — check your internet connection.')));
  });
}

/* -------------------------------------------------------------------------
 * Window
 * ---------------------------------------------------------------------- */

let mainWindow;
let helpWindow;

function openHelpWindow() {
  if (helpWindow) { helpWindow.focus(); return; }
  helpWindow = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#16130e',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    parent: mainWindow,
    webPreferences: { sandbox: true },
  });
  helpWindow.loadFile(path.join(__dirname, 'src', 'help.html'));
  helpWindow.on('closed', () => { helpWindow = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16130e',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* -------------------------------------------------------------------------
 * IPC — card database
 * ---------------------------------------------------------------------- */

ipcMain.handle('help:open', () => { openHelpWindow(); });

ipcMain.handle('db:load', () => readCurrentDb());

ipcMain.handle('db:update', async () => {
  try {
    const rawArr = extractCardArray(await fetchCardsFromApi());
    const payload = { fetchedAt: new Date().toISOString(), source: 'api', cards: rawArr };
    writeCurrentDb(payload);
    return { ok: true, db: payload };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('db:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import card database',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
    const cards = extractCardArray(parsed);
    const payload = { fetchedAt: new Date().toISOString(), source: 'import', cards };
    writeCurrentDb(payload);
    return { ok: true, db: payload };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

/* -------------------------------------------------------------------------
 * IPC — card images
 * -------------------------------------------------------------------------
 * Scans the images/ folder fresh every time it's asked (cheap for a few
 * thousand files), so dropping new images in and relaunching the app is
 * all that's needed — no rebuild required in dev mode.
 * ---------------------------------------------------------------------- */

ipcMain.handle('images:list', () => {
  try {
    if (!fs.existsSync(IMAGES_DIR)) return { baseUrl: null, files: [] };
    const files = fs.readdirSync(IMAGES_DIR).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    const baseUrl = pathToFileURL(IMAGES_DIR).href.replace(/\/?$/, '/');
    return { baseUrl, files };
  } catch (err) {
    console.error('Could not scan images folder:', err);
    return { baseUrl: null, files: [] };
  }
});

/* -------------------------------------------------------------------------
 * IPC — deck persistence (auto-save + explicit save/open dialogs)
 * ---------------------------------------------------------------------- */

ipcMain.handle('deck:loadCurrent', () => {
  try {
    if (!fs.existsSync(currentDeckPath())) return null;
    return JSON.parse(fs.readFileSync(currentDeckPath(), 'utf-8'));
  } catch (err) {
    return null;
  }
});

ipcMain.handle('deck:saveCurrent', (_e, deckState) => {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(currentDeckPath(), JSON.stringify(deckState));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('deck:saveAs', async (_e, deckState, suggestedName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save deck',
    defaultPath: suggestedName || 'deck.json',
    filters: [{ name: 'Grimoire deck', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, JSON.stringify(deckState, null, 2));
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('deck:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open deck',
    filters: [{ name: 'Deck files', extensions: ['json', 'txt'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(res.filePaths[0], 'utf-8');
    return { ok: true, content, path: res.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('deck:exportBulkTxt', async (_e, text, suggestedName) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Export bulk-add list for Curiosa',
    defaultPath: suggestedName || 'deck-curiosa-bulk-add.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, text);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
