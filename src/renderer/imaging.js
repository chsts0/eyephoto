// Вся работа с пикселями: проявка, резкость, сужение зрачка, заплатки нейронкой,
// размеры листов и раскладки студии.

// Заводские настройки проявки. Студия может заменить их своими:
// кнопка «Сделать стандартом» в окне проявки.
export const FACTORY_ADJUST = { temp: -20, tint: 0, exp: 0, contrast: 10, sat: 12, detail: 45 };
export const NEUTRAL_ADJUST = { temp: 0, tint: 0, exp: 0, contrast: 0, sat: 0, detail: 0 };
export const defaults = { ...FACTORY_ADJUST };
export function setDefaults(v) { Object.assign(defaults, FACTORY_ADJUST, v || {}); }

// Доля от радиуса радужки, которую занимает зрачок в готовом снимке.
// Взято из шаблонов студии: зрачок 600 px при радужке 2512 px.
export const PUPIL_RATIO = 0.236;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// --- Проявка ----------------------------------------------------------------

// Радиусы размытия в пикселях исходника и сила двух слоёв резкости.
// Подобрано так, чтобы «Детали 100» давали вид, близкий к Camera Raw
// с текстурой 100 и резкостью 150, которыми студия пользовалась в фотошопе.
const FINE_PX = 3, COARSE_PX = 12.5, A_FINE = 1.3, A_COARSE = 1.4;

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function buildLuts(p) {
  const t = p.temp / 100, u = p.tint / 100;
  const r = 1 + 0.45 * t, g = 1 - 0.25 * u, b = 1 - 0.45 * t;
  const norm = 0.2126 * r + 0.7152 * g + 0.0722 * b; // чтобы баланс не менял яркость
  const gain = Math.pow(2, p.exp / 100 * 2); // ползунок ±100 = ±2 ступени
  const k = p.contrast / 100;
  return [r, g, b].map((m) => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let x = toSrgb(Math.min(1, toLin(i / 255) * (m / norm) * gain));
      x -= k * Math.sin(2 * Math.PI * x) / (2 * Math.PI); // S-кривая, середина круче
      lut[i] = Math.max(0, Math.min(1, x)) * 255;
    }
    return lut;
  });
}

