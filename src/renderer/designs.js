// Дизайны листа по каталогу студии: бесконечность, половинки, россыпь,
// столкновение, увеличение и фоны космос, коллаж, граффити.
//
// Всё считается в долях листа, поэтому одинаково работает на А6–А3 и в
// миниатюрах. Результат это обычные слои: фон, глаза (с формой под ними, если
// глаз обрезан или рассыпается), россыпь и пыль отдельными слоями.

import * as im from './imaging.js';

// --- Раскладки: центр (доля ширины и высоты) и диаметр (доля высоты) ---------
// Сняты с фонов и готовых работ студии.
const L = {
  single: [[0.4998, 0.4997, 0.752]],
  whole: [[0.2946, 0.388, 0.5671], [0.7086, 0.6118, 0.5671]],
  corners: [[0.2274, 0.2766, 0.876], [0.7732, 0.7258, 0.876]],
  triangle: [[0.5, 0.3, 0.48], [0.24, 0.665, 0.48], [0.76, 0.665, 0.48]],
  collage: {
    single: [[0.5003, 0.4963, 0.7591]],
    whole: [[0.2725, 0.3885, 0.6042], [0.7261, 0.6091, 0.6042]],
    corners: [[0.1811, 0.2826, 0.9308], [0.7963, 0.7478, 0.9348]],
  },
  scatter: {
    single: [[0.5, 0.5, 0.86]],
    corners: [[0.235, 0.283, 0.85], [0.758, 0.665, 0.85]],
  },
  infinity: [[0.3373, 0.5, 0.7424], [0.6598, 0.5, 0.7424]],
  collision: [[0.3045, 0.3492, 0.6165], [0.6884, 0.6561, 0.6165]],
  zoom: { single: [[0.5, 0.5, 0.64]], whole: [[0.305, 0.371, 0.6], [0.695, 0.629, 0.6]] },
};

export const DESIGN_NAMES = { eyes: 'Глаза', infinity: 'Бесконечность', halves: 'Половинки', collision: 'Столкновение' };
export const BG_NAMES = { black: 'Чёрный', cosmos: 'Космос', collage: 'Коллаж', graffiti: 'Граффити', zoom: 'Увеличение' };

// Готовые сочетания для панели, как в каталоге
export const PRESETS = [
  { id: 'infinity', name: 'Бесконечность', opts: { design: 'infinity' } },
  { id: 'halves', name: 'Половинки', opts: { design: 'halves', scatter: true } },
  { id: 'scatter', name: 'Россыпь', opts: { design: 'eyes', scatter: true, count: 2, place: 'corners' } },
  { id: 'collision', name: 'Столкновение', opts: { design: 'collision' } },
  { id: 'zoom', name: 'Увеличение', opts: { design: 'eyes', bg: 'zoom', count: 2 } },
  { id: 'cosmos', name: 'Космос', opts: { design: 'eyes', bg: 'cosmos', count: 2, place: 'whole' } },
  { id: 'collage', name: 'Коллаж', opts: { design: 'eyes', bg: 'collage', count: 2, place: 'whole' } },
  { id: 'graffiti', name: 'Граффити', opts: { design: 'eyes', bg: 'graffiti', count: 2, place: 'whole' } },
];

export const DEFAULTS = { design: 'eyes', bg: 'black', count: 2, place: 'whole', scatter: false, split: 'v', swap: false, seed: 1 };

// Что с чем сочетается. n — сколько разных глаз есть.
export function allowed(o, n) {
  const pair = n >= 2;
  return {
    design: { eyes: true, infinity: pair, halves: pair, collision: pair },
    bg: {
      black: true,
      cosmos: o.design === 'eyes' || o.design === 'halves',
      collage: o.design === 'eyes' || o.design === 'halves',
      graffiti: true,
      zoom: o.design === 'eyes' || o.design === 'halves',
    },
    // три глаза только треугольником и только там, где он есть в каталоге
    count: { 1: true, 2: pair, 3: n >= 3 && o.design === 'eyes' && (o.bg === 'black' || o.bg === 'graffiti') },
    place: { whole: true, corners: o.bg !== 'zoom' },
    scatter: o.design !== 'collision',
  };
}

