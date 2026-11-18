// Вся работа с пикселями: проявка, резкость, сужение зрачка, заплатки нейронкой,
// размеры листов и раскладки студии.

// Настройки проявки по образцу Camera Raw. Студия всегда держит текстуру и
// резкость на максимуме, поэтому detail всегда 100 и в окне его нет.
// Всё остальное по умолчанию на нуле и крутится руками.
export const HSL_COLORS = ['Красные', 'Оранжевые', 'Жёлтые', 'Зелёные', 'Голубые', 'Синие', 'Фиолетовые', 'Пурпурные'];
const HSL_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];
const zeros = () => [0, 0, 0, 0, 0, 0, 0, 0];
export const newAdjust = () => ({
  v: 2, exp: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, sat: 0, hsl: { h: zeros(), s: zeros(), l: zeros() }, detail: 100,
});
export const NEUTRAL_ADJUST = { ...newAdjust(), detail: 0 };

// Приводит настройки любой версии к нынешнему виду.
export function normalizeAdjust(a) {
  const n = newAdjust();
  if (!a) return n;
  const out = { ...n, ...a, hsl: { h: zeros(), s: zeros(), l: zeros() } };
  if (a.hsl) for (const k of ['h', 's', 'l']) out.hsl[k] = (a.hsl[k] || zeros()).slice(0, 8);
  if (!a.v) out.exp = (a.exp || 0) / 50; // раньше яркость была от -100 до 100 на ±2 ступени
  out.v = 2;
  return out;
}

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
// Подобрано по снимку из Camera Raw с резкостью 150 и текстурой 100:
// средний рисунок там примерно в 1,8 раза сильнее исходного, мелкий около 2,2.
// Сильные перепады (край зрачка, ресницы) приглушаются, чтобы не было ореолов,
// как это делает «Детализация» в Camera Raw.
const FINE_PX = 3, COARSE_PX = 12.5, A_FINE = 0.5, A_COARSE = 0.8, HALO = 48;

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// Тоновые таблицы на каждый канал: баланс белого и экспозиция в линейном свете,
// потом белые и чёрные точки.
function buildLuts(p) {
  const t = p.temp / 100, u = p.tint / 100;
  const r = 1 + 0.45 * t, g = 1 - 0.25 * u, b = 1 - 0.45 * t;
  const norm = 0.2126 * r + 0.7152 * g + 0.0722 * b; // чтобы баланс не менял яркость
  const gain = Math.pow(2, p.exp);
  const bp = -p.blacks / 100 * 0.12, wp = 1 - p.whites / 100 * 0.12;
  return [r, g, b].map((m) => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let x = toSrgb(Math.min(1, toLin(i / 255) * (m / norm) * gain));
      x = (x - bp) / (wp - bp);
      lut[i] = Math.max(0, Math.min(1, x));
    }
    return lut;
  });
}

// Контрастность: S-кривая вокруг середины, одна на все каналы.
function contrastLut(c) {
  const k = c / 100 * 0.55, lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    lut[i] = Math.max(0, Math.min(1, x - k * Math.sin(2 * Math.PI * x) / (2 * Math.PI))) * 255;
  }
  return lut;
}