function blurred(src, radius) {
  const c = makeCanvas(src.width, src.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.filter = `blur(${radius}px)`;
  x.drawImage(src, 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
}

// Возвращает проявленную копию слоя. Прозрачность не меняется.
// scale < 1 даёт уменьшенный черновик: для больших снимков и для живого
// предпросмотра, пока тянут ползунок.
export function applyAdjust(src, p, scale = 1) {
  const w = Math.max(8, Math.round(src.width * scale)), h = Math.max(8, Math.round(src.height * scale));
  const out = makeCanvas(w, h);
  const x = out.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const [lr, lg, lb] = buildLuts(p);
  const sat = 1 + p.sat / 100, a = p.detail / 100;
  // Резкость считаем только по яркости, а цвет берём слегка размытый.
  // Так усиливается рисунок волокон, а цветной шум матрицы не вылезает.
  const fine = blurred(out, Math.max(0.5, FINE_PX * scale));
  const coarse = a > 0 ? blurred(out, Math.max(1.5, COARSE_PX * scale)) : null;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const Lf = 0.299 * fine[i] + 0.587 * fine[i + 1] + 0.114 * fine[i + 2];
    let add = L - Lf;
    if (coarse) {
      const Lc = 0.299 * coarse[i] + 0.587 * coarse[i + 1] + 0.114 * coarse[i + 2];
      add += a * (A_FINE * (L - Lf) + A_COARSE * (L - Lc));
    }
    const r = lr[clamp(fine[i] + add)], g = lg[clamp(fine[i + 1] + add)], b = lb[clamp(fine[i + 2] + add)];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    d[i] = l + (r - l) * sat;
    d[i + 1] = l + (g - l) * sat;
    d[i + 2] = l + (b - l) * sat;
  }
  x.putImageData(img, 0, 0);
  return out;
}

// --- Поиск зрачка -----------------------------------------------------------
// Зрачок на макроснимке это самое тёмное крупное круглое пятно. Перебираем
// несколько порогов яркости и среди тёмных пятен берём самое круглое, плотное
// и контрастное с тем, что вокруг. Блики внутри зрачка не мешают: пятно
// оценивается по своим границам. Это подсказка, круг всегда правится руками.

export function findPupil(canvas) {
  const W0 = canvas.width, H0 = canvas.height, k = 320 / Math.max(W0, H0);
  const w = Math.max(8, Math.round(W0 * k)), h = Math.max(8, Math.round(H0 * k)), n = w * h;
  const c = makeCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.filter = 'blur(1.2px)';
  x.drawImage(canvas, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(n), hist = new Uint32Array(256);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    // прозрачное считаем светлым, чтобы пустые углы вырезанного глаза не сошли за зрачок
    g[i] = a < 200 ? 255 : (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    if (a >= 200) { hist[g[i]]++; opaque++; }
  }
  const fallback = { x: W0 / 2, y: H0 / 2, r: Math.min(W0, H0) * 0.1, found: false };
  if (opaque < 100) return fallback;
  const label = new Int32Array(n), stack = new Int32Array(n);
  let best = null;
  for (const pct of [1, 2, 3, 5, 8, 12, 18, 25, 33]) {
    let acc = 0, thr = 0;
    while (thr < 255 && acc + hist[thr] < opaque * pct / 100) acc += hist[thr++];
    label.fill(0);
    let id = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (label[s0] || g[s0] > thr) continue;
      id++;
      let top = 0, area = 0, sx = 0, sy = 0, sum = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      stack[top++] = s0; label[s0] = id;
      while (top) {
        const i = stack[--top], px = i % w, py = (i - px) / w;
        area++; sx += px; sy += py; sum += g[i];
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && !label[i - 1] && g[i - 1] <= thr) { label[i - 1] = id; stack[top++] = i - 1; }
        if (px < w - 1 && !label[i + 1] && g[i + 1] <= thr) { label[i + 1] = id; stack[top++] = i + 1; }
        if (py > 0 && !label[i - w] && g[i - w] <= thr) { label[i - w] = id; stack[top++] = i - w; }
        if (py < h - 1 && !label[i + w] && g[i + w] <= thr) { label[i + w] = id; stack[top++] = i + w; }
      }
      const frac = area / n, bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (frac < 0.002 || frac > 0.45) continue;
      if (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1) continue; // у края кадра это тень, а не зрачок
      const aspect = Math.min(bw, bh) / Math.max(bw, bh);
      if (aspect < 0.6) continue;
      const r = (bw + bh) / 4, fill = area / (Math.PI * r * r);
      if (fill < 0.6 || fill > 1.3) continue;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, inside = sum / area;
      // яркость кольца вокруг пятна: у зрачка там радужка, она заметно светлее
      let ring = 0, cnt = 0;
      for (let a = 0; a < 24; a++) {
        const rx = Math.round(cx + Math.cos(a * Math.PI / 12) * r * 1.5), ry = Math.round(cy + Math.sin(a * Math.PI / 12) * r * 1.5);
        if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
        ring += g[ry * w + rx]; cnt++;
      }
      if (cnt < 12) continue;
      const contrast = (ring / cnt - inside) / 255;
      if (contrast < 0.04) continue;
      const central = 1 - Math.min(1, Math.hypot(cx - w / 2, cy - h / 2) / (Math.hypot(w, h) / 2));
      const score = 1.2 * aspect + 0.8 * Math.min(fill, 1 / fill) + 1.5 * contrast - 0.5 * inside / 255 + 0.3 * central;
      if (!best || score > best.score) best = { score, x: sx / area + 0.5, y: sy / area + 0.5, r };
    }
  }
  if (!best) return fallback;
  return { x: best.x / k, y: best.y / k, r: best.r / k * 1.04, found: true };
}

// --- Сужение зрачка ---------------------------------------------------------
// Работает как фильтр «Дисторсия» в фотошопе, которым студия пользовалась
// в своей панели: круглая зона вокруг зрачка стягивается к центру слабыми
// проходами, пока край зрачка не уйдёт под чёрный круг нужного размера.
// Проходы складываются в одну формулу, поэтому картинка пересчитывается
// один раз и не мылится. R — радиус радужки, ratio — доля зрачка от него.

const PINCH_AMOUNT = 0.2;  // сила одного прохода, как в панели студии
const PINCH_ZONE = 0.62;   // зона стягивания, доля от радиуса радужки
const PINCH_OVERSHOOT = 0.9; // текстура заходит чуть под чёрный круг
const PINCH_MAX_PASSES = 40;

function pinchZone(pupil, R) {
  return Math.max(R * PINCH_ZONE, pupil.r * 1.6);
}

