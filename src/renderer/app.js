import * as im from './imaging.js';
import * as D from './doc.js';
import * as ui from './ui.js';

const api = window.eyephoto;
const $ = (id) => document.getElementById(id);
const stage = $('stage');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const over = $('overlay');
const octx = over.getContext('2d');

const ACCENT = '#f2f2f3'; // рамки, круги и ручки на холсте: белые с тёмной подложкой
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
    stamp: { size: 80, hard: 50, flow: 100, aligned: true },
    heal: { size: 80, hard: 50, aligned: true },
    brush: { size: 40, hard: 80, flow: 100, color: '#000000' },
    eraser: { size: 60, hard: 80, flow: 100 },
    burn: { size: 120, hard: 0, flow: 50, mode: 'burn', range: 'mid', protect: true },
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
  guides: true,       // направляющие по центру листа
  wheeling: false,    // крутят колесо: рисуем быстро, начисто после остановки
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

// Картинка листа и служебные линии (курсор, выделение, рамки, направляющие)
// рисуются на разных холстах. Пока меняются только линии, лист не пересобирается:
// это главное, от чего зависит плавность.
let drawQueued = false, sceneDirty = true;
function schedule() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(frame);
}
function requestDraw() { sceneDirty = true; schedule(); }
function requestOverlay() { schedule(); }

const layer = () => (S.cur ? D.activeLayer(S.cur) : null);

// Слой, на котором можно рисовать и ретушировать.
function paintLayer() {
  const l = layer();
  if (!l) { ui.toast('Выберите слой в панели «Слои»'); return null; }
  if (!D.shown(S.cur, l)) { ui.toast('Слой скрыт. Включите его, чтобы править'); return null; }
  return l;
}

// --- Просмотр ---------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  over.width = canvas.width = Math.round(stage.clientWidth * dpr);
  over.height = canvas.height = Math.round(stage.clientHeight * dpr);
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
  octx.setLineDash([]);
  octx.lineWidth = px;
  octx.strokeStyle = 'rgba(0,0,0,.8)';
  octx.stroke();
  if (dash) { octx.setLineDash([4 * px, 4 * px]); octx.lineDashOffset = -S.ants * px; }
  octx.strokeStyle = '#fff';
  octx.stroke();
  octx.setLineDash([]);
}

function ring(c, color, handles) {
  const px = 1 / S.cur.view.scale;
  octx.beginPath(); octx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  octx.lineWidth = 3 * px; octx.strokeStyle = 'rgba(0,0,0,.55)'; octx.stroke();
  octx.lineWidth = 1.25 * px; octx.strokeStyle = color; octx.stroke();
  if (!handles) return;
  octx.fillStyle = color;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    octx.beginPath(); octx.arc(c.x + dx * c.r, c.y + dy * c.r, 3.5 * px, 0, Math.PI * 2); octx.fill();
  }
}

function draw() { sceneDirty = true; frame(); }

function frame() {
  drawQueued = false;
  if (sceneDirty) { drawScene(); sceneDirty = false; }
  drawOverlay();
}

let settle = 0;

function drawScene() {
  const dpr = window.devicePixelRatio || 1, d = S.cur;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#101113';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!d) return;
  const v = d.view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = checker;
  ctx.fillRect(v.ox, v.oy, d.w * v.scale, d.h * v.scale);

  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
  ctx.imageSmoothingEnabled = v.scale < 4; // при сильном увеличении показываем честные пиксели
  // Пока картинку двигают или крутят колесо, рисуем быстрым сглаживанием,
  // а как только остановились, перерисовываем начисто.
  const moving = !!S.drag || S.wheeling;
  ctx.imageSmoothingQuality = moving ? 'low' : 'high';
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, d.w, d.h); ctx.clip();
  D.composite(ctx, d, { draftId: S.draftId, zoom: v.scale * dpr, solo: true });
  ctx.restore();
  if (S.wheeling) {
    clearTimeout(settle);
    settle = setTimeout(() => { S.wheeling = false; requestDraw(); }, 160);
  }
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1, d = S.cur;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, over.width, over.height);
  if (!d) return;
  const v = d.view, px = 1 / v.scale, g = S.drag;
  octx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);

  if (S.guides) {
    octx.beginPath();
    octx.moveTo(d.w / 2, 0); octx.lineTo(d.w / 2, d.h);
    octx.moveTo(0, d.h / 2); octx.lineTo(d.w, d.h / 2);
    octx.lineWidth = px;
    octx.strokeStyle = 'rgba(0, 225, 255, .85)';
    octx.stroke();
  }

  // выделение: «бегущие муравьи» по общему краю всех обводок, как в фотошопе
  if (d.sel) drawSelectionEdge(d, dpr);
  if (g && g.shape) {
    octx.beginPath();
    if (g.shape.type === 'poly') g.shape.pts.forEach((q, i) => (i ? octx.lineTo(q.x, q.y) : octx.moveTo(q.x, q.y)));
    else D.shapePath(octx, g.shape);
    strokeBoth(px, true);
  }

  if (g && g.type === 'patch') {
    octx.beginPath();
    g.pts.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
    if (g.pts.length === 1) octx.lineTo(g.pts[0].x + 0.01, g.pts[0].y);
    octx.lineJoin = octx.lineCap = 'round';
    octx.lineWidth = g.size;
    octx.strokeStyle = 'rgba(90, 162, 224, .45)';
    octx.stroke();
  }

  if (S.tool === 'move') {
    const act = D.activeLayers(d).filter((l) => !l.locked && D.shown(d, l));
    for (const l of act) {
      const c = D.corners(l);
      octx.beginPath();
      c.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
      octx.closePath();
      octx.lineWidth = px; octx.strokeStyle = ACCENT; octx.stroke();
      if (act.length === 1) {
        for (const p of c) {
          octx.fillStyle = '#fff'; octx.strokeStyle = ACCENT;
          octx.beginPath(); octx.rect(p.x - 3.5 * px, p.y - 3.5 * px, 7 * px, 7 * px); octx.fill(); octx.stroke();
        }
      }
    }
  }

  const pr = S.tool === 'pupil' && pupilOnDoc();
  if (pr) ring(pr, ACCENT, true);

  if ((S.tool === 'stamp' || S.tool === 'heal') && S.stampSrc) {
    const p = g && g.type === 'stroke' && g.srcNow ? g.srcNow : S.stampSrc, a = 7 * px;
    octx.beginPath();
    octx.moveTo(p.x - a, p.y); octx.lineTo(p.x + a, p.y); octx.moveTo(p.x, p.y - a); octx.lineTo(p.x, p.y + a);
    strokeBoth(px, false);
  }

  const sized = S.opts[S.tool] && S.opts[S.tool].size;
  if (sized && S.cursor && !(g && g.type === 'pan') && !(S.ctrl && !g)) {
    ring({ x: S.cursor.x, y: S.cursor.y, r: sized / 2 }, '#fff', false);
    const hd = S.opts[S.tool].hard;
    if (g && g.type === 'brushsize' && hd != null && hd > 2) ring({ x: S.cursor.x, y: S.cursor.y, r: sized / 2 * hd / 100 }, 'rgba(255,90,90,.9)', false);
  }
}

// Край выделения считается по маске: все обводки сливаются в одно пятно,
// и рамка идёт только по его внешнему краю. Маска пересчитывается, только
// когда меняется выделение или вид; муравьи бегут поверх готового края.
const selCache = { key: '', edge: null, ants: null };
const antsTile = (() => {
  const c = im.makeCanvas(8, 8), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 8, 8);
  x.fillStyle = '#000';
  for (let i = -8; i < 16; i += 8) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 4, 0); x.lineTo(i + 12, 8); x.lineTo(i + 8, 8); x.fill(); }
  return c;
})();

function drawSelectionEdge(d, dpr) {
  const v = d.view, W = over.width, H = over.height;
  const key = JSON.stringify([d.sel.shapes, v.scale, v.ox, v.oy, W, H]);
  if (key !== selCache.key || !selCache.edge || selCache.edge.width !== W || selCache.edge.height !== H) {
    selCache.key = key;
    const mask = im.makeCanvas(W, H), m = mask.getContext('2d');
    m.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.ox, dpr * v.oy);
    m.fillStyle = '#fff';
    for (const s of d.sel.shapes) {
      m.globalCompositeOperation = s.sub ? 'destination-out' : 'source-over';
      m.beginPath(); D.shapePath(m, s); m.fill();
    }
    // край = маска минус маска, сжатая на пиксель
    const er = im.makeCanvas(W, H), e = er.getContext('2d');
    e.drawImage(mask, 0, 0);
    e.globalCompositeOperation = 'destination-in';
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) e.drawImage(mask, dx, dy);
    const edge = mask;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'destination-out';
    m.drawImage(er, 0, 0);
    selCache.edge = edge;
    selCache.ants = im.makeCanvas(W, H);
  }
  const a = selCache.ants, ax = a.getContext('2d');
  ax.globalCompositeOperation = 'copy';
  ax.fillStyle = ax.createPattern(antsTile, 'repeat');
  ax.save(); ax.translate(S.ants, 0); ax.fillRect(-8, 0, W + 8, H); ax.restore();
  ax.globalCompositeOperation = 'destination-in';
  ax.drawImage(selCache.edge, 0, 0);
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.drawImage(a, 0, 0);
  octx.restore();
}

// Прилипание к направляющим по центру листа.
function snapToCenter(p) {
  const d = S.cur, tol = 7 / d.view.scale;
  if (!S.guides) return p;
  return { x: Math.abs(p.x - d.w / 2) < tol ? d.w / 2 : p.x, y: Math.abs(p.y - d.h / 2) < tol ? d.h / 2 : p.y };
}

