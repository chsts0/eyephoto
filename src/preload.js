const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('eyephoto', {
  version: () => ipcRenderer.invoke('app-version'),
  openFile: (what) => ipcRenderer.invoke('open-file', what),
  openPath: (file) => ipcRenderer.invoke('open-path', file),
  templates: () => ipcRenderer.invoke('templates-list'),
  chooseTemplates: () => ipcRenderer.invoke('templates-choose'),
  readTemplate: (file) => ipcRenderer.invoke('templates-read', file),
  exportFile: (payload) => ipcRenderer.invoke('export-file', payload),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),

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
