'use strict';

/* ============================================================
 * JSON Merge Studio - renderer
 * ============================================================ */

const POLL_INTERVAL_MS = 3000;
const ACE_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.9/';

const state = {
  settings: null,
  tree: [],
  treeJson: '',
  expanded: new Set(),
  checked: [],
  tabs: new Map(),
  activeTab: null,
  polling: false,
  pollTimer: null,
  lastMainKeys: ['filename']
};

let mergeSelection = { main: null };
let statusTimer = null;

const $ = (id) => document.getElementById(id);

const els = {
  welcomeView: $('welcome-view'),
  welcomeError: $('welcome-error'),
  chooseBtn: $('choose-workspace-btn'),
  recentBlock: $('recent-block'),
  recentList: $('recent-list'),
  mainView: $('main-view'),
  workspaceLabel: $('workspace-label'),
  mergeBtn: $('merge-btn'),
  changeWorkspaceBtn: $('change-workspace-btn'),
  themeBtn: $('theme-btn'),
  selectionCount: $('selection-count'),
  tree: $('tree'),
  treeNote: $('tree-note'),
  tabs: $('tabs'),
  editorHost: $('editor-host'),
  editorEmpty: $('editor-empty'),
  statusMsg: $('status-msg'),
  mergeModal: $('merge-modal'),
  mergeMainOptions: $('merge-main-options'),
  mergeKeysList: $('merge-keys-list'),
  mergeAddKeyBtn: $('merge-add-key-btn'),
  overwriteCheck: $('overwrite-check'),
  mergeHint: $('merge-hint'),
  mergeCancelBtn: $('merge-cancel-btn'),
  mergeRunBtn: $('merge-run-btn')
};

/* ---------------- helpers ---------------- */

function setStatus(msg, kind) {
  els.statusMsg.textContent = msg;
  els.statusMsg.className = kind || '';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  if (kind) {
    statusTimer = setTimeout(() => {
      els.statusMsg.textContent = 'Ready';
      els.statusMsg.className = '';
    }, 7000);
  }
}

function setWelcomeError(msg) {
  els.welcomeError.textContent = msg || '';
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  els.themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
  els.themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  const aceTheme = theme === 'dark' ? 'ace/theme/monokai' : 'ace/theme/chrome';
  for (const tab of state.tabs.values()) {
    if (tab.editor) tab.editor.setTheme(aceTheme);
  }
}

/* ---------------- welcome / recents ---------------- */

function showWelcome() {
  stopPolling();
  els.mainView.classList.add('hidden');
  els.welcomeView.classList.remove('hidden');
  renderRecents();
}

function renderRecents() {
  const recents = (state.settings && state.settings.recentWorkspaces) || [];
  els.recentList.innerHTML = '';
  if (!recents.length) {
    els.recentBlock.classList.add('hidden');
    return;
  }
  els.recentBlock.classList.remove('hidden');
  for (const p of recents) {
    const li = document.createElement('li');
    li.textContent = p;
    li.title = p;
    li.addEventListener('click', async () => {
      setWelcomeError('');
      try {
        state.settings = await window.api.openRecent(p);
        await enterWorkspace();
      } catch (err) {
        try { state.settings = await window.api.getSettings(); } catch (e2) { /* keep previous */ }
        renderRecents();
        setWelcomeError(err.message || 'Could not open that workspace.');
      }
    });
    els.recentList.appendChild(li);
  }
}

/* ---------------- workspace ---------------- */

async function enterWorkspace() {
  els.welcomeView.classList.add('hidden');
  els.mainView.classList.remove('hidden');
  els.workspaceLabel.textContent = state.settings.workspace;
  els.workspaceLabel.title = state.settings.workspace;
  state.checked = [];
  closeAllTabs();
  updateSelectionUI();
  await refreshTree(true);
  startPolling();
  setStatus('Workspace loaded', 'ok');
}

/* ---------------- tree ---------------- */

function collectFilePaths(nodes, out) {
  for (const n of nodes) {
    if (n.type === 'file') out.add(n.path);
    else collectFilePaths(n.children || [], out);
  }
  return out;
}

function reconcileAfterTreeChange() {
  const files = collectFilePaths(state.tree, new Set());
  state.checked = state.checked.filter((p) => files.has(p));
  for (const rel of Array.from(state.tabs.keys())) {
    if (!files.has(rel)) closeTab(rel, true);
  }
  updateSelectionUI();
}