// Смешение цветов: вес каждой из восьми полос для оттенка h (в градусах).
function hueWeights(h, out) {
  out.fill(0);
  for (let i = 0; i < 8; i++) {
    const c = HSL_CENTERS[i], next = HSL_CENTERS[(i + 1) % 8] + (i === 7 ? 360 : 0);
    let d = h - c;
    if (d < 0) d += 360;
    const span = next - c;
    if (d < span) { const t = d / span; out[i] += 1 - t; out[(i + 1) % 8] += t; return out; }
  }
  return out;
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
// blurScale — во сколько раз картинка уже уменьшена относительно исходника
// (нужно, когда пересчитывается кусок уже уменьшенной копии).
export function applyAdjust(src, p0, scale = 1, blurScale = scale) {
  const p = normalizeAdjust(p0);
  const w = Math.max(8, Math.round(src.width * scale)), h = Math.max(8, Math.round(src.height * scale));
  const out = makeCanvas(w, h);
  const x = out.getContext('2d', { willReadFrequently: true });
  // 1:1 без сглаживания, иначе картинка слегка мылится ещё до проявки
  if (w === src.width && h === src.height) x.imageSmoothingEnabled = false;
  else x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const [lr, lg, lb] = buildLuts(p), cl = contrastLut(p.contrast);
  const sat = 1 + p.sat / 100, vib = p.vibrance / 100, a = p.detail / 100;
  const sh = p.shadows / 100, hi = p.highlights / 100;
  const hsl = p.hsl, useHsl = [...hsl.h, ...hsl.s, ...hsl.l].some((v) => v), wts = new Float32Array(8);
  // Резкость считаем только по яркости, а цвет берём слегка размытый.
  // Так усиливается рисунок волокон, а цветной шум матрицы не вылезает.
  const fine = blurred(out, Math.max(0.5, FINE_PX * blurScale));
  const coarse = a > 0 ? blurred(out, Math.max(1.5, COARSE_PX * blurScale)) : null;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const L0 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const Lf = 0.299 * fine[i] + 0.587 * fine[i + 1] + 0.114 * fine[i + 2];
    let add = L0 - Lf;
    if (coarse) {
      const Lc = 0.299 * coarse[i] + 0.587 * coarse[i + 1] + 0.114 * coarse[i + 2];
      const hp = A_FINE * (L0 - Lf) + A_COARSE * (L0 - Lc);
      add += a * hp / (1 + Math.abs(hp) / HALO);
    }
    let r = lr[clamp(fine[i] + add)], g = lg[clamp(fine[i + 1] + add)], b = lb[clamp(fine[i + 2] + add)];
    // светлые и тени: двигаем яркость в своём диапазоне, цвет не трогаем
    if (sh || hi) {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (L > 0.0005) {
        const L2 = Math.max(0, L + sh * 0.6 * L * (1 - L) * (1 - L) + hi * 0.6 * L * L * (1 - L));
        const k = L2 / L;
        r *= k; g *= k; b *= k;
      }
    }
    r = cl[clamp(r * 255)]; g = cl[clamp(g * 255)]; b = cl[clamp(b * 255)];
    // насыщенность и красочность (красочность сильнее тянет бледные цвета)
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s0 = mx > 0 ? (mx - mn) / mx : 0;
    const f = sat * (1 + vib * (1 - s0));
    if (f !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
    }
    if (useHsl && s0 > 0.02) {
      const R = clamp(r) / 255, G = clamp(g) / 255, B = clamp(b) / 255;
      const M = Math.max(R, G, B), m = Math.min(R, G, B), c = M - m;
      let hh = c === 0 ? 0 : M === R ? ((G - B) / c) % 6 : M === G ? (B - R) / c + 2 : (R - G) / c + 4;
      hh *= 60; if (hh < 0) hh += 360;
      hueWeights(hh, wts);
      let dh = 0, ds = 0, dl = 0;
      for (let k = 0; k < 8; k++) if (wts[k]) { dh += wts[k] * hsl.h[k]; ds += wts[k] * hsl.s[k]; dl += wts[k] * hsl.l[k]; }
      const strength = Math.min(1, s0 * 4); // серое не трогаем
      let H2 = (hh + dh / 100 * 30 * strength + 360) % 360;
      let S2 = Math.max(0, Math.min(1, (M ? c / M : 0) * (1 + ds / 100 * strength)));
      let V2 = Math.max(0, Math.min(1, M * (1 + dl / 100 * 0.5 * strength)));
      const C2 = V2 * S2, X = C2 * (1 - Math.abs(((H2 / 60) % 2) - 1)), m2 = V2 - C2;
      const seg = Math.floor(H2 / 60);
      const rgb = seg === 0 ? [C2, X, 0] : seg === 1 ? [X, C2, 0] : seg === 2 ? [0, C2, X] : seg === 3 ? [0, X, C2] : seg === 4 ? [X, 0, C2] : [C2, 0, X];
      r = (rgb[0] + m2) * 255; g = (rgb[1] + m2) * 255; b = (rgb[2] + m2) * 255;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
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
const PINCH_OVERSHOOT_V = 0.9; // текстура заходит чуть под чёрный круг
const PINCH_MAX_PASSES = 40;
// Край чёрного зрачка: середина перехода и его ширина в долях радиуса зрачка.
// Подобрано по снимку, обработанному в фотошопе панелью студии.
// Профиль яркости вышел почти как у фотошопа: среднее отклонение 3% против 11% раньше.
const PUPIL_EDGE_CENTER = 0.95, PUPIL_EDGE_SIGMA = 0.12;

// Приближение функции ошибок, точности хватает с запасом.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function fillPupil(x, cx, cy, c, sigma) {
  sigma = Math.max(0.8, sigma);
  const R = c + sigma * 4, W = x.canvas.width, H = x.canvas.height;
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
  if (x1 <= x0 || y1 <= y0) return;
  const img = x.getImageData(x0, y0, x1 - x0, y1 - y0), d = img.data, w = x1 - x0;
  const k = 1 / (sigma * Math.SQRT2);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const rho = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
      if (rho > R) continue;
      const black = 0.5 * (1 - erf((rho - c) * k)), keep = 1 - black, i = ((yy - y0) * w + (xx - x0)) * 4;
      d[i] *= keep; d[i + 1] *= keep; d[i + 2] *= keep;
    }
  }
  x.putImageData(img, x0, y0);
}

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

