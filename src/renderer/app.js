import * as im from './imaging.js';

const api = window.eyephoto;
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const ACCENT = '#e8b04a';
const MASK = 'rgba(255, 60, 200, .55)';
const RAW_RE = /\.(arw|dng|cr2|cr3|nef|raf|rw2|orf)$/i;
const UNDO_LIMIT = 30;

const state = {
  mode: 'empty',      // empty | circle | edit | layout
  photo: null,        // холст с исходным снимком
  photoName: '',
  circle: null,       // круг по радужке на снимке
  eye: null,          // глаз, который сейчас в ретуши
  editIndex: -1,      // его место в списке готовых, если правим готовый
  eyes: [],           // готовые глаза, первый = левый
  format: 'A5',
  layout: 'corners',
  layoutPreview: null,
  tool: 'lasso',
  brush: 60,
  view: { scale: 1, ox: 0, oy: 0 },
  drag: null,
  cursor: null,
  space: false,
  busy: false,
  modelReady: false,
  saved: false,
};
window.__eyephoto = state;

// --- Мелкие помощники интерфейса -------------------------------------------

function setBusy(text) {
  state.busy = !!text;
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  // даём браузеру нарисовать плашку до тяжёлой работы
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function ask({ title, text, ok = 'Да', cancel = 'Отмена' }) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text;
  $('modalOk').textContent = ok;
  $('modalOk').hidden = false;
  $('modalCancel').textContent = cancel;
  $('modalCancel').hidden = !cancel;
  $('modalProgress').hidden = true;
  $('modal').hidden = false;
  $('modalOk').focus();
  return new Promise((resolve) => {
    const done = (v) => { $('modal').hidden = true; resolve(v); };
    $('modalOk').onclick = () => done(true);
    $('modalCancel').onclick = () => done(false);
  });
}
const tell = (title, text) => ask({ title, text, ok: 'Понятно', cancel: '' });

// --- Нейронка: проверка и разовая загрузка ----------------------------------

async function ensureModel() {
  if (state.modelReady) return true;
  if ((await api.modelStatus()).ready) return (state.modelReady = true);
  const go = await ask({
    title: 'Нужно один раз скачать нейронку',
    text: 'Она убирает блики и ресницы. Весит 200 МБ, скачивается один раз и дальше работает без интернета.',
    ok: 'Скачать',
  });
  if (!go) return false;
  $('modalTitle').textContent = 'Скачиваю нейронку';
  $('modalText').textContent = 'Не закрывайте программу.';
  $('modalOk').hidden = true;
  $('modalCancel').hidden = true;
  $('modalProgress').hidden = false;
  $('modal').hidden = false;
  const res = await api.modelDownload();
  $('modal').hidden = true;
  if (!res.ok) {
    await tell('Не получилось скачать', 'Проверьте интернет и попробуйте ещё раз.');
    return false;
  }
  return (state.modelReady = true);
}
api.onModelProgress((p) => { $('modalProgress').firstElementChild.style.width = p + '%'; });

// --- Сцена и просмотр -------------------------------------------------------

function sceneSize() {
  if (state.mode === 'circle') return { w: state.photo.width, h: state.photo.height };
  if (state.mode === 'edit') return { w: state.eye.side, h: state.eye.side };
  if (state.mode === 'layout') { const f = im.FORMATS[state.format]; return { w: f.w, h: f.h }; }
  return null;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  draw();
}

function fit() {
  const s = sceneSize();
  if (!s) return;
  const pad = 36, w = stage.clientWidth, h = stage.clientHeight, v = state.view;
  v.scale = Math.min((w - pad * 2) / s.w, (h - pad * 2) / s.h);
  if (state.mode === 'circle') v.scale = Math.min(v.scale, 1);
  v.ox = (w - s.w * v.scale) / 2;
  v.oy = (h - s.h * v.scale) / 2;
  draw();
}

function zoomAt(x, y, factor) {
  if (!sceneSize()) return;
  const v = state.view;
  const next = Math.min(32, Math.max(0.02, v.scale * factor));
  v.ox = x - (x - v.ox) * (next / v.scale);
  v.oy = y - (y - v.oy) * (next / v.scale);
  v.scale = next;
  draw();
}