// Один проход: точка на расстоянии r (в долях зоны) берёт цвет с расстояния pinchOnce(r).
// У края зоны эффект плавно сходит на нет, как у выделения с растушёвкой.
function pinchOnce(r) {
  if (r <= 0 || r >= 1) return r;
  const src = Math.min(1, r * Math.pow(Math.sin(Math.PI / 2 * r), -PINCH_AMOUNT));
  const t = Math.max(0, Math.min(1, (1 - r) / 0.07)), m = t * t * (3 - 2 * t);
  return r + (src - r) * m;
}

export function pupilRect(canvas, pupil, R) {
  const zone = pinchZone(pupil, R);
  const x0 = Math.max(0, Math.floor(pupil.x - zone - 2)), y0 = Math.max(0, Math.floor(pupil.y - zone - 2));
  const x1 = Math.min(canvas.width, Math.ceil(pupil.x + zone + 2)), y1 = Math.min(canvas.height, Math.ceil(pupil.y + zone + 2));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, zone };
}

export function shrinkPupil(canvas, pupil, R, ratio = PUPIL_RATIO) {
  const target = R * ratio;
  const rect = pupilRect(canvas, pupil, R);
  const { zone } = rect;
  const x = canvas.getContext('2d');
  const a = target * PINCH_OVERSHOOT / zone, edge = pupil.r / zone;
  let passes = 0;
  for (let v = a; v < edge && passes < PINCH_MAX_PASSES; passes++) v = pinchOnce(v);
  if (passes > 0 && rect.w > 2 && rect.h > 2) {
    // таблица «откуда брать» для каждого расстояния от центра
    const N = 2048, map = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      let v = i / N;
      for (let p = 0; p < passes; p++) v = pinchOnce(v);
      map[i] = v;
    }
    const src = x.getImageData(rect.x, rect.y, rect.w, rect.h);
    const dst = x.createImageData(rect.w, rect.h);
    const s = src.data, o = dst.data, W = rect.w, H = rect.h;
    const cx = pupil.x - rect.x, cy = pupil.y - rect.y;
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const dx = xx - cx, dy = yy - cy, rho = Math.hypot(dx, dy);
        let fx = xx, fy = yy;
        if (rho < zone && rho > 0.001) {
          const u = rho / zone * N, i0 = Math.floor(u), f = u - i0;
          const sr = (map[i0] * (1 - f) + map[Math.min(N, i0 + 1)] * f) * zone;
          fx = cx + dx * sr / rho; fy = cy + dy * sr / rho;
        }
        const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
        const tx = Math.max(0, Math.min(1, fx - ix)), ty = Math.max(0, Math.min(1, fy - iy));
        const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4, oi = (yy * W + xx) * 4;
        for (let c = 0; c < 4; c++) {
          o[oi + c] = (s[i00 + c] * (1 - tx) + s[i10 + c] * tx) * (1 - ty) + (s[i01 + c] * (1 - tx) + s[i11 + c] * tx) * ty;
        }
      }
    }
    x.putImageData(dst, rect.x, rect.y);
  }
  // Чёрный зрачок с мягким краем: растушёвка 5% от диаметра, как в панели студии.
  const f = Math.max(3, target * 0.1), r0 = Math.max(0, target - f), r1 = target + f;
  const grad = x.createRadialGradient(pupil.x, pupil.y, r0, pupil.x, pupil.y, r1);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, e = 1 - t * t * (3 - 2 * t);
    grad.addColorStop(t, `rgba(0,0,0,${e})`);
  }
  x.save();
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = grad;
  x.beginPath();
  x.arc(pupil.x, pupil.y, r1, 0, Math.PI * 2);
  x.fill();
  x.restore();
  return rect;
}

// --- Заплатка нейронкой -----------------------------------------------------
// region: квадрат слоя, который отдаётся модели (см. patchRegion).
// mask: холст размером с region; непрозрачные пиксели = что убрать.
// run(rgba, mask512) вызывает модель.

export function patchRegion(canvas, bbox) {
  const W = canvas.width, H = canvas.height;
  const need = Math.max(512, Math.max(bbox.w, bbox.h) * 2.3);
  const side = Math.round(Math.min(need, W, H));
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
  const x = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const y = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  return { x, y, w: side, h: side };
}

