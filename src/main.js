const { app, BrowserWindow, dialog, ipcMain, protocol, net, Menu, shell } = require('electron');

const MAC = process.platform === 'darwin';
const RELEASES = 'https://github.com/chsts0/eyephoto/releases/latest';
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
  // Системное меню убираем совсем: иначе на Windows Alt открывал бы его
  // и мешал фотошоповским сочетаниям с Alt.
  if (MAC) {
    // на маке без меню программы не работают Cmd+C/V в полях и Cmd+Q
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  } else {
    win.removeMenu();
  }
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
  // На маке программа без платной подписи Apple, а такую система обновлять
  // в фоне не даёт. Поэтому там только сообщаем о новой версии и даём ссылку.
  autoUpdater.autoDownload = !MAC;
  autoUpdater.autoInstallOnAppQuit = !MAC;

  autoUpdater.on('checking-for-update', () => status('checking'));
  autoUpdater.on('update-not-available', () => status('latest'));
  autoUpdater.on('update-available', (i) => status(MAC ? 'manual' : 'downloading', { version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => status('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => status('ready', { version: i.version }));
  autoUpdater.on('error', (e) => status('error', { message: String(e && e.message ? e.message : e) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  // Прогу могут не закрывать сутками, поэтому проверяем ещё и раз в час.
  setInterval(check, 60 * 60 * 1000);

  ipcMain.handle('update-check', check);
  ipcMain.handle('update-install', () => autoUpdater.quitAndInstall(true, true));
  ipcMain.handle('open-releases', () => shell.openExternal(RELEASES));
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
ipcMain.handle('settings-set', (_e, patch) => saveSettings(patch));

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

// Исходники в студии лежат так же по дням: «исходники\ноябрь 2026\10.11».
// Если прошлый снимок брали из такой папки, окно выбора файла открывается
// сразу в папке за сегодня, а не во вчерашней.
async function todaysSourceFolder() {
  const { lastOpenDir } = await loadSettings();
  if (!lastOpenDir) return undefined;
  const dayLike = /^\d{1,4}[.\-_ ]\d{1,2}/.test(path.basename(lastOpenDir));
  if (dayLike) {
    const now = new Date();
    for (const root of [path.dirname(path.dirname(lastOpenDir)), path.dirname(lastOpenDir), path.dirname(path.dirname(path.dirname(lastOpenDir)))]) {
      const today = await findDayFolder(root, now);
      if (today) return today;
    }
  }
  return lastOpenDir;
}

// what: 'any' — всё, что умеем открывать; 'photo' — только снимки (для вставки слоем)
ipcMain.handle('open-file', async (_e, what) => {
  const ext = what === 'photo' ? [...RAW_EXT, ...IMG_EXT] : [...RAW_EXT, ...IMG_EXT, ...PSD_EXT];
  const res = await dialog.showOpenDialog(win, {
    title: what === 'photo' ? 'Поместить снимок' : 'Открыть',
    defaultPath: await todaysSourceFolder(),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: what === 'photo' ? 'Снимки' : 'Снимки и шаблоны', extensions: ext }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  if (!PSD_EXT.includes(path.extname(res.filePaths[0]).slice(1).toLowerCase())) {
    await saveSettings({ lastOpenDir: path.dirname(res.filePaths[0]) });
  }
  return Promise.all(res.filePaths.map(readFile));
});

// Только для автотестов: открыть файл по пути без диалога.
ipcMain.handle('open-path', (_e, file) => (process.env.EYEPHOTO_TEST ? readFile(file) : null));

// Папка с PSD-шаблонами студии: полароид, стикеры, магнит и так далее.
// Шаблоны студии лежат внутри программы: если папку не выбирали, берём их.
// Своя папка (меню «Файл») важнее, так можно подложить новые шаблоны без обновления.
const BUILTIN_TEMPLATES = app.isPackaged ? path.join(process.resourcesPath, 'templates') : path.join(__dirname, '..', 'templates');
async function templatesDir() {
  const { templatesPath } = await loadSettings();
  return templatesPath || BUILTIN_TEMPLATES;
}

ipcMain.handle('templates-list', async () => {
  const templatesPath = await templatesDir();
  try {
    const names = (await fs.readdir(templatesPath)).filter((n) => /\.(psd|psb)$/i.test(n)).sort((a, b) => a.localeCompare(b, 'ru'));
    const items = [];
    for (const n of names) {
      const st = await fs.stat(path.join(templatesPath, n));
      items.push({ name: n.replace(/\.(psd|psb)$/i, ''), file: n, stamp: `${st.size}-${Math.round(st.mtimeMs)}` });
    }
    return { dir: templatesPath === BUILTIN_TEMPLATES ? null : templatesPath, builtin: templatesPath === BUILTIN_TEMPLATES, items };
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
  const templatesPath = await templatesDir();
  if (path.basename(file) !== file) return null;
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

ipcMain.handle('save-as', async (_e, { name, label, ext, data }) => {
  const { lastSaveDir } = await loadSettings();
  const res = await dialog.showSaveDialog(win, {
    title: 'Сохранить как',
    defaultPath: lastSaveDir ? path.join(lastSaveDir, name) : name,
    filters: [{ name: label, extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data));
  await saveSettings({ lastSaveDir: path.dirname(res.filePath) });
  return res.filePath;
});

// Только для автотестов: записать файл по пути без диалога.
ipcMain.handle('write-path', async (_e, { file, data }) => {
  if (!process.env.EYEPHOTO_TEST) return null;
  await fs.writeFile(file, Buffer.from(data));
  return file;
});

// --- Папки по дням ----------------------------------------------------------
// В студии папки месяца и дня заводятся каждый день сами: «ноябрь 2026\10.11».
// Программа их только находит. Имена могут немного отличаться (регистр, год,
// разделитель), поэтому папка ищется по смыслу, а не по точному имени.

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const two = (n) => String(n).padStart(2, '0');

function yearOk(text, now) {
  const y = String(now.getFullYear());
  const found = text.match(/(?<!\d)(?:\d{4}|\d{2})(?!\d)/g) || [];
  const years = found.filter((v) => v.length === 4);
  return !years.length || years.includes(y);
}

function isDayFolder(name, now) {
  const n = name.trim().toLowerCase(), d = now.getDate(), m = now.getMonth() + 1, y = now.getFullYear();
  // 10.11, 10-11, 10_11, 10.11.2026, 10.11.26
  let t = n.match(/^(\d{1,2})[.\-_ ](\d{1,2})(?:[.\-_ ](\d{2}|\d{4}))?(?!\d)/);
  if (t) return +t[1] === d && +t[2] === m && (!t[3] || +t[3] === y || +t[3] === y % 100);
  // 2026-11-10
  t = n.match(/^(\d{4})[.\-_ ](\d{1,2})[.\-_ ](\d{1,2})(?!\d)/);
  if (t) return +t[1] === y && +t[2] === m && +t[3] === d;
  // 10 ноября
  t = n.match(/^(\d{1,2})\s+([а-яё]+)/);
  return !!t && +t[1] === d && monthIndex(t[2]) === m - 1 && yearOk(n, now);
}

function monthIndex(word) {
  // «май» и «мая» начинаются как «март», поэтому май проверяется отдельно
  if (/^ма[йя]/.test(word)) return 4;
  return MONTH_STEMS.findIndex((stem, i) => i !== 4 && word.startsWith(stem));
}

function isMonthFolder(name, now) {
  const n = name.trim().toLowerCase(), m = now.getMonth(), y = now.getFullYear();
  if (/^\d{1,2}[.\-_ ]\d{1,2}(?![.\-_ ]?\d{3})/.test(n) && !/[а-яё]/.test(n)) {
    // 11.2026 или 2026-11
    const a = n.match(/^(\d{1,2})[.\-_ ](\d{4})$/), b = n.match(/^(\d{4})[.\-_ ](\d{1,2})$/);
    return !!((a && +a[1] === m + 1 && +a[2] === y) || (b && +b[1] === y && +b[2] === m + 1));
  }
  const b = n.match(/^(\d{4})[.\-_ ](\d{1,2})$/);
  if (b) return +b[1] === y && +b[2] === m + 1;
  const word = (n.match(/[а-яё]+/) || [''])[0];
  return monthIndex(word) === m && yearOk(n, now);
}

async function subdirs(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Папка за сегодняшний день внутри root или null. Смотрим сам корень, папки
// месяцев и, если студия раскладывает по годам, папку года.
async function findDayFolder(root, now) {
  const top = await subdirs(root);
  const day = top.find((n) => isDayFolder(n, now));
  if (day) return path.join(root, day);
  const months = top.filter((n) => isMonthFolder(n, now)).map((n) => path.join(root, n));
  for (const n of top.filter((x) => x.trim() === String(now.getFullYear()))) {
    const inner = await subdirs(path.join(root, n));
    months.push(...inner.filter((x) => isMonthFolder(x, now)).map((x) => path.join(root, n, x)));
    const d2 = inner.find((x) => isDayFolder(x, now));
    if (d2) return path.join(root, n, d2);
  }
  for (const m of months) {
    const d2 = (await subdirs(m)).find((n) => isDayFolder(n, now));
    if (d2) return path.join(m, d2);
  }
  return null;
}

// Какую папку завести, если на сегодня её нет: в существующей папке месяца, а без неё
// в привычном виде «ноябрь 2026\10.11».
async function expectedDayFolder(root, now) {
  const top = await subdirs(root);
  const month = top.find((n) => isMonthFolder(n, now)) || `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  return path.join(root, month, `${two(now.getDate())}.${two(now.getMonth() + 1)}`);
}

// Готовый файл кладётся в папку сегодняшнего дня как <цифра точки>-<номер>.jpg
ipcMain.handle('save-jpeg', async (_e, { prefix, number, data, overwrite, create }) => {
  const { savePath } = await loadSettings();
  if (!savePath) return { status: 'no-root' };
  if (!/^\d{4}$/.test(number) || !/^\d{1,3}$/.test(String(prefix))) return { status: 'bad-number' };
  const now = new Date();
  try {
    let dir = await findDayFolder(savePath, now);
    if (!dir) {
      const expected = await expectedDayFolder(savePath, now);
      if (!create) return { status: 'no-folder', expected: path.relative(savePath, expected) };
      await fs.mkdir(expected, { recursive: true });
      dir = expected;
    }
    const file = path.join(dir, `${prefix}-${number}.jpg`);
    if (!overwrite) {
      try { await fs.access(file); return { status: 'exists', file }; } catch { /* файла нет */ }
    }
    await fs.writeFile(file, Buffer.from(data));
    return { status: 'ok', file };
  } catch (e) {
    return { status: 'error', message: e.message };
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