function ring(c, color, handles) {
  const px = 1 / state.view.scale;
  ctx.lineWidth = 3.5 * px;
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.75 * px;
  ctx.strokeStyle = color;
  ctx.stroke();
  if (!handles) return;
  ctx.fillStyle = color;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath(); ctx.arc(c.x + dx * c.r, c.y + dy * c.r, 5 * px, 0, Math.PI * 2); ctx.fill();
  }
}

function draw() {
  const dpr = window.devicePixelRatio || 1, v = state.view;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = sceneSize();
  if (!s) return;
  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
  ctx.imageSmoothingEnabled = v.scale < 3; // при сильном увеличении показываем честные пиксели
  ctx.imageSmoothingQuality = 'high';
  const px = 1 / v.scale;

  if (state.mode === 'circle') {
    const c = state.circle;
    ctx.drawImage(state.photo, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.beginPath(); ctx.rect(0, 0, s.w, s.h); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill('evenodd');
    ring(c, ACCENT, true);
  }

  if (state.mode === 'edit') {
    const e = state.eye, d = state.drag;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.drawImage(e.rendered, 0, 0, s.w, s.h);
    if (d && (d.type === 'lasso' || d.type === 'brush')) {
      ctx.beginPath();
      d.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.lineJoin = ctx.lineCap = 'round';
      if (d.type === 'lasso') {
        ctx.fillStyle = 'rgba(255, 60, 200, .25)'; ctx.fill();
        ctx.strokeStyle = '#ff3cc8'; ctx.lineWidth = 2 * px; ctx.stroke();
      } else {
        if (d.pts.length === 1) ctx.lineTo(d.pts[0].x + 0.01, d.pts[0].y);
        ctx.strokeStyle = MASK; ctx.lineWidth = d.size; ctx.stroke();
      }
    }
    if (state.tool === 'pupil') ring(e.pupil, ACCENT, true);
    if (state.cursor && !state.drag && (state.tool === 'brush' || state.tool === 'burn')) {
      ring({ x: state.cursor.x, y: state.cursor.y, r: state.brush / 2 }, '#fff', false);
    }
  }

  if (state.mode === 'layout') {
    ctx.drawImage(state.layoutPreview, 0, 0, s.w, s.h);
    ctx.strokeStyle = '#3a3a40'; ctx.lineWidth = px;
    ctx.strokeRect(0, 0, s.w, s.h);
  }
  $('zoomFit').textContent = Math.round(v.scale * 100) + '%';
}

// --- Режимы -----------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  state.drag = null;
  document.body.dataset.mode = mode;
  document.querySelectorAll('#steps li').forEach((li) => li.classList.toggle('on', li.dataset.step === mode));
  $('fileName').textContent = mode === 'layout' || mode === 'empty' ? '' : state.photoName;
  const s = sceneSize();
  if (mode === 'circle') $('meta').textContent = `${s.w} × ${s.h} px`;
  if (mode === 'edit') { $('meta').textContent = `Радужка ${s.w} px`; syncEditUi(); }
  if (mode === 'layout') refreshLayout();
  if (mode === 'empty') $('meta').textContent = '';
  resize();
  fit();
}

// --- Открытие снимка --------------------------------------------------------

