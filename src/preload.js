const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('eyephoto', {
  version: () => ipcRenderer.invoke('app-version'),
  openImage: () => ipcRenderer.invoke('open-image'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
});
