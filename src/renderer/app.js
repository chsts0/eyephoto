import * as im from './imaging.js';
import * as D from './doc.js';
import * as ui from './ui.js';

const api = window.eyephoto;
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const ACCENT = '#5aa2e0';
const RAW_RE = /\.(arw|dng|cr2|cr3|nef|raf|rw2|orf)$/i;
const PSD_RE = /\.(psd|psb)$/i;

const S = {
  docs: [],
  cur: null,          // открытый документ
  tool: 'move',
  opts: {
    move: { auto: true },
    marquee: { center: true, circle: true, feather: 8 },
    lasso: { feather: 0 },
    patch: { size: 60 },
    stamp: { size: 80, hard: 50, flow: 100 },
    brush: { size: 40, hard: 80, flow: 100, color: '#000000' },
    eraser: { size: 60, hard: 80, flow: 100 },
    burn: { size: 120, flow: 30, mode: 'burn' },
    pupil: { ratio: 23.5 },
  },
  drag: null,
  cursor: null,
  space: false,
  busy: false,
  modelReady: false,
  draftId: 0,         // слой, который сейчас показывается черновиком (тянут ползунок)
  pupil: null,        // круг инструмента «Зрачок» в пикселях своего слоя
  stampSrc: null,     // откуда берёт штамп
  ants: 0,
  lastFormat: 'A5',
  tab: 'layers',
};
window.__eyephoto = S;

// --- Общие помощники --------------------------------------------------------

function setBusy(text) {
  S.busy = !!text;
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  // даём окну нарисовать плашку до тяжёлой работы
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(draw);
}

const layer = () => (S.cur ? D.activeLayer(S.cur) : null);

// Слой, на котором можно рисовать и ретушировать.
function paintLayer() {
  const l = layer();
  if (!l) { ui.toast('Выберите слой в панели «Слои»'); return null; }
  if (!l.visible) { ui.toast('Слой скрыт. Включите его, чтобы править'); return null; }
  return l;
}

// --- Просмотр ---------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  if (S.cur && !S.cur.view.fitted) fit();
  draw();
}

function fit() {
  const d = S.cur;
  if (!d) return;
  const pad = 40, w = stage.clientWidth, h = stage.clientHeight;
  d.view.scale = Math.min((w - pad * 2) / d.w, (h - pad * 2) / d.h);
  d.view.ox = (w - d.w * d.view.scale) / 2;
  d.view.oy = (h - d.h * d.view.scale) / 2;
  d.view.fitted = true;
  refreshStatus();
  requestDraw();
}

function zoomAt(x, y, factor, absolute) {
  const d = S.cur;
  if (!d) return;
  const v = d.view;
  const next = Math.min(32, Math.max(0.02, absolute || v.scale * factor));
  v.ox = x - (x - v.ox) * (next / v.scale);
  v.oy = y - (y - v.oy) * (next / v.scale);
  v.scale = next;
  refreshStatus();
  requestDraw();
}
const center = () => [stage.clientWidth / 2, stage.clientHeight / 2];

function toDocPt(e) {
  const r = canvas.getBoundingClientRect(), v = S.cur.view;
  return { x: (e.clientX - r.left - v.ox) / v.scale, y: (e.clientY - r.top - v.oy) / v.scale };
}

const checker = (() => {
  const c = im.makeCanvas(16, 16), x = c.getContext('2d');
  x.fillStyle = '#2a2c2f'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#232528'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, 'repeat');
})();

function strokeBoth(px, dash) {
  ctx.setLineDash([]);
  ctx.lineWidth = px;
  ctx.strokeStyle = 'rgba(0,0,0,.8)';
  ctx.stroke();
  if (dash) { ctx.setLineDash([4 * px, 4 * px]); ctx.lineDashOffset = -S.ants * px; }
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.setLineDash([]);
}

function ring(c, color, handles) {
  const px = 1 / S.cur.view.scale;
  ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
  ctx.lineWidth = 1.25 * px; ctx.strokeStyle = color; ctx.stroke();
  if (!handles) return;
  ctx.fillStyle = color;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath(); ctx.arc(c.x + dx * c.r, c.y + dy * c.r, 3.5 * px, 0, Math.PI * 2); ctx.fill();
  }
}

function draw() {
  drawQueued = false;
  const dpr = window.devicePixelRatio || 1, d = S.cur;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!d) return;
  const v = d.view, px = 1 / v.scale;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = checker;
  ctx.fillRect(v.ox, v.oy, d.w * v.scale, d.h * v.scale);

  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
  ctx.imageSmoothingEnabled = v.scale < 4; // при сильном увеличении показываем честные пиксели
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, d.w, d.h); ctx.clip();
  D.composite(ctx, d, { draftId: S.draftId });
  ctx.restore();

  // выделение: «бегущие муравьи»
  const shapes = d.sel ? d.sel.shapes.slice() : [];
  const g = S.drag;
  if (g && g.shape) shapes.push(g.shape);
  for (const s of shapes) {
    ctx.beginPath();
    D.shapePath(ctx, s);
    strokeBoth(px, true);
  }

  if (g && g.type === 'patch') {
    ctx.beginPath();
    g.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (g.pts.length === 1) ctx.lineTo(g.pts[0].x + 0.01, g.pts[0].y);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.lineWidth = g.size;
    ctx.strokeStyle = 'rgba(90, 162, 224, .45)';
    ctx.stroke();
  }

  if (S.tool === 'move') {
    const act = D.activeLayers(d).filter((l) => !l.locked && l.visible);
    for (const l of act) {
      const c = D.corners(l);
      ctx.beginPath();
      c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.lineWidth = px; ctx.strokeStyle = ACCENT; ctx.stroke();
      if (act.length === 1) {
        for (const p of c) {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = ACCENT;
          ctx.beginPath(); ctx.rect(p.x - 3.5 * px, p.y - 3.5 * px, 7 * px, 7 * px); ctx.fill(); ctx.stroke();
        }
      }
    }
  }

  const pr = S.tool === 'pupil' && pupilOnDoc();
  if (pr) ring(pr, ACCENT, true);

  if (S.tool === 'stamp' && S.stampSrc) {
    const p = g && g.type === 'stroke' && g.srcNow ? g.srcNow : S.stampSrc, a = 7 * px;
    ctx.beginPath();
    ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y); ctx.moveTo(p.x, p.y - a); ctx.lineTo(p.x, p.y + a);
    strokeBoth(px, false);
  }

  const sized = S.opts[S.tool] && S.opts[S.tool].size;
  if (sized && S.cursor && !(g && g.type === 'pan')) ring({ x: S.cursor.x, y: S.cursor.y, r: sized / 2 }, '#fff', false);
}

setInterval(() => {
  if (S.cur && (S.cur.sel || (S.drag && S.drag.shape))) { S.ants = (S.ants + 1) % 8; requestDraw(); }
}, 110);

// --- Документы и вкладки ----------------------------------------------------

function addDoc(doc) {
  S.docs.push(doc);
  switchDoc(doc);
  showHome(false);
}

function switchDoc(doc) {
  S.cur = doc;
  S.drag = null;
  S.pupil = null;
  S.stampSrc = null;
  document.body.classList.toggle('no-doc', !doc);
  refreshOptions();
  refresh();
  resize();
  if (!doc) showHome(true);
}

async function closeDoc(doc) {
  if (doc.changed) {
    const go = await ui.ask({ title: `Закрыть «${doc.name}»?`, text: 'Документ не сохранён, работа пропадёт.', ok: 'Закрыть' });
    if (!go) return;
  }
  const i = S.docs.indexOf(doc);
  S.docs.splice(i, 1);
  if (S.cur === doc) switchDoc(S.docs[Math.min(i, S.docs.length - 1)] || null);
  else refreshTabs();
}

function refreshTabs() {
  const box = $('tabs');
  box.textContent = '';
  for (const d of S.docs) {
    const t = ui.el('button', 'tab' + (d === S.cur ? ' on' : ''));
    const name = ui.el('span');
    name.textContent = d.name + (d.changed ? ' •' : '');
    const x = ui.el('i', '', ui.icon('close'));
    x.title = 'Закрыть (Ctrl+W)';
    x.onclick = (e) => { e.stopPropagation(); closeDoc(d); };
    t.onclick = () => switchDoc(d);
    t.append(name, x);
    box.appendChild(t);
  }
  const plus = ui.el('button', 'tab tab-new', ui.icon('plus'));
  plus.title = 'Новый документ (Ctrl+N)';
  plus.onclick = () => showHome(true);
  box.appendChild(plus);
  api.setDirty(S.docs.some((d) => d.changed));
}

// --- Открытие файлов --------------------------------------------------------

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

const BLENDS = ['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light',
  'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

// Маска слоя из PSD запекается в его прозрачность.
function bakeMask(node, c) {
  const m = node.mask;
  if (!m || m.disabled || !m.canvas) return;
  const w = c.width, h = c.height;
  const t = im.makeCanvas(w, h), x = t.getContext('2d', { willReadFrequently: true });
  x.fillStyle = m.defaultColor === 255 ? '#fff' : '#000';
  x.fillRect(0, 0, w, h);
  x.drawImage(m.canvas, (m.left || 0) - (node.left || 0), (m.top || 0) - (node.top || 0));
  const md = x.getImageData(0, 0, w, h).data;
  const lx = c.getContext('2d'), img = lx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i + 3] = d[i + 3] * md[i] / 255;
  lx.putImageData(img, 0, 0);
}