async function decodeRaw(bytes) {
  const { default: LibRaw } = await import('/libraw/index.js');
  const raw = new LibRaw();
  try {
    // Автояркость выключена: иначе два глаза одного клиента проявлялись бы по-разному.
    // Множитель 4 даёт ту же яркость, что Camera Raw с экспозицией около нуля.
    await raw.open(new Uint8Array(bytes), {
      useCameraWb: true, outputBps: 8, userQual: 3, noAutoBright: true, bright: 4,
    });
    const out = await raw.imageData();
    const { width: w, height: h, data } = out;
    const ch = Math.round(data.length / (w * h));
    const img = new ImageData(w, h), d = img.data;
    for (let i = 0, j = 0; i < d.length; i += 4, j += ch) {
      d[i] = data[j]; d[i + 1] = data[j + 1]; d[i + 2] = data[j + 2]; d[i + 3] = 255;
    }
    const c = im.makeCanvas(w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  } finally {
    if (raw.dispose) raw.dispose();
  }
}

async function decodeImage(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = im.makeCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

async function openData(file) {
  if (state.busy) return;
  if (state.mode === 'edit' && state.eye.undo.length) {
    const go = await ask({
      title: 'Открыть другой снимок?',
      text: 'Текущий глаз ещё не отправлен на лист, ретушь пропадёт.',
      ok: 'Открыть другой',
    });
    if (!go) return;
  }
  await setBusy(file.raw ? 'Проявляю снимок с камеры' : 'Открываю снимок');
  let photo;
  try {
    photo = file.raw ? await decodeRaw(file.data) : await decodeImage(file.data);
  } catch (e) {
    console.error(e);
    setBusy('');
    await tell('Не получилось открыть файл', 'Подойдут ARW с камеры, JPG и PNG. Если это ARW, возможно, файл повреждён.');
    return;
  }
  setBusy('');
  state.photo = photo;
  state.photoName = file.name;
  state.eye = null;
  state.editIndex = -1;
  // Стартовое положение круга: вокруг самого тёмного пятна в центре (обычно зрачок).
  const g = im.guessPupil(photo), m = Math.min(photo.width, photo.height);
  const r = g.found ? Math.min(m * 0.46, Math.max(m * 0.15, g.r * 3.4)) : m * 0.3;
  state.circle = { x: g.x, y: g.y, r };
  setMode('circle');
}

async function openDialog() {
  if (state.busy) return;
  const file = await api.openImage();
  if (file) openData(file);
}
window.__openPath = async (p) => openData(await api.openPath(p));

// --- Шаг 1: круг ------------------------------------------------------------

function cropIris() {
  const c = state.circle, side = Math.round(c.r * 2);
  const base = im.makeCanvas(side, side);
  const x = base.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#000';
  x.fillRect(0, 0, side, side);
  x.drawImage(state.photo, c.x - c.r, c.y - c.r, c.r * 2, c.r * 2, 0, 0, side, side);
  const pupil = im.guessPupil(base);
  state.eye = {
    name: state.photoName, side, base,
    color: { ...im.DEFAULT_COLOR },
    pupil: { x: pupil.x, y: pupil.y, r: pupil.r },
    undo: [], redo: [], rendered: null, final: null, fromPhoto: true,
  };
  state.tool = 'lasso';
  rerender(true);
  setMode('edit');
}

// --- Шаг 2: ретушь ----------------------------------------------------------

const TOOL_HELP = {
  lasso: 'Обведите блик или ресницу с небольшим запасом. Когда отпустите мышку, нейронка уберёт обведённое.',
  brush: 'Закрасьте лишнее. Когда отпустите мышку, нейронка уберёт закрашенное.',
  burn: 'Проведите по месту, которое нужно затемнить. Каждый проход делает темнее.',
  pupil: 'Поставьте круг точно по краю зрачка и нажмите «Сузить зрачок». Он станет стандартного размера и ровно чёрным.',
  hand: 'Двигайте картинку мышкой. Колесо меняет масштаб.',
};

function syncEditUi() {
  const e = state.eye;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === state.tool));
  $('toolHelp').textContent = TOOL_HELP[state.tool];
  $('sizeRow').hidden = !(state.tool === 'brush' || state.tool === 'burn');
  $('pupilBtn').hidden = state.tool !== 'pupil';
  $('size').max = Math.round(e.side / 4);
  $('size').value = state.brush = Math.min(state.brush, Number($('size').max));
  $('sizeVal').textContent = state.brush;
  $('undoBtn').disabled = !e.undo.length;
  $('redoBtn').disabled = !e.redo.length;
  $('backToCircle').hidden = !e.fromPhoto;
  document.querySelectorAll('input[data-p]').forEach((inp) => {
    inp.value = e.color[inp.dataset.p];
    inp.previousElementSibling.textContent = e.color[inp.dataset.p];
  });
  canvas.style.cursor = state.tool === 'hand' ? 'grab' : state.tool === 'pupil' ? 'default' : 'crosshair';
}

function setTool(tool) {
  if (state.mode !== 'edit') return;
  state.tool = tool;
  syncEditUi();
  draw();
}

function rerender(full) {
  const e = state.eye;
  e.rendered = im.renderEye(e.base, e.color, full ? 1 : Math.min(1, 900 / e.side));
  draw();
}

const baseCtx = () => state.eye.base.getContext('2d', { willReadFrequently: true });

function pushUndo(entry) {
  const e = state.eye;
  e.undo.push(entry);
  if (e.undo.length > UNDO_LIMIT) e.undo.shift();
  e.redo = [];
}

