'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bot', {
  state: () => ipcRenderer.invoke('state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  setStrategy: (id, params) => ipcRenderer.invoke('set-strategy', id, params),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  reset: (cash) => ipcRenderer.invoke('reset', cash),
  exportCsv: () => ipcRenderer.invoke('export-csv'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onEngine: (cb) => ipcRenderer.on('engine', (_e, v) => cb(v)),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, v) => cb(v)),
});