setInterval(() => {
  if (S.cur && (S.cur.sel || (S.drag && S.drag.shape))) { S.ants = (S.ants + 1) % 8; requestOverlay(); }
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
  S.stampOff = null;
  document.body.classList.toggle('no-doc', !doc);
  refreshOptions();
  refresh();
  resize();
  if (!doc) showHome(true);
}

async function closeDoc(doc) {
  if (S.busy) { ui.toast('Подождите, программа ещё работает с этим документом'); return; }
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

// lock — закреплять ли слои. Шаблоны студии закрепляются, чтобы оформление
// не сдвинули случайно. Свои сохранённые работы открываются как были.
function psdToDoc(name, bytes, lock) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const psd = window.agPsd.readPsd(buf, { skipThumbnail: true });
  // наши пометки: какие слои были глазами и снимками (см. savePsd)
  let meta = null;
  try {
    const m = /<eyephoto>([\s\S]*?)<\/eyephoto>/.exec((psd.imageResources && psd.imageResources.xmpMetadata) || '');
    if (m) meta = JSON.parse(decodeURIComponent(m[1]));
  } catch { meta = null; }
  let index = 0;
  const res = psd.imageResources && psd.imageResources.resolutionInfo;
  const doc = D.makeDoc({ name, w: psd.width, h: psd.height, dpi: Math.round((res && res.horizontalResolution) || 300), background: false });
  let skipped = 0;
  doc.slots = [];
  doc.samples = [];
  doc.template = !!lock;
  if (meta) { doc.eyeSeq = meta.eyeSeq || 0; doc.eyes = meta.eyes || 0; }
  const walk = (nodes, hidden, opacity) => {
    for (const n of nodes || []) {
      const hid = hidden || !!n.hidden, op = opacity * (n.opacity == null ? 1 : n.opacity);
      if (n.children) { walk(n.children, hid, op); continue; }
      const mine = meta && meta.layers[index++];
      // Скрытые небольшие слои в шаблонах студии это образцы: они показывают,
      // куда и какого размера ставить глаз («одиночное») или пару («парное по углам»).
      const bw = (n.right || 0) - (n.left || 0), bh = (n.bottom || 0) - (n.top || 0);
      if (lock && hid && bw > 0 && bh > 0 && bw < psd.width * 0.6 && bh < psd.height * 0.6) {
        doc.samples.push({ x: n.left || 0, y: n.top || 0, w: bw, h: bh, name: (n.name || '').toLowerCase() });
        continue;
      }
      if (!n.canvas || !n.canvas.width || !n.canvas.height) { skipped++; continue; }
      const c = im.cloneCanvas(n.canvas);
      bakeMask(n, c);
      const blend = (n.blendMode || 'normal').replace(/ /g, '-');
      const full = c.width >= psd.width && c.height >= psd.height;
      doc.layers.push(D.makeLayer({
        name: n.name || D.nextName(doc), canvas: c,
        cx: (n.left || 0) + c.width / 2, cy: (n.top || 0) + c.height / 2,
        visible: !hid, opacity: op, clip: !!n.clipping,
        blend: BLENDS.includes(blend) ? blend : 'source-over',
        locked: lock ? true : !!(mine && mine.locked), // замок снимается щелчком
        kind: (mine && mine.kind) || 'pixel', eye: (mine && mine.eye) || 0, eyeKey: (mine && mine.eyeKey) || '',
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
// pupil — найденный на снимке зрачок. Если он есть, снимок ставится так, чтобы
// зрачок попал в центр листа, и сразу появляется круг по радужке: его остаётся
// подправить за край и вырезать.
function placeCanvas(doc, c, name, adjust, pupil) {
  const k = Math.min(doc.w / c.width, doc.h / c.height, 1);
  const found = !!(pupil && pupil.found);
  const eye = doc.eyeSeq = (doc.eyeSeq || 0) + 1;
  let placedLayer = null;
  D.structEdit(doc, 'Поместить снимок', () => {
    const l = D.makeLayer({
      name: name.replace(/\.[^.]+$/, ''), canvas: c, scale: k, kind: 'photo', adjust,
      eye, eyeKey: eyeKeyFor(doc, name),
      cx: doc.w / 2 - (found ? (pupil.x - c.width / 2) * k : 0),
      cy: doc.h / 2 - (found ? (pupil.y - c.height / 2) * k : 0),
    });
    doc.layers.push(l);
    doc.active = [l.id];
    doc.sel = null;
    placedLayer = l;
    if (found) {
      const m = Math.min(c.width, c.height);
      const r = Math.min(m * 0.46, Math.max(m * 0.15, pupil.r * 3.3)) * k;
      l.irisGuess = { x: pupil.x, y: pupil.y, r: r / k };
      doc.sel = { shapes: [{ type: 'ellipse', cx: doc.w / 2, cy: doc.h / 2, rx: r, ry: r }], feather: S.opts.marquee.feather };
    }
  });
  doc.solo = eye; // новый снимок показываем один, остальные глаза не мешают
  return placedLayer;
}

// Подпись глаза: последние 4 цифры имени файла (DSC04069 -> 4069), как в панели студии.
// Если такая уже есть, берём на цифру больше.
function eyeKeyFor(doc, name) {
  const taken = new Set(doc.layers.map((l) => l.eyeKey).filter(Boolean));
  const digits = (name.replace(/\.[^.]+$/, '').match(/\d/g) || []).join('');
  if (!digits) {
    const base = name.replace(/\.[^.]+$/, '').slice(0, 8) || 'глаз';
    let k = base, n = 2;
    while (taken.has(k)) k = `${base} ${n++}`;
    return k;
  }
  for (let len = Math.min(4, digits.length); len <= digits.length; len++) {
    if (!taken.has(digits.slice(-len))) return digits.slice(-len);
  }
  let k = digits, n = 2;
  while (taken.has(k)) k = `${digits}-${n++}`;
  return k;
}

// file: { name, kind: raw | image | psd, data }. how: 'place' — слоем в текущий документ,
// 'open' — отдельным документом.
// Возвращает положенный на лист снимок, если это был снимок, иначе null.
async function openData(file, how) {
  if (S.busy || !file) return null;
  let placed = null;
  await setBusy(file.kind === 'raw' ? 'Проявляю снимок с камеры' : file.kind === 'psd' ? 'Открываю шаблон' : 'Открываю снимок');
  try {
    if (file.kind === 'psd') {
      const { doc, skipped } = psdToDoc(file.name.replace(PSD_RE, ''), file.data, how === 'template');
      addDoc(doc);
      if (skipped) ui.toast(`Не перенесено слоёв: ${skipped}. Корректирующие слои и эффекты пока не поддерживаются`);
    } else {
      const c = file.kind === 'raw' ? await decodeRaw(file.data) : await decodeImage(file.data);
      const pupil = im.findPupil(c);
      setBusy('');
      // сначала окно проявки, как Camera Raw в фотошопе
      const adjust = await developDialog(c, im.newAdjust(), file.name, pupil);
      if (!adjust) return null;
      if (how === 'open') {
        const doc = D.makeDoc({ name: file.name.replace(/\.[^.]+$/, ''), w: c.width, h: c.height, dpi: 300, background: false });
        addDoc(doc);
        placeCanvas(doc, c, file.name, adjust, null);
        doc.undo = []; doc.changed = false;
      } else {
        if (!S.cur) addDoc(sheetDoc(S.lastFormat));
        showHome(false);
        placed = placeCanvas(S.cur, c, file.name, adjust, pupil);
        fit();
        setTool('marquee'); // первым делом снимок обводят кругом по радужке
      }
    }
  } catch (e) {
    console.error(e);
    setBusy('');
    await ui.tell('Не получилось открыть файл', `«${file.name}»: подойдут ARW с камеры, JPG, PNG и PSD. Возможно, файл повреждён.`);
    return null;
  }
  setBusy('');
  refresh();
  requestDraw();
  return placed;
}

// Несколько файлов разом, как в фотошопе: у каждого снимка своё окно проявки,
// все ложатся слоями в один лист, а в работе остаётся первый. Остальные ждут
// в полоске «Глаза».
async function openMany(files, how) {
  // пока идёт открытие (а у снимков открыто окно проявки), новые файлы не принимаем:
  // иначе второе окно проявки перебило бы первое
  if (S.importing) { ui.toast('Дождитесь, пока откроются предыдущие файлы'); return; }
  S.importing = true;
  const placed = [];
  try {
    for (const f of files) {
      const l = await openData(f, f.kind === 'psd' ? 'open' : how);
      if (l) placed.push(l);
    }
  } finally {
    S.importing = false;
  }
  if (placed.length > 1) focusPhoto(placed[0]);
}

function focusPhoto(l) {
  const d = S.cur;
  if (!d || !d.layers.includes(l)) return;
  d.solo = l.eye;
  d.active = [l.id];
  if (l.irisGuess) {
    const c = D.toDoc(l, l.irisGuess);
    d.sel = { shapes: [{ type: 'ellipse', cx: c.x, cy: c.y, rx: l.irisGuess.r * l.scale, ry: l.irisGuess.r * l.scale }], feather: S.opts.marquee.feather };
  }
  setTool('marquee');
  refresh(); requestDraw();
}

const fileKind = (name) => (RAW_RE.test(name) ? 'raw' : PSD_RE.test(name) ? 'psd' : 'image');

async function openDialog(how) {
  if (S.busy) return;
  const files = await api.openFile(how === 'place' ? 'photo' : 'any');
  if (files && files.length) openMany(files, how);
}
window.__openPath = async (p, how) => openData(await api.openPath(p), how || 'place');
window.__openPaths = async (ps, how) => openMany(await Promise.all(ps.map((p) => api.openPath(p))), how || 'place');

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
    card.children[1].textContent = item.name[0].toUpperCase() + item.name.slice(1);
    card.title = item.name;
    card.onclick = () => openTemplate(item);
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
$('tplFolder').onclick = async () => { if (await api.chooseTemplates()) { showHome(true); loadTemplateList(); } };

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
    // под вырезанным глазом лежит его исходный снимок: по нему модель видит, что за краем круга
    const photo = l.src && D.layerById(d, l.src.id);
    const under = photo && ((x, N) => x.drawImage(photo.canvas, region.x + l.src.x, region.y + l.src.y, region.w, region.h, 0, 0, N, N));
    await im.inpaintPatch(l.canvas, mask, region, (rgba, m) => api.inpaint({ rgba, mask: m }), under, irisOf(l));
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

// Где у слоя зрачок и какого размера радужка: нужно нейронке для больших мест.
function irisOf(l) {
  if (l.irisInfo && l.irisInfo.rev === l.rev) return l.irisInfo;
  let info = null;
  if (l.kind === 'eye') {
    const p = im.findPupil(l.canvas);
    info = { x: p.found ? p.x : l.canvas.width / 2, y: p.found ? p.y : l.canvas.height / 2, R: Math.min(l.canvas.width, l.canvas.height) / 2 };
  } else if (l.kind === 'photo' && l.irisGuess) {
    info = { x: l.irisGuess.x, y: l.irisGuess.y, R: l.irisGuess.r };
  }
  if (info) { info.rev = l.rev; l.irisInfo = info; }
  return info;
}

function removeSelection() {
  const d = S.cur, l = d && d.sel && paintLayer();
  if (!l) return;
  const sel = d.sel;
  neuralRemove(l, (_mx, setT, pad) => {
    const m = D.selMask(sel, _mx.canvas.width, _mx.canvas.height, setT, { grow: pad });
    _mx.setTransform(1, 0, 0, 1, 0, 0);
    _mx.drawImage(m, 0, 0);
  }, D.selBounds(sel)).then(() => {
    if (d.sel !== sel) return;
    const n = d.undo.length;
    D.structEdit(d, 'Снять выделение', () => { d.sel = null; });
    // правка пикселей и снятие выделения отменяются одним шагом
    if (n && d.undo[n - 1].name === 'Убрать нейронкой') D.mergeLast(d, 2, 'Убрать нейронкой');
    refresh(); requestDraw();
  });
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
  let c, cx = l.cx, cy = l.cy, cutAt = { x: 0, y: 0 };
  const hadSel = !!d.sel;
  if (d.sel) {
    const f = d.sel.feather / l.scale;
    const r = D.localRect(l, D.selBounds(d.sel), f * 2 + 2);
    if (r.w < 2 || r.h < 2) { ui.toast('Выделение не попадает на выбранный слой'); return; }
    cutAt = { x: r.x, y: r.y };
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
  D.structEdit(d, hadSel ? 'Вырезать на новый слой' : 'Дублировать слой', () => {
    made = D.makeLayer({
      name: isEye ? `Глаз ${d.eyes = (d.eyes || 0) + 1}` : d.sel ? D.nextName(d) : l.name + ' копия',
      kind: isEye ? 'eye' : d.sel ? 'pixel' : l.kind,
      canvas: c, cx, cy, scale: l.scale, rot: l.rot,
      adjust: l.adjust && { ...l.adjust }, opacity: l.opacity,
      eye: l.eye, eyeKey: l.eyeKey,
      // где этот кусок лежит в исходном снимке: нейронке это нужно как подложка у края глаза
      src: isEye ? { id: l.id, x: cutAt.x, y: cutAt.y } : l.src,
    });
    d.layers.splice(d.layers.indexOf(l) + 1, 0, made);
    d.active = [made.id];
    if (isEye) { l.visible = false; l.cache = null; l.dirty = true; } // исходник на листе больше не нужен, память под его копию тоже
    d.sel = null;
  });
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

// Ctrl+E: выбранный слой сливается с тем, что под ним. Если выбрано несколько,
// сливаются они все, снизу вверх.
function mergeDown() {
  const d = S.cur;
  let act = D.activeLayers(d);
  if (!act.length) return;
  if (act.length === 1) {
    const i = d.layers.indexOf(act[0]);
    if (i <= 0) { ui.toast('Под этим слоем нет слоя, с которым его объединить'); return; }
    act = [d.layers[i - 1], act[0]];
  }
  if (act.some((l) => l.locked)) { ui.toast('Один из слоёв закреплён. Снимите замок щелчком по нему в панели «Слои»'); return; }
  // как в фотошопе: со скрытым слоем не объединяем, иначе видимый глаз пропал бы вместе с ним
  if (act.some((l) => !l.visible)) { ui.toast('Один из слоёв скрыт. Включите его или выберите другой слой'); return; }
  let res = act[0];
  for (const up of act.slice(1)) res = D.merged(res, up);
  D.structEdit(d, 'Объединить слои', () => {
    const at = d.layers.indexOf(act[0]);
    d.layers = d.layers.filter((l) => !act.includes(l));
    d.layers.splice(Math.min(at, d.layers.length), 0, res);
    d.active = [res.id];
  });
  S.pupil = null;
  refresh(); requestDraw();
}

// Сохранение работы со слоями в PSD: файл открывается и в фотошопе, и здесь.
// Каждый слой записывается в пикселях листа, то есть проявка, размер и поворот
// запекаются, как это сделал бы сам фотошоп.
function buildPsd(d) {
    const children = d.layers.map((l) => {
      const r = D.rasterize(l);
      return {
        name: l.name, left: r.left, top: r.top, canvas: r.canvas, hidden: !l.visible, opacity: l.opacity,
        blendMode: l.blend === 'source-over' ? 'normal' : l.blend.replace(/-/g, ' '), clipping: !!l.clip,
      };
    });
    const meta = {
      eyeSeq: d.eyeSeq || 0, eyes: d.eyes || 0,
      layers: d.layers.map((l) => ({ kind: l.kind, eye: l.eye, eyeKey: l.eyeKey, locked: l.locked })),
    };
    const res = { horizontalResolution: d.dpi, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: d.dpi, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' };
    return new Uint8Array(window.agPsd.writePsd({
      width: d.w, height: d.h, children, canvas: D.flatten(d),
      imageResources: { resolutionInfo: res, xmpMetadata: `<eyephoto>${encodeURIComponent(JSON.stringify(meta))}</eyephoto>` },
    }, { generateThumbnail: true }));
}
window.__psd = (file) => api.writePath({ file, data: buildPsd(S.cur) });

async function savePsd() {
  const d = S.cur;
  if (!d || S.busy) return;
  await setBusy('Собираю PSD');
  let data;
  try {
    data = buildPsd(d);
  } catch (e) {
    console.error(e);
    setBusy('');
    await ui.tell('Не получилось собрать PSD', 'Скорее всего, не хватило памяти: документ слишком большой.');
    return;
  }
  setBusy('');
  const file = await api.saveAs({ name: d.name.replace(/[\\/:*?"<>|]/g, ' ') + '.psd', label: 'Photoshop', ext: 'psd', data });
  if (file) { d.changed = false; refreshTabs(); ui.toast('Сохранено: ' + file); }
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
const liveActive = (d) => D.activeLayers(d).filter((l) => !l.locked && D.shown(d, l));
const eyesOf = (d) => movable(d).filter((l) => l.kind === 'eye');

// Пара для раскладки: два выделенных слоя, а если выделено не два,
// то два глаза, которые есть на листе.
function pairTargets(quiet) {
  const d = S.cur, act = liveActive(d);
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
  if (l && !l.locked && D.shown(d, l)) return l;
  const eyes = eyesOf(d);
  if (eyes.length === 1) return eyes[0];
  if (!quiet) ui.toast('Выберите слой с глазом в панели «Слои»');
  return null;
}

function layoutPair(type) {
  const d = S.cur, pair = pairTargets();
  if (!pair) return;
  d.solo = 0;
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
  d.solo = 0;
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
  d.solo = 0;
  D.structEdit(d, 'По центру', () => {
    l.scale = im.singleIris(d.w, d.h) / Math.max(l.canvas.width, l.canvas.height);
    l.cx = d.w / 2; l.cy = d.h / 2; l.rot = 0;
    d.active = [l.id];
  });
  fit(); refresh();
}

// --- Шаблоны: места под глаза ------------------------------------------------
// Место под фото в шаблоне студии это чёрная область: круг стикера, квадрат,
// окно полароида, прямоугольник магнита. Находим такие области на картинке
// шаблона. Если рядом лежит скрытый образец, он задаёт, что ставить и какого
// размера: один глаз или пару по углам. Без образца в прямоугольник идёт пара,
// в круг один глаз.

function findBlackAreas(doc) {
  const k = Math.min(1, 1100 / Math.max(doc.w, doc.h));
  const w = Math.max(1, Math.round(doc.w * k)), h = Math.max(1, Math.round(doc.h * k));
  const c = im.makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.scale(k, k);
  D.composite(x, doc, { zoom: k });
  const d = x.getImageData(0, 0, w, h).data, n = w * h;
  const black = new Uint8Array(n);
  for (let i = 0; i < n; i++) black[i] = d[i * 4 + 3] > 128 && 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] < 60 ? 1 : 0;
  const seen = new Uint8Array(n), stack = new Int32Array(n), out = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!black[s0] || seen[s0]) continue;
    let top = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[top++] = s0; seen[s0] = 1;
    while (top) {
      const i = stack[--top], px = i % w, py = (i - px) / w;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const j of [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1]) {
        if (j >= 0 && black[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (area < n * 0.003 || (bw > w * 0.9 && bh > h * 0.9)) continue;
    out.push({ x: x0 / k, y: y0 / k, w: bw / k, h: bh / k, fill: area / (bw * bh) });
  }
  return out;
}

// Маска места в полном размере: чёрное плюс всё, что внутри него (тонкие
// линии разметки внутри круга тоже считаются местом).
function slotMask(doc, a) {
  const pad = 3, x0 = Math.max(0, Math.floor(a.x) - pad), y0 = Math.max(0, Math.floor(a.y) - pad);
  const w = Math.min(doc.w, Math.ceil(a.x + a.w) + pad) - x0, h = Math.min(doc.h, Math.ceil(a.y + a.h) + pad) - y0;
  const c = im.makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.translate(-x0, -y0);
  D.composite(x, doc, { full: true });
  const img = x.getImageData(0, 0, w, h), d = img.data, n = w * h;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = d[i * 4 + 3] > 128 && 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2] < 90 ? 1 : 0;
  // заливаем снаружи всё, до чего можно дойти не по чёрному: остальное и есть место
  const out = new Uint8Array(n), stack = new Int32Array(n);
  let top = 0;
  const push = (i) => { if (!inside[i] && !out[i]) { out[i] = 1; stack[top++] = i; } };
  for (let i = 0; i < w; i++) { push(i); push((h - 1) * w + i); }
  for (let j = 0; j < h; j++) { push(j * w); push(j * w + w - 1); }
  while (top) {
    const i = stack[--top], px = i % w, py = (i - px) / w;
    if (px > 0) push(i - 1); if (px < w - 1) push(i + 1); if (py > 0) push(i - w); if (py < h - 1) push(i + w);
  }
  for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = out[i] ? 0 : 255; }
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.putImageData(img, 0, 0);
  // лёгкое сглаживание края
  const soft = im.makeCanvas(w, h), sx = soft.getContext('2d');
  sx.filter = 'blur(0.6px)';
  sx.drawImage(c, 0, 0);
  return { canvas: soft, x: x0, y: y0 };
}

// Над каким слоем шаблона лежит место: верхний видимый слой, у которого здесь чёрное.
function holderOf(doc, a) {
  let best = null, bestHits = 0;
  for (const l of doc.layers.slice().reverse()) {
    if (!l.visible || l.tplPart) continue;
    let hits = 0;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.2], [0.5, 0.8]]) {
      const q = D.toLocal(l, { x: a.x + a.w * fx, y: a.y + a.h * fy });
      if (q.x < 0 || q.y < 0 || q.x >= l.canvas.width || q.y >= l.canvas.height) continue;
      const px = l.canvas.getContext('2d').getImageData(Math.floor(q.x), Math.floor(q.y), 1, 1).data;
      if (px[3] > 128 && 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] < 90) hits++;
    }
    if (hits > bestHits) { best = l; bestHits = hits; }
  }
  return best;
}

function prepareTemplate(doc) {
  doc.slots = [];
  for (const a of findBlackAreas(doc)) {
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    const sample = doc.samples.find((s) => cx > s.x - s.w * 0.3 && cx < s.x + s.w * 1.3 && cy > s.y - s.h * 0.3 && cy < s.y + s.h * 1.3);
    const round = a.fill > 0.68 && a.fill < 0.86 && Math.abs(a.w - a.h) < Math.max(a.w, a.h) * 0.08;
    const kind = sample ? (/парн/.test(sample.name) ? (/цел/.test(sample.name) ? 'whole' : 'corners') : 'single') : round ? 'single' : 'corners';
    doc.slots.push({ area: a, sample, kind, fixed: kind });
  }
  doc.slots.sort((p, q) => p.area.y - q.area.y || p.area.x - q.area.x);
}

// Глаза для шаблона: копии вырезанных глаз из листа, откуда открыли шаблон.
function eyeSources(src) {
  return eyesOf(src).filter((l) => !l.tplPart)
    .sort((a, b) => (Math.abs(a.cx - b.cx) > 1 ? a.cx - b.cx : a.eye - b.eye))
    .map((l) => ({ canvas: im.cloneCanvas(l.canvas), adjust: l.adjust && { ...l.adjust }, name: l.name, eye: l.eye, eyeKey: l.eyeKey }));
}

// Расставляет глаза по всем местам шаблона. mode: 'auto' — как задумано в шаблоне,
// иначе 'single', 'corners' или 'whole' для всех мест.
function fillTemplate(doc, mode = 'auto', name = 'Глаза в шаблон') {
  const eyes = doc.tplEyes || [];
  doc.tplMode = mode;
  if (!eyes.length) { ui.toast('Нет вырезанных глаз. Откройте шаблон из листа с глазами или вырежьте глаз здесь'); return; }
  D.structEdit(doc, name, () => {
    doc.layers = doc.layers.filter((l) => !l.tplPart);
    let next = 0;
    doc.slots.forEach((slot, si) => {
      slot.kind = mode === 'auto' ? slot.fixed : mode;
      const a = slot.area, box = slot.sample || a;
      const holder = holderOf(doc, a);
      const m = slotMask(doc, a);
      const base = D.makeLayer({ name: `Место ${si + 1}`, canvas: m.canvas, cx: m.x + m.canvas.width / 2, cy: m.y + m.canvas.height / 2, tplPart: true, locked: true });
      const parts = [base];
      // у каждого места своя копия глаза, чтобы правка одного не меняла другие
      const put = (e, cx, cy, size) => parts.push(D.makeLayer({
        name: e.name, kind: 'eye', canvas: im.cloneCanvas(e.canvas), adjust: e.adjust && { ...e.adjust }, eye: e.eye, eyeKey: e.eyeKey,
        cx, cy, scale: size / Math.max(e.canvas.width, e.canvas.height), clip: true, tplPart: true,
      }));
      if (slot.kind === 'single' || eyes.length < 2) {
        const e = eyes[next++ % eyes.length];
        const size = slot.sample ? Math.max(box.w, box.h) : Math.min(box.w, box.h);
        put(e, box.x + box.w / 2, box.y + box.h / 2, size);
      } else {
        // пара: раскладка студии внутри места; для вертикального места её поворачиваем
        const tall = box.h > box.w, W = tall ? box.h : box.w, H = tall ? box.w : box.h;
        const pos = im.pairSlots(W, H, slot.kind);
        // в шаблонах глаза не должны заходить друг на друга: если раскладка листа
        // ставит их впритык, уменьшаем оба, чтобы между ними остался зазор
        const dist = Math.hypot(pos[0].cx - pos[1].cx, pos[0].cy - pos[1].cy), gap = H * 0.03;
        const dd = Math.min(pos[0].d, dist - gap);
        pos.forEach((q) => { q.d = dd; });
        const order = [eyes[0], eyes[1]];
        pos.forEach((p, i) => {
          const px = tall ? p.cy : p.cx, py = tall ? W - p.cx : p.cy;
          put(order[i], box.x + px, box.y + py, p.d);
        });
      }
      const at = holder ? doc.layers.indexOf(holder) + 1 : doc.layers.length;
      doc.layers.splice(at, 0, ...parts);
    });
    doc.active = [];
  });
  refresh(); requestDraw();
}

// Открыть шаблон, и если в текущем листе есть вырезанные глаза, сразу поставить их.
async function openTemplate(item) {
  if (S.busy) return;
  const src = S.cur;
  const file = await api.readTemplate(item.file);
  if (!file) { ui.toast('Шаблон не найден. Проверьте папку шаблонов в меню «Файл»'); return; }
  await setBusy('Открываю шаблон');
  let doc;
  try {
    ({ doc } = psdToDoc(file.name.replace(PSD_RE, ''), file.data, true));
    prepareTemplate(doc);
  } catch (e) {
    console.error(e);
    setBusy('');
    await ui.tell('Не получилось открыть шаблон', 'Файл повреждён или слишком большой.');
    return;
  }
  doc.tplEyes = src ? eyeSources(src) : [];
  addDoc(doc);
  setBusy('');
  if (!doc.slots.length) ui.toast('В шаблоне не нашлось чёрных мест под фото');
  else if (doc.tplEyes.length) fillTemplate(doc);
  doc.changed = !!doc.tplEyes.length;
  refresh(); fit();
}

// Шаблоны на панели раскладываются по разделам. Подписи короткие, полное имя
// файла видно в подсказке.
const TPL_GROUPS = [
  ['Стикеры', /стикер/i],
  ['Магниты', /магнит/i],
  ['Фото', /полароид|поляроид|паларойд|поларойд|телефон|фото/i],
];
const TPL_NAMES = [
  [/кругл.*стикер|стикер.*кругл/i, 'Круглые'],
  [/шаблон стикер/i, 'Квадратные'],
  [/стикер.*а4|а4.*стикер/i, 'Лист А4'],
  [/магнит.*(биг|больш)/i, 'Большой'],
  [/магнит.*(поменьше|маленьк|мини)/i, 'Малый'],
  [/пол[ая]ро[ий]д/i, 'Полароид'],
  [/телефон/i, 'Мини'],
];

function tplLabel(name) {
  const hit = TPL_NAMES.find(([re]) => re.test(name));
  if (hit) return hit[1];
  const clean = name.replace(/\s*(новый|шаблон)\s*/gi, ' ').trim() || name;
  return clean[0].toUpperCase() + clean.slice(1);
}

function refreshTemplates(list) {
  const box = $('tplBtns');
  box.textContent = '';
  $('tplPanel').hidden = !list.items.length;
  const groups = new Map();
  for (const item of list.items) {
    const g = (TPL_GROUPS.find(([, re]) => re.test(item.name)) || ['Другое'])[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }
  for (const [title] of [...TPL_GROUPS, ['Другое']]) {
    const items = groups.get(title);
    if (!items) continue;
    const sec = ui.el('div', 'tpl-group');
    sec.appendChild(ui.el('div', 'tpl-label', title));
    const grid = ui.el('div', 'tpl-grid');
    grid.style.setProperty('--n', Math.min(3, Math.max(2, items.length)));
    for (const item of items) {
      const b = ui.el('button', 'tpl-btn');
      b.textContent = tplLabel(item.name);
      b.title = item.name + ': открыть, глаза из текущего листа встанут сами';
      b.onclick = () => openTemplate(item);
      grid.appendChild(b);
    }
    sec.appendChild(grid);
    box.appendChild(sec);
  }
}
async function loadTemplateList() { refreshTemplates(await api.templates()); }

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
  if (d.template && d.slots.length) {
    // в шаблоне те же кнопки работают по местам шаблона
    if (!d.tplEyes || !d.tplEyes.length) d.tplEyes = eyeSources(d);
    const has = d.tplEyes.length > 0, two = d.tplEyes.length > 1;
    btn('Как в шаблоне', 'Расставить глаза так, как задумано в шаблоне', () => fillTemplate(d, 'auto'), has, 'full');
    btn('Один', 'В каждое место по одному глазу', () => fillTemplate(d, 'single', 'Один глаз в шаблоне'), has);
    btn('Углы', 'В каждое место пару по углам', () => fillTemplate(d, 'corners', 'Углы в шаблоне'), two);
    btn('Целые', 'В каждое место пару целиком', () => fillTemplate(d, 'whole', 'Целые в шаблоне'), two);
    btn('Поменять местами', 'Поменять глаза местами', () => { d.tplEyes.reverse(); fillTemplate(d, d.tplMode || 'auto', 'Поменять глаза'); }, two, 'full');
    return;
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

// Цифра точки, с которой начинаются имена файлов (у каждой студии своя).
// Спрашивается один раз и запоминается на этом компьютере.
async function askPrefix(current) {
  const v = await ui.ask({
    title: 'Номер точки',
    text: 'С этой цифры начинаются имена готовых файлов, например 4-1233. Спрашиваю один раз, поменять можно в меню «Файл».',
    ok: 'Запомнить',
    input: {
      value: current || '', maxLength: 3, placeholder: '4', note: 'цифра вашей точки',
      filter: (x) => x.replace(/\D/g, '').slice(0, 3),
      validate: (x) => (/^\d{1,3}$/.test(x) ? '' : 'Введите цифру точки, например 4'),
    },
  });
  if (v) await api.setSettings({ pointPrefix: v });
  return v;
}

async function saveNumbered() {
  const d = S.cur;
  if (!d || S.busy) return;
  let { savePath, pointPrefix } = await api.settings();
  if (!pointPrefix) {
    pointPrefix = await askPrefix('');
    if (!pointPrefix) return;
  }
  if (!savePath) {
    await ui.tell('Куда сохранять готовые фото', 'Сейчас выберите общую папку готовых фото. Папку месяца и дня программа будет находить в ней сама.');
    savePath = await api.chooseSaveRoot();
    if (!savePath) return;
  }
  const number = await ui.ask({
    title: 'Сохранить JPEG',
    text: savePath,
    ok: 'Сохранить',
    input: {
      prefix: pointPrefix + '-', maxLength: 4, placeholder: '0000', note: 'номер фото, 4 цифры',
      filter: (v) => v.replace(/\D/g, '').slice(0, 4),
      validate: (v) => (/^\d{4}$/.test(v) ? '' : 'Нужно ровно 4 цифры, например 1233'),
    },
  });
  if (!number) return;
  // сохраняется то же, что на экране: все глаза, а не только выбранный
  if (d.solo) { d.solo = 0; fit(); refresh(); }
  await setBusy('Сохраняю');
  const data = await sheetJpeg(d);
  const req = { prefix: pointPrefix, number, data, overwrite: false, create: false };
  let res = await api.saveJpeg(req);
  setBusy('');
  if (res.status === 'no-folder') {
    const go = await ui.ask({
      title: 'Папки на сегодня ещё нет',
      text: `Не нашёл в «${savePath}» папку за сегодняшнее число. Создать ${res.expected}?`,
      ok: 'Создать и сохранить',
    });
    if (!go) return;
    req.create = true;
    res = await api.saveJpeg(req);
  }
  if (res.status === 'exists') {
    if (!(await ui.ask({ title: `Файл ${pointPrefix}-${number}.jpg уже есть`, text: 'Заменить его новым?', ok: 'Заменить' }))) return;
    req.overwrite = true;
    res = await api.saveJpeg(req);
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
  ['move', 'Перемещение', 'V', 'Щелчок выбирает слой, мимо снимает выбор. Углы рамки: размер, снаружи от угла: поворот. Alt: тащить копию'],
  ['marquee', 'Овальная область', 'M', 'Тяните от центра радужки. Круг потом двигается за середину и меняется за край. Ctrl+J: вырезать на новый слой'],
  ['lasso', 'Лассо', 'L', 'Добавить к выделенной области: обводки сливаются в одно пятно. Alt: вычесть, щелчок: снять выделение'],
  '-',
  ['heal', 'Восстанавливающая кисть', 'J', 'Alt+щелчок: откуда брать. Рисуйте по дефекту, при отпускании текстура подстроится под цвет вокруг'],
  ['patch', 'Заплатка нейронкой', 'Shift+J', 'Закрасьте лишнее. Нейронка уберёт, когда отпустите мышку'],
  ['stamp', 'Штамп', 'S', 'Alt+щелчок: откуда брать. Потом рисуйте там, куда переносить'],
  ['brush', 'Кисть', 'B', 'Рисует выбранным цветом на активном слое'],
  ['eraser', 'Ластик', 'E', 'Стирает пиксели активного слоя до прозрачности'],
  ['burn', 'Затемнитель', 'O', 'Темнит только тона из выбранного диапазона. С Alt осветляет'],
  ['pupil', 'Зрачок', 'P', 'Подведите круг к краю зрачка ползунком справа или мышкой за край. Потом «Сузить зрачок» или Enter'],
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
  if (t[0] === 'hand') b.ondblclick = () => fit();
  if (t[0] === 'zoom') b.ondblclick = () => zoomAt(...center(), 1, 1);
  $('tools').appendChild(b);
}

// Круг ставится по центру глаза, как в панели студии для фотошопа. Если зрачок
// нашёлся и лежит рядом с центром, круг встаёт точно на него. Размер берётся
// по найденному зрачку, а если не нашёлся, то с запасом, в 1,6 раза шире итогового.
function initPupil() {
  const l = layer();
  if (!l || !D.shown(S.cur, l)) { S.pupil = null; return; }
  if (S.pupil && S.pupil.layerId === l.id) return;
  const w = l.canvas.width, h = l.canvas.height, R = Math.min(w, h) / 2;
  const g = im.findPupil(l.canvas);
  const near = g.found && Math.hypot(g.x - w / 2, g.y - h / 2) < R * 0.2;
  S.pupil = {
    layerId: l.id,
    x: near ? g.x : w / 2, y: near ? g.y : h / 2,
    // круг чуть шире чёрного, чтобы тёмный ободок вокруг зрачка тоже ушёл под чёрное
    r: near ? g.r * 1.1 : R * im.PUPIL_RATIO * 1.6,
  };
}

// Тот же круг в координатах листа, чтобы рисовать его и ловить мышкой.
function pupilOnDoc() {
  const l = S.pupil && S.cur && D.layerById(S.cur, S.pupil.layerId);
  if (!l) return null;
  const c = D.toDoc(l, S.pupil);
  return { x: c.x, y: c.y, r: S.pupil.r * l.scale, layer: l };
}

function setTool(id) {
  if (id === 'pupil' && S.tool !== 'pupil') S.prevTool = S.tool;
  S.tool = id;
  S.drag = null;
  if (id === 'pupil') { initPupil(); syncPupilPanel(); }
  refreshOptions();
  refreshStatus();
  setCursor();
  requestDraw();
}

function applyPupil() {
  const d = S.cur, l = paintLayer();
  if (!l || S.busy) return;
  if (!S.pupil || S.pupil.layerId !== l.id) { S.pupil = null; initPupil(); }
  if (!S.pupil) return;
  const lp = { x: S.pupil.x, y: S.pupil.y, r: S.pupil.r };
  const R = Math.min(l.canvas.width, l.canvas.height) / 2;
  const rect = im.pupilRect(l.canvas, lp, R);
  if (rect.w < 2 || rect.h < 2) return;
  const before = l.canvas.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h);
  im.shrinkPupil(l.canvas, lp, R, im.PUPIL_RATIO);
  D.pushPixels(d, l, 'Сузить зрачок', rect.x, rect.y, before);
  // дело сделано: круг убираем и возвращаем инструмент, которым работали до этого
  S.pupil = null;
  if (S.tool === 'pupil') setTool(S.prevTool && S.prevTool !== 'pupil' ? S.prevTool : 'lasso');
  refresh(); requestDraw();
}

// Панель «Зрачок» справа устроена как панель студии для фотошопа: один ползунок
// показывает кругом, где сейчас край зрачка, кнопка сужает его до стандартного.
const pupilUi = {};
(() => {
  const box = $('pupilBody');
  pupilUi.now = ui.slider({
    label: 'Край зрачка', min: 8, max: 80, step: 0.5, unit: '%', value: 38,
    onInput: (v) => {
      const l = layer();
      if (!l) return;
      if (S.tool !== 'pupil') setTool('pupil');
      if (!S.pupil) return;
      S.pupil.r = v / 100 * Math.min(l.canvas.width, l.canvas.height) / 2;
      requestOverlay();
    },
  });
  pupilUi.go = ui.el('button', 'btn wide', 'Сузить зрачок');
  pupilUi.go.onclick = () => {
    if (S.tool !== 'pupil') { setTool('pupil'); ui.toast('Подведите круг к краю зрачка и нажмите ещё раз'); return; }
    applyPupil();
  };
  pupilUi.note = ui.el('p', 'panel-note', '');
  box.append(pupilUi.now, pupilUi.go, pupilUi.note);
})();

function syncPupilPanel() {
  const l = layer();
  if (S.pupil && l && S.pupil.layerId === l.id) {
    pupilUi.now.set(Math.round(S.pupil.r / (Math.min(l.canvas.width, l.canvas.height) / 2) * 200) / 2);
  }
}

function refreshPupilPanel() {
  const l = layer(), ok = !!(l && D.shown(S.cur, l) && l.kind !== 'photo');
  pupilUi.go.disabled = !ok;
  pupilUi.now.classList.toggle('off', !ok);
  pupilUi.note.textContent = ok ? '' : l && l.kind === 'photo' ? 'Сначала вырежьте глаз: круг по радужке и Ctrl+J.' : 'Выберите слой с глазом.';
  pupilUi.note.hidden = ok;
  syncPupilPanel();
}

// Мазок кистью, ластиком, штампом или затемнителем. Рисуем сразу в пиксели слоя.
function beginStroke(l, mode, p, e) {
  const o = S.opts[S.tool];
  const g = { type: 'stroke', mode, layer: l, snap: im.cloneCanvas(l.canvas), last: null, box: null };
  g.targets = [{ x: l.canvas.getContext('2d'), k: 1, snap: g.snap }];
  if (l.adjust) {
    // проявленную копию правим теми же мазками, чтобы результат было видно сразу
    const v = D.layerView(l);
    g.targets.push({ x: v.canvas.getContext('2d'), k: v.k, snap: mode === 'stamp' || mode === 'heal' ? im.cloneCanvas(v.canvas) : null });
  }
  if (mode === 'burn') g.dodge = (o.mode === 'dodge') !== e.altKey;
  if (mode === 'stamp' || mode === 'heal') {
    // с «Выравниванием» источник едет вместе с кистью и между мазками, как в фотошопе;
    // без него каждый мазок начинается с той же точки источника
    if (!o.aligned || !S.stampOff) S.stampOff = { x: S.stampSrc.x - p.x, y: S.stampSrc.y - p.y };
    const a = D.toLocal(l, { x: p.x + S.stampOff.x, y: p.y + S.stampOff.y }), b = D.toLocal(l, p);
    // целое смещение: так перенесённая текстура не размывается пересчётом пикселей
    g.off = { x: Math.round(a.x - b.x), y: Math.round(a.y - b.y) };
    g.srcDelta = { ...S.stampOff };
    if (mode === 'heal') g.dabs = [];
  }
  l.live = true;
  S.drag = g;
  dab(g, p);
}

function dab(g, p) {
  const o = S.opts[S.tool], l = g.layer;
  const q = D.toLocal(l, p), r = o.size / 2 / l.scale;
  const hard = Math.min(0.98, (o.hard == null ? 0 : o.hard) / 100), flow = (o.flow == null ? 100 : o.flow) / 100;
  if (g.dabs) g.dabs.push({ x: q.x, y: q.y, r, hard });
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
    if (g.mode === 'stamp' || g.mode === 'heal') {
      const s = Math.ceil(rr * 2) + 2, tmp = im.makeCanvas(s, s), tx = tmp.getContext('2d');
      tx.drawImage(t.snap, (q.x + g.off.x) * k - s / 2, (q.y + g.off.y) * k - s / 2, s, s, 0, 0, s, s);
      const gr = tx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, rr);
      gr.addColorStop(0, `rgba(0,0,0,${flow})`); gr.addColorStop(hard, `rgba(0,0,0,${flow})`); gr.addColorStop(1, 'rgba(0,0,0,0)');
      tx.globalCompositeOperation = 'destination-in';
      tx.fillStyle = gr; tx.fillRect(0, 0, s, s);
      x.drawImage(tmp, cx - s / 2, cy - s / 2);
    } else {
      if (g.mode === 'erase') { x.globalCompositeOperation = 'destination-out'; x.fillStyle = grad('0,0,0', flow); }
      else if (g.mode === 'burn') { burnPixels(x, cx, cy, rr, hard, flow * 0.12, g.dodge, o.range, o.protect); x.restore(); continue; }
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

// Затемнитель и осветлитель как в фотошопе: сила зависит от яркости пикселя.
// «Средние тона» почти не трогают чёрное и белое, «Тени» работают по тёмному,
// «Света» по светлому. «Защитить тона» меняет только яркость, оттенок и
// насыщенность остаются прежними; без защиты цвет в тенях становится гуще.
const RANGE_W = {
  shadows: (v) => (1 - v) * (1 - v),
  mid: (v) => 1 - (2 * v - 1) * (2 * v - 1),
  highlights: (v) => v * v,
};

function burnPixels(x, cx, cy, rr, hard, strength, dodge, range, protect) {
  const W = x.canvas.width, H = x.canvas.height;
  const x0 = Math.max(0, Math.floor(cx - rr)), y0 = Math.max(0, Math.floor(cy - rr));
  const x1 = Math.min(W, Math.ceil(cx + rr)), y1 = Math.min(H, Math.ceil(cy + rr));
  if (x1 <= x0 || y1 <= y0) return;
  const img = x.getImageData(x0, y0, x1 - x0, y1 - y0), d = img.data, w = x1 - x0;
  const rw = RANGE_W[range] || RANGE_W.mid;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const dist = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) / rr;
      if (dist >= 1) continue;
      const i = ((yy - y0) * w + (xx - x0)) * 4;
      if (d[i + 3] === 0) continue;
      const t = dist <= hard ? 0 : (dist - hard) / (1 - hard), fall = 1 - t * t * (3 - 2 * t);
      if (protect) {
        const L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        const a = strength * fall * rw(L);
        const L2 = dodge ? L + (1 - L) * a : L * (1 - a);
        if (L > 0.004) {
          const k = L2 / L;
          d[i] = d[i] * k; d[i + 1] = d[i + 1] * k; d[i + 2] = d[i + 2] * k;
        } else {
          const add = (L2 - L) * 255;
          d[i] += add; d[i + 1] += add; d[i + 2] += add;
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const v = d[i + c] / 255, a = strength * fall * rw(v);
          d[i + c] = (dodge ? v + (1 - v) * a : v * (1 - a)) * 255;
        }
      }
    }
  }
  x.putImageData(img, x0, y0);
}

function strokeTo(g, p) {
  const step = Math.max(1, S.opts[S.tool].size * 0.12);
  const dx = p.x - g.last.x, dy = p.y - g.last.y, dist = Math.hypot(dx, dy);
  if (dist < step) return;
  const from = g.last;
  for (let t = step; t <= dist; t += step) dab(g, { x: from.x + dx * t / dist, y: from.y + dy * t / dist });
}

const STROKE_NAMES = { paint: 'Кисть', erase: 'Ластик', burn: 'Затемнитель', stamp: 'Штамп', heal: 'Восстанавливающая кисть' };

// Восстанавливающая кисть. Пока рисуешь, текстура переносится как штампом.
// При отпускании разница между тем, что было вокруг мазка, и перенесённой
// текстурой плавно растягивается внутрь мазка: так заплатка берёт рисунок
// у источника, а цвет и яркость у места, куда её положили.
function healStroke(g, bx, by, bw, bh) {
  const l = g.layer, W = l.canvas.width, H = l.canvas.height;
  const pad = Math.ceil(Math.max(6, Math.max(...g.dabs.map((d) => d.r)) * 0.4));
  const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad);
  const w = Math.min(W, bx + bw + pad) - x0, h = Math.min(H, by + bh + pad) - y0;
  if (w < 3 || h < 3) return;
  // маска мазка
  const mc = im.makeCanvas(w, h), mx = mc.getContext('2d', { willReadFrequently: true });
  for (const d of g.dabs) {
    const gr = mx.createRadialGradient(d.x - x0, d.y - y0, 0, d.x - x0, d.y - y0, d.r);
    gr.addColorStop(0, '#fff'); gr.addColorStop(d.hard, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    mx.fillStyle = gr;
    mx.beginPath(); mx.arc(d.x - x0, d.y - y0, d.r, 0, Math.PI * 2); mx.fill();
  }
  const M = mx.getImageData(0, 0, w, h).data;
  // как было и откуда берём текстуру
  const O = g.snap.getContext('2d').getImageData(x0, y0, w, h).data;
  const sc = im.makeCanvas(w, h), sx = sc.getContext('2d', { willReadFrequently: true });
  sx.drawImage(g.snap, x0 + g.off.x, y0 + g.off.y, w, h, 0, 0, w, h);
  const Sd = sx.getImageData(0, 0, w, h).data;
  // разница на краю мазка, внутрь растягивается
  const n = w * h, diff = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], wt = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = M[i * 4 + 3] / 255;
    if (m < 0.03 && O[i * 4 + 3] > 0 && Sd[i * 4 + 3] > 0) {
      wt[i] = 1;
      for (let c = 0; c < 3; c++) diff[c][i] = O[i * 4 + c] - Sd[i * 4 + c];
    }
  }
  const fill = pullPush(diff, wt, w, h);
  const cur = l.canvas.getContext('2d'), out = cur.getImageData(x0, y0, w, h), od = out.data;
  for (let i = 0; i < n; i++) {
    const m = M[i * 4 + 3] / 255;
    if (m <= 0 || Sd[i * 4 + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      const healed = Sd[i * 4 + c] + fill[c][i];
      od[i * 4 + c] = O[i * 4 + c] * (1 - m) + healed * m;
    }
    od[i * 4 + 3] = O[i * 4 + 3];
  }
  cur.putImageData(out, x0, y0);
}

// Плавно заполняет пропуски: значения с весом 1 остаются, остальные
// достраиваются из уменьшенных копий, от грубой к точной.
function pullPush(ch, wt, w, h) {
  if (w <= 1 && h <= 1) return ch;
  const w2 = Math.ceil(w / 2), h2 = Math.ceil(h / 2), n2 = w2 * h2;
  const cch = ch.map(() => new Float32Array(n2)), cw = new Float32Array(n2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = (y >> 1) * w2 + (x >> 1), v = wt[i];
    if (!v) continue;
    cw[j] += v;
    for (let c = 0; c < ch.length; c++) cch[c][j] += ch[c][i] * v;
  }
  for (let j = 0; j < n2; j++) if (cw[j] > 0) { for (let c = 0; c < ch.length; c++) cch[c][j] /= cw[j]; cw[j] = Math.min(1, cw[j]); }
  const coarse = pullPush(cch, cw, w2, h2);
  const out = ch.map((a) => new Float32Array(a));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = Math.min(1, wt[i]);
    if (v >= 1) continue;
    // берём среднее четырёх соседних клеток грубого уровня, чтобы не было ступенек
    const fx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const ix1 = Math.min(w2 - 1, ix + 1), iy1 = Math.min(h2 - 1, iy + 1);
    for (let c = 0; c < ch.length; c++) {
      const a = coarse[c];
      const cv = (a[iy * w2 + ix] * (1 - tx) + a[iy * w2 + ix1] * tx) * (1 - ty) + (a[iy1 * w2 + ix] * (1 - tx) + a[iy1 * w2 + ix1] * tx) * ty;
      out[c][i] = ch[c][i] * v + cv * (1 - v);
    }
  }
  return out;
}

function endStroke(g) {
  const l = g.layer, b = g.box;
  l.live = false;
  S.lastPaint = { id: l.id, tool: S.tool, p: g.last };
  const x = Math.max(0, Math.floor(b.x0)), y = Math.max(0, Math.floor(b.y0));
  const w = Math.min(l.canvas.width, Math.ceil(b.x1)) - x, h = Math.min(l.canvas.height, Math.ceil(b.y1)) - y;
  if (w > 0 && h > 0) {
    if (g.mode === 'heal') healStroke(g, x, y, w, h);
    const before = g.snap.getContext('2d').getImageData(x, y, w, h);
    D.pushPixels(S.cur, l, g.mode === 'burn' && g.dodge ? 'Осветлитель' : STROKE_NAMES[g.mode], x, y, before);
  }
  refresh();
}

// Курсоры по образцу фотошопа. Для кистей системный курсор прячется: вместо него
// рисуется круг размером с кисть.
const svgCursor = (body, x, y, fallback) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`)}") ${x} ${y}, ${fallback}`;
const two = (d, extra = '') => `<path d='${d}' stroke='#fff' stroke-width='3' ${extra}/><path d='${d}' stroke='#000' stroke-width='1.2' ${extra}/>`;
const CURSORS = {
  move: svgCursor(`<path d='M4 3l9 5.2-3.7 1 2.1 4.3-1.7.8-2.1-4.3L5 12.600z' fill='#000' stroke='#fff' stroke-width='1'/>${two('M17 13v8M13 17h8M17 13l-1.300 1.500M17 13l1.300 1.500M17 21l-1.300-1.500M17 21l1.300-1.500M13 17l1.500-1.300M13 17l1.500 1.300M21 17l-1.500-1.300M21 17l-1.500 1.300')}`, 4, 3, 'default'),
  marquee: svgCursor(two('M12 4v6M12 14v6M4 12h6M14 12h6'), 12, 12, 'crosshair'),
  lasso: svgCursor(`${two('M13 5c-4.400 0-8 2-8 4.500S8.600 14 13 14s8-2 8-4.500S17.400 5 13 5z')}${two('M8.500 13.300c-1.400.900-1.500 2.600-.300 3.300 1.100.700 2.500-.100 2.300-1.300M9.600 16.500 7 21')}${two('M16 19.500h5M18.500 17v5')}`, 7, 21, 'crosshair'),
  lassoMinus: svgCursor(`${two('M13 5c-4.400 0-8 2-8 4.500S8.600 14 13 14s8-2 8-4.500S17.400 5 13 5z')}${two('M8.500 13.300c-1.400.900-1.500 2.600-.300 3.300 1.100.700 2.500-.100 2.300-1.300M9.600 16.500 7 21')}${two('M16 19.500h5')}`, 7, 21, 'crosshair'),
  pupil: svgCursor(two('M12 5v5M12 14v5M5 12h5M14 12h5'), 12, 12, 'default'),
  zoomIn: svgCursor(`<circle cx='10' cy='10' r='6' fill='#fff' fill-opacity='.25' stroke='#fff' stroke-width='3'/><circle cx='10' cy='10' r='6' stroke='#000' stroke-width='1.300'/>${two('M14.500 14.500 20 20M7.500 10h5M10 7.500v5')}`, 10, 10, 'zoom-in'),
  zoomOut: svgCursor(`<circle cx='10' cy='10' r='6' fill='#fff' fill-opacity='.25' stroke='#fff' stroke-width='3'/><circle cx='10' cy='10' r='6' stroke='#000' stroke-width='1.300'/>${two('M14.500 14.500 20 20M7.500 10h5')}`, 10, 10, 'zoom-out'),
  dot: svgCursor(two('M12 9.500v5M9.500 12h5'), 12, 12, 'crosshair'),
};
const SIZED = ['patch', 'heal', 'stamp', 'brush', 'eraser', 'burn'];

function setCursor(over) {
  const t = S.tool;
  let c = over;
  if (!c) {
    if (t === 'hand' || S.space) c = S.drag && S.drag.type === 'pan' ? 'grabbing' : 'grab';
    else if (S.ctrl && TEMP_MOVE.includes(t)) c = CURSORS.move;
    else if (t === 'zoom') c = S.alt ? CURSORS.zoomOut : CURSORS.zoomIn;
    else if (t === 'lasso') c = S.alt ? CURSORS.lassoMinus : CURSORS.lasso;
    else if (SIZED.includes(t)) {
      // совсем маленькую кисть кругом не разглядеть, показываем перекрестие
      const tiny = S.cur && S.opts[t].size * S.cur.view.scale < 7;
      c = (t === 'stamp' || t === 'heal') && S.alt ? CURSORS.marquee : tiny ? CURSORS.dot : 'none';
    } else c = CURSORS[t] || 'default';
  }
  canvas.style.cursor = c;
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
  const d = S.cur, act = liveActive(d);
  if (act.length !== 1) return null;
  const l = act[0], k = d.view.scale, cs = D.corners(l);
  let best = -1, dist = Infinity;
  cs.forEach((c, i) => { const v = Math.hypot(c.x - p.x, c.y - p.y) * k; if (v < dist) { dist = v; best = i; } });
  if (dist <= 8) return { type: 'scale', layer: l, corner: best };
  const q = D.toLocal(l, p), out = q.x < 0 || q.y < 0 || q.x > l.canvas.width || q.y > l.canvas.height;
  if (dist <= 28 && out) return { type: 'rotate', layer: l };
  return null;
}

// Ctrl с любым рисующим инструментом временно даёт перемещение, как в фотошопе.
const TEMP_MOVE = ['marquee', 'lasso', 'patch', 'heal', 'stamp', 'brush', 'eraser', 'burn', 'pupil'];
const tempMove = (e) => e.ctrlKey && TEMP_MOVE.includes(S.tool);

// Перемещение. С автовыбором щелчок по глазу выбирает его, щелчок мимо слоёв
// снимает выбор. Если выбрано несколько слоёв, перетаскивание двигает все,
// а щелчок без перетаскивания оставляет выбранным один. Alt тащит копию.
function moveDown(d, p, e) {
  const o = S.opts.move;
  const h = !tempMove(e) && moveHit(p);
  if (h) {
    const l = h.layer;
    S.drag = { ...h, commit: D.beginStruct(d), start: p, s0: l.scale, r0: l.rot, c0: { x: l.cx, y: l.cy } };
    if (h.type === 'scale') S.drag.anchor = D.corners(l)[(h.corner + 2) % 4];
    return;
  }
  const auto = o.auto || tempMove(e);
  const under = d.layers.slice().reverse().find((l) => D.shown(d, l) && !l.locked && D.hit(l, p));
  let only = 0;
  if (auto) {
    if (!under) {
      if (!e.shiftKey && d.active.length) { d.active = []; S.pupil = null; refresh(); }
      return;
    }
    if (e.shiftKey) {
      d.active = d.active.includes(under.id) ? d.active.filter((i) => i !== under.id) : [...d.active, under.id];
      refresh();
      if (!d.active.includes(under.id)) return;
    } else if (!d.active.includes(under.id)) {
      d.active = [under.id];
      S.pupil = null;
      refresh();
    } else if (d.active.length > 1) only = under.id;
  }
  const act = liveActive(d);
  if (!act.length) return;
  const commit = D.beginStruct(d);
  let layers = act;
  if (e.altKey) {
    // Alt+перетаскивание: тащим копию, оригинал остаётся на месте
    layers = act.map((l) => {
      const { id, rev, cache, thumb, proxy, ...rest } = l; // у копии свой номер и свои кэши
      const c = D.makeLayer({ ...rest, name: l.name + ' копия', canvas: im.cloneCanvas(l.canvas), adjust: l.adjust && { ...l.adjust }, slotCopy: false });
      d.layers.splice(d.layers.indexOf(l) + 1, 0, c);
      return c;
    });
    d.active = layers.map((l) => l.id);
    refresh();
  }
  S.drag = { type: 'move', commit, copy: e.altKey, start: p, only, layers: layers.map((l) => ({ l, x: l.cx, y: l.cy })), moved: false };
}

canvas.addEventListener('pointerdown', (e) => {
  const d = S.cur;
  if (!d || S.busy) return;
  const p = toDocPt(e), o = S.opts[S.tool];
  canvas.setPointerCapture(e.pointerId);
  // Alt + правая кнопка: влево-вправо размер кисти, вверх-вниз жёсткость
  if (e.button === 2 && e.altKey && o && o.size) {
    S.drag = { type: 'brushsize', sx: e.clientX, sy: e.clientY, at: p, size0: o.size, hard0: o.hard };
    S.cursor = p;
    return;
  }
  // Ctrl+пробел щелчок приближает, Alt+пробел отдаляет
  if (S.space && e.button === 0 && (e.ctrlKey || e.altKey)) {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.altKey ? 1 / 1.5 : 1.5);
    return;
  }
  if (e.button !== 0 || S.space || S.tool === 'hand') { S.drag = { type: 'pan' }; setCursor('grabbing'); return; }
  // Alt+щелчок кистью берёт цвет с картинки, как пипетка
  if (S.tool === 'brush' && e.altKey) {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const px = ctx.getImageData(Math.round((e.clientX - r.left) * dpr), Math.round((e.clientY - r.top) * dpr), 1, 1).data;
    o.color = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    refreshOptions();
    return;
  }

  if (S.tool === 'zoom') {
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.altKey ? 1 / 1.5 : 1.5);
  } else if (S.tool === 'move' || tempMove(e)) {
    moveDown(d, p, e);
  } else if (S.tool === 'marquee') {
    const one = soleEllipse(), h = one && !e.shiftKey ? circleHit({ x: one.cx, y: one.cy, r: Math.max(one.rx, one.ry) }, p) : '';
    if (h === 'edge') S.drag = { type: 'selresize', commit: D.beginStruct(d), s: one, k: one.ry / one.rx };
    else if (h === 'in') S.drag = { type: 'selmove', commit: D.beginStruct(d), s: one, dx: p.x - one.cx, dy: p.y - one.cy };
    else {
      const start = o.center ? snapToCenter(p) : p;
      S.drag = { type: 'marquee', commit: D.beginStruct(d), start, add: e.shiftKey, shape: { type: 'ellipse', cx: start.x, cy: start.y, rx: 0, ry: 0 } };
    }
  } else if (S.tool === 'lasso') {
    // как просили в студии: новая обводка добавляется к старой, Alt вычитает, щелчок снимает выделение
    S.drag = { type: 'lasso', commit: D.beginStruct(d), add: true, shape: { type: 'poly', pts: [p], sub: e.altKey } };
  } else if (S.tool === 'pupil') {
    initPupil();
    const c = pupilOnDoc(), h = c ? circleHit(c, p) : '';
    if (h === 'edge') S.drag = { type: 'pupilresize', c };
    else if (h === 'in') S.drag = { type: 'pupilmove', c, dx: p.x - c.x, dy: p.y - c.y };
  } else if (S.tool === 'patch') {
    if (paintLayer()) S.drag = { type: 'patch', pts: [p], size: o.size };
  } else if (S.tool === 'stamp' || S.tool === 'heal') {
    if (e.altKey) { S.stampSrc = p; S.stampOff = null; ui.toast('Источник задан. Теперь рисуйте там, куда переносить'); }
    else if (!S.stampSrc) ui.toast('Сначала Alt+щелчок там, откуда брать');
    else { const l = paintLayer(); if (l) beginStroke(l, S.tool, p, e); }
  } else if (S.tool === 'brush' || S.tool === 'eraser' || S.tool === 'burn') {
    const l = paintLayer();
    if (l) {
      const mode = S.tool === 'brush' ? 'paint' : S.tool === 'eraser' ? 'erase' : 'burn';
      const last = S.lastPaint;
      if (e.shiftKey && last && last.id === l.id && last.tool === S.tool) {
        // Shift+щелчок: прямая от прошлой точки до этой
        beginStroke(l, mode, last.p, e);
        strokeTo(S.drag, p);
        endStroke(S.drag);
        S.drag = null;
      } else beginStroke(l, mode, p, e);
    }
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
      setCursor(!h ? '' : h.type === 'scale' ? 'nwse-resize' : 'alias');
    } else if (S.tool === 'marquee' || S.tool === 'pupil') {
      const one = S.tool === 'pupil' ? pupilOnDoc() : soleEllipse();
      const h = one ? circleHit(S.tool === 'pupil' ? one : { x: one.cx, y: one.cy, r: Math.max(one.rx, one.ry) }, p) : '';
      setCursor(h === 'edge' ? 'nwse-resize' : h === 'in' ? 'move' : '');
    }
    if (S.opts[S.tool] && S.opts[S.tool].size) requestOverlay();
    return;
  }
  if (g.type === 'brushsize') {
    const o = S.opts[S.tool];
    o.size = Math.round(Math.max(4, Math.min(600, g.size0 + (e.clientX - g.sx) * 2 / d.view.scale)));
    if (g.hard0 != null) o.hard = Math.round(Math.max(0, Math.min(100, g.hard0 - (e.clientY - g.sy) / 2)));
    S.cursor = g.at;
    refreshOptions();
    requestOverlay();
    return;
  }
  if (g.type === 'pan') {
    d.view.ox += e.movementX; d.view.oy += e.movementY;
  } else if (g.type === 'move') {
    let dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    for (const m of g.layers) { m.l.cx = m.x + dx; m.l.cy = m.y + dy; }
    if (g.layers.length === 1 && !e.ctrlKey && !e.metaKey) {
      const l = g.layers[0].l, c = snapToCenter({ x: l.cx, y: l.cy });
      l.cx = c.x; l.cy = c.y;
    }
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
    if (S.space) { g.start.x += e.movementX / d.view.scale; g.start.y += e.movementY / d.view.scale; }
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
    const c = snapToCenter({ x: p.x - g.dx, y: p.y - g.dy });
    g.s.cx = c.x; g.s.cy = c.y;
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
  // лист пересобираем, только если менялось то, что на нём нарисовано
  if (['pan', 'move', 'scale', 'rotate', 'stroke'].includes(g.type)) requestDraw(); else requestOverlay();
  if (g.type === 'pupilresize') syncPupilPanel();
});

function endDrag(e) {
  // сколько занимает отпускание мыши до готового кадра: для проверки на задержки
  const t0 = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => { S.releaseMs = Math.round(performance.now() - t0); }));
  const d = S.cur, g = S.drag;
  S.drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (!g || !d) return;
  if (g.type === 'pan' || g.type === 'brushsize') { setCursor(); if (g.type === 'brushsize') S.cursor = toDocPt(e); }
  if (g.type === 'move' || g.type === 'scale' || g.type === 'rotate') {
    if (g.moved || g.copy) g.commit(g.copy ? 'Копия слоя' : g.type === 'move' ? 'Перемещение' : g.type === 'scale' ? 'Размер слоя' : 'Поворот слоя');
    else if (g.only) { S.cur.active = [g.only]; S.pupil = null; }
    refresh();
  }
  if (g.type === 'marquee' || g.type === 'lasso') {
    const s = g.shape;
    // щелчок с дрожью руки не считаем обводкой: смотрим размер на экране
    const spanPx = s.type === 'ellipse' ? Math.min(s.rx, s.ry) * 2 * d.view.scale
      : Math.max(Math.max(...s.pts.map((q) => q.x)) - Math.min(...s.pts.map((q) => q.x)), Math.max(...s.pts.map((q) => q.y)) - Math.min(...s.pts.map((q) => q.y))) * d.view.scale;
    const ok = (s.type === 'ellipse' ? s.rx > 2 && s.ry > 2 : s.pts.length > 2) && spanPx > 5;
    const had = !!d.sel;
    if (!ok) { if (g.type === 'lasso' ? !s.sub : !g.add && !s.sub) d.sel = null; }
    else if ((g.add || s.sub) && d.sel) d.sel.shapes.push(s);
    else if (!s.sub) d.sel = { shapes: [s], feather: S.opts[S.tool].feather };
    if (ok) g.commit(g.type === 'marquee' ? 'Овальная область' : 'Лассо');
    else if (had && !d.sel) g.commit('Снять выделение');
    refresh();
  }
  if (g.type === 'selmove' || g.type === 'selresize') {
    g.commit(g.type === 'selmove' ? 'Перемещение выделения' : 'Размер выделения');
    refreshHistory(); refreshTabs();
  }
  if (g.type === 'patch') removeStroke(D.activeLayer(d), g);
  if (g.type === 'stroke') endStroke(g);
  requestDraw();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { S.cursor = null; if (!S.drag) requestOverlay(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), d = S.cur;
  if (!d) return;
  S.wheeling = true;
  // как в фотошопе: колесо листает вверх-вниз, с Ctrl или Shift вбок, с Alt масштабирует
  if (e.altKey) { zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15); return; }
  const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? stage.clientHeight : 1;
  let dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey || e.shiftKey) { dx = dx || dy; dy = 0; }
  d.view.ox -= dx; d.view.oy -= dy;
  requestDraw();
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
    if (S.tool === 'stamp') check('Выравн.', 'aligned');
  } else if (S.tool === 'heal') {
    size(); range('Жёсткость', 'hard', 0, 100, '%'); check('Выравн.', 'aligned');
  } else if (S.tool === 'brush') {
    const c = ui.el('input', 'swatch');
    c.type = 'color'; c.value = o.color; c.title = 'Цвет кисти';
    c.oninput = () => { o.color = c.value; };
    add(c);
    size(); range('Жёсткость', 'hard', 0, 100, '%'); range('Нажим', 'flow', 1, 100, '%');
  } else if (S.tool === 'burn') {
    const seg = (items, key) => {
      const box = ui.el('div', 'seg');
      for (const [v, t] of items) {
        const b = ui.el('button', o[key] === v ? 'on' : '', t);
        b.onclick = () => { o[key] = v; refreshOptions(); };
        box.appendChild(b);
      }
      return add(box);
    };
    seg([['burn', 'Затемнитель'], ['dodge', 'Осветлитель']], 'mode');
    size(); range('Жёсткость', 'hard', 0, 100, '%');
    // диапазон выпадающим списком, как в фотошопе
    const wrap = ui.el('label', 'opt-select', '<span>Диапазон</span>');
    const sel = ui.el('select');
    for (const [v, t] of [['shadows', 'Тени'], ['mid', 'Средние тона'], ['highlights', 'Света']]) {
      const op = ui.el('option', '', t);
      op.value = v;
      sel.appendChild(op);
    }
    sel.value = o.range;
    sel.onchange = () => { o.range = sel.value; sel.blur(); };
    wrap.appendChild(sel);
    add(wrap);
    range('Экспонир.', 'flow', 1, 100, '%');
    check('Защитить тона', 'protect');
  } else if (S.tool === 'pupil') {
    button('Сузить зрачок', applyPupil, true);
  } else {
    button('Вписать в окно', fit);
    button('100%', () => zoomAt(...center(), 1, 1));
  }
  bar.appendChild(ui.el('div', 'opt-hint', info[3]));
}

// --- Панели справа ----------------------------------------------------------

// Окно проявки: большой предпросмотр и ручки справа, как Camera Raw.
// Открывается при вставке снимка и по Ctrl+Shift+A для выбранного слоя.
// Считается только то, что видно на экране, поэтому ручки отзываются сразу.
// Окно проявки по образцу Camera Raw: гистограмма, «Свет», «Цвет»
// и «Смешение цветов». Считается только то, что видно на экране.
const signed = (v) => (v > 0 ? '+' : '') + v;
const DEV_LIGHT = [
  ['exp', 'Экспозиция', -5, 5, 0.05, (v) => signed(v.toFixed(2)), 'linear-gradient(90deg,#111,#eee)'],
  ['contrast', 'Контрастность', -100, 100, 1, signed, 'linear-gradient(90deg,#777,#333 50%,#ddd 50%,#fff)'],
  ['highlights', 'Светлые', -100, 100, 1, signed],
  ['shadows', 'Тени', -100, 100, 1, signed],
  ['whites', 'Белые', -100, 100, 1, signed],
  ['blacks', 'Черные', -100, 100, 1, signed],
];
const DEV_COLOR = [
  ['temp', 'Температура', -100, 100, 1, signed, 'linear-gradient(90deg,#3f74c9,#d9d9d9,#e3c23c)'],
  ['tint', 'Оттенок', -100, 100, 1, signed, 'linear-gradient(90deg,#4caf50,#d9d9d9,#c45ec4)'],
  ['vibrance', 'Красочность', -100, 100, 1, signed, 'linear-gradient(90deg,#8b8b8b,#d97b3a)'],
  ['sat', 'Насыщенность', -100, 100, 1, signed, 'linear-gradient(90deg,#8b8b8b,#e0433a)'],
];
const HSL_HEX = ['#e8453c', '#ee8a2f', '#e6d23a', '#47b04b', '#3fc4c9', '#3f6fd8', '#8b4fd8', '#d64fb6'];
const HSL_NEXT = [['#e84a8c', '#ee8a2f'], ['#e8453c', '#e6d23a'], ['#ee8a2f', '#47b04b'], ['#e6d23a', '#3fc4c9'], ['#47b04b', '#3f6fd8'], ['#3fc4c9', '#8b4fd8'], ['#3f6fd8', '#d64fb6'], ['#8b4fd8', '#e8453c']];
const dev = { rows: {}, hslRows: [], hslTab: 'h', src: null, p: null, zoom: 'fit', center: null, done: null, raf: 0, pan: null };

function devSlider([key, label, min, max, step, fmt, track]) {
  dev.rows[key] = ui.slider({
    label, min, max, step, value: 0, reset: 0, fmt, track,
    onInput: (v) => { dev.p[key] = v; devQueue(); },
    onChange: () => { cancelAnimationFrame(dev.raf); devRender(false); },
  });
  return dev.rows[key];
}

function devSection(title, open, build) {
  const det = ui.el('details', 'dev-sec');
  det.open = open;
  det.appendChild(ui.el('summary', '', title));
  build(det);
  $('devBody').appendChild(det);
}

devSection('Свет', true, (box) => DEV_LIGHT.forEach((r) => box.appendChild(devSlider(r))));
devSection('Цвет', true, (box) => {
  box.appendChild(ui.el('div', 'dev-sub', 'Баланс белого: как снято, ниже поправка'));
  DEV_COLOR.forEach((r) => box.appendChild(devSlider(r)));
});
devSection('Смешение цветов', false, (box) => {
  const seg = ui.el('div', 'seg');
  for (const [k, t] of [['h', 'Тон'], ['s', 'Насыщенность'], ['l', 'Светимость']]) {
    const b = ui.el('button', k === dev.hslTab ? 'on' : '', t);
    b.dataset.k = k;
    b.onclick = () => { dev.hslTab = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); devSync(); };
    seg.appendChild(b);
  }
  box.appendChild(seg);
  im.HSL_COLORS.forEach((name, i) => {
    const row = ui.slider({
      label: name, min: -100, max: 100, value: 0, reset: 0, fmt: signed,
      onInput: (v) => { dev.p.hsl[dev.hslTab][i] = v; devQueue(); },
      onChange: () => { cancelAnimationFrame(dev.raf); devRender(false); },
    });
    dev.hslRows.push(row);
    box.appendChild(row);
  });
});

