// Вся работа с пикселями: цвет, резкость, сужение зрачка, заплатки нейронкой.

export const DEFAULT_COLOR = { temp: -20, tint: 0, exp: 0, contrast: 20, sat: 25, detail: 100 };

// Доля от радиуса радужки, которую занимает зрачок в готовом снимке.
// Взято из шаблонов студии: зрачок 600 px при радужке 2512 px.
export const PUPIL_RATIO = 0.236;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const ctx2d = (c, readback) => c.getContext('2d', { willReadFrequently: !!readback });

// --- Цвет и резкость --------------------------------------------------------

// Радиусы размытия как доля ширины глаза и сила двух слоёв резкости.
// Подобрано так, чтобы «Детали 100» давали вид, близкий к Camera Raw
// с текстурой 100 и резкостью 150, которыми студия пользовалась в фотошопе.
const FINE_DIV = 500, COARSE_DIV = 120, A_FINE = 1.6, A_COARSE = 1.4;

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

function buildLuts(p) {
  const t = p.temp / 100, u = p.tint / 100;
  let r = 1 + 0.45 * t, g = 1 - 0.25 * u, b = 1 - 0.45 * t;
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
  const x = ctx2d(c, true);
  x.filter = `blur(${radius}px)`;
  x.drawImage(src, 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
}

// Готовый вид глаза: цвет + резкость + круглая маска с мягким краем.
// scale < 1 даёт быстрый черновик для живого предпросмотра ползунков.
export function renderEye(base, p, scale = 1) {
  const w = Math.max(16, Math.round(base.width * scale));
  const out = makeCanvas(w, w);
  const x = ctx2d(out, true);
  x.imageSmoothingQuality = 'high';
  x.drawImage(base, 0, 0, w, w);
  const img = x.getImageData(0, 0, w, w);
  const d = img.data;
  const [lr, lg, lb] = buildLuts(p);
  const sat = 1 + p.sat / 100;
  const a = p.detail / 100;
  // Резкость считаем только по яркости, а цвет берём слегка размытый.
  // Так усиливается рисунок волокон, а цветной шум матрицы не вылезает.
  const fine = blurred(out, Math.max(0.6, w / FINE_DIV));
  const coarse = a > 0 ? blurred(out, Math.max(2, w / COARSE_DIV)) : null;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;
  for (let i = 0; i < d.length; i += 4) {
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

  // Круг с растушёвкой края, как овальное выделение с растушёвкой в фотошопе.
  const R = w / 2, feather = Math.max(2, w * 0.006);
  const grad = x.createRadialGradient(R, R, R - feather * 2, R, R, R);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  x.globalCompositeOperation = 'destination-in';
  x.fillStyle = grad;
  x.fillRect(0, 0, w, w);
  x.globalCompositeOperation = 'source-over';
  return out;
}

// --- Поиск зрачка (только как стартовая подсказка, круг всегда двигается руками)

export function guessPupil(canvas) {
  const n = 160;
  const c = makeCanvas(n, n);
  const x = ctx2d(c, true);
  x.drawImage(canvas, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data;
  let sx = 0, sy = 0, cnt = 0;
  for (let y = 0; y < n; y++) {
    for (let xx = 0; xx < n; xx++) {
      if (Math.hypot(xx - n / 2, y - n / 2) > n * 0.3) continue;
      const i = (y * n + xx) * 4;
      if (Math.max(d[i], d[i + 1], d[i + 2]) < 26) { sx += xx; sy += y; cnt++; }
    }
  }
  const kx = canvas.width / n, ky = canvas.height / n;
  if (cnt < 40) return { x: canvas.width / 2, y: canvas.height / 2, r: Math.min(canvas.width, canvas.height) * 0.1, found: false };
  return { x: (sx / cnt + 0.5) * kx, y: (sy / cnt + 0.5) * ky, r: Math.sqrt(cnt * kx * ky / Math.PI) * 1.15, found: true };
}

// --- Сужение зрачка ---------------------------------------------------------
// Текстура радужки стягивается к центру зрачка, затем поверх ставится чёрный
// круг стандартного размера с мягким краем. Меняет base на месте.
// Возвращает прямоугольник, который затронут (для отмены).

export function pupilRect(base, pupil) {
  const R = base.width / 2;
  const zone = Math.min(R * 0.97, Math.max(R * 0.62, pupil.r * 1.5));
  const x0 = Math.max(0, Math.floor(pupil.x - zone - 2)), y0 = Math.max(0, Math.floor(pupil.y - zone - 2));
  const x1 = Math.min(base.width, Math.ceil(pupil.x + zone + 2)), y1 = Math.min(base.height, Math.ceil(pupil.y + zone + 2));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, zone };
}

export function shrinkPupil(base, pupil) {
  const R = base.width / 2;
  const target = R * PUPIL_RATIO;
  const rect = pupilRect(base, pupil);
  const { zone } = rect;
  const x = ctx2d(base, true);
  const a = target * 0.9; // текстура заходит чуть под чёрный круг
  if (pupil.r > a) {
    const src = x.getImageData(rect.x, rect.y, rect.w, rect.h);
    const dst = x.createImageData(rect.w, rect.h);
    const s = src.data, o = dst.data, W = rect.w, H = rect.h;
    const cx = pupil.x - rect.x, cy = pupil.y - rect.y;
    const m0 = (zone - pupil.r) / (zone - a), span = zone - a;
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const dx = xx - cx, dy = yy - cy, rho = Math.hypot(dx, dy);
        let fx = xx, fy = yy;
        if (rho < zone && rho > 0.001) {
          let sr;
          if (rho <= a) sr = rho * pupil.r / a;
          else {
            // плавная кривая: у края зоны переходит в «ничего не трогать»
            const t = (rho - a) / span, t2 = t * t, t3 = t2 * t;
            sr = (2 * t3 - 3 * t2 + 1) * pupil.r + (t3 - 2 * t2 + t) * m0 * span
              + (-2 * t3 + 3 * t2) * zone + (t3 - t2) * span;
          }
          fx = cx + dx * sr / rho; fy = cy + dy * sr / rho;
        }
        const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
        const tx = Math.max(0, Math.min(1, fx - ix)), ty = Math.max(0, Math.min(1, fy - iy));
        const i00 = (iy * W + ix) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4, oi = (yy * W + xx) * 4;
        for (let c = 0; c < 3; c++) {
          o[oi + c] = (s[i00 + c] * (1 - tx) + s[i10 + c] * tx) * (1 - ty) + (s[i01 + c] * (1 - tx) + s[i11 + c] * tx) * ty;
        }
        o[oi + 3] = 255;
      }
    }
    x.putImageData(dst, rect.x, rect.y);
  }
  const f = Math.max(2, target * 0.1);
  const grad = x.createRadialGradient(pupil.x, pupil.y, Math.max(0, target - f), pupil.x, pupil.y, target + f * 0.5);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = grad;
  x.beginPath();
  x.arc(pupil.x, pupil.y, target + f, 0, Math.PI * 2);
  x.fill();
  return rect;
}