function stepHistory(from, to) {
  const e = state.eye;
  if (state.busy || !e[from].length) return;
  const entry = e[from].pop(), x = baseCtx();
  const now = x.getImageData(entry.x, entry.y, entry.data.width, entry.data.height);
  x.putImageData(entry.data, entry.x, entry.y);
  e[to].push({ x: entry.x, y: entry.y, data: now });
  rerender(true);
  syncEditUi();
}

function buildMask(d) {
  const side = state.eye.side;
  const mask = im.makeCanvas(side, side), x = mask.getContext('2d');
  x.fillStyle = x.strokeStyle = '#fff';
  x.lineJoin = x.lineCap = 'round';
  x.beginPath();
  d.pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)));
  let pad;
  if (d.type === 'lasso') {
    pad = Math.max(5, side / 160); // небольшой запас наружу от обводки
    x.closePath(); x.fill();
    x.lineWidth = pad * 2; x.stroke();
  } else {
    pad = d.size / 2;
    if (d.pts.length === 1) x.lineTo(d.pts[0].x + 0.01, d.pts[0].y);
    x.lineWidth = d.size; x.stroke();
  }
  const xs = d.pts.map((p) => p.x), ys = d.pts.map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
  const x1 = Math.min(side, Math.max(...xs) + pad), y1 = Math.min(side, Math.max(...ys) + pad);
  return { mask, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

async function removeMarked(d) {
  if (d.type === 'lasso' && d.pts.length < 3) return;
  const { mask, bbox } = buildMask(d);
  if (bbox.w < 2 || bbox.h < 2) return;
  if (!(await ensureModel())) return;
  const e = state.eye;
  const region = im.patchRegion(e.base, bbox);
  const before = baseCtx().getImageData(region.x, region.y, region.w, region.h);
  await setBusy('Убираю лишнее');
  try {
    await im.inpaintPatch(e.base, mask, region, (rgba, m) => api.inpaint({ rgba, mask: m }));
    pushUndo({ x: region.x, y: region.y, data: before });
  } catch (err) {
    console.error(err);
    setBusy('');
    await tell('Нейронка не сработала', 'Попробуйте ещё раз. Если повторится, перезапустите программу.');
  }
  setBusy('');
  rerender(true);
  syncEditUi();
}

function burnDab(p) {
  const e = state.eye, d = state.drag, r = state.brush / 2;
  const k = e.rendered.width / e.side;
  for (const [x, scale, op] of [[baseCtx(), 1, 'source-over'], [e.rendered.getContext('2d'), k, 'source-atop']]) {
    const g = x.createRadialGradient(p.x * scale, p.y * scale, 0, p.x * scale, p.y * scale, r * scale);
    g.addColorStop(0, 'rgba(0,0,0,.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalCompositeOperation = op;
    x.fillStyle = g;
    x.beginPath(); x.arc(p.x * scale, p.y * scale, r * scale, 0, Math.PI * 2); x.fill();
    x.globalCompositeOperation = 'source-over';
  }
  d.x0 = Math.min(d.x0, p.x - r); d.y0 = Math.min(d.y0, p.y - r);
  d.x1 = Math.max(d.x1, p.x + r); d.y1 = Math.max(d.y1, p.y + r);
  d.last = p;
}

function startBurn(p) {
  const e = state.eye;
  const copy = im.makeCanvas(e.side, e.side);
  copy.getContext('2d', { willReadFrequently: true }).drawImage(e.base, 0, 0);
  state.drag = { type: 'burn', copy, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  burnDab(p);
}

function endBurn(d) {
  const side = state.eye.side;
  const x = Math.max(0, Math.floor(d.x0)), y = Math.max(0, Math.floor(d.y0));
  const w = Math.min(side, Math.ceil(d.x1)) - x, h = Math.min(side, Math.ceil(d.y1)) - y;
  if (w > 0 && h > 0) pushUndo({ x, y, data: d.copy.getContext('2d').getImageData(x, y, w, h) });
  rerender(true);
  syncEditUi();
}

function applyPupil() {
  const e = state.eye;
  if (state.busy) return;
  const rect = im.pupilRect(e.base, e.pupil);
  const before = baseCtx().getImageData(rect.x, rect.y, rect.w, rect.h);
  im.shrinkPupil(e.base, e.pupil);
  pushUndo({ x: rect.x, y: rect.y, data: before });
  e.pupil.r = (e.side / 2) * im.PUPIL_RATIO;
  rerender(true);
  syncEditUi();
}

function finishEye() {
  const e = state.eye;
  if (state.busy) return;
  e.final = im.renderEye(e.base, e.color, 1);
  e.fromPhoto = false;
  if (state.editIndex >= 0) state.eyes[state.editIndex] = e;
  else state.eyes.push(e);
  state.editIndex = -1;
  state.saved = false;
  if (state.eyes.length < 2) state.layout = 'single';
  else if (state.layout === 'single') state.layout = 'corners';
  setMode('layout');
}

// --- Шаг 3: лист ------------------------------------------------------------

function refreshLayout() {
  const f = im.FORMATS[state.format];
  if (state.eyes.length < 2) state.layout = 'single';
  const pw = 1600;
  state.layoutPreview = im.makeCanvas(pw, Math.round(pw * f.h / f.w));
  im.drawLayout(state.layoutPreview, state.format, state.layout, state.eyes.map((e) => e.final));
  $('meta').textContent = `${f.label}, ${f.w} × ${f.h} px, ${im.DPI} dpi`;

  document.querySelectorAll('#formatSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.format));
  document.querySelectorAll('#layoutSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === state.layout);
    b.disabled = b.dataset.v !== 'single' && state.eyes.length < 2;
  });

  const box = $('eyes');
  box.textContent = '';
  const onSheet = state.layout === 'single' ? 1 : 2;
  state.eyes.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'eye';
    const thumb = im.makeCanvas(104, 104);
    thumb.getContext('2d').drawImage(e.final, 0, 0, 104, 104);
    const text = document.createElement('div');
    const role = i >= onSheet ? 'Не на листе' : state.layout === 'single' ? 'На листе' : i === 0 ? 'Левый' : 'Правый';
    text.innerHTML = '<div class="eye-title"></div><div class="eye-sub"></div>';
    text.firstChild.textContent = role;
    text.lastChild.textContent = e.name;
    const actions = document.createElement('div');
    actions.className = 'eye-actions';
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'icon-btn'; b.textContent = label; b.title = title; b.onclick = fn;
      actions.appendChild(b);
    };
    if (i > 0) btn('↑', 'Поднять выше (поменять местами)', () => {
      [state.eyes[i - 1], state.eyes[i]] = [state.eyes[i], state.eyes[i - 1]];
      refreshLayout();
    });
    btn('✎', 'Вернуться к ретуши', () => {
      state.eye = e; state.editIndex = i; state.photoName = e.name; state.tool = 'lasso';
      rerender(true);
      setMode('edit');
    });
    btn('✕', 'Убрать', () => { state.eyes.splice(i, 1); refreshLayout(); });
    row.append(thumb, text, actions);
    box.appendChild(row);
  });
  $('saveBtn').disabled = !state.eyes.length;
  draw();
}