function devQueue() {
  cancelAnimationFrame(dev.raf);
  dev.raf = requestAnimationFrame(() => devRender(true));
}

function devHistogram(c) {
  const hc = $('devHisto'), x = hc.getContext('2d'), W = hc.width, H = hc.height;
  const small = im.makeCanvas(256, Math.max(1, Math.round(256 * c.height / c.width)));
  small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
  const d = small.getContext('2d').getImageData(0, 0, small.width, small.height).data;
  const hs = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { hs[0][d[i]]++; hs[1][d[i + 1]]++; hs[2][d[i + 2]]++; }
  // крайние столбцы не учитываем в масштабе, иначе чёрный фон всё сплющит
  let max = 1;
  for (const h of hs) for (let i = 2; i < 254; i++) max = Math.max(max, h[i]);
  x.clearRect(0, 0, W, H);
  x.globalCompositeOperation = 'lighter';
  ['#e5483f', '#45c25a', '#3f7de8'].forEach((col, k) => {
    x.fillStyle = col;
    x.globalAlpha = 0.75;
    x.beginPath(); x.moveTo(0, H);
    for (let i = 0; i < 256; i++) x.lineTo(i / 255 * W, H - Math.min(1, hs[k][i] / max) * (H - 4));
    x.lineTo(W, H); x.closePath(); x.fill();
  });
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
}