async function refreshTree(force) {
  try {
    const res = await window.api.getTree();
    const json = JSON.stringify(res.tree);
    if (!force && json === state.treeJson) return;
    state.treeJson = json;
    state.tree = res.tree;
    reconcileAfterTreeChange();
    renderTree();
    if (res.truncated) {
      els.treeNote.textContent = 'Large workspace: tree display was truncated.';
      els.treeNote.classList.remove('hidden');
    } else {
      els.treeNote.classList.add('hidden');
    }
  } catch (err) {
    setStatus(err.message || 'Could not read the workspace.', 'error');
    if (String(err.message).indexOf('no longer available') >= 0) stopPolling();
  }
}

function renderTree() {
  els.tree.innerHTML = '';
  els.tree.appendChild(buildLevel(state.tree, 0));
  updateSelectionUI();
}

function buildLevel(nodes, depth) {
  const wrap = document.createElement('div');
  for (const node of nodes) {
    wrap.appendChild(buildRow(node, depth));
    if (node.type === 'dir' && state.expanded.has(node.path)) {
      wrap.appendChild(buildLevel(node.children || [], depth + 1));
    }
  }
  return wrap;
}

function buildRow(node, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = node.path;
  row.title = node.path;
  row.style.paddingLeft = (8 + depth * 14) + 'px';

  if (node.type === 'dir') {
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = state.expanded.has(node.path) ? '▾' : '▸';
    const label = document.createElement('span');
    label.className = 'node-name';
    label.textContent = node.name;
    row.appendChild(caret);
    row.appendChild(label);
    row.addEventListener('click', () => {
      if (state.expanded.has(node.path)) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderTree();
    });
    return row;
  }

  const isJson = node.name.toLowerCase().endsWith('.json');
  if (isJson) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.checked.includes(node.path);
    cb.title = 'Select for merge';
    cb.addEventListener('click', (ev) => ev.stopPropagation());
    cb.addEventListener('change', () => onToggleCheck(node.path, cb));
    row.appendChild(cb);
  } else {
    const pad = document.createElement('span');
    pad.className = 'caret';
    row.appendChild(pad);
  }

  const label = document.createElement('span');
  label.className = 'node-name';
  label.textContent = node.name;
  row.appendChild(label);
  row.addEventListener('dblclick', () => openFile(node.path));
  return row;
}

/* ---------------- checkbox selection (max 2) ---------------- */

function onToggleCheck(relPath, checkbox) {
  if (checkbox.checked) {
    if (state.checked.length >= 2 || state.checked.includes(relPath)) {
      checkbox.checked = false;
      return;
    }
    state.checked.push(relPath);
    updateSelectionUI();
    if (state.checked.length === 2) openMergeDialog();
    return;
  }
  state.checked = state.checked.filter((p) => p !== relPath);
  updateSelectionUI();
}

function updateSelectionUI() {
  const full = state.checked.length >= 2;
  const boxes = els.tree.querySelectorAll('input[type=checkbox]');
  boxes.forEach((cb) => {
    const row = cb.closest('.tree-row');
    if (!row) return;
    const isOn = state.checked.includes(row.dataset.path);
    cb.checked = isOn;
    cb.disabled = full && !isOn;
    row.classList.toggle('checked', isOn);
  });
  els.selectionCount.textContent = state.checked.length + '/2';
  els.mergeBtn.disabled = state.checked.length !== 2;
}

/* ---------------- tabs & editor ---------------- */

function modeForFile(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const map = {
    json: 'ace/mode/json',
    js: 'ace/mode/javascript',
    ts: 'ace/mode/javascript',
    css: 'ace/mode/css',
    html: 'ace/mode/html',
    md: 'ace/mode/markdown'
  };
  return map[ext] || 'ace/mode/text';
}

async function openFile(relPath) {
  if (state.tabs.has(relPath)) {
    activateTab(relPath);
    return;
  }
  let content;
  try {
    content = await window.api.readFile(relPath);
  } catch (err) {
    setStatus(err.message || 'Could not open the file.', 'error');
    return;
  }
  const name = relPath.split('/').pop();

  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.title = relPath;
  const label = document.createElement('span');
  label.className = 'tab-label ellipsis';
  label.textContent = name;
  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeTab(relPath);
  });
  tabEl.appendChild(label);
  tabEl.appendChild(closeBtn);
  tabEl.addEventListener('click', () => activateTab(relPath));
  els.tabs.appendChild(tabEl);

  const pane = document.createElement('div');
  pane.className = 'editor-pane';
  els.editorHost.appendChild(pane);

  const tab = { relPath, name, tabEl, pane, editor: null, fallback: null };
  state.tabs.set(relPath, tab);

  if (window.ace) {
    ace.config.set('basePath', ACE_CDN_BASE);
    const ed = ace.edit(pane, {
      readOnly: true,
      showPrintMargin: false,
      useWorker: false,
      fontSize: 13
    });
    ed.session.setMode(modeForFile(name));
    ed.setTheme(currentTheme() === 'dark' ? 'ace/theme/monokai' : 'ace/theme/chrome');
    ed.setValue(content, -1);
    tab.editor = ed;
  } else {
    const pre = document.createElement('div');
    pre.className = 'editor-fallback';
    pre.textContent = content;
    pane.appendChild(pre);
    tab.fallback = pre;
  }

  els.tabs.classList.remove('hidden');
  activateTab(relPath);
}