function saveMsg(text, cls = '') {
  $('saveMsg').textContent = text;
  $('saveMsg').className = 'save-msg ' + cls;
}

async function showFolder() {
  const { savePath } = await api.settings();
  $('folderText').textContent = savePath || 'Папка не выбрана';
  $('folderText').title = savePath || '';
  $('folderBtn').textContent = savePath ? 'Сменить' : 'Выбрать';
  return savePath;
}

async function save(overwrite = false) {
  if (state.busy || !state.eyes.length) return;
  const number = $('number').value.trim();
  if (!/^\d{4}$/.test(number)) {
    saveMsg('Введите номер фото: ровно 4 цифры, например 1233.', 'err');
    $('number').focus();
    return;
  }
  if (!(await showFolder())) {
    if (!(await api.chooseSaveRoot())) return;
    await showFolder();
  }
  await setBusy('Сохраняю');
  const f = im.FORMATS[state.format];
  const sheet = im.makeCanvas(f.w, f.h);
  im.drawLayout(sheet, state.format, state.layout, state.eyes.map((e) => e.final));
  const blob = await new Promise((r) => sheet.toBlob(r, 'image/jpeg', 0.97));
  const data = im.setJpegDpi(await blob.arrayBuffer(), im.DPI);
  const res = await api.saveJpeg({ number, data, overwrite });
  setBusy('');
  if (res.status === 'ok') {
    state.saved = true;
    saveMsg('Сохранено: ' + res.file, 'ok');
  } else if (res.status === 'exists') {
    const go = await ask({ title: `Файл 4-${number}.jpg уже есть`, text: 'Заменить его новым?', ok: 'Заменить' });
    if (go) save(true);
  } else {
    saveMsg('Не получилось сохранить. Проверьте, что папка доступна, и выберите её заново.', 'err');
  }
}

