// Вся работа с пикселями: проявка, резкость, сужение зрачка, заплатки нейронкой,
// размеры листов и раскладки студии.

export const DEFAULT_ADJUST = { temp: -20, tint: 0, exp: 0, contrast: 20, sat: 25, detail: 100 };
export const NEUTRAL_ADJUST = { temp: 0, tint: 0, exp: 0, contrast: 0, sat: 0, detail: 0 };

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
const FINE_PX = 3, COARSE_PX = 12.5, A_FINE = 1.6, A_COARSE = 1.4;

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

// --- Поиск зрачка (стартовая подсказка, круг всегда двигается руками) --------

export function guessPupil(canvas) {
  const n = 160;
  const c = makeCanvas(n, n);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(canvas, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data;
  let sx = 0, sy = 0, cnt = 0;
  for (let y = 0; y < n; y++) {
    for (let xx = 0; xx < n; xx++) {
      if (Math.hypot(xx - n / 2, y - n / 2) > n * 0.3) continue;
      const i = (y * n + xx) * 4;
      if (d[i + 3] > 200 && Math.max(d[i], d[i + 1], d[i + 2]) < 26) { sx += xx; sy += y; cnt++; }
    }
  }
  const kx = canvas.width / n, ky = canvas.height / n, m = Math.min(canvas.width, canvas.height);
  if (cnt < 40) return { x: canvas.width / 2, y: canvas.height / 2, r: m * 0.1, found: false };
  return { x: (sx / cnt + 0.5) * kx, y: (sy / cnt + 0.5) * ky, r: Math.sqrt(cnt * kx * ky / Math.PI) * 1.15, found: true };
}

// --- Сужение зрачка ---------------------------------------------------------
// Текстура радужки стягивается к центру зрачка, затем поверх ставится чёрный
// круг нужного размера с мягким краем. Меняет холст на месте.
// R — радиус радужки, ratio — какую долю от него должен занять зрачок.

export function pupilRect(canvas, pupil, R) {
  const zone = Math.min(R * 0.97, Math.max(R * 0.62, pupil.r * 1.5));
  const x0 = Math.max(0, Math.floor(pupil.x - zone - 2)), y0 = Math.max(0, Math.floor(pupil.y - zone - 2));
  const x1 = Math.min(canvas.width, Math.ceil(pupil.x + zone + 2)), y1 = Math.min(canvas.height, Math.ceil(pupil.y + zone + 2));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, zone };
}

export function shrinkPupil(canvas, pupil, R, ratio = PUPIL_RATIO) {
  const target = R * ratio;
  const rect = pupilRect(canvas, pupil, R);
  const { zone } = rect;
  const x = canvas.getContext('2d');
  const a = target * 0.9; // текстура заходит чуть под чёрный круг
  if (pupil.r > a && rect.w > 2 && rect.h > 2) {
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
        for (let c = 0; c < 4; c++) {
          o[oi + c] = (s[i00 + c] * (1 - tx) + s[i10 + c] * tx) * (1 - ty) + (s[i01 + c] * (1 - tx) + s[i11 + c] * tx) * ty;
        }
      }
    }
    x.putImageData(dst, rect.x, rect.y);
  }
  const f = Math.max(2, target * 0.1);
  const grad = x.createRadialGradient(pupil.x, pupil.y, Math.max(0, target - f), pupil.x, pupil.y, target + f * 0.5);
  grad.addColorStop(0, '#000');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  x.save();
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = grad;
  x.beginPath();
  x.arc(pupil.x, pupil.y, target + f, 0, Math.PI * 2);
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