export function shrinkPupil(canvas, pupil, R, ratio = PUPIL_RATIO, soft = 1) {
  const target = R * ratio;
  const rect = pupilRect(canvas, pupil, R);
  const { zone } = rect;
  const x = canvas.getContext('2d');
  const a = target * PINCH_OVERSHOOT_V / zone, edge = pupil.r / zone;
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
  // Чёрный зрачок с мягким краем. Растушёвка в фотошопе даёт плавный переход
  // по нормальному закону, поэтому и здесь край считается так же.
  fillPupil(x, pupil.x, pupil.y, target * PUPIL_EDGE_CENTER, target * PUPIL_EDGE_SIGMA * soft);
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

// under(ctx, N) — необязательная подложка: рисует в квадрат N×N то, что лежит
// под слоем в этом же месте (исходный снимок под вырезанным глазом). С ней модель
// у края круга видит продолжение радужки и дорисовывает по границе. Без подложки
// прозрачное место отдаётся модели как «дорисуй сама», иначе она приняла бы
// пустоту за чёрный предмет и затянула бы им половину глаза.
// Перенос мелкого рисунка поворотом. Нейронка видит место уменьшенным до 512 точек,
// поэтому на больших заплатках мылит. Волокна радужки идут лучами от зрачка, и если
// повернуть глаз вокруг зрачка, чистый участок с другой стороны ложится на
// испорченное место с правильным направлением лучей. Берём у него мелкий рисунок,
// а у нейронки общий цвет и свет.
// iris: { x, y, R } — центр зрачка и радиус радужки в пикселях слоя.
function chooseTurn(canvas, mask, region, iris) {
  const side = region.w, step = Math.max(2, Math.round(side / 80));
  const md = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, side, side).data;
  const pts = [];
  for (let y = 0; y < side; y += step) for (let x = 0; x < side; x += step) {
    if (md[(y * side + x) * 4 + 3] > 20) pts.push([region.x + x, region.y + y]);
  }
  if (!pts.length) return null;
  // карта яркости слоя в уменьшенном виде: по ней отсекаем источники с бликами
  const k = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
  const lw = Math.max(1, Math.round(canvas.width * k)), lh = Math.max(1, Math.round(canvas.height * k));
  const lc = makeCanvas(lw, lh), lx = lc.getContext('2d', { willReadFrequently: true });
  lx.drawImage(canvas, 0, 0, lw, lh);
  const ld = lx.getImageData(0, 0, lw, lh).data;
  const at = (x, y) => {
    const ix = Math.floor(x * k), iy = Math.floor(y * k);
    if (ix < 0 || iy < 0 || ix >= lw || iy >= lh) return null;
    const i = (iy * lw + ix) * 4;
    return ld[i + 3] < 200 ? null : 0.299 * ld[i] + 0.587 * ld[i + 1] + 0.114 * ld[i + 2];
  };
  const inMask = (x, y) => {
    const rx = Math.round(x - region.x), ry = Math.round(y - region.y);
    return rx >= 0 && ry >= 0 && rx < side && ry < side && md[(ry * side + rx) * 4 + 3] > 20;
  };
  // считаем только то, что на радужке: за её краем поворот всё равно даёт пустоту
  const all = pts.length;
  for (let i = pts.length - 1; i >= 0; i--) if (Math.hypot(pts[i][0] - iris.x, pts[i][1] - iris.y) > iris.R * 0.97) pts.splice(i, 1);
  if (pts.length < all * 0.5) return null; // место в основном не на радужке
  const all2 = [];
  for (let deg = 20; deg <= 180; deg += 10) {
    for (const sgn of [1, -1]) {
      const a = sgn * deg * Math.PI / 180, c = Math.cos(-a), sn = Math.sin(-a);
      let good = 0;
      for (const [x, y] of pts) {
        const dx = x - iris.x, dy = y - iris.y;
        const qx = iris.x + dx * c - dy * sn, qy = iris.y + dx * sn + dy * c;
        const L = at(qx, qy);
        if (L != null && L < 225 && !inMask(qx, qy)) good++;
      }
      const score = good / pts.length - deg * 0.0008; // при равенстве берём поворот поменьше: свет похожее
      all2.push({ a, score, good: good / pts.length });
    }
  }
  // годные повороты по убыванию, соседние (ближе 30°) не повторяем: для вариантов
  const out = [];
  for (const t of all2.filter((t) => t.good > 0.92).sort((p, q) => q.score - p.score)) {
    if (out.every((a) => Math.abs(a - t.a) > Math.PI / 6 + 1e-6)) out.push(t.a);
  }
  return out;
}