// --- Заплатка нейронкой -----------------------------------------------------
// mask: холст того же размера, что base; непрозрачные пиксели = что убрать.
// bbox: границы закрашенного. run(rgba, mask512) вызывает модель.
// Возвращает прямоугольник, который будет изменён, и функцию применения.

export function patchRegion(base, bbox) {
  const W = base.width, H = base.height;
  const need = Math.max(512, Math.max(bbox.w, bbox.h) * 2.3);
  const side = Math.round(Math.min(need, W, H));
  const cx = bbox.x + bbox.w / 2, cy = bbox.y + bbox.h / 2;
  const x = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const y = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  return { x, y, w: side, h: side };
}

export async function inpaintPatch(base, mask, region, run) {
  const N = 512, side = region.w;
  const small = makeCanvas(N, N);
  const sx = ctx2d(small, true);
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(base, region.x, region.y, side, side, 0, 0, N, N);
  const rgba = sx.getImageData(0, 0, N, N).data;

  const sm = makeCanvas(N, N);
  const mx = ctx2d(sm, true);
  mx.drawImage(mask, region.x, region.y, side, side, 0, 0, N, N);
  const md = mx.getImageData(0, 0, N, N).data;
  const m = new Uint8Array(N * N);
  for (let i = 0; i < m.length; i++) m[i] = md[i * 4 + 3] > 20 ? 255 : 0;

  const out = await run(new Uint8Array(rgba.buffer), m);
  sx.putImageData(new ImageData(new Uint8ClampedArray(out), N, N), 0, 0);

  // Вклеиваем только закрашенное место, край заплатки размыт, чтобы не было шва.
  const patch = makeCanvas(side, side);
  const px = ctx2d(patch);
  px.imageSmoothingQuality = 'high';
  px.drawImage(small, 0, 0, side, side);
  const soft = makeCanvas(side, side);
  const fx = ctx2d(soft);
  fx.filter = `blur(${Math.max(1.5, side / 300)}px)`;
  fx.drawImage(mask, region.x, region.y, side, side, 0, 0, side, side);
  // Размытая маска на краю полупрозрачная, из-за этого просвечивал бы старый блик.
  // Накладываем её саму на себя, чтобы внутри обводки заплатка была плотной.
  for (let i = 0; i < 4; i++) fx.drawImage(soft, 0, 0);
  px.globalCompositeOperation = 'destination-in';
  px.drawImage(soft, 0, 0);
  ctx2d(base, true).drawImage(patch, region.x, region.y);
}