function activateTab(relPath) {
  const tab = state.tabs.get(relPath);
  if (!tab) return;
  state.activeTab = relPath;
  for (const t of state.tabs.values()) {
    const on = t.relPath === relPath;
    t.tabEl.classList.toggle('active', on);
    t.pane.classList.toggle('active', on);
  }
  els.editorEmpty.classList.add('hidden');
  if (tab.editor) {
    tab.editor.resize();
    tab.editor.focus();
  }
}

function closeTab(relPath, silent) {
  const tab = state.tabs.get(relPath);
  if (!tab) return;
  if (tab.editor) tab.editor.destroy();
  tab.tabEl.remove();
  tab.pane.remove();
  state.tabs.delete(relPath);
  if (state.activeTab === relPath) {
    state.activeTab = null;
    const rest = Array.from(state.tabs.keys());
    if (rest.length) {
      activateTab(rest[rest.length - 1]);
    } else {
      els.editorEmpty.classList.remove('hidden');
      els.tabs.classList.add('hidden');
    }
  }
  if (!silent) setStatus('Closed ' + tab.name, '');
}

function closeAllTabs() {
  for (const rel of Array.from(state.tabs.keys())) closeTab(rel, true);
  state.activeTab = null;
}

async function reloadTabIfOpen(relPath) {
  const tab = state.tabs.get(relPath);
  if (!tab) return;
  try {
    const content = await window.api.readFile(relPath);
    if (tab.editor) tab.editor.setValue(content, -1);
    else if (tab.fallback) tab.fallback.textContent = content;
  } catch (err) { /* file may have been removed */ }
}

/* ---------------- merge dialog ---------------- */

function openMergeDialog() {
  if (state.checked.length !== 2) return;
  mergeSelection.main = state.checked[0];
  els.overwriteCheck.checked = false;
  renderMergeOptions();
  const remembered = (state.lastMainKeys && state.lastMainKeys.length) ? state.lastMainKeys.slice() : ['filename'];
  renderKeyRows(remembered);
  updateMergeHint();
  els.mergeModal.classList.remove('hidden');
  els.mergeRunBtn.focus();
}

function closeMergeDialog() {
  els.mergeModal.classList.add('hidden');
}

function renderMergeOptions() {
  els.mergeMainOptions.innerHTML = '';
  for (const rel of state.checked) {
    const row = document.createElement('label');
    row.className = 'radio-row' + (mergeSelection.main === rel ? ' selected' : '');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'merge-main';
    radio.checked = mergeSelection.main === rel;
    radio.addEventListener('change', () => {
      mergeSelection.main = rel;
      renderMergeOptions();
      updateMergeHint();
    });
    const span = document.createElement('span');
    span.className = 'ellipsis';
    span.textContent = rel + '  —  Main (Old)';
    row.appendChild(radio);
    row.appendChild(span);
    els.mergeMainOptions.appendChild(row);
  }
}

/* ---------------- multiple main keys ---------------- */

function renderKeyRows(keys) {
  els.mergeKeysList.innerHTML = '';
  keys.forEach((k) => addKeyRow(k));
  refreshKeyRows();
}

function addKeyRow(value) {
  const row = document.createElement('div');
  row.className = 'key-row';

  const indexLabel = document.createElement('span');
  indexLabel.className = 'key-index';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = 'Key name';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'key-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove key';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshKeyRows();
  });

  row.appendChild(indexLabel);
  row.appendChild(input);
  row.appendChild(removeBtn);
  els.mergeKeysList.appendChild(row);
  refreshKeyRows();
}

function refreshKeyRows() {
  const rows = Array.from(els.mergeKeysList.querySelectorAll('.key-row'));
  rows.forEach((row, i) => {
    row.querySelector('.key-index').textContent = 'Key ' + (i + 1);
    row.querySelector('.key-remove').disabled = rows.length <= 1;
  });
}