// Расширение маски на r точек (квадратом, этого хватает)
function dilate(m, N, r) {
  const t = new Uint8Array(m.length), o = new Uint8Array(m.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < N && m[y * N + xx]) v = 255; }
    t[y * N + x] = v;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0;
    for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < N && t[yy * N + x]) v = 255; }
    o[y * N + x] = v;
  }
  return o;
}

// Отражение квадрата N×N (rgba по 4 байта или маска по 1) по горизонтали или вертикали.
function flipSquare(a, N, ch, how) {
  const o = new Uint8Array(a.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const sx = how === 'h' ? N - 1 - x : x, sy = how === 'v' ? N - 1 - y : y;
    const i = (y * N + x) * ch, j = (sy * N + sx) * ch;
    for (let c = 0; c < ch; c++) o[i + c] = a[j + c];
  }
  return o;
}

function detailFromTurn(canvas, region, lamaUp, iris, angle, sigma) {
  const side = region.w;
  const src = makeCanvas(side, side), sx = src.getContext('2d', { willReadFrequently: true });
  sx.translate(-region.x, -region.y);
  sx.translate(iris.x, iris.y); sx.rotate(angle); sx.translate(-iris.x, -iris.y);
  sx.drawImage(canvas, 0, 0);
  const blur = (c) => {
    const b = makeCanvas(side, side), bx = b.getContext('2d', { willReadFrequently: true });
    bx.filter = `blur(${sigma}px)`;
    bx.drawImage(c, 0, 0);
    return bx.getImageData(0, 0, side, side).data;
  };
  const S = sx.getImageData(0, 0, side, side).data, Sb = blur(src), Lb = blur(lamaUp);
  const out = makeCanvas(side, side), ox = out.getContext('2d');
  const img = ox.createImageData(side, side), o = img.data;
  for (let i = 0; i < o.length; i += 4) {
    for (let c = 0; c < 3; c++) o[i + c] = Lb[i + c] + (S[i + 3] > 0 ? S[i + c] - Sb[i + c] : 0);
    o[i + 3] = 255;
  }
  ox.putImageData(img, 0, 0);
  return out;
}