// --- Раскладка на лист ------------------------------------------------------
// Размеры листов в пикселях при 500 точках на дюйм, как в шаблонах студии.

export const DPI = 500;

export const FORMATS = {
  A6: { label: 'А6 (10×15)', w: 2953, h: 1969, iris: 1699,
    whole: { right: { cx: 0.6966, cy: 0.4210, d: 0.6247 }, left: { cx: 0.2943, cy: 0.5838, d: 0.6247 } },
    corners: { right: { cx: 0.7675, cy: 0.2806, d: 0.9309 }, left: { cx: 0.2274, cy: 0.7271, d: 0.9309 } } },
  A5: { label: 'А5', w: 4134, h: 2913, iris: 2512 },
  A4: { label: 'А4', w: 5846, h: 4134, iris: 3632 },
  A3: { label: 'А3', w: 8268, h: 5846, iris: 5248 },
};

const WHOLE = { cx: 0.7132, cy: 0.4185, d: 0.6262 };
const CORNERS = { cx: 0.7719, cy: 0.2873, d: 0.8871 };
const mirror = (s) => ({ cx: 1 - s.cx, cy: 1 - s.cy, d: s.d });

// Возвращает места для глаз: [{cx, cy, d}] в пикселях листа, первый = левый глаз.
export function layoutSlots(formatKey, layout) {
  const f = FORMATS[formatKey];
  if (layout === 'single') return [{ cx: f.w / 2, cy: f.h / 2, d: f.iris }];
  const own = layout === 'whole' ? f.whole : f.corners;
  const right = own ? own.right : (layout === 'whole' ? WHOLE : CORNERS);
  const left = own ? own.left : mirror(right);
  return [left, right].map((s) => ({ cx: s.cx * f.w, cy: s.cy * f.h, d: s.d * f.h }));
}

export function drawLayout(canvas, formatKey, layout, eyes) {
  const f = FORMATS[formatKey];
  const k = canvas.width / f.w;
  const x = ctx2d(canvas);
  x.fillStyle = '#000';
  x.fillRect(0, 0, canvas.width, canvas.height);
  x.imageSmoothingQuality = 'high';
  layoutSlots(formatKey, layout).forEach((s, i) => {
    const eye = eyes[i];
    const d = s.d * k, left = s.cx * k - d / 2, top = s.cy * k - d / 2;
    if (eye) x.drawImage(eye, left, top, d, d);
    else {
      x.strokeStyle = '#3a3a40';
      x.lineWidth = Math.max(1, canvas.width / 600);
      x.setLineDash([canvas.width / 80, canvas.width / 80]);
      x.beginPath();
      x.arc(s.cx * k, s.cy * k, d / 2, 0, Math.PI * 2);
      x.stroke();
      x.setLineDash([]);
    }
  });
}

// Холст сохраняет JPEG без сведений о плотности. Вписываем 500 точек на дюйм,
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
