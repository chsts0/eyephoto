const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141416',
    autoHideMenuBar: true,
    title: 'EyePhoto',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// --- Обновления -----------------------------------------------------------
// Прога сама проверяет релизы на гитхабе, качает новую версию в фоне
// и ставит её при следующем закрытии. Статус уходит в интерфейс.

function sendUpdate(state, info = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('update-status', { state, ...info });
}

function setupUpdater() {
  if (!app.isPackaged) {
    sendUpdate('dev');
    return;
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-not-available', () => sendUpdate('latest'));
  autoUpdater.on('update-available', (i) => sendUpdate('downloading', { version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => sendUpdate('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate('ready', { version: i.version }));
  autoUpdater.on('error', (e) => sendUpdate('error', { message: String(e && e.message ? e.message : e) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  // Прогу могут не закрывать сутками, поэтому проверяем ещё и раз в час.
  setInterval(check, 60 * 60 * 1000);

  ipcMain.handle('update-check', check);
  ipcMain.handle('update-install', () => autoUpdater.quitAndInstall(true, true));
}

// --- Файлы ----------------------------------------------------------------

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('open-image', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Открыть снимок',
    properties: ['openFile'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const file = res.filePaths[0];
  return { name: path.basename(file), data: await fs.readFile(file) };
});

app.whenReady().then(() => {
  createWindow();
  win.webContents.once('did-finish-load', setupUpdater);
});

app.on('window-all-closed', () => app.quit());