function devRender(draft) {
  if (!dev.src) return;
  const view = $('devView'), cv = $('devCanvas'), vw = view.clientWidth, vh = view.clientHeight;
  if (cv.width !== vw || cv.height !== vh) { cv.width = vw; cv.height = vh; }
  const x = cv.getContext('2d'), W = dev.src.width, H = dev.src.height, raw = $('devBefore').checked;
  const q = draft ? 0.5 : 1; // пока тянут ручку, считаем вдвое грубее
  x.fillStyle = '#0c0d0e';
  x.fillRect(0, 0, vw, vh);
  x.imageSmoothingQuality = 'high';
  let shown;
  if (dev.zoom === 'fit') {
    const k = Math.min((vw - 48) / W, (vh - 48) / H, 1);
    shown = raw ? dev.src : im.applyAdjust(dev.src, dev.p, k * q);
    x.drawImage(shown, (vw - W * k) / 2, (vh - H * k) / 2, W * k, H * k);
  } else {
    const cw = Math.min(W, vw), ch = Math.min(H, vh);
    const sx = Math.round(Math.max(0, Math.min(W - cw, dev.center.x - cw / 2)));
    const sy = Math.round(Math.max(0, Math.min(H - ch, dev.center.y - ch / 2)));
    const part = im.makeCanvas(cw, ch);
    part.getContext('2d').drawImage(dev.src, sx, sy, cw, ch, 0, 0, cw, ch);
    shown = raw ? part : im.applyAdjust(part, dev.p, q);
    x.drawImage(shown, (vw - cw) / 2, (vh - ch) / 2, cw, ch);
  }
  if (!draft) devHistogram(shown);
}

