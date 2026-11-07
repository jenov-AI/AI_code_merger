'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const MAX_RECENTS = 8;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB read limit
const MAX_TREE_NODES = 20000;
const MAX_TREE_DEPTH = 12;

let win = null;
let currentWorkspace = null;

/* ------------------------------------------------------------------ */
/* Settings store (userData/settings.json)                             */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = { theme: 'dark', workspace: null, recentWorkspaces: [] };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function isDirectory(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch (err) {
    return false;
  }
}

async function sanitizeSettings(s) {
  if (s.workspace && !(await isDirectory(s.workspace))) s.workspace = null;
  const recents = [];
  for (const p of s.recentWorkspaces) {
    if (typeof p !== 'string' || recents.includes(p)) continue;
    if (await isDirectory(p)) recents.push(p);
  }
  s.recentWorkspaces = recents.slice(0, MAX_RECENTS);
  return s;
}

async function loadSettings() {
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const s = {
      theme: parsed && parsed.theme === 'light' ? 'light' : 'dark',
      workspace: parsed && typeof parsed.workspace === 'string' ? parsed.workspace : null,
      recentWorkspaces: parsed && Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces : []
    };
    return await sanitizeSettings(s);
  } catch (err) {
    return { theme: DEFAULT_SETTINGS.theme, workspace: null, recentWorkspaces: [] };
  }
}

async function saveSettings(s) {
  const tmp = settingsPath() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await fsp.rename(tmp, settingsPath());
}

function pushRecent(s, dir) {
  s.recentWorkspaces = [dir, ...s.recentWorkspaces.filter((x) => x !== dir)].slice(0, MAX_RECENTS);
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

function resolveInsideWorkspace(relPath) {
  if (!currentWorkspace) throw new Error('No workspace is selected.');
  if (typeof relPath !== 'string' || relPath.length === 0) throw new Error('Invalid file path.');
  const abs = path.resolve(currentWorkspace, relPath);
  if (abs !== currentWorkspace && !abs.startsWith(currentWorkspace + path.sep)) {
    throw new Error('Path escapes the workspace.');
  }
  return abs;
}

/* ------------------------------------------------------------------ */
/* Tree builder (async, capped, skips symlinks to avoid loops)         */
/* ------------------------------------------------------------------ */

async function buildTree(absDir, relDir, depth, scan) {
  if (scan.truncated) return [];
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const nodes = [];
  for (const ent of entries) {
    if (scan.truncated) break;
    if (!ent.isFile() && !ent.isDirectory()) continue;
    if (scan.count >= MAX_TREE_NODES) { scan.truncated = true; break; }
    const rel = relDir ? relDir + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      scan.count += 1;
      const children = depth + 1 >= MAX_TREE_DEPTH
        ? []
        : await buildTree(path.join(absDir, ent.name), rel, depth + 1, scan);
      nodes.push({ name: ent.name, path: rel, type: 'dir', children });
    } else {
      scan.count += 1;
      nodes.push({ name: ent.name, path: rel, type: 'file' });
    }
  }
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Merge logic (composite main keys)                                   */
/* ------------------------------------------------------------------ */

function compositeKey(item, keys) {
  // JSON.stringify makes the key type-aware (1 vs '1' do not collide)
  return keys.map((k) => JSON.stringify(item[k])).join('|');
}

function mergeArrays(oldArr, newArr, keys) {
  const validate = (arr, label) => {
    arr.forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(label + ' file: item at index ' + i + ' is not an object.');
      }
      for (const k of keys) {
        if (item[k] === undefined || item[k] === null) {
          throw new Error(label + ' file: item at index ' + i + ' is missing the main key: ' + k);
        }
      }
    });
  };
  validate(oldArr, 'Old');
  validate(newArr, 'New');

  const map = new Map();
  for (const item of oldArr) map.set(compositeKey(item, keys), item);
  for (const item of newArr) map.set(compositeKey(item, keys), item); // replaces only when ALL keys match
  return Array.from(map.values());
}

