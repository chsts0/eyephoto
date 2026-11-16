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
  saveAs: (payload) => ipcRenderer.invoke('save-as', payload),
  writePath: (payload) => ipcRenderer.invoke('write-path', payload),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),

  settings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  chooseSaveRoot: () => ipcRenderer.invoke('choose-save-root'),
  saveJpeg: (payload) => ipcRenderer.invoke('save-jpeg', payload),

  modelStatus: () => ipcRenderer.invoke('model-status'),
  modelDownload: () => ipcRenderer.invoke('model-download'),
  onModelProgress: on('model-progress'),
  inpaint: (payload) => ipcRenderer.invoke('inpaint', payload),

  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  openReleases: () => ipcRenderer.invoke('open-releases'),
  platform: process.env.EYEPHOTO_TEST && process.env.EYEPHOTO_PLATFORM || process.platform, // в тестах можно показать вид мака
  setMenu: (menus) => ipcRenderer.send('set-menu', menus),
  assistantStatus: () => ipcRenderer.invoke('assistant-status'),
  assistantDownload: () => ipcRenderer.invoke('assistant-download'),
  onAssistantProgress: (cb) => ipcRenderer.on('assistant-progress', (_e, p) => cb(p)),
  assistantRemove: () => ipcRenderer.invoke('assistant-remove'),
  assistantReset: () => ipcRenderer.invoke('assistant-reset'),
  assistantAsk: (id, question) => ipcRenderer.invoke('assistant-ask', { id, question }),
  onAssistantChunk: (cb) => ipcRenderer.on('assistant-chunk', (_e, m) => cb(m)),
  setZoom: (f) => ipcRenderer.invoke('set-zoom', f),
  setNeuralDevice: (cpu) => ipcRenderer.invoke('set-neural-device', cpu),
  modelRemove: () => ipcRenderer.invoke('model-remove'),
  onMenuCmd: (cb) => ipcRenderer.on('menu-cmd', (_e, id) => cb(id)),
  onUpdateStatus: on('update-status'),
});