function devSync() {
  for (const key of Object.keys(dev.rows)) dev.rows[key].set(dev.p[key]);
  const tab = dev.hslTab;
  dev.hslRows.forEach((row, i) => {
    row.set(dev.p.hsl[tab][i]);
    const c = HSL_HEX[i], [a, b] = HSL_NEXT[i];
    const track = tab === 'h' ? `linear-gradient(90deg,${a},${c},${b})` : tab === 's' ? `linear-gradient(90deg,#8b8b8b,${c})` : `linear-gradient(90deg,#111,${c},#fff)`;
    row.classList.add('colored');
    row.querySelector('.sl-range').style.setProperty('--track', track);
  });
  document.querySelectorAll('#devZoom button').forEach((b) => b.classList.toggle('on', b.dataset.z === dev.zoom));
  $('devCanvas').style.cursor = dev.zoom === 'fit' ? 'zoom-in' : 'grab';
}

function developDialog(src, adjust, name, pupil) {
  dev.src = src;
  dev.p = im.normalizeAdjust(adjust);
  dev.p.detail = 100; // текстура и резкость в студии всегда на максимуме
  dev.zoom = 'fit';
  dev.center = pupil && pupil.found ? { x: pupil.x, y: pupil.y } : { x: src.width / 2, y: src.height / 2 };
  $('devName').textContent = name;
  $('devBefore').checked = false;
  $('dev').hidden = false;
  devSync();
  devRender(false);
  return new Promise((resolve) => {
    dev.done = (result) => {
      $('dev').hidden = true;
      dev.src = dev.done = null;
      resolve(result);
    };
  });
}