export function normalize(o0, n) {
  const o = { ...DEFAULTS, ...o0 };
  let a = allowed(o, n);
  if (!a.design[o.design]) o.design = 'eyes';
  a = allowed(o, n);
  if (!a.bg[o.bg]) o.bg = 'black';
  a = allowed(o, n);
  if (o.design !== 'eyes') o.count = o.design === 'halves' ? 1 : 2;
  else {
    o.count = Math.max(1, Math.min(o.count | 0 || 1, 3));
    while (o.count > 1 && !a.count[o.count]) o.count--;
  }
  if (!a.place[o.place]) o.place = 'whole';
  if (o.design === 'collision') o.scatter = true;
  return o;
}

// --- Случайные числа с зерном: «Другая россыпь» просто меняет зерно ----------
function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Плавный шум для рваного края
function noiseField(rand, cells) {
  const g = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (u, v) => {
    const x = Math.max(0, Math.min(cells - 1e-6, u * cells)), y = Math.max(0, Math.min(cells - 1e-6, v * cells));
    const i = x | 0, j = y | 0, fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const r = cells + 1, a = g[j * r + i], b = g[j * r + i + 1], c = g[(j + 1) * r + i], d = g[(j + 1) * r + i + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// --- Фоны -------------------------------------------------------------------
const ASSETS = {
  cosmos: { single: 'cosmos_single', whole: 'cosmos_whole', corners: 'cosmos_corners' },
  collage: { single: 'collage_single', whole: 'collage_whole', corners: 'collage_corners' },
  graffiti: { any: 'graffiti' },
};
const cache = new Map();
export function loadAsset(name) {
  if (!cache.has(name)) {
    cache.set(name, new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => { cache.delete(name); fail(new Error('нет фона ' + name)); };
      img.src = new URL(`./designs/${name}.webp`, import.meta.url).href;
    }));
  }
  return cache.get(name);
}

function assetName(o) {
  const a = ASSETS[o.bg];
  if (!a) return null;
  if (a.any) return a.any;
  const kind = o.design === 'halves' || o.count === 1 ? 'single' : o.place;
  return a[kind];
}

// Где стоят глаза: список { x, y, d } в пикселях листа
function slotsFor(o, W, H) {
  let list;
  const kind = o.design === 'halves' || o.count === 1 ? 'single' : o.count === 3 ? 'triangle' : o.place;
  if (o.design === 'infinity') list = L.infinity;
  else if (o.design === 'collision') list = L.collision;
  else if (o.bg === 'collage') list = L.collage[kind] || L.collage.single;
  else if (o.bg === 'zoom') list = L.zoom[kind === 'single' ? 'single' : 'whole'];
  else if (kind === 'triangle') list = L.triangle;
  else if (o.bg === 'black' && o.scatter && L.scatter[kind]) list = L.scatter[kind];
  else list = L[kind];
  return list.map(([x, y, d]) => ({ x: x * W, y: y * H, d: d * H }));
}

// --- Глаз в маленьком виде: из него берутся цвета россыпи и увеличение -------
function eyeSample(e, size) {
  const src = e.adjust ? im.applyAdjust(e.canvas, e.adjust, Math.min(1, size * 1.5 / Math.max(e.canvas.width, e.canvas.height))) : e.canvas;
  const c = im.makeCanvas(size, size), x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, size, size);
  return { canvas: c, data: x.getImageData(0, 0, size, size).data, size };
}

