'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTheme: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openRecent: (dir) => ipcRenderer.invoke('workspace:open', dir),
  getTree: () => ipcRenderer.invoke('workspace:get-tree'),
  readFile: (relPath) => ipcRenderer.invoke('file:read', relPath),
  merge: (payload) => ipcRenderer.invoke('merge:run', payload)
});