// Как в Camera Raw: с зажатым Alt «Отмена» превращается в «Сбросить»
function devReset() { dev.p = im.newAdjust(); devSync(); devRender(false); }
window.addEventListener('keydown', (e) => { if (e.key === 'Alt' && dev.done) $('devCancel').textContent = 'Сбросить'; });
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') $('devCancel').textContent = 'Отмена'; });
window.addEventListener('blur', () => { $('devCancel').textContent = 'Отмена'; });

$('devOk').onclick = () => dev.done && dev.done({ ...dev.p });
$('devCancel').onclick = (e) => { if (e.altKey) devReset(); else if (dev.done) dev.done(null); };
$('devBefore').onchange = () => devRender(false);
document.querySelectorAll('#devZoom button').forEach((b) => {
  b.onclick = () => { dev.zoom = b.dataset.z; devSync(); devRender(false); };
});
// Щелчок по картинке переключает «целиком» и 100%, в 100% картинку можно таскать.
$('devCanvas').addEventListener('pointerdown', (e) => {
  if (dev.zoom === 'fit') {
    const view = $('devView'), W = dev.src.width, H = dev.src.height;
    const k = Math.min((view.clientWidth - 48) / W, (view.clientHeight - 48) / H, 1);
    const r = e.target.getBoundingClientRect();
    dev.center = { x: (e.clientX - r.left - (view.clientWidth - W * k) / 2) / k, y: (e.clientY - r.top - (view.clientHeight - H * k) / 2) / k };
    dev.zoom = 'one';
    devSync(); devRender(false);
    return;
  }
  e.target.setPointerCapture(e.pointerId);
  dev.pan = { x: e.clientX, y: e.clientY, moved: false };
});
$('devCanvas').addEventListener('pointermove', (e) => {
  if (!dev.pan) return;
  const dx = e.clientX - dev.pan.x, dy = e.clientY - dev.pan.y;
  if (Math.abs(dx) + Math.abs(dy) < 2) return;
  dev.center.x = Math.max(0, Math.min(dev.src.width, dev.center.x - dx));
  dev.center.y = Math.max(0, Math.min(dev.src.height, dev.center.y - dy));
  dev.pan = { x: e.clientX, y: e.clientY, moved: true };
  cancelAnimationFrame(dev.raf);
  dev.raf = requestAnimationFrame(() => devRender(true));
});
$('devCanvas').addEventListener('pointerup', () => {
  if (!dev.pan) return;
  const moved = dev.pan.moved;
  dev.pan = null;
  if (!moved) { dev.zoom = 'fit'; devSync(); }
  devRender(false);
});
window.addEventListener('resize', () => { if (dev.src) devRender(false); });

