// Модель документа: слои, их положение, выделение, история и сборка картинки.

import * as im from './imaging.js';

let nextId = 1;
const HISTORY_LIMIT = 40;

// Слой хранит свои пиксели в исходном разрешении, а положение, масштаб и поворот
// отдельно. Поэтому глаз можно сколько угодно двигать и менять в размере
// без потери качества: пересчёт идёт один раз, при сохранении.
export function makeLayer(props) {
  return {
    id: nextId++,
    name: 'Слой',
    kind: 'pixel',   // photo — снимок с камеры, eye — вырезанный глаз, pixel — всё остальное
    canvas: null,
    cx: 0, cy: 0, scale: 1, rot: 0,
    visible: true, opacity: 1, blend: 'source-over', clip: false, locked: false,
    adjust: null,   // настройки проявки или null, если слой не проявляется
    cache: null,    // проявленная копия для показа
    cacheScale: 1,
    dirty: true,
    rev: 0,         // растёт при каждом изменении вида слоя; по нему обновляются миниатюра и уменьшенная копия
    ...props,
  };
}

export function makeDoc({ name, w, h, dpi = im.DPI, background = true }) {
  const doc = {
    id: nextId++, name, w, h, dpi,
    layers: [],        // снизу вверх
    active: [],        // id выделенных слоёв
    sel: null,         // выделение: { shapes: [...], feather }
    undo: [], redo: [],
    view: { scale: 1, ox: 0, oy: 0, fitted: false },
    changed: false,
    counter: 1,
  };
  if (background) {
    const c = im.makeCanvas(w, h);
    const x = c.getContext('2d');
    x.fillStyle = '#000';
    x.fillRect(0, 0, w, h);
    doc.layers.push(makeLayer({ name: 'Фон', canvas: c, cx: w / 2, cy: h / 2, locked: true }));
  }
  return doc;
}

export const layerById = (doc, id) => doc.layers.find((l) => l.id === id) || null;
export const activeLayers = (doc) => doc.layers.filter((l) => doc.active.includes(l.id));
export const activeLayer = (doc) => {
  const a = activeLayers(doc);
  return a.length ? a[a.length - 1] : null;
};
export const nextName = (doc) => `Слой ${doc.counter++}`;

// --- Координаты -------------------------------------------------------------

export function toLocal(l, p) {
  const dx = p.x - l.cx, dy = p.y - l.cy, c = Math.cos(-l.rot), s = Math.sin(-l.rot);
  return { x: (dx * c - dy * s) / l.scale + l.canvas.width / 2, y: (dx * s + dy * c) / l.scale + l.canvas.height / 2 };
}

export function toDoc(l, q) {
  const x = (q.x - l.canvas.width / 2) * l.scale, y = (q.y - l.canvas.height / 2) * l.scale;
  const c = Math.cos(l.rot), s = Math.sin(l.rot);
  return { x: l.cx + x * c - y * s, y: l.cy + x * s + y * c };
}

export function corners(l) {
  const w = l.canvas.width, h = l.canvas.height;
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map((q) => toDoc(l, q));
}