async function newClient() {
  if (state.eyes.length && !state.saved) {
    const go = await ask({ title: 'Начать нового клиента?', text: 'Лист ещё не сохранён, готовые глаза пропадут.', ok: 'Начать нового' });
    if (!go) return;
  }
  state.eyes = [];
  state.eye = state.photo = null;
  state.saved = false;
  $('number').value = '';
  saveMsg('');
  setMode('empty');
}

// --- Мышь -------------------------------------------------------------------

function toScene(e) {
  const r = canvas.getBoundingClientRect(), v = state.view;
  return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale };
}

// Круг двигается за середину и меняет размер за край.
function circleHit(c, p) {
  const d = Math.hypot(p.x - c.x, p.y - c.y), tol = 12 / state.view.scale;
  if (Math.abs(d - c.r) <= tol) return { type: 'resize', c };
  if (d < c.r) return { type: 'move', c, dx: p.x - c.x, dy: p.y - c.y };
  return null;
}

function activeCircle() {
  if (state.mode === 'circle') return state.circle;
  if (state.mode === 'edit' && state.tool === 'pupil') return state.eye.pupil;
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.mode === 'empty' || state.busy) return;
  const p = toScene(e);
  canvas.setPointerCapture(e.pointerId);
  const pan = e.button !== 0 || state.space || state.mode === 'layout' || (state.mode === 'edit' && state.tool === 'hand');
  const circle = activeCircle();
  if (pan) state.drag = { type: 'pan' };
  else if (circle) state.drag = circleHit(circle, p) || { type: 'pan' };
  else if (state.tool === 'lasso') state.drag = { type: 'lasso', pts: [p] };
  else if (state.tool === 'brush') state.drag = { type: 'brush', pts: [p], size: state.brush };
  else if (state.tool === 'burn') startBurn(p);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (state.mode === 'empty') return;
  const p = toScene(e), d = state.drag, s = sceneSize();
  state.cursor = p;
  if (!d) {
    const c = activeCircle();
    if (c) {
      const hit = circleHit(c, p);
      canvas.style.cursor = !hit ? 'default' : hit.type === 'move' ? 'move' : 'nwse-resize';
    }
    if (state.mode === 'edit' && (state.tool === 'brush' || state.tool === 'burn')) draw();
    return;
  }
  if (d.type === 'pan') {
    state.view.ox += e.movementX;
    state.view.oy += e.movementY;
  } else if (d.type === 'move') {
    d.c.x = Math.max(0, Math.min(s.w, p.x - d.dx));
    d.c.y = Math.max(0, Math.min(s.h, p.y - d.dy));
  } else if (d.type === 'resize') {
    const min = state.mode === 'circle' ? 120 : 8;
    d.c.r = Math.max(min, Math.min(Math.max(s.w, s.h), Math.hypot(p.x - d.c.x, p.y - d.c.y)));
  } else if (d.type === 'lasso' || d.type === 'brush') {
    const last = d.pts[d.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5 / state.view.scale) d.pts.push(p);
  } else if (d.type === 'burn') {
    if (Math.hypot(p.x - d.last.x, p.y - d.last.y) > state.brush * 0.12) burnDab(p);
  }
  draw();
});

function endDrag(e) {
  const d = state.drag;
  state.drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (!d) return;
  if (d.type === 'lasso' || d.type === 'brush') removeMarked(d);
  if (d.type === 'burn') endBurn(d);
  draw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { state.cursor = null; if (!state.drag) draw(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

// --- Кнопки и клавиши -------------------------------------------------------

const center = () => [stage.clientWidth / 2, stage.clientHeight / 2];
$('zoomIn').onclick = () => zoomAt(...center(), 1.25);
$('zoomOut').onclick = () => zoomAt(...center(), 1 / 1.25);
$('zoomFit').onclick = fit;
window.addEventListener('resize', resize);

$('openBtn').onclick = openDialog;
$('openBtn2').onclick = openDialog;
$('addEye').onclick = openDialog;
$('cropBtn').onclick = cropIris;
$('pupilBtn').onclick = applyPupil;
$('doneBtn').onclick = finishEye;
$('undoBtn').onclick = () => stepHistory('undo', 'redo');
$('redoBtn').onclick = () => stepHistory('redo', 'undo');
$('saveBtn').onclick = () => save();
$('newClient').onclick = newClient;
$('folderBtn').onclick = async () => { await api.chooseSaveRoot(); showFolder(); };
$('number').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); saveMsg(''); });
$('number').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