async function writeUniqueFile(dir, baseName, ext, data) {
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '_merged' : '_merged (' + i + ')';
    const abs = path.join(dir, baseName + suffix + ext);
    try {
      // wx flag guarantees the file is created only if it does not exist (race-safe)
      await fsp.writeFile(abs, data, { encoding: 'utf8', flag: 'wx' });
      return abs;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not allocate a unique file name.');
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('settings:get', async () => {
    const s = await loadSettings();
    try { await saveSettings(s); } catch (err) { /* best effort persistence of cleanup */ }
    currentWorkspace = s.workspace;
    return s;
  });

  ipcMain.handle('settings:set-theme', async (_e, theme) => {
    const t = theme === 'light' ? 'light' : 'dark';
    const s = await loadSettings();
    s.theme = t;
    await saveSettings(s);
    return t;
  });

  ipcMain.handle('workspace:choose', async () => {
    const opts = { title: 'Choose a workspace folder', properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    if (!(await isDirectory(dir))) throw new Error('The selected path is not a folder.');
    const s = await loadSettings();
    s.workspace = dir;
    pushRecent(s, dir);
    await saveSettings(s);
    currentWorkspace = dir;
    return s;
  });

  ipcMain.handle('workspace:open', async (_e, dir) => {
    if (typeof dir !== 'string' || dir.length === 0 || !(await isDirectory(dir))) {
      throw new Error('That folder no longer exists.');
    }
    const s = await loadSettings();
    s.workspace = dir;
    pushRecent(s, dir);
    await saveSettings(s);
    currentWorkspace = dir;
    return s;
  });

  ipcMain.handle('workspace:get-tree', async () => {
    if (!currentWorkspace || !(await isDirectory(currentWorkspace))) {
      throw new Error('The workspace is no longer available.');
    }
    const scan = { count: 0, truncated: false };
    const tree = await buildTree(currentWorkspace, '', 0, scan);
    return { tree, truncated: scan.truncated };
  });

  ipcMain.handle('file:read', async (_e, relPath) => {
    const abs = resolveInsideWorkspace(relPath);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      throw new Error('The file does not exist.');
    }
    if (!st.isFile()) throw new Error('The path is not a file.');
    if (st.size > MAX_FILE_SIZE) throw new Error('The file is larger than 5 MB.');
    return await fsp.readFile(abs, 'utf8');
  });

  ipcMain.handle('merge:run', async (_e, args) => {
    if (!args || typeof args !== 'object') throw new Error('Invalid merge request.');
    const oldAbs = resolveInsideWorkspace(args.oldPath);
    const newAbs = resolveInsideWorkspace(args.newPath);

    let rawKeys = args.mainKeys;
    if (typeof rawKeys === 'string') rawKeys = [rawKeys]; // backwards compatible
    if (!Array.isArray(rawKeys) || !rawKeys.length) throw new Error('At least one main key is required.');
    const keys = rawKeys.map((k) => (typeof k === 'string' ? k.trim() : ''));
    if (keys.some((k) => !k)) throw new Error('Main keys cannot be empty.');
    const seenKeys = new Set();
    for (const k of keys) {
      if (seenKeys.has(k)) throw new Error('Duplicate main key: ' + k);
      seenKeys.add(k);
    }

    let oldRaw;
    let newRaw;
    try {
      const pair = await Promise.all([fsp.readFile(oldAbs, 'utf8'), fsp.readFile(newAbs, 'utf8')]);
      oldRaw = pair[0];
      newRaw = pair[1];
    } catch (err) {
      throw new Error('Could not read the selected files.');
    }

    let oldData;
    let newData;
    try { oldData = JSON.parse(oldRaw); } catch (err) { throw new Error('The main (old) file is not valid JSON.'); }
    try { newData = JSON.parse(newRaw); } catch (err) { throw new Error('The new file is not valid JSON.'); }
    if (!Array.isArray(oldData)) throw new Error('The main (old) file must contain a JSON array.');
    if (!Array.isArray(newData)) throw new Error('The new file must contain a JSON array.');

    const merged = mergeArrays(oldData, newData, keys);
    const output = JSON.stringify(merged, null, 2) + '\n';

    if (args.overwrite === true) {
      try {
        const st = await fsp.stat(oldAbs);
        if (!st.isFile()) throw new Error('not a file');
      } catch (err) {
        throw new Error('The main file disappeared.');
      }
      // Atomic overwrite: write to temp file, then rename
      const tmp = oldAbs + '.tmp';
      await fsp.writeFile(tmp, output, 'utf8');
      await fsp.rename(tmp, oldAbs);
      return { mode: 'overwritten', relPath: args.oldPath };
    }

    const dir = path.dirname(oldAbs);
    const ext = path.extname(oldAbs);
    const base = path.basename(oldAbs, ext);
    const abs = await writeUniqueFile(dir, base, ext, output);
    const rel = path.relative(currentWorkspace, abs).split(path.sep).join('/');
    return { mode: 'created', relPath: rel };
  });
}

/* ------------------------------------------------------------------ */
/* Window / lifecycle                                                  */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    title: 'JSON Merge Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