function psdToDoc(name, bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const psd = window.agPsd.readPsd(buf, { skipThumbnail: true });
  const res = psd.imageResources && psd.imageResources.resolutionInfo;
  const doc = D.makeDoc({ name, w: psd.width, h: psd.height, dpi: Math.round((res && res.horizontalResolution) || 300), background: false });
  let skipped = 0;
  doc.slots = [];
  doc.template = true;
  const walk = (nodes, hidden, opacity) => {
    for (const n of nodes || []) {
      const hid = hidden || !!n.hidden, op = opacity * (n.opacity == null ? 1 : n.opacity);
      if (n.children) { walk(n.children, hid, op); continue; }
      if (!n.canvas || !n.canvas.width || !n.canvas.height) { skipped++; continue; }
      const c = im.cloneCanvas(n.canvas);
      bakeMask(n, c);
      // Скрытые небольшие слои в шаблонах студии это образцы: они показывают,
      // куда и какого размера ставить глаз.
      if (hid && c.width < psd.width * 0.6 && c.height < psd.height * 0.6) {
        doc.slots.push({ cx: (n.left || 0) + c.width / 2, cy: (n.top || 0) + c.height / 2, d: Math.max(c.width, c.height) });
      }
      const blend = (n.blendMode || 'normal').replace(/ /g, '-');
      const full = c.width >= psd.width && c.height >= psd.height;
      doc.layers.push(D.makeLayer({
        name: n.name || D.nextName(doc), canvas: c,
        cx: (n.left || 0) + c.width / 2, cy: (n.top || 0) + c.height / 2,
        visible: !hid, opacity: op, clip: !!n.clipping,
        blend: BLENDS.includes(blend) ? blend : 'source-over',
        locked: true, // оформление шаблона закреплено, чтобы его не сдвинули случайно; замок снимается щелчком
      }));
    }
  };
  walk(psd.children, false, 1);
  if (!doc.layers.length && psd.canvas) {
    doc.layers.push(D.makeLayer({ name: 'Фон', canvas: im.cloneCanvas(psd.canvas), cx: psd.width / 2, cy: psd.height / 2 }));
  }
  doc.counter = doc.layers.length + 1;
  const top = doc.layers[doc.layers.length - 1];
  if (top) doc.active = [top.id];
  return { doc, skipped };
}

function sheetDoc(key) {
  const f = im.FORMATS[key];
  S.lastFormat = key;
  const n = S.docs.filter((d) => d.sheet).length + 1;
  const doc = D.makeDoc({ name: `${f.label} · ${n}`, w: f.w, h: f.h });
  doc.sheet = true;
  doc.active = [];
  return doc;
}

// Кладёт снимок слоем в текущий документ, вписывая его в лист.
function placeCanvas(doc, c, name, photo) {
  const k = Math.min(doc.w / c.width, doc.h / c.height, 1);
  D.structEdit(doc, 'Поместить снимок', () => {
    const l = D.makeLayer({
      name: name.replace(/\.[^.]+$/, ''), canvas: c, cx: doc.w / 2, cy: doc.h / 2, scale: k,
      kind: photo ? 'photo' : 'pixel',
      adjust: photo ? { ...im.DEFAULT_ADJUST } : null,
    });
    doc.layers.push(l);
    doc.active = [l.id];
  });
}

// file: { name, kind: raw | image | psd, data }. how: 'place' — слоем в текущий документ,
// 'open' — отдельным документом.
async function openData(file, how) {
  if (S.busy || !file) return;
  await setBusy(file.kind === 'raw' ? 'Проявляю снимок с камеры' : file.kind === 'psd' ? 'Открываю шаблон' : 'Открываю снимок');
  try {
    if (file.kind === 'psd') {
      const { doc, skipped } = psdToDoc(file.name.replace(PSD_RE, ''), file.data);
      addDoc(doc);
      if (skipped) ui.toast(`Не перенесено слоёв: ${skipped}. Корректирующие слои и эффекты пока не поддерживаются`);
    } else {
      const c = file.kind === 'raw' ? await decodeRaw(file.data) : await decodeImage(file.data);
      if (how === 'open') {
        const doc = D.makeDoc({ name: file.name.replace(/\.[^.]+$/, ''), w: c.width, h: c.height, dpi: 300, background: false });
        addDoc(doc);
        placeCanvas(doc, c, file.name, true);
        doc.undo = []; doc.changed = false;
      } else {
        if (!S.cur) addDoc(sheetDoc(S.lastFormat));
        showHome(false);
        placeCanvas(S.cur, c, file.name, true);
        fit();
        setTool('marquee'); // первым делом снимок обводят кругом по радужке
      }
    }
  } catch (e) {
    console.error(e);
    setBusy('');
    await ui.tell('Не получилось открыть файл', 'Подойдут ARW с камеры, JPG, PNG и PSD. Возможно, файл повреждён.');
    return;
  }
  setBusy('');
  refresh();
  requestDraw();
}

const fileKind = (name) => (RAW_RE.test(name) ? 'raw' : PSD_RE.test(name) ? 'psd' : 'image');

async function openDialog(how) {
  if (S.busy) return;
  const file = await api.openFile(how === 'place' ? 'photo' : 'any');
  if (file) openData(file, how);
}
window.__openPath = async (p, how) => openData(await api.openPath(p), how || 'place');

// --- Стартовый экран --------------------------------------------------------

async function showHome(on) {
  const home = $('home'), over = !!S.cur;
  home.hidden = !on;
  home.classList.toggle('over', over);
  $('homeClose').hidden = !over;
  if (!on) return;
  const t = await api.templates();
  $('tplFolder').textContent = t.dir ? 'Сменить папку' : 'Выбрать папку';
  const box = $('tplCards');
  box.textContent = '';
  for (const item of t.items) {
    const card = ui.el('button', 'card');
    card.append(ui.el('div', 'card-art', ui.icon('sheet')), ui.el('div', 'card-name'), ui.el('div', 'card-note', 'PSD'));
    card.children[1].textContent = item.name;
    card.title = item.name;
    card.onclick = async () => openData(await api.readTemplate(item.file), 'open');
    box.appendChild(card);
    templateThumb(item, card.firstChild);
  }
  const empty = $('tplEmpty');
  empty.hidden = t.items.length > 0;
  empty.textContent = !t.dir
    ? 'Укажите папку, где лежат PSD-шаблоны: полароид, стикеры, магнит. Они появятся здесь кнопками.'
    : t.missing ? 'Папка с шаблонами не найдена. Выберите её заново.' : 'В выбранной папке нет файлов PSD.';
}

// Маленькая картинка шаблона: берётся из самого PSD и запоминается,
// чтобы не читать файлы при каждом открытии стартового экрана.
async function templateThumb(item, art) {
  const key = `tpl:${item.file}:${item.stamp}`;
  let url = null, note = '';
  try { [note, url] = JSON.parse(localStorage.getItem(key)); } catch { /* ещё не считали */ }
  if (!url) {
    try {
      const f = await api.readTemplate(item.file);
      const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
      const psd = window.agPsd.readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true });
      const t = psd.imageResources && psd.imageResources.thumbnail;
      if (!t) return;
      url = t.toDataURL('image/jpeg', 0.8);
      const res = psd.imageResources.resolutionInfo, dpi = (res && res.horizontalResolution) || 300;
      const cm = (v) => String(Math.round(v / dpi * 25.4) / 10).replace('.', ',');
      note = `${cm(Math.min(psd.width, psd.height))} × ${cm(Math.max(psd.width, psd.height))} см`;
      try { localStorage.setItem(key, JSON.stringify([note, url])); } catch { /* не поместилось, не страшно */ }
    } catch { return; }
  }
  art.parentNode.lastChild.textContent = note;
  const img = new Image();
  img.src = url;
  art.textContent = '';
  art.appendChild(img);
}

for (const [key, f] of Object.entries(im.FORMATS)) {
  const card = ui.el('button', 'card');
  const art = ui.el('div', 'card-art');
  const k = 100 / im.FORMATS.A3.w;
  const sheet = ui.el('b');
  sheet.style.width = f.w * k + 'px';
  sheet.style.height = f.h * k + 'px';
  art.appendChild(sheet);
  card.append(art, ui.el('div', 'card-name', f.label), ui.el('div', 'card-note', f.note));
  card.onclick = () => addDoc(sheetDoc(key));
  $('sheetCards').appendChild(card);
}
$('homeClose').innerHTML = ui.icon('close');
$('homeClose').onclick = () => showHome(false);
$('homeOpen').innerHTML = 'Открыть файл…';
$('homeOpen').onclick = () => openDialog('open');
$('tplFolder').onclick = async () => { if (await api.chooseTemplates()) showHome(true); };

// --- Нейронка ---------------------------------------------------------------

async function ensureModel() {
  if (S.modelReady) return true;
  if ((await api.modelStatus()).ready) return (S.modelReady = true);
  const go = await ui.ask({
    title: 'Нужно один раз скачать нейронку',
    text: 'Она убирает блики и ресницы. Весит 200 МБ, скачивается один раз и дальше работает без интернета.',
    ok: 'Скачать',
  });
  if (!go) return false;
  const p = ui.progress('Скачиваю нейронку', 'Не закрывайте программу.');
  api.onModelProgress((v) => p.set(v));
  const res = await api.modelDownload();
  p.close();
  if (!res.ok) { await ui.tell('Не получилось скачать', 'Проверьте интернет и попробуйте ещё раз.'); return false; }
  return (S.modelReady = true);
}