// Варианты как в фотошопе. Модель на одном и том же входе всегда отвечает одинаково,
// а отражение для неё почти ничего не меняет (на небольших местах три варианта
// выходили одинаковыми). Поэтому каждый вариант получает место по-настоящему по-другому:
//   0 — как есть;
//   1 — то же, но мелкий рисунок берётся с другого места радужки (поворотом вокруг зрачка);
//   2 — модель видит место с большим запасом вокруг, плюс рисунок с третьего места;
// дальше по кругу, с отражением и чуть шире место. Считается по копии слоя.
export const VARIANTS = 3;
const FLIPS = [null, 'h', 'v', 'hv'];

export async function makePatch(canvas, mask, region, run, under, iris, variant = 0) {
  const N = 512, side = region.w;
  const kind = variant % 3, round = Math.floor(variant / 3);
  // запас вокруг: модель видит больше соседней радужки и дорисовывает иначе
  const zoom = kind === 2 && !under ? 1.6 : 1;
  const side2 = Math.round(side * zoom), off = (side2 - side) / 2;
  const small = makeCanvas(N, N);
  const sx = small.getContext('2d', { willReadFrequently: true });
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(canvas, region.x - off, region.y - off, side2, side2, 0, 0, N, N);
  const alpha = sx.getImageData(0, 0, N, N).data;
  sx.globalCompositeOperation = 'destination-over';
  if (under) under(sx, N);
  sx.fillStyle = '#000';
  sx.fillRect(0, 0, N, N);
  sx.globalCompositeOperation = 'source-over';
  let rgba = new Uint8Array(sx.getImageData(0, 0, N, N).data.buffer);

  const sm = makeCanvas(N, N);
  const mx = sm.getContext('2d', { willReadFrequently: true });
  const kk = N / side2;
  mx.drawImage(mask, 0, 0, side, side, off * kk, off * kk, side * kk, side * kk);
  const md = mx.getImageData(0, 0, N, N).data;
  let m = new Uint8Array(N * N);
  for (let i = 0; i < m.length; i++) m[i] = md[i * 4 + 3] > 20 || (!under && alpha[i * 4 + 3] < 128) ? 255 : 0;

  // «ещё варианты»: следующие круги с отражением и чуть шире местом
  const grow = round * 3;
  if (grow) m = dilate(m, N, grow);
  const flip = FLIPS[round % FLIPS.length];
  const fl = (a, ch) => { for (const f of flip || '') a = flipSquare(a, N, ch, f); return a; };
  if (flip) { rgba = fl(rgba, 4); m = fl(m, 1); }
  let out = new Uint8Array(await run(rgba, m));
  if (flip) out = fl(out, 4);
  sx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), N, N), 0, 0);

  let patch = makeCanvas(side, side);
  const px0 = patch.getContext('2d', { willReadFrequently: true });
  px0.imageSmoothingQuality = 'high';
  px0.drawImage(small, off * kk, off * kk, side * kk, side * kk, 0, 0, side, side);
  // мелкий рисунок с другого места радужки: на больших местах всегда (нейронка видела
  // их уменьшенными), на маленьких — у вариантов 1 и 2, чтобы они правда отличались
  const f = side2 / N;
  if (iris && (f > 1.25 || kind > 0)) {
    const turns = chooseTurn(canvas, mask, region, iris);
    if (turns && turns.length) {
      const angle = turns[(f > 1.25 ? variant : kind - 1 + round) % turns.length];
      patch = detailFromTurn(canvas, region, patch, iris, angle, Math.min(10, Math.max(3, (side / N) * 3)));
    }
  }
  // Вклеиваем только закрашенное место, край заплатки размыт, чтобы не было шва.
  const px = patch.getContext('2d');
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
  return patch;
}

export function applyPatch(canvas, patch, region) {
  const cx = canvas.getContext('2d');
  cx.save();
  cx.globalCompositeOperation = 'source-atop'; // прозрачные места слоя остаются прозрачными
  cx.drawImage(patch, region.x, region.y);
  cx.restore();
}

export async function inpaintPatch(canvas, mask, region, run, under, iris, variant = 0) {
  applyPatch(canvas, await makePatch(canvas, mask, region, run, under, iris, variant), region);
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
