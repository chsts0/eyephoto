const { app, BrowserWindow, dialog, ipcMain, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const inpaint = require('./inpaint');

let win;

// Интерфейс грузится через свой протокол app://, а не file://.
// Так в окне нормально работают модули, воркеры и wasm (нужны для чтения ARW).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ROOTS = {
  libraw: path.join(__dirname, '..', 'node_modules', 'libraw-wasm', 'dist'),
  agpsd: path.join(__dirname, '..', 'node_modules', 'ag-psd', 'dist'),
  ui: path.join(__dirname, 'renderer'),
};

function serveApp() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let root = ROOTS.ui;
    for (const key of ['libraw', 'agpsd']) {
      if (rel.startsWith(key + '/')) { root = ROOTS[key]; rel = rel.slice(key.length + 1); }
    }
    const file = path.normalize(path.join(root, rel || 'index.html'));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#121315',
    autoHideMenuBar: true,
    title: 'EyePhoto',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('app://local/index.html');

  // Не даём случайно закрыть окно с несохранённой работой.
  win.on('close', (e) => {
    if (!dirty || process.env.EYEPHOTO_TEST) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Закрыть', 'Отмена'], defaultId: 1, cancelId: 1,
      title: 'EyePhoto', message: 'Закрыть программу?', detail: 'Есть несохранённые документы, работа в них пропадёт.',
    });
    if (choice !== 0) e.preventDefault();
  });
}

let dirty = false;
ipcMain.on('set-dirty', (_e, v) => { dirty = !!v; });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- Обновления -----------------------------------------------------------
// Прога сама проверяет релизы на гитхабе, качает новую версию в фоне
// и ставит её при следующем закрытии. Статус уходит в интерфейс.

function setupUpdater() {
  const status = (state, info = {}) => send('update-status', { state, ...info });
  if (!app.isPackaged) {
    status('dev');
    return;
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => status('checking'));
  autoUpdater.on('update-not-available', () => status('latest'));
  autoUpdater.on('update-available', (i) => status('downloading', { version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => status('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => status('ready', { version: i.version }));
  autoUpdater.on('error', (e) => status('error', { message: String(e && e.message ? e.message : e) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  // Прогу могут не закрывать сутками, поэтому проверяем ещё и раз в час.
  setInterval(check, 60 * 60 * 1000);

  ipcMain.handle('update-check', check);
  ipcMain.handle('update-install', () => autoUpdater.quitAndInstall(true, true));
}

// --- Настройки ------------------------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try { return JSON.parse(await fs.readFile(settingsFile(), 'utf8')); } catch { return {}; }
}
async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await fs.writeFile(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

ipcMain.handle('settings-get', loadSettings);

ipcMain.handle('choose-save-root', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Папка для готовых фото',
    message: 'Внутри неё сами создадутся папки месяца и дня',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  await saveSettings({ savePath: res.filePaths[0] });
  return res.filePaths[0];
});

// --- Файлы ----------------------------------------------------------------

ipcMain.handle('app-version', () => app.getVersion());

const RAW_EXT = ['arw', 'dng', 'cr2', 'cr3', 'nef', 'raf', 'rw2', 'orf'];
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp'];
const PSD_EXT = ['psd', 'psb'];

async function readFile(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const kind = RAW_EXT.includes(ext) ? 'raw' : PSD_EXT.includes(ext) ? 'psd' : 'image';
  return { name: path.basename(file), kind, data: await fs.readFile(file) };
}

// what: 'any' — всё, что умеем открывать; 'photo' — только снимки (для вставки слоем)
ipcMain.handle('open-file', async (_e, what) => {
  const ext = what === 'photo' ? [...RAW_EXT, ...IMG_EXT] : [...RAW_EXT, ...IMG_EXT, ...PSD_EXT];
  const res = await dialog.showOpenDialog(win, {
    title: what === 'photo' ? 'Поместить снимок' : 'Открыть',
    properties: ['openFile'],
    filters: [{ name: what === 'photo' ? 'Снимки' : 'Снимки и шаблоны', extensions: ext }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return readFile(res.filePaths[0]);
});

// Только для автотестов: открыть файл по пути без диалога.
ipcMain.handle('open-path', (_e, file) => (process.env.EYEPHOTO_TEST ? readFile(file) : null));

// Папка с PSD-шаблонами студии: полароид, стикеры, магнит и так далее.
ipcMain.handle('templates-list', async () => {
  const { templatesPath } = await loadSettings();
  if (!templatesPath) return { dir: null, items: [] };
  try {
    const names = (await fs.readdir(templatesPath)).filter((n) => /\.(psd|psb)$/i.test(n)).sort((a, b) => a.localeCompare(b, 'ru'));
    const items = [];
    for (const n of names) {
      const st = await fs.stat(path.join(templatesPath, n));
      items.push({ name: n.replace(/\.(psd|psb)$/i, ''), file: n, stamp: `${st.size}-${Math.round(st.mtimeMs)}` });
    }
    return { dir: templatesPath, items };
  } catch {
    return { dir: templatesPath, items: [], missing: true };
  }
});

ipcMain.handle('templates-choose', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Папка с шаблонами PSD', properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  await saveSettings({ templatesPath: res.filePaths[0] });
  return res.filePaths[0];
});

ipcMain.handle('templates-read', async (_e, file) => {
  const { templatesPath } = await loadSettings();
  if (!templatesPath || path.basename(file) !== file) return null;
  return readFile(path.join(templatesPath, file));
});

ipcMain.handle('export-file', async (_e, { name, data, png }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Экспорт',
    defaultPath: name,
    filters: [{ name: 'JPEG', extensions: ['jpg'] }, { name: 'PNG', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(/\.png$/i.test(res.filePath) ? png : data));
  return res.filePath;
});

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// Готовый файл кладётся как <корень>\ноябрь 2026\10.11\4-1233.jpg
ipcMain.handle('save-jpeg', async (_e, { number, data, overwrite }) => {
  const { savePath } = await loadSettings();
  if (!savePath) return { status: 'no-root' };
  if (!/^\d{4}$/.test(number)) return { status: 'bad-number' };
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const dir = path.join(savePath, `${MONTHS[now.getMonth()]} ${now.getFullYear()}`,
    `${two(now.getDate())}.${two(now.getMonth() + 1)}`);
  const file = path.join(dir, `4-${number}.jpg`);
  try {
    await fs.mkdir(dir, { recursive: true });
    if (!overwrite) {
      try { await fs.access(file); return { status: 'exists', file }; } catch { /* файла нет */ }
    }
    await fs.writeFile(file, Buffer.from(data));
    return { status: 'ok', file };
  } catch (e) {
    return { status: 'error', message: e.message, file };
  }
});

// --- Нейронка -------------------------------------------------------------

ipcMain.handle('model-status', () => inpaint.status(app.getPath('userData')));
ipcMain.handle('model-download', async () => {
  const res = await inpaint.download(app.getPath('userData'), (percent) => send('model-progress', percent));
  if (res.ok) inpaint.warm(app.getPath('userData'));
  return res;
});
ipcMain.handle('inpaint', (_e, { rgba, mask }) => inpaint.run(app.getPath('userData'), rgba, mask));

app.whenReady().then(() => {
  serveApp();
  createWindow();
  win.webContents.once('did-finish-load', () => {
    setupUpdater();
    inpaint.warm(app.getPath('userData'));
  });
});

app.on('window-all-closed', () => app.quit());
