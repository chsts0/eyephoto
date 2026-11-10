const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('eyephoto', {
  version: () => ipcRenderer.invoke('app-version'),
  openImage: () => ipcRenderer.invoke('open-image'),
  openPath: (file) => ipcRenderer.invoke('open-path', file),

  settings: () => ipcRenderer.invoke('settings-get'),
  chooseSaveRoot: () => ipcRenderer.invoke('choose-save-root'),
  saveJpeg: (payload) => ipcRenderer.invoke('save-jpeg', payload),

  modelStatus: () => ipcRenderer.invoke('model-status'),
  modelDownload: () => ipcRenderer.invoke('model-download'),
  onModelProgress: on('model-progress'),
  inpaint: (payload) => ipcRenderer.invoke('inpaint', payload),

  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: on('update-status'),
});