$('backToCircle').onclick = async () => {
  if (state.eye.undo.length) {
    const go = await ask({ title: 'Вернуться к кругу?', text: 'Ретушь этого глаза пропадёт.', ok: 'Вернуться' });
    if (!go) return;
  }
  setMode('circle');
};

document.querySelectorAll('.tool[data-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });

$('size').addEventListener('input', (e) => {
  state.brush = Number(e.target.value);
  $('sizeVal').textContent = state.brush;
});

let colorFrame = 0;
document.querySelectorAll('input[data-p]').forEach((inp) => {
  inp.addEventListener('input', () => {
    state.eye.color[inp.dataset.p] = Number(inp.value);
    inp.previousElementSibling.textContent = inp.value;
    cancelAnimationFrame(colorFrame);
    colorFrame = requestAnimationFrame(() => rerender(false)); // быстрый черновик, пока тянут ползунок
  });
  inp.addEventListener('change', () => { cancelAnimationFrame(colorFrame); rerender(true); });
});
$('resetColor').onclick = () => {
  state.eye.color = { ...im.DEFAULT_COLOR };
  syncEditUi();
  rerender(true);
};

Object.keys(im.FORMATS).forEach((key) => {
  const b = document.createElement('button');
  b.dataset.v = b.textContent = key.replace('A', 'А');
  b.dataset.v = key;
  b.onclick = () => { state.format = key; refreshLayout(); fit(); };
  $('formatSeg').appendChild(b);
});
document.querySelectorAll('#layoutSeg button').forEach((b) => {
  b.onclick = () => { state.layout = b.dataset.v; refreshLayout(); };
});

const TOOL_KEYS = { KeyL: 'lasso', KeyB: 'brush', KeyO: 'burn', KeyP: 'pupil', KeyH: 'hand' };
window.addEventListener('keydown', (e) => {
  if (!$('modal').hidden) return;
  const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range';
  if (e.ctrlKey && e.code === 'KeyO') { e.preventDefault(); openDialog(); return; }
  if (e.ctrlKey && e.code === 'Digit0') { e.preventDefault(); fit(); return; }
  if (typing) return;
  if (e.code === 'Space') { state.space = true; e.preventDefault(); return; }
  if (state.mode !== 'edit') return;
  if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? stepHistory('redo', 'undo') : stepHistory('undo', 'redo'); return; }
  if (e.ctrlKey && e.code === 'KeyY') { e.preventDefault(); stepHistory('redo', 'undo'); return; }
  if (e.ctrlKey || e.altKey) return;
  if (TOOL_KEYS[e.code]) setTool(TOOL_KEYS[e.code]);
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const k = e.code === 'BracketLeft' ? 1 / 1.2 : 1.2;
    state.brush = Math.round(Math.max(8, Math.min(Number($('size').max), state.brush * k)));
    syncEditUi();
    draw();
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') state.space = false; });

window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drag'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file) openData({ name: file.name, raw: RAW_RE.test(file.name), data: new Uint8Array(await file.arrayBuffer()) });
});

// --- Обновления -------------------------------------------------------------

function setUpdate(dot, text, action) {
  $('updateDot').className = 'dot ' + dot;
  $('updateText').textContent = text;
  const btn = $('updateAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
}

api.onUpdateStatus((s) => {
  switch (s.state) {
    case 'dev': return setUpdate('', 'Режим разработки, обновления выключены');
    case 'checking': return setUpdate('busy', 'Проверяю обновления');
    case 'latest': return setUpdate('ok', 'Установлена последняя версия', { label: 'Проверить', run: api.checkUpdate });
    case 'downloading': return setUpdate('busy', `Скачиваю обновление${s.percent ? ' ' + s.percent + '%' : ''}`);
    case 'ready': return setUpdate('ok', `Версия ${s.version} скачана и поставится при закрытии.`, { label: 'Перезапустить сейчас', run: api.installUpdate });
    case 'error': return setUpdate('err', 'Не получилось проверить обновления. Нужен интернет.', { label: 'Проверить ещё раз', run: api.checkUpdate });
  }
});

api.version().then((v) => { $('version').textContent = 'Версия ' + v; });
api.modelStatus().then((s) => { state.modelReady = s.ready; });
showFolder();
resize();
