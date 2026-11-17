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
  collision: [[0.3, 0.35, 0.6], [0.7, 0.655, 0.6]],
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
function shapeCanvas(side, { half = null, cut = null, erode = null }, rand) {
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
  if (erode) erodeEdge(x, side, erode, rand);
  return c;
}

// Край радужки рассыпается: у кромки появляются дыры и рваный край.
// erode.dir — куда летит (единичный вектор) или null для россыпи по кругу.
function erodeEdge(x, side, erode, rand) {
  const R = side / 2, img = x.getImageData(0, 0, side, side), d = img.data;
  const big = noiseField(rand, 9), fine = noiseField(rand, 46);
  const bandMax = R * (erode.dir ? 0.42 : 0.11);
  for (let py = 0; py < side; py++) {
    const vy = (py + 0.5 - R) / R;
    for (let px = 0; px < side; px++) {
      const vx = (px + 0.5 - R) / R, rr = Math.hypot(vx, vy);
      if (rr > 1.0 || rr < 1 - bandMax / R) continue;
      const i = (py * side + px) * 4;
      if (!d[i + 3]) continue;
      let w = 1;
      if (erode.dir) {
        const dot = (vx * erode.dir[0] + vy * erode.dir[1]) / (rr || 1);
        w = Math.max(0, dot);
        w = w * w;
        if (w < 0.02) { w = 0.12 * (0.6 + big(px / side, py / side)); }
      } else w = 0.55 + 0.9 * big(px / side, py / side);
      const band = Math.max(1e-3, bandMax * w / R);
      const t = (1 - rr) / band;          // 0 у кромки, 1 на внутренней границе полосы
      // зерно: пиксели выпадают по одному, гуще у самой кромки
      const n = 0.6 * big(px / side, py / side) + 0.4 * fine(px / side, py / side);
      const p = Math.max(0, Math.min(1, (t - n * 0.85) * 2.2 + 0.25));
      const a = p >= 1 ? 1 : rand() < p * p ? 1 : 0;
      d[i + 3] = Math.round(d[i + 3] * a);
    }
  }
  x.putImageData(img, 0, 0);
}

// --- Россыпь: пылинки и крошки цвета глаза -----------------------------------
function drawParticles(x, k, eyes, rand) {
  const rgba = (c, lift, a) => `rgba(${Math.min(255, c[0] * lift) | 0},${Math.min(255, c[1] * lift) | 0},${Math.min(255, c[2] * lift) | 0},${a.toFixed(2)})`;
  for (const e of eyes) {
    const R = e.d / 2, dir = e.dir, px1 = 1 / k;          // px1 — один пиксель холста в единицах листа
    const base = dir ? Math.atan2(dir[1], dir[0]) : 0;
    // откуда летит: угол у кромки, у столкновения в сторону соседа
    const angle = () => (dir ? base + (rand() + rand() + rand() - 1.5) * 1.35 : rand() * Math.PI * 2);
    const weight = (ux, uy) => (dir ? Math.max(0.08, ux * dir[0] + uy * dir[1]) : 1);
    // 1) мелкий порошок: тысячи точек в 1–2 пикселя, плотно у края
    const fineN = Math.round((dir ? 150000 : 45000) * Math.min(2.5, Math.max(0.15, (R * k) / 1100)));
    for (let i = 0; i < fineN; i++) {
      const ang = angle(), ux = Math.cos(ang), uy = Math.sin(ang), w = weight(ux, uy);
      const tail = -Math.log(1 - rand() * 0.999);
      const dist = R * (dir ? (0.02 + 0.26 * tail) * w : 0.004 + 0.075 * tail * w);
      let mx = ux, my = uy;
      if (dir) { mx = ux * 0.5 + dir[0] * 0.7 + (rand() - 0.5) * 0.7; my = uy * 0.5 + dir[1] * 0.7 + (rand() - 0.5) * 0.7; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; }
      const r0 = R * (1 - Math.pow(rand(), 1.6) * (dir ? 0.36 : 0.1) * w);
      const col = colorAt(e.sample, ux * 0.8, uy * 0.8);
      const s = (rand() < 0.7 ? 1 : 1.6 + rand() * 2.4) * px1;
      x.fillStyle = rgba(col, 1 + rand() * 0.6, 0.5 + rand() * 0.5);
      x.fillRect((e.x + ux * r0 + mx * dist) * k, (e.y + uy * r0 + my * dist) * k, s * k, s * k);
    }
    // 2) крошки: неровные кусочки, яркие, цвета глаза
    const crumbN = Math.round(dir ? 70 : 34);
    for (let i = 0; i < crumbN; i++) {
      const ang = angle(), ux = Math.cos(ang), uy = Math.sin(ang), w = weight(ux, uy);
      if (dir && w < 0.3 && rand() < 0.8) continue;
      const tail = -Math.log(1 - rand() * 0.98);
      const dist = R * (dir ? 0.05 + 0.3 * tail * w : 0.02 + 0.12 * tail);
      let mx = ux, my = uy;
      if (dir) { mx = ux * 0.4 + dir[0] * 0.8 + (rand() - 0.5) * 0.6; my = uy * 0.4 + dir[1] * 0.8 + (rand() - 0.5) * 0.6; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l; }
      const cx = (e.x + ux * R + mx * dist) * k, cy = (e.y + uy * R + my * dist) * k;
      const col = colorAt(e.sample, ux * 0.75, uy * 0.75, 1.6);
      const size = R * k * (0.004 + Math.pow(rand(), 2.2) * 0.022);
      const m = 6 + (rand() * 5 | 0), a0 = rand() * 6.3;
      x.beginPath();
      for (let j = 0; j < m; j++) {
        const a = a0 + (j / m) * Math.PI * 2, rr = size * (0.45 + rand() * 0.6);
        const qx = cx + Math.cos(a) * rr, qy = cy + Math.sin(a) * rr * (0.6 + rand() * 0.4);
        j ? x.lineTo(qx, qy) : x.moveTo(qx, qy);
      }
      x.closePath();
      const g = x.createLinearGradient(cx - size, cy - size, cx + size, cy + size);
      g.addColorStop(0, rgba(col, 1.35, 1));
      g.addColorStop(1, rgba(col, 0.8, 1));
      x.fillStyle = g;
      x.fill();
    }
  }
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
    if (o.scatter) opts.erode = { dir: p.dir || null };
    const eyeLayer = {
      name: e.name || `Глаз ${i + 1}`, kind: 'eye', canvas: im.cloneCanvas(e.canvas), adjust: e.adjust && { ...e.adjust },
      eye: e.eye, eyeKey: e.eyeKey, cx: p.x, cy: p.y, scale,
    };
    if (opts.half != null || opts.cut || opts.erode) {
      const side = Math.min(thumb ? 200 : 2600, Math.round(side0));
      const shape = shapeCanvas(side, opts, rand);
      out.push({ name: `Форма ${i + 1}`, canvas: shape, cx: p.x, cy: p.y, scale: p.d / side });
      eyeLayer.clip = true;
    }
    out.push(eyeLayer);
  });

  // россыпь поверх глаз
  if (o.scatter) {
    const { c, k } = sheetCanvas(thumb ? 400 : 4200);
    const x = c.getContext('2d');
    drawParticles(x, k, placed.map((p) => ({ x: p.x, y: p.y, d: p.d, dir: p.dir, sample: p.sample })), rand);
    out.push(full(c, k, { name: 'Россыпь' }));
  }
  if (overlay) out.push(overlay);
  return { layers: out, opts: o };
}