// Проявка выбранного слоя. Исходные пиксели не меняются, настройки можно открыть снова.
async function developLayer() {
  const d = S.cur, l = layer();
  if (!d || !l) { ui.toast('Выберите слой в панели «Слои»'); return; }
  const res = await developDialog(l.canvas, l.adjust ? l.adjust : im.NEUTRAL_ADJUST, l.name, null);
  if (!res) return;
  D.structEdit(d, 'Проявка', () => { l.adjust = res; D.touch(l); });
  refresh(); requestDraw();
}

// Полоска «Глаза» над слоями, по образцу панели студии Iris Layers: щелчок по глазу
// показывает только его и выбирает его слой, «Оба» возвращает все глаза разом.
// Сами слои при этом не скрываются, в истории ничего лишнего не появляется.
function showEye(g) {
  const d = S.cur;
  if (!g.cut && g.layer.irisGuess && !d.sel) { focusPhoto(g.layer); return; }
  d.solo = g.id;
  d.active = [g.layer.id];
  S.pupil = null;
  if (S.tool === 'pupil') initPupil();
  refresh(); requestDraw();
}

function showAllEyes() {
  const d = S.cur;
  d.solo = 0;
  const eyes = eyesOf(d);
  if (eyes.length) d.active = eyes.map((l) => l.id);
  S.pupil = null;
  refresh(); requestDraw();
}