// paint(ctx) рисует в координатах листа то, что надо убрать. box — границы на листе.
async function neuralRemove(l, paint, box) {
  const d = S.cur;
  const pad = Math.max(4, Math.min(l.canvas.width, l.canvas.height) / 160);
  const bbox = D.localRect(l, box, pad);
  if (bbox.w < 2 || bbox.h < 2) { ui.toast('Выделение не попадает на выбранный слой'); return; }
  if (!(await ensureModel())) return;
  const region = im.patchRegion(l.canvas, bbox);
  const mask = im.makeCanvas(region.w, region.h), mx = mask.getContext('2d');
  mx.translate(-region.x, -region.y);
  paint(mx, (c) => { c.translate(-region.x, -region.y); D.docToLayerTransform(c, l); }, pad);
  const before = l.canvas.getContext('2d').getImageData(region.x, region.y, region.w, region.h);
  await setBusy('Убираю лишнее');
  try {
    await im.inpaintPatch(l.canvas, mask, region, (rgba, m) => api.inpaint({ rgba, mask: m }));
    D.pushPixels(d, l, 'Убрать нейронкой', region.x, region.y, before);
  } catch (e) {
    console.error(e);
    setBusy('');
    await ui.tell('Нейронка не сработала', 'Попробуйте ещё раз. Если повторится, перезапустите программу.');
  }
  setBusy('');
  refresh();
  requestDraw();
}

function removeSelection() {
  const d = S.cur, l = d && d.sel && paintLayer();
  if (!l) return;
  const sel = d.sel;
  neuralRemove(l, (_mx, setT, pad) => {
    const m = D.selMask(sel, _mx.canvas.width, _mx.canvas.height, setT, { grow: pad });
    _mx.setTransform(1, 0, 0, 1, 0, 0);
    _mx.drawImage(m, 0, 0);
  }, D.selBounds(sel)).then(() => { d.sel = null; refresh(); });
}

function removeStroke(l, g) {
  const xs = g.pts.map((p) => p.x), ys = g.pts.map((p) => p.y), r = g.size / 2;
  const box = { x: Math.min(...xs) - r, y: Math.min(...ys) - r, w: Math.max(...xs) - Math.min(...xs) + g.size, h: Math.max(...ys) - Math.min(...ys) + g.size };
  neuralRemove(l, (mx, setT) => {
    mx.setTransform(1, 0, 0, 1, 0, 0);
    setT(mx);
    mx.strokeStyle = '#fff'; mx.lineJoin = mx.lineCap = 'round'; mx.lineWidth = g.size;
    mx.beginPath();
    g.pts.forEach((p, i) => (i ? mx.lineTo(p.x, p.y) : mx.moveTo(p.x, p.y)));
    if (g.pts.length === 1) mx.lineTo(g.pts[0].x + 0.01, g.pts[0].y);
    mx.stroke();
  }, box);
}

// --- Действия со слоями -----------------------------------------------------

function newLayer() {
  const d = S.cur;
  D.structEdit(d, 'Новый слой', () => {
    const l = D.makeLayer({ name: D.nextName(d), canvas: im.makeCanvas(d.w, d.h), cx: d.w / 2, cy: d.h / 2 });
    const top = D.activeLayer(d);
    d.layers.splice(top ? d.layers.indexOf(top) + 1 : d.layers.length, 0, l);
    d.active = [l.id];
  });
  refresh(); requestDraw();
}