// Цвет радужки в точке (доли радиуса), с поиском непрозрачного пикселя ближе к центру
function colorAt(s, ux, uy, sat = 1.35) {
  const n = s.size;
  for (let k = 0.86; k > 0.4; k -= 0.06) {
    const px = Math.round(n / 2 + ux * k * (n / 2 - 1)), py = Math.round(n / 2 + uy * k * (n / 2 - 1));
    const i = (Math.max(0, Math.min(n - 1, py)) * n + Math.max(0, Math.min(n - 1, px))) * 4;
    if (s.data[i + 3] > 200) {
      const r = s.data[i], g = s.data[i + 1], b = s.data[i + 2], m = (r + g + b) / 3;
      return [m + (r - m) * sat, m + (g - m) * sat, m + (b - m) * sat].map((v) => Math.max(0, Math.min(255, v)));
    }
  }
  return [180, 140, 90];
}

// --- Форма глаза: круг, половина, вырез бесконечности, рассыпающийся край ----
// Возвращает холст размера side×side, круг радужки вписан в него.
function shapeCanvas(side, { half = null, cut = null }) {
  const c = im.makeCanvas(side, side), x = c.getContext('2d');
  const R = side / 2;
  x.fillStyle = '#000';
  x.beginPath();
  x.arc(R, R, R, 0, Math.PI * 2);
  x.fill();
  if (half != null) {
    // оставить половину: half = угол нормали оставляемой стороны
    x.globalCompositeOperation = 'destination-out';
    x.save();
    x.translate(R, R);
    x.rotate(half + Math.PI);
    x.fillRect(0, -side, side * 2, side * 2);
    x.restore();
  }
  if (cut) {
    // бесконечность: верхняя часть пересечения достаётся соседнему глазу
    x.globalCompositeOperation = 'destination-out';
    x.save();
    x.beginPath();
    x.rect(-side, -side, side * 3, side + R + R * cut.y);
    x.clip();
    x.beginPath();
    x.arc(R + cut.dx * R, R + cut.dy * R, cut.r * R, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  x.globalCompositeOperation = 'source-over';
  return c;
}

// --- Россыпь кистями студии --------------------------------------------------
// Повторяет ручную работу в фотошопе, параметры подогнаны наложением на макеты
// каталога: край глаза со стороны разлёта прореживается мелким зерном и
// пробивается кистями Explosion (тёмная крапинка по радужке), рядом из копии
// глаза проявляется пыль: мелкое зерно у самой кромки, облачка кисти дальше
// и светлые крошки по бокам.

// Россыпь по кругу: base — насколько осыпается край в среднем, vary — разброс по кругу
const SCATTER = { base: 0.35, vary: 0.45, count: 1.6, crumbs: 1.2 };

const BRUSH_LEVELS = [[70, 3], [40, 2.4], [28, 2.1]];
const brushes = new Map();
function loadBrush(i) {
  if (!brushes.has(i)) {
    const [lo, gain] = BRUSH_LEVELS[i];
    brushes.set(i, loadAsset('brush' + i).then((img) => {
      // белое на кисти красит: переводим яркость в прозрачность
      const c = im.makeCanvas(img.width, img.height), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
      for (let j = 0; j < p.length; j += 4) { p[j + 3] = Math.max(0, Math.min(255, (p[j] - lo) * gain)); p[j] = p[j + 1] = p[j + 2] = 255; }
      x.putImageData(d, 0, 0);
      return c;
    }));
  }
  return brushes.get(i);
}

// Насколько рассыпается край в направлении (ux, uy): 0 — цел, 1 — сильно.
function spreadOf(p, rand) {
  if (p.dir) return (ux, uy) => Math.max(0, Math.min(1, (ux * p.dir[0] + uy * p.dir[1]) * 1.25 + 0.05));
  // россыпь по кругу: местами сильнее, местами слабее
  const nz = noiseField(rand, 6);
  return (ux, uy) => Math.max(0, Math.min(1, p.scatter.base + p.scatter.vary * (nz(0.5 + ux * 0.45, 0.5 + uy * 0.45) - 0.5) * 2));
}

// Мазки кистью, всё в единицах листа.
function strokePlan(p, rand) {
  const R = p.d / 2, erase = [], reveal = [], crumbs = [];
  const at = (ang, r) => [p.x + Math.cos(ang) * r, p.y + Math.sin(ang) * r];
  const dirs = p.dir ? [Math.atan2(p.dir[1], p.dir[0])] : null;
  const pick = (spread) => (dirs ? dirs[0] + (rand() - 0.5) * spread : rand() * Math.PI * 2);
  const k = p.dir ? 1 : p.scatter.count;
  for (let i = 0; i < Math.round(40 * k); i++) {
    const ang = pick(1.6), [x, y] = at(ang, R * (0.6 + rand() * 0.4));
    if (!p.dir && p.spread(Math.cos(ang), Math.sin(ang)) < rand() * 0.8) continue;
    erase.push({ x, y, size: R * (0.3 + rand() * 0.35), rot: ang + Math.PI / 2 + (rand() - 0.5), b: rand() < 0.6 ? 0 : 1, a: 0.75 + rand() * 0.25 });
  }
  for (let i = 0; i < Math.round(16 * k); i++) {
    const ang = pick(1.8), [x, y] = at(ang, R * (1.05 + rand() * 0.45));
    if (!p.dir && p.spread(Math.cos(ang), Math.sin(ang)) < rand() * 0.8) continue;
    reveal.push({ x, y, size: R * (0.35 + rand() * 0.35), rot: ang + Math.PI / 2 + (rand() - 0.5) * 0.8, b: rand() < 0.4 ? 0 : 1, a: 0.85 + rand() * 0.15 });
  }
  // крошки: у столкновения по бокам от места встречи, где между глазами темно
  for (let i = 0; i < Math.round(p.dir ? 2 : 4 * p.scatter.crumbs); i++) {
    const ang = p.dir ? dirs[0] + (i % 2 ? -1 : 1) * (0.5 + rand() * 0.45) : rand() * Math.PI * 2;
    const [x, y] = at(ang, R * (1.0 + rand() * 0.3));
    crumbs.push({ x, y, size: R * (2.2 + rand() * 0.7), rot: rand() * 6.3, b: 2, a: 1 });
  }
  return { erase, reveal, crumbs };
}

function stamp(x, brush, cx, cy, size, rot, alpha, flip) {
  const k = size / Math.max(brush.width, brush.height);
  x.save();
  x.globalAlpha = alpha;
  x.translate(cx, cy);
  x.rotate(rot);
  x.scale(k * (flip ? -1 : 1), k);
  x.drawImage(brush, -brush.width / 2, -brush.height / 2);
  x.restore();
}

// Стёрка по форме глаза (холст формы вписан в круг глаза диаметра p.d)
function eraseStrokes(shape, plan, p, br, rand) {
  const x = shape.getContext('2d', { willReadFrequently: true }), side = shape.width, s = side / p.d, R = side / 2;
  x.globalCompositeOperation = 'destination-out';
  for (const st of plan) stamp(x, br[st.b], (st.x - p.x) * s + R, (st.y - p.y) * s + R, st.size * s, st.rot, st.a, rand() < 0.5);
  x.globalCompositeOperation = 'source-over';
  // кромка со стороны разлёта прореживается зерном
  const img = x.getImageData(0, 0, side, side), d = img.data, IN = 0.6;
  for (let py = 0; py < side; py++) {
    const vy = (py + 0.5 - R) / R;
    for (let px = 0; px < side; px++) {
      const vx = (px + 0.5 - R) / R, rr = Math.hypot(vx, vy);
      if (rr <= IN || rr > 1) continue;
      const i = (py * side + px) * 4;
      if (!d[i + 3]) continue;
      const w = p.spread(vx / rr, vy / rr);
      if (!w) continue;
      const e = Math.min(1, Math.pow((rr - IN) / (1 - IN), 1.5) * w * 1.15);
      d[i + 3] = rand() < e ? 0 : Math.round(d[i + 3] * (1 - e * 0.3));
    }
  }
  x.putImageData(img, 0, 0);
}

// Пыль из копии глаза: мазки кисти плюс мелкое зерно у кромки. Возвращает свойства слоя.
function revealStrokes(plan, p, br, W, H, kMax, rand) {
  const R = p.d / 2;
  let x0 = p.x - R * 1.5, y0 = p.y - R * 1.5, x1 = p.x + R * 1.5, y1 = p.y + R * 1.5;
  for (const st of [...plan.reveal, ...plan.crumbs]) {
    x0 = Math.min(x0, st.x - st.size * 0.75); y0 = Math.min(y0, st.y - st.size * 0.75);
    x1 = Math.max(x1, st.x + st.size * 0.75); y1 = Math.max(y1, st.y + st.size * 0.75);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  const k = Math.min(1, kMax / Math.max(W, H));
  const cw = Math.round((x1 - x0) * k), ch = Math.round((y1 - y0) * k);
  const c = im.makeCanvas(cw, ch), x = c.getContext('2d', { willReadFrequently: true });
  for (const st of plan.reveal) stamp(x, br[st.b], (st.x - x0) * k, (st.y - y0) * k, st.size * k, st.rot, st.a, rand() < 0.5);
  const cc = im.makeCanvas(cw, ch), cx = cc.getContext('2d', { willReadFrequently: true });
  for (const st of plan.crumbs) stamp(cx, br[st.b], (st.x - x0) * k, (st.y - y0) * k, st.size * k, st.rot, st.a, rand() < 0.5);
  const img = x.getImageData(0, 0, cw, ch), d = img.data, cd = cx.getImageData(0, 0, cw, ch).data;
  const sm = p.big, n = sm.size, sd = sm.data, dir = p.dir, RIN = 0.88;
  // зерно мельче при малом листе не делаем: одно зерно — один пиксель холста
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const i = (py * cw + px) * 4;
      const vx = ((px + 0.5) / k + x0 - p.x) / R, vy = ((py + 0.5) / k + y0 - p.y) / R, rr = Math.hypot(vx, vy);
      let a = d[i + 3] / 255;
      if (rr > 0.8) {
        const sp = p.spread(vx / rr, vy / rr), out = Math.max(rr - 1, 0);
        // зерно: густо у кромки, реже дальше
        const dens = (Math.exp(-out / 0.1) * 0.35 + Math.exp(-out / 0.3) * 0.18) * sp * (rr > 0.95 ? 1 : (rr - 0.8) / 0.15);
        if (dens > 0 && rand() < dens) a = Math.min(1, a + 0.5 + 0.5 * rand());
      }
      const crumb = cd[i + 3] / 255;
      if (crumb > a) a = crumb;
      if (a < 0.012) { d[i + 3] = 0; continue; }
      // цвет из копии глаза, растянутой в сторону полёта
      let sx, sy;
      if (dir) {
        const t = vx * dir[0] + vy * dir[1], qx = vx - t * dir[0], qy = vy - t * dir[1], pl = Math.hypot(qx, qy);
        if (pl >= RIN) { sx = qx / pl * RIN * 0.98; sy = qy / pl * RIN * 0.98; }
        else { const back = Math.max(0, t - Math.sqrt(RIN * RIN - pl * pl)); sx = vx - dir[0] * back; sy = vy - dir[1] * back; }
      } else {
        const m = Math.min(rr, RIN) / (rr || 1);
        sx = vx * m; sy = vy * m;
      }
      const qx = Math.max(0, Math.min(n - 1, Math.round(n / 2 + sx * (n / 2 - 1)))), qy = Math.max(0, Math.min(n - 1, Math.round(n / 2 + sy * (n / 2 - 1))));
      const j = (qy * n + qx) * 4;
      if (sd[j + 3] < 128) { d[i + 3] = 0; continue; }
      const lift = a > 0.5 && d[i + 3] < 30 ? 0.95 : 1.12;
      let r = sd[j] * lift, g = sd[j + 1] * lift, b = sd[j + 2] * lift;
      // крошки светлее: на свету они выглядят выгоревшими
      if (crumb > 0.3) { r = r * 0.75 + 60; g = g * 0.75 + 55; b = b * 0.75 + 45; }
      d[i] = Math.min(255, r); d[i + 1] = Math.min(255, g); d[i + 2] = Math.min(255, b);
      d[i + 3] = Math.round(a * 255);
    }
  }
  x.putImageData(img, 0, 0);
  return { canvas: c, cx: x0 + cw / k / 2, cy: y0 + ch / k / 2, scale: 1 / k };
}

// Мелкая светлая пыль понизу листа, как на печати каталога
function drawDust(x, W, H, rand) {
  const n = Math.round(W * H / 260);
  for (let i = 0; i < n; i++) {
    const t = Math.pow(rand(), 0.45);              // гуще к низу
    const y = H * (0.45 + 0.55 * t), xx = W * rand();
    const fade = (y / H - 0.45) / 0.55;
    if (rand() > fade * fade) continue;
    const s = 0.6 + rand() * 1.1;
    x.fillStyle = `rgba(235,235,235,${(0.08 + rand() * 0.3).toFixed(2)})`;
    x.fillRect(xx, y, s, s);
  }
}

// --- Увеличение: размытая затемнённая копия глаза во весь фон ------------------
function drawZoom(x, W, H, eyes, split) {
  const parts = eyes.map((e) => ({ e, big: e.d * 3.4 }));
  const blur = Math.max(1, H * 0.004);
  const draw = (p) => {
    x.save();
    x.filter = `blur(${blur}px) brightness(0.52)`;
    x.drawImage(p.e.sample.canvas, p.e.x - p.big / 2, p.e.y - p.big / 2, p.big, p.big);
    x.restore();
  };
  if (parts.length === 1) { draw(parts[0]); return; }
  // две копии делят лист по линии между глазами (или по разрезу половинок)
  const [a, b] = parts;
  const mx = (a.e.x + b.e.x) / 2, my = (a.e.y + b.e.y) / 2;
  let nx = b.e.x - a.e.x, ny = b.e.y - a.e.y;
  if (split) { nx = split[0]; ny = split[1]; }
  const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
  draw(b);
  x.save();
  x.beginPath();
  const D = (W + H) * 2;
  // полуплоскость со стороны глаза a
  x.moveTo(mx - ny * D, my + nx * D);
  x.lineTo(mx + ny * D, my - nx * D);
  x.lineTo(mx + ny * D - nx * D, my - nx * D - ny * D);
  x.lineTo(mx - ny * D - nx * D, my + nx * D - ny * D);
  x.closePath();
  x.clip();
  draw(a);
  x.restore();
}

// --- Сборка ------------------------------------------------------------------
// eyes: [{ canvas, adjust, name, eye, eyeKey }], W×H — размер листа.
// Возвращает слои снизу вверх как свойства для makeLayer (без фона, он у листа свой).
export async function build(o0, eyes0, W, H, { thumb = false } = {}) {
  const o = normalize(o0, eyes0.length);
  const rand = rng(o.seed || 1);
  let eyes = eyes0.slice(0, o.design === 'eyes' ? o.count : 2);
  if (o.swap && eyes.length > 1) eyes = [eyes[1], eyes[0], ...eyes.slice(2)];
  const slots = slotsFor(o, W, H);
  const sampleSize = thumb ? 160 : 900;
  const out = [];
  const sheetCanvas = (maxSide) => {
    const k = Math.min(1, maxSide / Math.max(W, H));
    return { c: im.makeCanvas(W * k, H * k), k };
  };
  const full = (c, k, props) => ({ canvas: c, cx: W / 2, cy: H / 2, scale: 1 / k, ...props });

  // фон-картинка
  const an = assetName(o);
  let overlay = null;
  if (an) {
    const img = await loadAsset(an);
    const k = Math.max(W / img.width, H / img.height);
    const c = im.makeCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    const layer = { name: `Фон ${BG_NAMES[o.bg].toLowerCase()}`, canvas: c, cx: W / 2, cy: H / 2, scale: k, locked: o.bg === 'collage' };
    if (o.bg === 'collage') overlay = layer; else out.push(layer);
  }

  // где какой глаз
  const placed = [];
  if (o.design === 'halves') {
    const s = slots[0];
    placed.push({ e: eyes[0], ...s }, { e: eyes[1], ...s });
  } else slots.forEach((s, i) => eyes[i] && placed.push({ e: eyes[i], ...s }));
  for (const p of placed) p.sample = eyeSample(p.e, sampleSize);
  const br = o.scatter ? await Promise.all([0, 1, 2].map(loadBrush)) : null;
  if (o.scatter) for (const p of placed) p.big = thumb ? p.sample : eyeSample(p.e, 1800);

  // увеличение
  if (o.bg === 'zoom') {
    const { c, k } = sheetCanvas(thumb ? 400 : 2400);
    const x = c.getContext('2d');
    x.scale(k, k);
    drawZoom(x, W, H, placed.map((p) => ({ x: p.x, y: p.y, d: p.d, sample: p.sample })), o.design === 'halves' ? (o.split === 'h' ? [0, 1] : [1, 0]) : null);
    out.push(full(c, k, { name: 'Увеличение' }));
  }

  // пыль под глазами
  if (o.scatter && o.bg !== 'collage') {
    const { c, k } = sheetCanvas(thumb ? 400 : 4200);
    drawDust(c.getContext('2d'), c.width, c.height, rand);
    out.push(full(c, k, { name: 'Пыль', opacity: 0.9 }));
  }

  // направления столкновения: каждый глаз рассыпается к другому
  if (o.design === 'collision') {
    const [a, b] = placed, dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    a.dir = [dx / l, dy / l]; b.dir = [-dx / l, -dy / l];
  }

  // глаза
  placed.forEach((p, i) => {
    const e = p.e, side0 = Math.max(e.canvas.width, e.canvas.height);
    const scale = p.d / side0;
    const opts = {};
    if (o.design === 'halves') {
      // первый глаз слева (или сверху), второй справа (снизу)
      opts.half = o.split === 'h' ? (i ? Math.PI / 2 : -Math.PI / 2) : (i ? 0 : Math.PI);
    }
    if (o.design === 'infinity' && i === 1) {
      const a = placed[0];
      opts.cut = { dx: (a.x - p.x) / (p.d / 2), dy: (a.y - p.y) / (p.d / 2), r: a.d / p.d, y: 0 };
    }
    if (o.scatter) {
      p.scatter = SCATTER;
      p.spread = spreadOf(p, rand);
      p.plan = strokePlan(p, rand);
    }
    const eyeLayer = {
      name: e.name || `Глаз ${i + 1}`, kind: 'eye', canvas: im.cloneCanvas(e.canvas), adjust: e.adjust && { ...e.adjust },
      eye: e.eye, eyeKey: e.eyeKey, cx: p.x, cy: p.y, scale,
    };
    if (opts.half != null || opts.cut || p.plan) {
      const side = Math.min(thumb ? 200 : 2600, Math.round(side0));
      const shape = shapeCanvas(side, opts);
      if (p.plan) eraseStrokes(shape, p.plan.erase, p, br, rand);
      out.push({ name: `Форма ${i + 1}`, canvas: shape, cx: p.x, cy: p.y, scale: p.d / side });
      eyeLayer.clip = true;
    }
    out.push(eyeLayer);
  });

  // разлёт поверх глаз: у каждого глаза свой слой, его можно подтереть ластиком
  if (o.scatter) {
    placed.forEach((p, i) => {
      const l = revealStrokes(p.plan, p, br, W, H, thumb ? 400 : 4200, rand);
      if (l) out.push({ name: placed.length > 1 ? `Разлёт ${i + 1}` : 'Разлёт', ...l });
    });
  }
  if (overlay) out.push(overlay);
  return { layers: out, opts: o };
}
