'use strict';

// The only bridge between the interface and the system. The interface can ask
// for scans and cleanups by item id; it never gets to name a path to delete.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('cleanmac', {
  platform: process.platform,
  systemInfo: () => ipcRenderer.invoke('system:info'),
  categories: () => ipcRenderer.invoke('categories:list'),
  scan: () => ipcRenderer.invoke('scan:start'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  clean: (ids, mode) => ipcRenderer.invoke('clean:start', { ids, mode }),
  reveal: (id) => ipcRenderer.invoke('item:reveal', id),
  deepApps: () => ipcRenderer.invoke('deep:apps'),
  deepPreview: (appId) => ipcRenderer.invoke('deep:preview', appId),
  deepRemove: (previewId, ids) => ipcRenderer.invoke('deep:remove', { previewId, ids }),
  deepReveal: (previewId, id) => ipcRenderer.invoke('deep:reveal', { previewId, id }),
  openFullDiskAccess: () => ipcRenderer.invoke('app:open-fda'),
  openTrash: () => ipcRenderer.invoke('app:open-trash'),
  openProjectFolder: () => ipcRenderer.invoke('app:open-project'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  update: () => ipcRenderer.invoke('update:start'),
  onUpdateProgress: (cb) => subscribe('update:progress', cb),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onScanProgress: (cb) => subscribe('scan:progress', cb),
  onCleanProgress: (cb) => subscribe('clean:progress', cb),
  onDeepProgress: (cb) => subscribe('deep:progress', cb),
  onNavigate: (cb) => subscribe('app:navigate', cb),
  onCommand: (cb) => subscribe('app:command', cb),
  onNotice: (cb) => subscribe('app:notice', cb),
});