// Ctrl+J: с выделением вырезает его на новый слой, без выделения дублирует слой.
function copyToLayer() {
  const d = S.cur, l = layer();
  if (!l) { ui.toast('Выберите слой в панели «Слои»'); return; }
  let c, cx = l.cx, cy = l.cy;
  if (d.sel) {
    const f = d.sel.feather / l.scale;
    const r = D.localRect(l, D.selBounds(d.sel), f * 2 + 2);
    if (r.w < 2 || r.h < 2) { ui.toast('Выделение не попадает на выбранный слой'); return; }
    c = im.makeCanvas(r.w, r.h);
    const x = c.getContext('2d');
    x.drawImage(l.canvas, -r.x, -r.y);
    const mask = D.selMask(d.sel, r.w, r.h, (m) => { m.translate(-r.x, -r.y); D.docToLayerTransform(m, l); }, { feather: f });
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(mask, 0, 0);
    x.globalCompositeOperation = 'source-over'; // иначе этот режим останется на слое и испортит кисти
    ({ x: cx, y: cy } = D.toDoc(l, { x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  } else {
    c = im.cloneCanvas(l.canvas);
  }
  // Круг, вырезанный из снимка, это и есть глаз: с ним дальше работают раскладки.
  const isEye = !!d.sel && l.kind === 'photo';
  let made;
  D.structEdit(d, d.sel ? 'Вырезать на новый слой' : 'Дублировать слой', () => {
    made = D.makeLayer({
      name: isEye ? `Глаз ${d.eyes = (d.eyes || 0) + 1}` : d.sel ? D.nextName(d) : l.name + ' копия',
      kind: isEye ? 'eye' : d.sel ? 'pixel' : l.kind,
      canvas: c, cx, cy, scale: l.scale, rot: l.rot,
      adjust: l.adjust && { ...l.adjust }, opacity: l.opacity,
    });
    d.layers.splice(d.layers.indexOf(l) + 1, 0, made);
    d.active = [made.id];
    if (isEye) l.visible = false; // исходник после вырезания на листе больше не нужен
  });
  d.sel = null;
  S.pupil = null;
  if (isEye) {
    // дальше по делу идёт ретушь: показываем глаз крупно и даём лассо
    zoomToLayer(made);
    setTool('lasso');
  }
  refresh(); requestDraw();
}

function zoomToLayer(l) {
  const d = S.cur, b = D.bounds(l), w = stage.clientWidth, h = stage.clientHeight;
  d.view.scale = Math.min(w / (b.w * 1.2), h / (b.h * 1.2), 8);
  d.view.ox = w / 2 - (b.x + b.w / 2) * d.view.scale;
  d.view.oy = h / 2 - (b.y + b.h / 2) * d.view.scale;
  refreshStatus();
  requestDraw();
}

function deleteLayers() {
  const d = S.cur, act = D.activeLayers(d).filter((l) => !l.locked);
  if (!act.length) return;
  D.structEdit(d, 'Удалить слой', () => {
    d.layers = d.layers.filter((l) => !act.includes(l));
    d.active = [];
  });
  refresh(); requestDraw();
}

// Del: с выделением стирает его содержимое, без выделения удаляет слой.
function clearSelection() {
  const d = S.cur;
  if (!d.sel) return deleteLayers();
  const l = paintLayer();
  if (!l) return;
  const r = D.localRect(l, D.selBounds(d.sel), d.sel.feather * 2 / l.scale + 2);
  if (r.w < 1 || r.h < 1) return;
  const x = l.canvas.getContext('2d');
  const before = x.getImageData(r.x, r.y, r.w, r.h);
  const mask = D.selMask(d.sel, r.w, r.h, (m) => { m.translate(-r.x, -r.y); D.docToLayerTransform(m, l); }, { feather: d.sel.feather / l.scale });
  x.save();
  x.globalCompositeOperation = 'destination-out';
  x.drawImage(mask, r.x, r.y);
  x.restore();
  D.pushPixels(d, l, 'Очистить', r.x, r.y, before);
  refresh(); requestDraw();
}

function moveOrder(dir) {
  const d = S.cur, l = layer();
  if (!l || l.locked) return;
  const i = d.layers.indexOf(l), j = i + dir;
  if (j < 0 || j >= d.layers.length || d.layers[j].locked) return;
  D.structEdit(d, 'Порядок слоёв', () => { d.layers.splice(i, 1); d.layers.splice(j, 0, l); });
  refresh(); requestDraw();
}

function toggleClip() {
  const d = S.cur, l = layer();
  if (!l || l.locked || d.layers.indexOf(l) === 0) return;
  D.structEdit(d, l.clip ? 'Снять обтравку' : 'Обтравочная маска', () => { l.clip = !l.clip; });
  refresh(); requestDraw();
}

const movable = (d) => d.layers.filter((l) => l.visible && !l.locked);
const eyesOf = (d) => movable(d).filter((l) => l.kind === 'eye');

// Пара для раскладки: два выделенных слоя, а если выделено не два,
// то два глаза, которые есть на листе.
function pairTargets(quiet) {
  const d = S.cur, act = D.activeLayers(d).filter((l) => !l.locked && l.visible);
  if (act.length === 2) return act;
  const eyes = eyesOf(d);
  if (eyes.length === 2) return eyes;
  if (!quiet) {
    ui.toast(eyes.length < 2 ? 'Для пары нужно два глаза на листе. Сейчас готовых: ' + eyes.length
      : 'На листе больше двух глаз. Выделите нужные два: щелчок и Ctrl+щелчок в панели «Слои»');
  }
  return null;
}

function singleTarget(quiet) {
  const d = S.cur, l = layer();
  if (l && !l.locked && l.visible) return l;
  const eyes = eyesOf(d);
  if (eyes.length === 1) return eyes[0];
  if (!quiet) ui.toast('Выберите слой с глазом в панели «Слои»');
  return null;
}

function layoutPair(type) {
  const d = S.cur, pair = pairTargets();
  if (!pair) return;
  // кто левее на листе, тот и левый; если стоят одинаково, левый тот, что ниже в слоях
  const [left, right] = pair.slice().sort((a, b) => (Math.abs(a.cx - b.cx) > 1 ? a.cx - b.cx : d.layers.indexOf(a) - d.layers.indexOf(b)));
  const slots = im.pairSlots(d.w, d.h, type);
  D.structEdit(d, type === 'whole' ? 'Раскладка «Целые»' : 'Раскладка «Углы»', () => {
    [left, right].forEach((l, i) => {
      l.scale = slots[i].d / Math.max(l.canvas.width, l.canvas.height);
      l.cx = slots[i].cx; l.cy = slots[i].cy; l.rot = 0;
    });
    d.active = [left.id, right.id];
  });
  fit(); refresh();
}

function layoutSwap() {
  const d = S.cur, pair = pairTargets();
  if (!pair) return;
  const [a, b] = pair, size = (l) => Math.max(l.canvas.width, l.canvas.height);
  D.structEdit(d, 'Поменять глаза местами', () => {
    const pa = { cx: a.cx, cy: a.cy, d: size(a) * a.scale }, pb = { cx: b.cx, cy: b.cy, d: size(b) * b.scale };
    a.cx = pb.cx; a.cy = pb.cy; a.scale = pb.d / size(a);
    b.cx = pa.cx; b.cy = pa.cy; b.scale = pa.d / size(b);
  });
  refresh(); requestDraw();
}

function layoutSingle() {
  const d = S.cur, l = singleTarget();
  if (!l) return;
  D.structEdit(d, 'По центру', () => {
    l.scale = im.singleIris(d.w, d.h) / Math.max(l.canvas.width, l.canvas.height);
    l.cx = d.w / 2; l.cy = d.h / 2; l.rot = 0;
    d.active = [l.id];
  });
  fit(); refresh();
}

// Ставит глаза в места, отмеченные в шаблоне скрытыми образцами.
// Если мест больше, чем глаз, глаз повторяется (лист с несколькими стикерами).
function layoutSlots() {
  const d = S.cur, eyes = eyesOf(d).filter((l) => !l.slotCopy);
  if (!eyes.length) { ui.toast('Сначала вырежьте глаз: круг по радужке и Ctrl+J'); return; }
  D.structEdit(d, 'По местам шаблона', () => {
    d.layers = d.layers.filter((l) => !l.slotCopy);
    d.slots.forEach((slot, i) => {
      let l = eyes[i];
      if (!l) {
        const src = eyes[i % eyes.length];
        l = D.makeLayer({ name: src.name + ' копия', kind: 'eye', slotCopy: true, canvas: src.canvas, adjust: src.adjust && { ...src.adjust } });
        d.layers.push(l);
      }
      l.scale = slot.d / Math.max(l.canvas.width, l.canvas.height);
      l.cx = slot.cx; l.cy = slot.cy; l.rot = 0;
    });
    d.active = [eyes[0].id];
  });
  fit(); refresh();
}

function refreshActions() {
  const d = S.cur, box = $('actions');
  box.textContent = '';
  if (!d) return;
  const pair = !!pairTargets(true), one = !!singleTarget(true);
  const btn = (label, title, fn, on, cls = '') => {
    const b = ui.el('button', 'btn ' + cls, label);
    b.title = title; b.onclick = fn; b.disabled = !on;
    box.appendChild(b);
  };
  if (d.slots && d.slots.length) {
    btn(`По местам шаблона (${d.slots.length})`, 'Поставить глаз туда, где в шаблоне лежат скрытые образцы', layoutSlots, eyesOf(d).length > 0, 'full');
  }
  btn('Углы', 'Два глаза крупно, по диагонали, с обрезкой краями листа', () => layoutPair('corners'), pair);
  btn('Целые', 'Два глаза целиком, по диагонали', () => layoutPair('whole'), pair);
  btn('По центру', 'Один глаз по центру листа в стандартном размере', layoutSingle, one);
  btn('Поменять местами', 'Левый глаз становится правым и наоборот', layoutSwap, pair, 'full');
}

function history(back) {
  const d = S.cur;
  if (!d || S.busy || !D.stepHistory(d, back)) return;
  S.pupil = null;
  refresh(); requestDraw();
}

// --- Сохранение -------------------------------------------------------------

async function sheetJpeg(d) {
  const sheet = D.flatten(d);
  const blob = await new Promise((r) => sheet.toBlob(r, 'image/jpeg', 0.97));
  return im.setJpegDpi(await blob.arrayBuffer(), d.dpi);
}

async function saveNumbered() {
  const d = S.cur;
  if (!d || S.busy) return;
  let { savePath } = await api.settings();
  if (!savePath) {
    await ui.tell('Куда сохранять готовые фото', 'Сейчас выберите папку. Внутри неё сами создадутся папки месяца и дня.');
    savePath = await api.chooseSaveRoot();
    if (!savePath) return;
  }
  const number = await ui.ask({
    title: 'Сохранить JPEG',
    text: savePath,
    ok: 'Сохранить',
    input: {
      prefix: '4-', maxLength: 4, placeholder: '0000', note: 'номер фото, 4 цифры',
      filter: (v) => v.replace(/\D/g, '').slice(0, 4),
      validate: (v) => (/^\d{4}$/.test(v) ? '' : 'Нужно ровно 4 цифры, например 1233'),
    },
  });
  if (!number) return;
  await setBusy('Сохраняю');
  const data = await sheetJpeg(d);
  let res = await api.saveJpeg({ number, data, overwrite: false });
  setBusy('');
  if (res.status === 'exists') {
    if (!(await ui.ask({ title: `Файл 4-${number}.jpg уже есть`, text: 'Заменить его новым?', ok: 'Заменить' }))) return;
    res = await api.saveJpeg({ number, data, overwrite: true });
  }
  if (res.status === 'ok') {
    d.changed = false;
    refreshTabs();
    ui.toast('Сохранено: ' + res.file);
  } else {
    await ui.tell('Не получилось сохранить', 'Проверьте, что папка доступна: Файл → Папка готовых фото.');
  }
}

async function exportAs() {
  const d = S.cur;
  if (!d || S.busy) return;
  await setBusy('Готовлю файл');
  const jpg = await sheetJpeg(d);
  const png = new Uint8Array(await (await new Promise((r) => D.flatten(d, null).toBlob(r, 'image/png'))).arrayBuffer());
  setBusy('');
  // формат выбирается в окне сохранения, поэтому отдаём оба варианта по расширению
  const file = await api.exportFile({ name: d.name + '.jpg', data: jpg, png });
  if (file) { d.changed = false; refreshTabs(); ui.toast('Сохранено: ' + file); }
}

// --- Инструменты ------------------------------------------------------------

const TOOLS = [
  ['move', 'Перемещение', 'V', 'Тяните слой, чтобы подвинуть. Углы рамки меняют размер, снаружи от угла поворот. Shift: шаг 15°'],
  ['marquee', 'Овальная область', 'M', 'Тяните от центра радужки. Круг потом двигается за середину и меняется за край. Ctrl+J: вырезать на новый слой'],
  ['lasso', 'Лассо', 'L', 'Обведите блик или ресницу с запасом. Shift: добавить к выделению, Alt: вычесть'],
  '-',
  ['patch', 'Заплатка', 'J', 'Закрасьте лишнее. Нейронка уберёт, когда отпустите мышку'],
  ['stamp', 'Штамп', 'S', 'Alt+щелчок: откуда брать. Потом рисуйте там, куда переносить'],
  ['brush', 'Кисть', 'B', 'Рисует выбранным цветом на активном слое'],
  ['eraser', 'Ластик', 'E', 'Стирает пиксели активного слоя до прозрачности'],
  ['burn', 'Затемнитель', 'O', 'Каждый проход делает темнее. С Alt осветляет'],
  ['pupil', 'Зрачок', 'P', 'Поставьте круг по краю зрачка и нажмите «Сузить зрачок» или Enter'],
  '-',
  ['hand', 'Рука', 'H', 'Двигает картинку. То же самое делает пробел с любым инструментом'],
  ['zoom', 'Масштаб', 'Z', 'Щелчок приближает, Alt+щелчок отдаляет. Колесо работает всегда'],
];
const toolInfo = (id) => TOOLS.find((t) => t !== '-' && t[0] === id);

for (const t of TOOLS) {
  if (t === '-') { $('tools').appendChild(ui.el('div', 'tool-sep')); continue; }
  const b = ui.el('button', 'tool', ui.icon(t[0]));
  b.dataset.tool = t[0];
  b.title = `${t[1]} (${t[2]})`;
  b.onclick = () => setTool(t[0]);
  $('tools').appendChild(b);
}

function initPupil() {
  const l = layer();
  if (!l || !l.visible) { S.pupil = null; return; }
  if (S.pupil && S.pupil.layerId === l.id) return;
  const g = im.guessPupil(l.canvas);
  S.pupil = { layerId: l.id, x: g.x, y: g.y, r: g.r };
}

// Тот же круг в координатах листа, чтобы рисовать его и ловить мышкой.
function pupilOnDoc() {
  const l = S.pupil && S.cur && D.layerById(S.cur, S.pupil.layerId);
  if (!l) return null;
  const c = D.toDoc(l, S.pupil);
  return { x: c.x, y: c.y, r: S.pupil.r * l.scale, layer: l };
}

function setTool(id) {
  S.tool = id;
  S.drag = null;
  if (id === 'pupil') initPupil();
  refreshOptions();
  refreshStatus();
  canvas.style.cursor = id === 'hand' ? 'grab' : id === 'zoom' ? 'zoom-in' : id === 'move' || id === 'pupil' ? 'default' : 'crosshair';
  requestDraw();
}

function applyPupil() {
  const d = S.cur, l = paintLayer();
  if (!l || !S.pupil || S.busy) return;
  if (S.pupil.layerId !== l.id) { S.pupil = null; initPupil(); }
  const lp = { x: S.pupil.x, y: S.pupil.y, r: S.pupil.r };
  const R = Math.min(l.canvas.width, l.canvas.height) / 2, ratio = S.opts.pupil.ratio / 100;
  const rect = im.pupilRect(l.canvas, lp, R);
  if (rect.w < 2 || rect.h < 2) return;
  const before = l.canvas.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h);
  im.shrinkPupil(l.canvas, lp, R, ratio);
  D.pushPixels(d, l, 'Сузить зрачок', rect.x, rect.y, before);
  S.pupil.r = R * ratio;
  refresh(); requestDraw();
}

// Мазок кистью, ластиком, штампом или затемнителем. Рисуем сразу в пиксели слоя.
function beginStroke(l, mode, p, e) {
  const o = S.opts[S.tool];
  const g = { type: 'stroke', mode, layer: l, snap: im.cloneCanvas(l.canvas), last: null, box: null };
  g.targets = [{ x: l.canvas.getContext('2d'), k: 1, snap: g.snap }];
  if (l.adjust) {
    // проявленную копию правим теми же мазками, чтобы результат было видно сразу
    const v = D.layerView(l);
    g.targets.push({ x: v.canvas.getContext('2d'), k: v.k, snap: mode === 'stamp' ? im.cloneCanvas(v.canvas) : null });
  }
  if (mode === 'burn') g.dodge = (o.mode === 'dodge') !== e.altKey;
  if (mode === 'stamp') {
    const a = D.toLocal(l, S.stampSrc), b = D.toLocal(l, p);
    g.off = { x: a.x - b.x, y: a.y - b.y };
    g.srcDelta = { x: S.stampSrc.x - p.x, y: S.stampSrc.y - p.y };
  }
  S.drag = g;
  dab(g, p);
}

function dab(g, p) {
  const o = S.opts[S.tool], l = g.layer;
  const q = D.toLocal(l, p), r = o.size / 2 / l.scale;
  const hard = Math.min(0.98, (o.hard == null ? 0 : o.hard) / 100), flow = o.flow / 100;
  for (const t of g.targets) {
    const x = t.x, k = t.k, cx = q.x * k, cy = q.y * k, rr = Math.max(0.5, r * k);
    const grad = (color, a) => {
      const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gr.addColorStop(0, `rgba(${color},${a})`);
      gr.addColorStop(hard, `rgba(${color},${a})`);
      gr.addColorStop(1, `rgba(${color},0)`);
      return gr;
    };
    x.save();
    x.globalCompositeOperation = 'source-over';
    x.globalAlpha = 1;
    if (g.mode === 'stamp') {
      const s = Math.ceil(rr * 2) + 2, tmp = im.makeCanvas(s, s), tx = tmp.getContext('2d');
      tx.drawImage(t.snap, (q.x + g.off.x) * k - s / 2, (q.y + g.off.y) * k - s / 2, s, s, 0, 0, s, s);
      const gr = tx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, rr);
      gr.addColorStop(0, `rgba(0,0,0,${flow})`); gr.addColorStop(hard, `rgba(0,0,0,${flow})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      tx.globalCompositeOperation = 'destination-in';
      tx.fillStyle = gr; tx.fillRect(0, 0, s, s);
      x.drawImage(tmp, cx - s / 2, cy - s / 2);
    } else {
      if (g.mode === 'erase') { x.globalCompositeOperation = 'destination-out'; x.fillStyle = grad('0,0,0', flow); }
      else if (g.mode === 'burn') { x.globalCompositeOperation = 'source-atop'; x.fillStyle = grad(g.dodge ? '255,255,255' : '0,0,0', flow * 0.2); }
      else {
        const c = o.color;
        x.fillStyle = grad(`${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)}`, flow);
      }
      x.beginPath(); x.arc(cx, cy, rr, 0, Math.PI * 2); x.fill();
    }
    x.restore();
  }
  const b = g.box || (g.box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  b.x0 = Math.min(b.x0, q.x - r - 1); b.y0 = Math.min(b.y0, q.y - r - 1);
  b.x1 = Math.max(b.x1, q.x + r + 1); b.y1 = Math.max(b.y1, q.y + r + 1);
  g.last = p;
  if (g.srcDelta) g.srcNow = { x: p.x + g.srcDelta.x, y: p.y + g.srcDelta.y };
}

function strokeTo(g, p) {
  const step = Math.max(1, S.opts[S.tool].size * 0.12);
  const dx = p.x - g.last.x, dy = p.y - g.last.y, dist = Math.hypot(dx, dy);
  if (dist < step) return;
  const from = g.last;
  for (let t = step; t <= dist; t += step) dab(g, { x: from.x + dx * t / dist, y: from.y + dy * t / dist });
}

const STROKE_NAMES = { paint: 'Кисть', erase: 'Ластик', burn: 'Затемнитель', stamp: 'Штамп' };

function endStroke(g) {
  const l = g.layer, b = g.box;
  const x = Math.max(0, Math.floor(b.x0)), y = Math.max(0, Math.floor(b.y0));
  const w = Math.min(l.canvas.width, Math.ceil(b.x1)) - x, h = Math.min(l.canvas.height, Math.ceil(b.y1)) - y;
  if (w > 0 && h > 0) {
    const before = g.snap.getContext('2d').getImageData(x, y, w, h);
    D.pushPixels(S.cur, l, g.mode === 'burn' && g.dodge ? 'Осветлитель' : STROKE_NAMES[g.mode], x, y, before);
  }
  refresh();
}

// Круг двигается за середину и меняет размер за край.
function circleHit(c, p) {
  const d = Math.hypot(p.x - c.x, p.y - c.y), tol = 7 / S.cur.view.scale;
  if (Math.abs(d - c.r) <= tol) return 'edge';
  return d < c.r ? 'in' : '';
}

function soleEllipse() {
  const sel = S.cur.sel;
  return sel && sel.shapes.length === 1 && sel.shapes[0].type === 'ellipse' ? sel.shapes[0] : null;
}

function moveHit(p) {
  const d = S.cur, act = D.activeLayers(d).filter((l) => !l.locked && l.visible);
  if (act.length !== 1) return null;
  const l = act[0], k = d.view.scale, cs = D.corners(l);
  let best = -1, dist = Infinity;
  cs.forEach((c, i) => { const v = Math.hypot(c.x - p.x, c.y - p.y) * k; if (v < dist) { dist = v; best = i; } });
  if (dist <= 8) return { type: 'scale', layer: l, corner: best };
  const q = D.toLocal(l, p), out = q.x < 0 || q.y < 0 || q.x > l.canvas.width || q.y > l.canvas.height;
  if (dist <= 28 && out) return { type: 'rotate', layer: l };
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  const d = S.cur;
  if (!d || S.busy) return;
  const p = toDocPt(e), o = S.opts[S.tool];
  canvas.setPointerCapture(e.pointerId);
  if (e.button !== 0 || S.space || S.tool === 'hand') { S.drag = { type: 'pan' }; canvas.style.cursor = 'grabbing'; return; }

  if (S.tool === 'zoom') {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.altKey ? 1 / 1.5 : 1.5);
  } else if (S.tool === 'move') {
    const h = moveHit(p);
    if (h) {
      const l = h.layer;
      S.drag = { ...h, commit: D.beginStruct(d), start: p, s0: l.scale, r0: l.rot, c0: { x: l.cx, y: l.cy } };
      if (h.type === 'scale') S.drag.anchor = D.corners(l)[(h.corner + 2) % 4];
    } else {
      const under = d.layers.slice().reverse().find((l) => l.visible && !l.locked && D.hit(l, p));
      if (under && o.auto && !d.active.includes(under.id)) {
        d.active = e.shiftKey || e.ctrlKey ? [...d.active, under.id] : [under.id];
        refresh();
      }
      const act = D.activeLayers(d).filter((l) => !l.locked && l.visible);
      const inside = act.some((l) => { const b = D.bounds(l); return p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h; });
      if (act.length && (under || inside)) {
        S.drag = { type: 'move', commit: D.beginStruct(d), start: p, layers: act.map((l) => ({ l, x: l.cx, y: l.cy })), moved: false };
      }
    }
  } else if (S.tool === 'marquee') {
    const one = soleEllipse(), h = one && !e.shiftKey ? circleHit({ x: one.cx, y: one.cy, r: Math.max(one.rx, one.ry) }, p) : '';
    if (h === 'edge') S.drag = { type: 'selresize', s: one, k: one.ry / one.rx };
    else if (h === 'in') S.drag = { type: 'selmove', s: one, dx: p.x - one.cx, dy: p.y - one.cy };
    else S.drag = { type: 'marquee', start: p, add: e.shiftKey, shape: { type: 'ellipse', cx: p.x, cy: p.y, rx: 0, ry: 0 } };
  } else if (S.tool === 'lasso') {
    S.drag = { type: 'lasso', add: e.shiftKey, shape: { type: 'poly', pts: [p], sub: e.altKey } };
  } else if (S.tool === 'pupil') {
    initPupil();
    const c = pupilOnDoc(), h = c ? circleHit(c, p) : '';
    if (h === 'edge') S.drag = { type: 'pupilresize', c };
    else if (h === 'in') S.drag = { type: 'pupilmove', c, dx: p.x - c.x, dy: p.y - c.y };
  } else if (S.tool === 'patch') {
    if (paintLayer()) S.drag = { type: 'patch', pts: [p], size: o.size };
  } else if (S.tool === 'stamp') {
    if (e.altKey) { S.stampSrc = p; ui.toast('Источник задан. Теперь рисуйте там, куда переносить'); }
    else if (!S.stampSrc) ui.toast('Сначала Alt+щелчок там, откуда брать');
    else { const l = paintLayer(); if (l) beginStroke(l, 'stamp', p, e); }
  } else if (S.tool === 'brush' || S.tool === 'eraser' || S.tool === 'burn') {
    const l = paintLayer();
    if (l) beginStroke(l, S.tool === 'brush' ? 'paint' : S.tool === 'eraser' ? 'erase' : 'burn', p, e);
  }
  requestDraw();
});

canvas.addEventListener('pointermove', (e) => {
  const d = S.cur;
  if (!d) return;
  const p = toDocPt(e), g = S.drag;
  S.cursor = p;
  if (!g) {
    if (S.tool === 'move') {
      const h = moveHit(p);
      canvas.style.cursor = !h ? 'default' : h.type === 'scale' ? 'nwse-resize' : 'alias';
    } else if (S.tool === 'marquee' || S.tool === 'pupil') {
      const one = S.tool === 'pupil' ? pupilOnDoc() : soleEllipse();
      const h = one ? circleHit(S.tool === 'pupil' ? one : { x: one.cx, y: one.cy, r: Math.max(one.rx, one.ry) }, p) : '';
      canvas.style.cursor = h === 'edge' ? 'nwse-resize' : h === 'in' ? 'move' : S.tool === 'pupil' ? 'default' : 'crosshair';
    }
    if (S.opts[S.tool] && S.opts[S.tool].size) requestDraw();
    return;
  }
  if (g.type === 'pan') {
    d.view.ox += e.movementX; d.view.oy += e.movementY;
  } else if (g.type === 'move') {
    let dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    for (const m of g.layers) { m.l.cx = m.x + dx; m.l.cy = m.y + dy; }
    g.moved = true;
  } else if (g.type === 'scale') {
    const l = g.layer, a = e.altKey ? g.c0 : g.anchor;
    const vx = g.start.x - a.x, vy = g.start.y - a.y;
    const f = Math.max(0.02, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy));
    l.scale = g.s0 * f;
    l.cx = a.x + (g.c0.x - a.x) * f; l.cy = a.y + (g.c0.y - a.y) * f;
    g.moved = true;
  } else if (g.type === 'rotate') {
    const l = g.layer;
    let r = g.r0 + Math.atan2(p.y - l.cy, p.x - l.cx) - Math.atan2(g.start.y - l.cy, g.start.x - l.cx);
    if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
    l.rot = r;
    g.moved = true;
  } else if (g.type === 'marquee') {
    const o = S.opts.marquee, s = g.shape, dx = p.x - g.start.x, dy = p.y - g.start.y;
    const round = o.circle !== e.shiftKey && !g.add ? true : o.circle;
    if (o.center) {
      s.cx = g.start.x; s.cy = g.start.y;
      s.rx = round ? Math.hypot(dx, dy) : Math.abs(dx);
      s.ry = round ? s.rx : Math.abs(dy);
    } else {
      const w = round ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.sign(dx || 1) : dx;
      const h = round ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.sign(dy || 1) : dy;
      s.cx = g.start.x + w / 2; s.cy = g.start.y + h / 2; s.rx = Math.abs(w) / 2; s.ry = Math.abs(h) / 2;
    }
  } else if (g.type === 'selmove') {
    g.s.cx = p.x - g.dx; g.s.cy = p.y - g.dy;
  } else if (g.type === 'selresize') {
    g.s.rx = Math.max(4, Math.hypot(p.x - g.s.cx, p.y - g.s.cy)); g.s.ry = g.s.rx * g.k;
  } else if (g.type === 'lasso' || g.type === 'patch') {
    const pts = g.type === 'lasso' ? g.shape.pts : g.pts, last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 1.5 / d.view.scale) pts.push(p);
  } else if (g.type === 'pupilmove') {
    const q = D.toLocal(g.c.layer, { x: p.x - g.dx, y: p.y - g.dy });
    S.pupil.x = q.x; S.pupil.y = q.y;
  } else if (g.type === 'pupilresize') {
    S.pupil.r = Math.max(3, Math.hypot(p.x - g.c.x, p.y - g.c.y) / g.c.layer.scale);
  } else if (g.type === 'stroke') {
    strokeTo(g, p);
  }
  requestDraw();
});

function endDrag(e) {
  const d = S.cur, g = S.drag;
  S.drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (!g || !d) return;
  if (g.type === 'pan') canvas.style.cursor = S.tool === 'hand' ? 'grab' : S.tool === 'move' ? 'default' : 'crosshair';
  if (g.type === 'move' || g.type === 'scale' || g.type === 'rotate') {
    if (g.moved) g.commit(g.type === 'move' ? 'Перемещение' : g.type === 'scale' ? 'Размер слоя' : 'Поворот слоя');
    refresh();
  }
  if (g.type === 'marquee' || g.type === 'lasso') {
    const s = g.shape;
    const ok = s.type === 'ellipse' ? s.rx > 2 && s.ry > 2 : s.pts.length > 2;
    if (!ok) { if (!g.add && !s.sub) d.sel = null; }
    else if ((g.add || s.sub) && d.sel) d.sel.shapes.push(s);
    else if (!s.sub) d.sel = { shapes: [s], feather: S.opts[S.tool].feather };
    refresh();
  }
  if (g.type === 'patch') removeStroke(D.activeLayer(d), g);
  if (g.type === 'stroke') endStroke(g);
  requestDraw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { S.cursor = null; if (!S.drag) requestDraw(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

// --- Строка параметров инструмента ------------------------------------------

function refreshOptions() {
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  const bar = $('optbar'), info = toolInfo(S.tool), o = S.opts[S.tool] || {};
  bar.textContent = '';
  if (!S.cur) { bar.appendChild(ui.el('div', 'opt-hint start', 'Выберите чистый лист или шаблон, чтобы начать')); return; }
  bar.appendChild(ui.el('div', 'opt-tool', ui.icon(S.tool) + `<span>${info[1]}</span>`));
  const add = (node) => { const w = ui.el('div', 'opt'); w.appendChild(node); bar.appendChild(w); return node; };
  const range = (label, key, min, max, unit = '', step = 1) => add(ui.slider({
    label, min, max, step, value: o[key], unit, onInput: (v) => { o[key] = v; requestDraw(); },
  }));
  const check = (label, key) => {
    const l = ui.el('label', 'check'), i = ui.el('input');
    i.type = 'checkbox'; i.checked = o[key];
    i.onchange = () => { o[key] = i.checked; };
    l.append(i, document.createTextNode(label));
    add(l);
  };
  const button = (label, run, primary) => {
    const b = ui.el('button', 'btn' + (primary ? ' primary' : ''), label);
    b.onclick = run;
    return add(b);
  };
  const size = () => range('Размер', 'size', 4, 600, ' px');

  if (S.tool === 'move') {
    check('Выбирать слой щелчком', 'auto');
    button('По центру листа', () => {
      const d = S.cur, l = layer();
      if (!d || !l || l.locked) return;
      D.structEdit(d, 'По центру листа', () => { l.cx = d.w / 2; l.cy = d.h / 2; });
      refresh(); requestDraw();
    });
    button('Убрать поворот', () => {
      const d = S.cur, l = layer();
      if (!d || !l || l.locked || !l.rot) return;
      D.structEdit(d, 'Убрать поворот', () => { l.rot = 0; });
      refresh(); requestDraw();
    });
  } else if (S.tool === 'marquee') {
    check('Из центра', 'center');
    check('Ровный круг', 'circle');
    add(ui.slider({ label: 'Растушёвка', min: 0, max: 60, value: o.feather, unit: ' px', onInput: (v) => { o.feather = v; if (S.cur && S.cur.sel) S.cur.sel.feather = v; } }));
  } else if (S.tool === 'lasso') {
    add(ui.slider({ label: 'Растушёвка', min: 0, max: 60, value: o.feather, unit: ' px', onInput: (v) => { o.feather = v; if (S.cur && S.cur.sel) S.cur.sel.feather = v; } }));
  } else if (S.tool === 'patch') {
    size();
  } else if (S.tool === 'stamp' || S.tool === 'eraser') {
    size(); range('Жёсткость', 'hard', 0, 100, '%'); range('Нажим', 'flow', 1, 100, '%');
  } else if (S.tool === 'brush') {
    const c = ui.el('input', 'swatch');
    c.type = 'color'; c.value = o.color; c.title = 'Цвет кисти';
    c.oninput = () => { o.color = c.value; };
    add(c);
    size(); range('Жёсткость', 'hard', 0, 100, '%'); range('Нажим', 'flow', 1, 100, '%');
  } else if (S.tool === 'burn') {
    const seg = ui.el('div', 'seg');
    for (const [v, t] of [['burn', 'Затемнять'], ['dodge', 'Осветлять']]) {
      const b = ui.el('button', o.mode === v ? 'on' : '', t);
      b.onclick = () => { o.mode = v; refreshOptions(); };
      seg.appendChild(b);
    }
    add(seg);
    size(); range('Сила', 'flow', 1, 100, '%');
  } else if (S.tool === 'pupil') {
    range('Размер зрачка', 'ratio', 12, 40, '%', 0.5);
    button('Сузить зрачок', applyPupil, true);
  } else {
    button('Вписать в окно', fit);
    button('100%', () => zoomAt(...center(), 1, 1));
  }
  bar.appendChild(ui.el('div', 'opt-hint', info[3]));
}

// --- Панели справа ----------------------------------------------------------

const ADJUST = [
  ['temp', 'Теплее / холоднее', -100, 100], ['tint', 'Оттенок', -100, 100], ['exp', 'Яркость', -100, 100],
  ['contrast', 'Контраст', -50, 80], ['sat', 'Насыщенность', -100, 100], ['detail', 'Детали', 0, 200],
];
const adjustRows = {};
let adjustCommit = null;
const developOn = ui.el('div');
const developOff = ui.el('div');
for (const [key, label, min, max] of ADJUST) {
  adjustRows[key] = ui.slider({
    label, min, max, value: 0, reset: im.DEFAULT_ADJUST[key],
    onInput: (v) => {
      const l = layer();
      if (!l || !l.adjust) return;
      if (!adjustCommit) adjustCommit = D.beginStruct(S.cur);
      l.adjust[key] = v;
      l.dirty = true;
      S.draftId = l.id; // пока тянут ползунок, считаем уменьшенный черновик
      requestDraw();
    },
    onChange: () => {
      const l = layer();
      S.draftId = 0;
      if (l) l.dirty = true;
      if (adjustCommit) { adjustCommit('Проявка'); adjustCommit = null; }
      refreshHistory(); refreshTabs(); requestDraw();
    },
  });
  developOn.appendChild(adjustRows[key]);
}
$('develop').append(developOn, developOff);

function setAdjust(next, name) {
  const d = S.cur, l = layer();
  if (!d || !l) return;
  D.structEdit(d, name, () => { l.adjust = next; l.dirty = true; });
  refresh(); requestDraw();
}
$('developReset').onclick = () => { if (layer() && layer().adjust) setAdjust({ ...im.DEFAULT_ADJUST }, 'Сбросить проявку'); };

function refreshDevelop() {
  const l = layer(), on = !!(l && l.adjust);
  developOn.hidden = !on;
  developOff.hidden = on;
  $('developReset').hidden = !on;
  if (on) { for (const [key] of ADJUST) adjustRows[key].set(l.adjust[key]); return; }
  developOff.textContent = '';
  developOff.appendChild(ui.el('p', 'panel-note', l ? 'Этот слой не проявляется: цвет и резкость показаны как есть.' : 'Выберите слой, чтобы настроить цвет и резкость.'));
  if (l && !l.locked) {
    const b = ui.el('button', 'btn', 'Включить проявку');
    b.onclick = () => setAdjust({ ...im.NEUTRAL_ADJUST }, 'Включить проявку');
    developOff.appendChild(b);
  }
}

let dragLayerId = 0;

// Первый щелчок двойного щелчка перестраивает список, поэтому двойной щелчок
// ловим на самом списке, а не на строке, которой к этому моменту уже нет.
$('layers').addEventListener('dblclick', (e) => {
  const cell = e.target.closest('.layer-name'), row = e.target.closest('.layer');
  const l = row && S.cur && D.layerById(S.cur, Number(row.dataset.id));
  if (cell && l && !l.locked && e.target.tagName !== 'INPUT') renameLayer(l, cell);
});

function renameLayer(l, cell) {
  const inp = ui.el('input');
  inp.value = l.name;
  cell.textContent = '';
  cell.appendChild(inp);
  inp.focus(); inp.select();
  const done = (save) => {
    const v = inp.value.trim();
    if (save && v && v !== l.name) D.structEdit(S.cur, 'Переименовать слой', () => { l.name = v; });
    refresh();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
}

function refreshLayers() {
  const d = S.cur, box = $('layers'), head = $('layerHead'), foot = $('layerFoot');
  box.textContent = head.textContent = foot.textContent = '';
  if (!d) return;
  const act = D.activeLayer(d);

  let opCommit = null;
  head.appendChild(ui.slider({
    label: 'Непрозрачность', min: 0, max: 100, unit: '%', value: act ? Math.round(act.opacity * 100) : 100,
    onInput: (v) => { if (!act) return; if (!opCommit) opCommit = D.beginStruct(d); act.opacity = v / 100; requestDraw(); },
    onChange: () => { if (opCommit) { opCommit('Непрозрачность'); opCommit = null; refreshHistory(); } },
  }));

  for (const l of d.layers.slice().reverse()) {
    const row = ui.el('div', 'layer' + (d.active.includes(l.id) ? ' on' : '') + (l.clip ? ' clip' : '') + (l.visible ? '' : ' hid'));
    const eye = ui.el('button', 'layer-eye' + (l.visible ? '' : ' off'), ui.icon('eye'));
    eye.title = l.visible ? 'Скрыть слой' : 'Показать слой';
    eye.onclick = (e) => {
      e.stopPropagation();
      D.structEdit(d, l.visible ? 'Скрыть слой' : 'Показать слой', () => { l.visible = !l.visible; });
      refresh(); requestDraw();
    };
    const name = ui.el('div', 'layer-name');
    name.textContent = l.name;
    row.dataset.id = l.id;
    const tags = ui.el('div', 'layer-tags', l.clip ? ui.icon('clip') : '');
    if (l.locked) {
      const lock = ui.el('button', 'layer-lock', ui.icon('lock'));
      lock.title = 'Слой закреплён: его нельзя сдвинуть или удалить. Щелчок снимает замок';
      lock.onclick = (e) => {
        e.stopPropagation();
        D.structEdit(d, 'Снять закрепление', () => { l.locked = false; });
        refresh(); requestDraw();
      };
      tags.appendChild(lock);
    }
    row.append(eye, D.thumb(l, 60), name, tags);
    row.onclick = (e) => {
      const plain = !(e.ctrlKey || e.metaKey || e.shiftKey);
      if (plain && d.active.length === 1 && d.active[0] === l.id) return; // уже выбран, список не трогаем
      if (e.ctrlKey || e.metaKey) d.active = d.active.includes(l.id) ? d.active.filter((i) => i !== l.id) : [...d.active, l.id];
      else if (e.shiftKey && act) {
        const a = d.layers.indexOf(act), b = d.layers.indexOf(l);
        d.active = d.layers.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
      } else d.active = [l.id];
      S.pupil = null;
      if (S.tool === 'pupil') initPupil();
      refresh(); requestDraw();
    };
    if (!l.locked) {
      row.draggable = true;
      row.ondragstart = (e) => { dragLayerId = l.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-layer', String(l.id)); };
    }
    row.ondragover = (e) => {
      if (!dragLayerId || dragLayerId === l.id) return;
      e.preventDefault();
      const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
      row.classList.toggle('drop-above', above);
      row.classList.toggle('drop-below', !above);
    };
    row.ondragleave = () => row.classList.remove('drop-above', 'drop-below');
    row.ondrop = (e) => {
      e.preventDefault();
      const above = row.classList.contains('drop-above');
      const moving = D.layerById(d, dragLayerId);
      dragLayerId = 0;
      if (!moving || moving === l) return refresh();
      D.structEdit(d, 'Порядок слоёв', () => {
        d.layers.splice(d.layers.indexOf(moving), 1);
        let at = d.layers.indexOf(l) + (above ? 1 : 0); // выше в списке = позже в массиве
        if (d.layers[0] && d.layers[0].locked) at = Math.max(1, at);
        d.layers.splice(at, 0, moving);
      });
      refresh(); requestDraw();
    };
    box.appendChild(row);
  }

  const btn = (ic, title, run, off) => {
    const b = ui.el('button', 'icon-btn', ui.icon(ic));
    b.title = title; b.onclick = run; b.disabled = !!off;
    foot.appendChild(b);
  };
  const free = act && !act.locked;
  btn('clip', 'Обтравочная маска: показывать слой только поверх нижнего (Ctrl+Alt+G)', toggleClip, !free);
  btn('plus', 'Новый слой (Ctrl+Shift+N)', newLayer);
  btn('copy', 'Дублировать слой (Ctrl+J)', copyToLayer, !act);
  btn('trash', 'Удалить слой (Del)', deleteLayers, !free);
}

function refreshHistory() {
  const d = S.cur, box = $('history');
  box.textContent = '';
  if (!d) return;
  const jump = (n) => {
    if (S.busy) return;
    while (d.undo.length > n && D.stepHistory(d, true));
    while (d.undo.length < n && D.stepHistory(d, false));
    S.pupil = null;
    refresh(); requestDraw();
  };
  const row = (text, n, cls) => {
    const b = ui.el('button', 'hist ' + cls);
    b.textContent = text;
    b.onclick = () => jump(n);
    box.appendChild(b);
  };
  row('Начало', 0, d.undo.length ? '' : 'on');
  d.undo.forEach((e, i) => row(e.name, i + 1, i === d.undo.length - 1 ? 'on' : ''));
  d.redo.slice().reverse().forEach((e, i) => row(e.name, d.undo.length + i + 1, 'undone'));
  const cur = box.querySelector('.on');
  if (cur && !box.hidden) cur.scrollIntoView({ block: 'nearest' });
}

function refreshStatus() {
  const d = S.cur;
  $('stZoom').textContent = d ? Math.round(d.view.scale * 100) + '%' : '';
  const f = d && im.matchFormat(d.w, d.h);
  $('stDoc').textContent = d ? `${f ? f.label + ' · ' : ''}${d.w} × ${d.h} px · ${d.dpi} dpi` : '';
  const l = layer();
  $('stHint').textContent = d ? (l ? `Слой: ${l.name}` : 'Слой не выбран') : '';
}

function refresh() {
  refreshTabs();
  refreshLayers();
  refreshHistory();
  refreshDevelop();
  refreshStatus();
  refreshActions();
  refreshCtx();
  const d = S.cur;
  $('docHint').hidden = !d || !$('home').hidden || d.layers.some((l) => l.kind === 'photo' || l.kind === 'eye');
  $('saveBtn').disabled = $('placeBtn').disabled = false;
  $('saveBtn').disabled = !d;
}

// Кнопки рядом с выделением. Главная та, которая обычно нужна дальше:
// после круга по снимку глаз вырезают, после лассо лишнее убирают.
function refreshCtx() {
  const d = S.cur, bar = $('ctxbar');
  bar.hidden = !(d && d.sel);
  if (bar.hidden) return;
  const l = layer();
  const cut = d.sel.shapes.length === 1 && d.sel.shapes[0].type === 'ellipse' && l && l.kind === 'photo';
  const items = [['neural', 'Убрать нейронкой'], ['layerCopy', cut ? 'Вырезать глаз на новый слой' : 'На новый слой'], ['deselect', 'Снять выделение']];
  if (cut) items.unshift(items.splice(1, 1)[0]);
  bar.textContent = '';
  for (const [id, label] of items) {
    const b = ui.el('button', '', label);
    b.title = CMD[id].keys || '';
    b.onclick = () => run(id);
    bar.appendChild(b);
  }
}

document.querySelectorAll('.panel-tabs button').forEach((b) => {
  b.onclick = () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('.panel-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('layers').hidden = $('layerHead').hidden = $('layerFoot').hidden = S.tab !== 'layers';
    $('history').hidden = S.tab !== 'history';
    refreshHistory();
  };
});

// --- Команды, меню и клавиши ------------------------------------------------

const has = () => !!S.cur;
const hasSel = () => !!(S.cur && S.cur.sel);
const hasLayer = () => !!layer();

const CMD = {
  new: { label: 'Новый документ…', keys: 'Ctrl+N', run: () => showHome(true) },
  open: { label: 'Открыть…', keys: 'Ctrl+O', run: () => openDialog('open') },
  place: { label: 'Поместить снимок…', keys: 'Ctrl+Shift+O', run: () => openDialog('place') },
  save: { label: 'Сохранить JPEG с номером…', keys: 'Ctrl+S', run: saveNumbered, enabled: has },
  export: { label: 'Экспорт как…', keys: 'Ctrl+Shift+S', run: exportAs, enabled: has },
  close: { label: 'Закрыть документ', keys: 'Ctrl+W', run: () => closeDoc(S.cur), enabled: has },
  tplFolder: { label: 'Папка шаблонов…', run: async () => { if (await api.chooseTemplates()) ui.toast('Папка шаблонов выбрана'); } },
  saveFolder: { label: 'Папка готовых фото…', run: async () => { const p = await api.chooseSaveRoot(); if (p) ui.toast('Готовые фото: ' + p); } },

  undo: { label: 'Отменить', keys: 'Ctrl+Z', run: () => history(true), enabled: () => has() && S.cur.undo.length > 0 },
  redo: { label: 'Вернуть', keys: 'Ctrl+Shift+Z', run: () => history(false), enabled: () => has() && S.cur.redo.length > 0 },
  transform: { label: 'Свободное трансформирование', keys: 'Ctrl+T', run: () => setTool('move'), enabled: hasLayer },
  clear: { label: 'Очистить', keys: 'Del', run: clearSelection, enabled: has },

  layerNew: { label: 'Новый слой', keys: 'Ctrl+Shift+N', run: newLayer, enabled: has },
  layerCopy: { label: 'Скопировать на новый слой', keys: 'Ctrl+J', run: copyToLayer, enabled: hasLayer },
  layerDelete: { label: 'Удалить слой', run: deleteLayers, enabled: hasLayer },
  layerUp: { label: 'Переместить выше', keys: 'Ctrl+]', run: () => moveOrder(1), enabled: hasLayer },
  layerDown: { label: 'Переместить ниже', keys: 'Ctrl+[', run: () => moveOrder(-1), enabled: hasLayer },
  layerClip: { label: 'Обтравочная маска', keys: 'Ctrl+Alt+G', run: toggleClip, enabled: hasLayer },
  layoutCorners: { label: 'Раскладка «Углы»', run: () => layoutPair('corners'), enabled: has },
  layoutWhole: { label: 'Раскладка «Целые»', run: () => layoutPair('whole'), enabled: has },
  layoutSingle: { label: 'Один глаз по центру', run: layoutSingle, enabled: has },
  layoutSwap: { label: 'Поменять глаза местами', run: layoutSwap, enabled: has },

  selAll: { label: 'Выделить всё', keys: 'Ctrl+A', enabled: has, run: () => {
    const d = S.cur;
    d.sel = { shapes: [{ type: 'poly', pts: [{ x: 0, y: 0 }, { x: d.w, y: 0 }, { x: d.w, y: d.h }, { x: 0, y: d.h }] }], feather: 0 };
    refresh(); requestDraw();
  } },
  deselect: { label: 'Снять выделение', keys: 'Ctrl+D', enabled: hasSel, run: () => { S.cur.sel = null; refresh(); requestDraw(); } },
  neural: { label: 'Убрать выделенное нейронкой', keys: 'Shift+Backspace', run: removeSelection, enabled: hasSel },

  fit: { label: 'Вписать в окно', keys: 'Ctrl+0', run: fit, enabled: has },
  actual: { label: 'Реальный размер, 100%', keys: 'Ctrl+1', run: () => zoomAt(...center(), 1, 1), enabled: has },
  zoomIn: { label: 'Приблизить', keys: 'Ctrl+=', run: () => zoomAt(...center(), 1.25), enabled: has },
  zoomOut: { label: 'Отдалить', keys: 'Ctrl+-', run: () => zoomAt(...center(), 1 / 1.25), enabled: has },
};

ui.menubar($('menus'), [
  { title: 'Файл', items: ['new', 'open', 'place', '-', 'save', 'export', '-', 'tplFolder', 'saveFolder', '-', 'close'] },
  { title: 'Правка', items: ['undo', 'redo', '-', 'transform', 'clear'] },
  { title: 'Слой', items: ['layerNew', 'layerCopy', 'layerDelete', '-', 'layerUp', 'layerDown', 'layerClip', '-', 'layoutCorners', 'layoutWhole', 'layoutSingle', 'layoutSwap'] },
  { title: 'Выделение', items: ['selAll', 'deselect', '-', 'neural'] },
  { title: 'Просмотр', items: ['fit', 'actual', 'zoomIn', 'zoomOut'] },
], CMD);

const run = (id) => { const c = CMD[id]; if (!S.busy && (!c.enabled || c.enabled())) c.run(); };
$('placeBtn').onclick = () => run('place');
$('saveBtn').onclick = () => run('save');

const TOOL_KEYS = Object.fromEntries(TOOLS.filter((t) => t !== '-').map((t) => [t[2], t[0]]));
const BY_KEYS = Object.fromEntries(Object.entries(CMD).filter(([, c]) => c.keys).map(([id, c]) => [c.keys, id]));

window.addEventListener('keydown', (e) => {
  if (!$('modal').hidden) return;
  const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox';
  const k = ui.combo(e);
  if (typing && !k.startsWith('Ctrl+')) return;
  if (BY_KEYS[k]) { e.preventDefault(); run(BY_KEYS[k]); return; }
  if (k === 'Ctrl+Y') { e.preventDefault(); run('redo'); return; }
  if (typing) return;
  if (e.code === 'Space') { S.space = true; e.preventDefault(); return; }
  if (!S.cur || S.busy) return;
  if (k === 'Backspace') { e.preventDefault(); run('clear'); return; }
  if (k === 'Esc') { if (!$('home').hidden && S.cur) showHome(false); else if (S.cur.sel) run('deselect'); return; }
  if (k === 'Enter' && S.tool === 'pupil') { applyPupil(); return; }
  if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  const o = S.opts[S.tool];
  if (o && o.size && (e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.ctrlKey) {
    o.size = Math.round(Math.max(4, Math.min(600, o.size * (e.code === 'BracketLeft' ? 1 / 1.2 : 1.2))));
    refreshOptions(); requestDraw();
    return;
  }
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.code];
  if (arrow && S.tool === 'move') {
    const act = D.activeLayers(S.cur).filter((l) => !l.locked), step = e.shiftKey ? 10 : 1;
    if (!act.length) return;
    e.preventDefault();
    D.structEdit(S.cur, 'Сдвиг', () => { for (const l of act) { l.cx += arrow[0] * step; l.cy += arrow[1] * step; } });
    refreshHistory(); requestDraw();
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') S.space = false; });
window.addEventListener('resize', resize);

window.addEventListener('dragover', (e) => {
  if (dragLayerId) return;
  e.preventDefault();
  stage.classList.add('drag');
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drag'); });
window.addEventListener('drop', async (e) => {
  stage.classList.remove('drag');
  if (dragLayerId) return;
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const kind = fileKind(file.name);
  openData({ name: file.name, kind, data: new Uint8Array(await file.arrayBuffer()) }, kind === 'psd' ? 'open' : 'place');
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
    case 'dev': return setUpdate('', 'Режим разработки');
    case 'checking': return setUpdate('busy', 'Проверяю обновления');
    case 'latest': return setUpdate('ok', 'Последняя версия');
    case 'downloading': return setUpdate('busy', `Скачиваю обновление${s.percent ? ' ' + s.percent + '%' : ''}`);
    case 'ready': return setUpdate('ok', `Версия ${s.version} поставится при закрытии`, { label: 'Перезапустить', run: api.installUpdate });
    case 'error': return setUpdate('err', 'Обновления недоступны, нужен интернет', { label: 'Повторить', run: api.checkUpdate });
  }
});

api.version().then((v) => { $('version').textContent = v; });
api.modelStatus().then((s) => { S.modelReady = s.ready; });

refreshOptions();
refresh();
showHome(true);
resize();