function refreshEyes() {
  const d = S.cur, box = $('eyes');
  box.textContent = '';
  const groups = d ? D.eyeGroups(d) : [];
  $('eyesPanel').hidden = !groups.length;
  if (!groups.length) return;
  for (const g of groups) {
    const b = ui.el('button', 'eye-chip' + (d.solo === g.id ? ' on' : ''));
    b.title = g.cut ? 'Показать только этот глаз' : 'Снимок ещё не вырезан: круг по радужке и Ctrl+J';
    const label = ui.el('span');
    label.textContent = g.key;
    b.append(im.cloneCanvas(D.thumb(g.layer, 60)), label);
    b.onclick = () => showEye(g);
    box.appendChild(b);
  }
  if (groups.length > 1) {
    const all = ui.el('button', 'eye-chip all' + (d.solo ? '' : ' on'), '<span>Оба</span>');
    all.title = 'Показать все глаза вместе';
    all.onclick = showAllEyes;
    box.appendChild(all);
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
    const row = ui.el('div', 'layer' + (d.active.includes(l.id) ? ' on' : '') + (l.clip ? ' clip' : '') + (D.shown(d, l) ? '' : ' hid'));
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
  refreshEyes();
  refreshPupilPanel();
  refreshStatus();
  refreshActions();
  refreshCtx();
  const d = S.cur;
  $('docHint').hidden = !d || !$('home').hidden || d.layers.some((l) => l.kind === 'photo' || l.kind === 'eye');
  $('saveBtn').disabled = $('placeBtn').disabled = false;
  $('saveBtn').disabled = !d;
  $('developBtn').disabled = !layer();
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
  savePsd: { label: 'Сохранить как PSD…', keys: 'Ctrl+Shift+S', run: savePsd, enabled: has },
  export: { label: 'Экспорт как…', keys: 'Ctrl+Shift+Alt+W', run: exportAs, enabled: has },
  close: { label: 'Закрыть документ', keys: 'Ctrl+W', run: () => closeDoc(S.cur), enabled: has },
  tplFolder: { label: 'Папка шаблонов…', run: async () => { if (await api.chooseTemplates()) { ui.toast('Папка шаблонов выбрана'); loadTemplateList(); } } },
  pointPrefix: { label: 'Номер точки…', run: async () => { const v = await askPrefix((await api.settings()).pointPrefix); if (v) ui.toast(`Имена файлов теперь начинаются с ${v}-`); } },
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
  layerMerge: { label: 'Объединить слои', keys: 'Ctrl+E', run: mergeDown, enabled: hasLayer },
  layerClip: { label: 'Обтравочная маска', keys: 'Ctrl+Alt+G', run: toggleClip, enabled: hasLayer },
  layoutCorners: { label: 'Раскладка «Углы»', run: () => layoutPair('corners'), enabled: has },
  layoutWhole: { label: 'Раскладка «Целые»', run: () => layoutPair('whole'), enabled: has },
  layoutSingle: { label: 'Один глаз по центру', run: layoutSingle, enabled: has },
  layoutSwap: { label: 'Поменять глаза местами', run: layoutSwap, enabled: has },

  selAll: { label: 'Выделить всё', keys: 'Ctrl+A', enabled: has, run: () => {
    const d = S.cur;
    D.structEdit(d, 'Выделить всё', () => {
      d.sel = { shapes: [{ type: 'poly', pts: [{ x: 0, y: 0 }, { x: d.w, y: 0 }, { x: d.w, y: d.h }, { x: 0, y: d.h }] }], feather: 0 };
    });
    refresh(); requestDraw();
  } },
  deselect: { label: 'Снять выделение', keys: 'Ctrl+D', enabled: hasSel, run: () => { D.structEdit(S.cur, 'Снять выделение', () => { S.cur.sel = null; }); refresh(); requestDraw(); } },
  neural: { label: 'Убрать выделенное нейронкой', keys: 'Shift+Backspace', run: removeSelection, enabled: hasSel },

  develop: { label: 'Проявка…', keys: 'Ctrl+Shift+A', run: developLayer, enabled: hasLayer },
  guides: { label: 'Направляющие по центру', keys: 'Ctrl+;', run: () => {
    S.guides = !S.guides;
    api.setSettings({ guides: S.guides });
    requestOverlay();
  } },
  fit: { label: 'Вписать в окно', keys: 'Ctrl+0', run: fit, enabled: has },
  actual: { label: 'Реальный размер, 100%', keys: 'Ctrl+1', run: () => zoomAt(...center(), 1, 1), enabled: has },
  zoomIn: { label: 'Приблизить', keys: 'Ctrl+=', run: () => zoomAt(...center(), 1.25), enabled: has },
  zoomOut: { label: 'Отдалить', keys: 'Ctrl+-', run: () => zoomAt(...center(), 1 / 1.25), enabled: has },
};

ui.menubar($('menus'), [
  { title: 'Файл', items: ['new', 'open', 'place', '-', 'save', 'savePsd', 'export', '-', 'tplFolder', 'saveFolder', 'pointPrefix', '-', 'close'] },
  { title: 'Правка', items: ['undo', 'redo', '-', 'transform', 'clear'] },
  { title: 'Слой', items: ['layerNew', 'layerCopy', 'layerDelete', '-', 'layerUp', 'layerDown', 'layerMerge', 'layerClip', '-', 'layoutCorners', 'layoutWhole', 'layoutSingle', 'layoutSwap'] },
  { title: 'Выделение', items: ['selAll', 'deselect', '-', 'neural'] },
  { title: 'Фильтр', items: ['develop', 'neural'] },
  { title: 'Просмотр', items: ['fit', 'actual', 'zoomIn', 'zoomOut', '-', 'guides'] },
], CMD);

const run = (id) => { const c = CMD[id]; if (!S.busy && (!c.enabled || c.enabled())) c.run(); };
$('placeBtn').onclick = () => run('place');
$('saveBtn').onclick = () => run('save');
$('developBtn').onclick = () => run('develop');

const TOOL_KEYS = Object.fromEntries(TOOLS.filter((t) => t !== '-').map((t) => [t[2], t[0]]));
const BY_KEYS = Object.fromEntries(Object.entries(CMD).filter(([, c]) => c.keys).map(([id, c]) => [c.keys, id]));

window.addEventListener('keydown', (e) => {
  if (!$('modal').hidden) return;
  if (dev.done) {
    // открыто окно проявки: работают только «готово» и «отмена»
    const typingNum = e.target.tagName === 'INPUT' && e.target.type === 'text';
    if (e.key === 'Enter' && !typingNum) { e.preventDefault(); dev.done({ ...dev.p }); }
    if (e.key === 'Escape') { e.preventDefault(); dev.done(null); }
    return;
  }
  const typing = e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox';
  const k = ui.combo(e);
  if (typing && !k.startsWith('Ctrl+')) return;
  if (BY_KEYS[k]) { e.preventDefault(); run(BY_KEYS[k]); return; }
  if (k === 'Ctrl+Y') { e.preventDefault(); run('redo'); return; }
  if (k === 'Ctrl+Alt+Z') { e.preventDefault(); run('undo'); return; } // «шаг назад» из фотошопа
  if (typing) return;
  if (e.code === 'Space') { S.space = true; setCursor(); e.preventDefault(); return; }
  if (e.key === 'Alt') { S.alt = true; setCursor(); e.preventDefault(); return; }
  if (e.key === 'Control') { S.ctrl = true; setCursor(); requestOverlay(); return; }
  if (e.code === 'Tab') { e.preventDefault(); document.body.classList.toggle('bare'); resize(); return; }
  if (!S.cur || S.busy) return;
  if (k === 'Backspace') { e.preventDefault(); run('clear'); return; }
  if (k === 'Esc') {
    if (S.drag && S.drag.shape) { S.drag = null; requestOverlay(); return; } // бросить недорисованную обводку
    if (!$('home').hidden && S.cur) showHome(false); else if (S.cur.sel) run('deselect');
    return;
  }
  if (k === 'Enter' && S.tool === 'pupil') { applyPupil(); return; }
  if (TOOL_KEYS[k]) {
    // Удержание клавиши инструмента включает его на время, отпустил и вернулся к прежнему
    if (!e.repeat) { S.spring = { key: e.code, prev: S.tool, at: Date.now() }; setTool(TOOL_KEYS[k]); }
    return;
  }
  // Цифры как в фотошопе: у перемещения непрозрачность слоя, у кистей нажим. 1 = 10%, 0 = 100%
  if (/^\d$/.test(k)) {
    const v = k === '0' ? 100 : Number(k) * 10;
    if (S.tool === 'move') {
      const act = D.activeLayers(S.cur).filter((l) => !l.locked);
      if (act.length) { D.structEdit(S.cur, 'Непрозрачность', () => { for (const l of act) l.opacity = v / 100; }); refresh(); requestDraw(); }
    } else if (S.opts[S.tool] && S.opts[S.tool].flow != null) { S.opts[S.tool].flow = v; refreshOptions(); }
    return;
  }
  const o = S.opts[S.tool];
  if (k === 'D') { S.opts.brush.color = '#000000'; refreshOptions(); return; }
  if (o && o.hard != null && (k === 'Shift+[' || k === 'Shift+]')) {
    o.hard = Math.max(0, Math.min(100, o.hard + (k === 'Shift+[' ? -25 : 25)));
    refreshOptions();
    return;
  }
  if (o && o.size && (e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.ctrlKey) {
    o.size = Math.round(Math.max(4, Math.min(600, o.size * (e.code === 'BracketLeft' ? 1 / 1.2 : 1.2))));
    refreshOptions(); setCursor(); requestDraw();
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
window.addEventListener('keyup', (e) => {
  if (e.key === 'Control') { S.ctrl = false; setCursor(); requestOverlay(); }
  if (S.spring && e.code === S.spring.key) {
    const sp = S.spring;
    S.spring = null;
    if (Date.now() - sp.at > 350 && !S.drag) setTool(sp.prev);
  }
  if (e.code === 'Space') { S.space = false; setCursor(); }
  if (e.key === 'Alt') { S.alt = false; setCursor(); e.preventDefault(); }
});
window.addEventListener('blur', () => { S.alt = S.space = S.ctrl = false; S.spring = null; });
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
  const list = [...e.dataTransfer.files];
  if (!list.length || S.busy) return;
  const files = [];
  for (const f of list) files.push({ name: f.name, kind: fileKind(f.name), data: new Uint8Array(await f.arrayBuffer()) });
  openMany(files, 'place');
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
    case 'manual': return setUpdate('busy', `Вышла версия ${s.version}`, { label: 'Скачать', run: api.openReleases });
    case 'ready': return setUpdate('ok', `Версия ${s.version} поставится при закрытии`, { label: 'Перезапустить', run: api.installUpdate });
    case 'error': return setUpdate('err', 'Обновления недоступны, нужен интернет', { label: 'Повторить', run: api.checkUpdate });
  }
});

api.version().then((v) => { $('version').textContent = v; });
api.modelStatus().then((s) => { S.modelReady = s.ready; });
loadTemplateList();

api.settings().then((s) => {
  if (s.guides === false) S.guides = false;
});

refreshOptions();
refresh();
showHome(true);
resize();