function getKeyValues() {
  const inputs = els.mergeKeysList.querySelectorAll('input[type=text]');
  return Array.from(inputs).map((inp) => inp.value.trim());
}

/* ---------------- merge execution ---------------- */

function plannedOutputName() {
  const main = mergeSelection.main || '';
  const dot = main.lastIndexOf('.');
  const slash = main.lastIndexOf('/');
  if (dot > slash && dot > 0) return main.slice(0, dot) + '_merged' + main.slice(dot);
  return main + '_merged';
}

function updateMergeHint() {
  if (els.overwriteCheck.checked) {
    els.mergeHint.textContent = 'The main file will be overwritten with the merge result.';
  } else {
    els.mergeHint.textContent = 'A new file will be created: ' + plannedOutputName();
  }
}

async function runMerge() {
  if (state.checked.length !== 2 || !mergeSelection.main) return;
  const oldPath = mergeSelection.main;
  const newPath = state.checked.find((p) => p !== oldPath);

  const mainKeys = getKeyValues();
  if (!mainKeys.length || mainKeys.some((k) => !k)) {
    setStatus('All main key fields must be filled.', 'error');
    return;
  }
  const seen = new Set();
  for (const k of mainKeys) {
    if (seen.has(k)) {
      setStatus('Duplicate main key: ' + k, 'error');
      return;
    }
    seen.add(k);
  }

  els.mergeRunBtn.disabled = true;
  try {
    const res = await window.api.merge({
      oldPath,
      newPath,
      mainKeys,
      overwrite: els.overwriteCheck.checked
    });
    state.lastMainKeys = mainKeys.slice();
    closeMergeDialog();
    state.checked = [];
    await refreshTree(true);
    updateSelectionUI();
    if (res.mode === 'created') {
      setStatus('Merged into ' + res.relPath, 'ok');
      openFile(res.relPath);
    } else {
      setStatus('Merged and overwrote ' + res.relPath, 'ok');
      await reloadTabIfOpen(res.relPath);
    }
  } catch (err) {
    setStatus(err.message || 'Merge failed.', 'error');
  } finally {
    els.mergeRunBtn.disabled = false;
  }
}

/* ---------------- polling (async, non-blocking) ---------------- */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollOnce() {
  if (state.polling) return;
  if (!state.settings || !state.settings.workspace) return;
  if (document.hidden) return;
  state.polling = true;
  try {
    await refreshTree(false);
  } finally {
    state.polling = false;
  }
}

/* ---------------- events ---------------- */

function bindEvents() {
  els.chooseBtn.addEventListener('click', async () => {
    setWelcomeError('');
    try {
      const s = await window.api.chooseWorkspace();
      if (!s) return;
      state.settings = s;
      await enterWorkspace();
    } catch (err) {
      setWelcomeError(err.message || 'Could not open that workspace.');
    }
  });

  els.changeWorkspaceBtn.addEventListener('click', async () => {
    try {
      const s = await window.api.chooseWorkspace();
      if (!s) return;
      state.settings = s;
      stopPolling();
      await enterWorkspace();
    } catch (err) {
      setStatus(err.message || 'Could not open that workspace.', 'error');
    }
  });

  els.themeBtn.addEventListener('click', async () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { await window.api.setTheme(next); } catch (err) { /* ignore */ }
  });

  els.mergeBtn.addEventListener('click', openMergeDialog);
  els.mergeCancelBtn.addEventListener('click', closeMergeDialog);
  els.mergeRunBtn.addEventListener('click', runMerge);
  els.overwriteCheck.addEventListener('change', updateMergeHint);

  els.mergeAddKeyBtn.addEventListener('click', () => {
    addKeyRow('');
    const inputs = els.mergeKeysList.querySelectorAll('input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  els.mergeModal.addEventListener('click', (ev) => {
    if (ev.target === els.mergeModal) closeMergeDialog();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !els.mergeModal.classList.contains('hidden')) closeMergeDialog();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollOnce();
  });
}

/* ---------------- init ---------------- */

(async function init() {
  bindEvents();
  try {
    state.settings = await window.api.getSettings();
  } catch (err) {
    state.settings = { theme: 'dark', workspace: null, recentWorkspaces: [] };
  }
  applyTheme(state.settings.theme === 'light' ? 'light' : 'dark');
  if (state.settings.workspace) await enterWorkspace();
  else showWelcome();
})();