export async function inpaintPatch(canvas, mask, region, run) {
  const N = 512, side = region.w;
  const small = makeCanvas(N, N);
  const sx = small.getContext('2d', { willReadFrequently: true });
  sx.imageSmoothingQuality = 'high';
  sx.fillStyle = '#000';
  sx.fillRect(0, 0, N, N);
  sx.drawImage(canvas, region.x, region.y, side, side, 0, 0, N, N);
  const rgba = sx.getImageData(0, 0, N, N).data;

  const sm = makeCanvas(N, N);
  const mx = sm.getContext('2d', { willReadFrequently: true });
  mx.drawImage(mask, 0, 0, side, side, 0, 0, N, N);
  const md = mx.getImageData(0, 0, N, N).data;
  const m = new Uint8Array(N * N);
  for (let i = 0; i < m.length; i++) m[i] = md[i * 4 + 3] > 20 ? 255 : 0;

  const out = await run(new Uint8Array(rgba.buffer), m);
  sx.putImageData(new ImageData(new Uint8ClampedArray(out), N, N), 0, 0);

  // Вклеиваем только закрашенное место, край заплатки размыт, чтобы не было шва.
  const patch = makeCanvas(side, side);
  const px = patch.getContext('2d');
  px.imageSmoothingQuality = 'high';
  px.drawImage(small, 0, 0, side, side);
  const soft = makeCanvas(side, side);
  const fx = soft.getContext('2d');
  fx.filter = `blur(${Math.max(1.5, side / 300)}px)`;
  fx.drawImage(mask, 0, 0, side, side, 0, 0, side, side);
  fx.filter = 'none';
  // Размытая маска на краю полупрозрачная, из-за этого просвечивал бы старый блик.
  // Накладываем её саму на себя, чтобы внутри обводки заплатка была плотной.
  for (let i = 0; i < 4; i++) fx.drawImage(soft, 0, 0);
  px.globalCompositeOperation = 'destination-in';
  px.drawImage(soft, 0, 0);
  const cx = canvas.getContext('2d');
  cx.save();
  cx.globalCompositeOperation = 'source-atop'; // прозрачные места слоя остаются прозрачными
  cx.drawImage(patch, region.x, region.y);
  cx.restore();
}

// --- Листы и раскладки студии -------------------------------------------------
// Размеры в пикселях при 500 точках на дюйм, координаты мест под глаза взяты
// из скриптов «Углы» и «Целые».

export const DPI = 500;

export const FORMATS = {
  A6: { label: 'А6', note: '10 × 15 см', w: 2953, h: 1969, iris: 1699,
    whole: { right: { cx: 0.6966, cy: 0.4210, d: 0.6247 }, left: { cx: 0.2943, cy: 0.5838, d: 0.6247 } },
    corners: { right: { cx: 0.7675, cy: 0.2806, d: 0.9309 }, left: { cx: 0.2274, cy: 0.7271, d: 0.9309 } } },
  A5: { label: 'А5', note: '14,8 × 21 см', w: 4134, h: 2913, iris: 2512 },
  A4: { label: 'А4', note: '21 × 29,7 см', w: 5846, h: 4134, iris: 3632 },
  A3: { label: 'А3', note: '29,7 × 42 см', w: 8268, h: 5846, iris: 5248 },
};

const WHOLE = { cx: 0.7132, cy: 0.4185, d: 0.6262 };
const CORNERS = { cx: 0.7719, cy: 0.2873, d: 0.8871 };
const mirror = (s) => ({ cx: 1 - s.cx, cy: 1 - s.cy, d: s.d });

export function matchFormat(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  return Object.values(FORMATS).find((f) => Math.abs(f.w - long) <= 4 && Math.abs(f.h - short) <= 4) || null;
}

// Места под пару глаз в пикселях листа: [левый, правый].
export function pairSlots(w, h, type) {
  const f = matchFormat(w, h);
  const own = f && f[type];
  const right = own ? own.right : (type === 'whole' ? WHOLE : CORNERS);
  const left = own ? own.left : mirror(right);
  return [left, right].map((s) => ({ cx: s.cx * w, cy: s.cy * h, d: s.d * h }));
}

// Ширина радужки для одного глаза по центру листа.
export function singleIris(w, h) {
  const f = matchFormat(w, h);
  return f ? f.iris : Math.max(w, h) * 0.61;
}

// Холст сохраняет JPEG без сведений о плотности. Вписываем точки на дюйм,
// чтобы файл открывался с правильным размером листа в сантиметрах.
export function setJpegDpi(buf, dpi) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0
    && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46) {
    b[13] = 1;
    b[14] = dpi >> 8; b[15] = dpi & 255;
    b[16] = dpi >> 8; b[17] = dpi & 255;
  }
  return b;
}