export function bounds(l) {
  const c = corners(l), xs = c.map((p) => p.x), ys = c.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Дальше на холсте можно рисовать в координатах листа, а попадает в пиксели слоя.
export function docToLayerTransform(ctx, l) {
  ctx.translate(l.canvas.width / 2, l.canvas.height / 2);
  ctx.scale(1 / l.scale, 1 / l.scale);
  ctx.rotate(-l.rot);
  ctx.translate(-l.cx, -l.cy);
}

function layerToDocTransform(ctx, l, k = 1) {
  ctx.translate(l.cx, l.cy);
  ctx.rotate(l.rot);
  ctx.scale(l.scale / k, l.scale / k);
  ctx.translate(-l.canvas.width * k / 2, -l.canvas.height * k / 2);
}

// Есть ли у слоя непрозрачный пиксель под точкой листа.
export function hit(l, p) {
  const q = toLocal(l, p);
  if (q.x < 0 || q.y < 0 || q.x >= l.canvas.width || q.y >= l.canvas.height) return false;
  return l.canvas.getContext('2d').getImageData(Math.floor(q.x), Math.floor(q.y), 1, 1).data[3] > 12;
}

// --- Проявка слоя -----------------------------------------------------------

// Большой снимок целиком проявляется в уменьшенном виде: этого хватает для
// показа, а при сохранении всё считается в полном размере.
const VIEW_LIMIT = 2048, DRAFT_LIMIT = 900;

// Отметить, что вид слоя изменился.
export function touch(l) {
  l.dirty = true;
  l.rev++;
}

// zoom — сколько пикселей экрана приходится на пиксель листа.
export function layerView(l, draft = false, zoom = 1) {
  if (!l.adjust) {
    // Большой слой, пока его не приблизили, рисуем уменьшенной копией:
    // иначе каждое движение мышки таскало бы десятки мегапикселей.
    const big = Math.max(l.canvas.width, l.canvas.height);
    if (big <= 3000 || l.live) return { canvas: l.canvas, k: 1 };
    const k = VIEW_LIMIT / big;
    if (zoom * l.scale > k * 1.15) return { canvas: l.canvas, k: 1 };
    if (!l.proxy || l.proxyRev !== l.rev) {
      l.proxy = im.makeCanvas(l.canvas.width * k, l.canvas.height * k);
      const x = l.proxy.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(l.canvas, 0, 0, l.proxy.width, l.proxy.height);
      l.proxyRev = l.rev;
    }
    return { canvas: l.proxy, k: l.proxy.width / l.canvas.width };
  }
  const limit = draft ? DRAFT_LIMIT : VIEW_LIMIT;
  const k = Math.min(1, limit / Math.max(l.canvas.width, l.canvas.height));
  if (l.dirty || !l.cache || (!draft && l.cacheScale < k)) {
    l.cache = im.applyAdjust(l.canvas, l.adjust, k);
    l.cacheScale = k;
    l.dirty = false;
  }
  return { canvas: l.cache, k: l.cacheScale };
}

function layerFull(l) {
  return l.adjust ? im.applyAdjust(l.canvas, l.adjust, 1) : l.canvas;
}

// --- Сборка картинки --------------------------------------------------------

function drawLayer(ctx, l, full, draft, zoom) {
  const v = full ? { canvas: layerFull(l), k: 1 } : layerView(l, draft, zoom);
  ctx.save();
  layerToDocTransform(ctx, l, v.k);
  ctx.drawImage(v.canvas, 0, 0);
  ctx.restore();
}

// Рисует все видимые слои. На ctx уже должен стоять перевод «лист -> экран».
// Слой с обтравкой виден только там, где есть пиксели слоя под ним.
export function composite(ctx, doc, { full = false, draftId = 0, zoom = 1 } = {}) {
  const ls = doc.layers;
  for (let i = 0; i < ls.length; i++) {
    const base = ls[i];
    if (base.clip && i > 0) continue; // нарисован вместе со своей основой
    let j = i + 1;
    while (j < ls.length && ls[j].clip) j++;
    const clipped = ls.slice(i + 1, j).filter((l) => l.visible);
    if (!base.visible) continue;
    ctx.globalAlpha = base.opacity;
    ctx.globalCompositeOperation = base.blend;
    if (!clipped.length) {
      drawLayer(ctx, base, full, base.id === draftId, zoom);
    } else {
      const tmp = im.makeCanvas(ctx.canvas.width, ctx.canvas.height);
      const t = tmp.getContext('2d');
      t.setTransform(ctx.getTransform());
      t.imageSmoothingQuality = ctx.imageSmoothingQuality;
      drawLayer(t, base, full, base.id === draftId, zoom);
      for (const l of clipped) {
        t.globalAlpha = l.opacity;
        t.globalCompositeOperation = l.blend === 'source-over' ? 'source-atop' : l.blend;
        drawLayer(t, l, full, l.id === draftId, zoom);
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export function flatten(doc, background = '#000') {
  const c = im.makeCanvas(doc.w, doc.h);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  if (background) { x.fillStyle = background; x.fillRect(0, 0, doc.w, doc.h); }
  composite(x, doc, { full: true });
  return c;
}

// Миниатюра для панели слоёв. Пересчитывается только когда слой изменился.
export function thumb(l, size) {
  if (l.thumb && l.thumbRev === l.rev) return l.thumb;
  const c = im.makeCanvas(size, size), x = c.getContext('2d');
  const v = l.adjust ? (l.cache || l.canvas) : (l.proxy || l.canvas);
  l.thumb = c;
  l.thumbRev = l.rev;
  const k = Math.min(size / v.width, size / v.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(v, (size - v.width * k) / 2, (size - v.height * k) / 2, v.width * k, v.height * k);
  return c;
}

// --- Выделение --------------------------------------------------------------

export function shapePath(ctx, s) {
  if (s.type === 'ellipse') {
    ctx.moveTo(s.cx + s.rx, s.cy);
    ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, Math.PI * 2);
  } else {
    s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  }
  ctx.closePath();
}

export function selBounds(sel) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of sel.shapes) {
    if (s.sub) continue;
    const xs = s.type === 'ellipse' ? [s.cx - s.rx, s.cx + s.rx] : s.pts.map((p) => p.x);
    const ys = s.type === 'ellipse' ? [s.cy - s.ry, s.cy + s.ry] : s.pts.map((p) => p.y);
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs);
    y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Маска выделения размером w×h. setTransform переводит координаты листа
// в координаты маски. grow расширяет край, feather размывает (всё в px маски).
export function selMask(sel, w, h, setTransform, { feather = 0, grow = 0 } = {}) {
  const c = im.makeCanvas(w, h), x = c.getContext('2d');
  x.fillStyle = x.strokeStyle = '#fff';
  x.lineJoin = 'round';
  for (const s of sel.shapes) {
    x.save();
    setTransform(x);
    x.globalCompositeOperation = s.sub ? 'destination-out' : 'source-over';
    x.beginPath();
    shapePath(x, s);
    x.fill();
    x.restore();
    if (grow > 0 && !s.sub) {
      x.save();
      setTransform(x);
      x.beginPath();
      shapePath(x, s);
      x.restore(); // обводка в пикселях маски, а не листа
      x.lineWidth = grow * 2;
      x.stroke();
    }
  }
  if (feather <= 0) return c;
  const out = im.makeCanvas(w, h), o = out.getContext('2d');
  o.filter = `blur(${feather}px)`;
  o.drawImage(c, 0, 0);
  return out;
}

// Прямоугольник в пикселях слоя, который накрывает область листа.
export function localRect(l, b, pad = 0) {
  const pts = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]
    .map((p) => toLocal(l, p));
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - pad));
  const x1 = Math.min(l.canvas.width, Math.ceil(Math.max(...pts.map((p) => p.x)) + pad));
  const y1 = Math.min(l.canvas.height, Math.ceil(Math.max(...pts.map((p) => p.y)) + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// --- История ----------------------------------------------------------------
// Каждая запись умеет одно: поменять местами «было» и «стало».

function push(doc, entry) {
  doc.undo.push(entry);
  if (doc.undo.length > HISTORY_LIMIT) doc.undo.shift();
  doc.redo = [];
  doc.changed = true;
}

function snapshot(doc) {
  return {
    layers: doc.layers.slice(),
    active: doc.active.slice(),
    props: doc.layers.map((l) => [l, {
      name: l.name, cx: l.cx, cy: l.cy, scale: l.scale, rot: l.rot, visible: l.visible,
      opacity: l.opacity, blend: l.blend, clip: l.clip, locked: l.locked, adjust: l.adjust && { ...l.adjust },
    }]),
  };
}

function restore(doc, s) {
  doc.layers = s.layers.slice();
  doc.active = s.active.slice();
  for (const [l, p] of s.props) {
    if (JSON.stringify(l.adjust) !== JSON.stringify(p.adjust)) touch(l);
    Object.assign(l, p, { adjust: p.adjust && { ...p.adjust } });
  }
}

// Изменение состава или свойств слоёв. Вызвать до правки, потом commit(имя).
export function beginStruct(doc) {
  let before = snapshot(doc);
  return (name) => push(doc, {
    name,
    swap() { const now = snapshot(doc); restore(doc, before); before = now; },
  });
}

export function structEdit(doc, name, fn) {
  const commit = beginStruct(doc);
  fn();
  commit(name);
}

// Изменение пикселей слоя в прямоугольнике. data — пиксели «до».
export function pushPixels(doc, layer, name, x, y, data) {
  touch(layer);
  push(doc, {
    name,
    swap() {
      const ctx = layer.canvas.getContext('2d');
      const now = ctx.getImageData(x, y, data.width, data.height);
      ctx.putImageData(data, x, y);
      data = now;
      touch(layer);
    },
  });
}

export function stepHistory(doc, back) {
  const from = back ? doc.undo : doc.redo, to = back ? doc.redo : doc.undo;
  if (!from.length) return false;
  const e = from.pop();
  e.swap();
  to.push(e);
  doc.active = doc.active.filter((id) => layerById(doc, id));
  return true;
}
