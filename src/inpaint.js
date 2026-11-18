// Локальная нейронка для ретуши (LaMa). Работает без интернета и без оплаты.
// Файл модели большой, поэтому в установщик не входит: скачивается один раз
// в папку пользователя и дальше лежит там между обновлениями.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { net } = require('electron');

const SIZE = 512;
// Две модели: стандартная LaMa и студийная — она же, дообученная на глазах студии.
const MODELS = {
  standard: {
    file: 'lama_fp32.onnx', bytes: 208044816,
    urls: [
      'https://github.com/chsts0/eyephoto/releases/download/models-v1/lama_fp32.onnx',
      'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
    ],
  },
  studio: {
    file: 'eyes_lama.onnx', bytes: 206031121,
    urls: ['https://github.com/chsts0/eyephoto/releases/download/models-v2/eyes_lama.onnx'],
  },
};
let current = 'studio';

let session = null;
const downloading = {};

const modelPath = (userData, name = current) =>
  process.env.EYEPHOTO_MODEL || path.join(userData, 'models', MODELS[name].file);

async function has(userData, name = current) {
  try {
    const st = await fsp.stat(modelPath(userData, name));
    return st.size === MODELS[name].bytes || !!process.env.EYEPHOTO_MODEL;
  } catch {
    return false;
  }
}

async function status(userData) {
  return { ready: await has(userData), model: current };
}

function setModel(name) {
  if (!MODELS[name] || name === current) return;
  current = name;
  session = null;
}
const getModel = () => current;

async function fetchTo(url, file, onProgress, bytes) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || bytes;
  const out = fs.createWriteStream(file);
  let got = 0, last = -1;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const pct = Math.floor((got / total) * 100);
      if (pct !== last) { last = pct; onProgress(pct); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (got !== bytes) throw new Error('файл скачался не полностью');
}

function download(userData, onProgress, name = current) {
  if (downloading[name]) return downloading[name];
  const m = MODELS[name];
  downloading[name] = (async () => {
    const file = modelPath(userData, name);
    const tmp = file + '.part';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let lastError;
    for (const url of m.urls) {
      try {
        await fetchTo(url, tmp, onProgress, m.bytes);
        await fsp.rename(tmp, file);
        return { ok: true };
      } catch (e) {
        lastError = e;
        await fsp.rm(tmp, { force: true });
      }
    }
    return { ok: false, message: String(lastError && lastError.message) };
  })().finally(() => { delete downloading[name]; });
  return downloading[name];
}

// На винде пробуем видеокарту (DirectML): на игровых ноутах это в разы быстрее.
// Не завелась или выдала ерунду, переходим на процессор и больше её не трогаем.
let onGpu = false, gpuFailed = false;

async function getSession(userData) {
  if (!session) {
    const ort = require('onnxruntime-node');
    if (process.platform === 'win32' && !gpuFailed && !process.env.EYEPHOTO_CPU) {
      try {
        session = await ort.InferenceSession.create(modelPath(userData), {
          executionProviders: ['dml'], enableMemPattern: false, executionMode: 'sequential',
        });
        onGpu = true;
      } catch (e) {
        console.error('Видеокарта для нейронки не завелась, считаю на процессоре:', e.message);
        gpuFailed = true;
      }
    }
    if (!session) {
      session = await ort.InferenceSession.create(modelPath(userData), { executionProviders: ['cpu'] });
      onGpu = false;
    }
  }
  return session;
}

function fallBackToCpu(reason) {
  console.error('Нейронка на видеокарте:', reason, '— перехожу на процессор');
  gpuFailed = true;
  session = null;
}

// rgba: Uint8Array 512*512*4, mask: Uint8Array 512*512 (0 или 255).
// Возвращает RGBA 512*512 с дорисованной областью.
async function run(userData, rgba, mask) {
  try {
    const out = await runOnce(userData, rgba, mask);
    if (onGpu && !looksSane(out, rgba)) { fallBackToCpu('ответ похож на ошибку'); return runOnce(userData, rgba, mask); }
    return out;
  } catch (e) {
    if (!onGpu) throw e;
    fallBackToCpu(e.message);
    return runOnce(userData, rgba, mask);
  }
}

// Проверка ответа: не пустой и по средней яркости близок к входу.
function looksSane(out, rgba) {
  let a = 0, b = 0, n = 0;
  for (let i = 0; i < out.length; i += 4 * 97) { a += out[i] + out[i + 1] + out[i + 2]; b += rgba[i] + rgba[i + 1] + rgba[i + 2]; n++; }
  return n > 0 && Number.isFinite(a) && Math.abs(a - b) / n < 90;
}

async function runOnce(userData, rgba, mask) {
  const ort = require('onnxruntime-node');
  const s = await getSession(userData);
  const n = SIZE * SIZE;
  const img = new Float32Array(n * 3);
  const msk = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    img[i] = rgba[i * 4] / 255;
    img[n + i] = rgba[i * 4 + 1] / 255;
    img[2 * n + i] = rgba[i * 4 + 2] / 255;
    msk[i] = mask[i] > 0 ? 1 : 0;
  }
  const out = await s.run({
    image: new ort.Tensor('float32', img, [1, 3, SIZE, SIZE]),
    mask: new ort.Tensor('float32', msk, [1, 1, SIZE, SIZE]),
  });
  const o = out[Object.keys(out)[0]].data;
  // Разные сборки модели отдают 0..1 или 0..255, приводим к 0..255.
  let max = 0;
  for (let i = 0; i < o.length; i += 97) if (o[i] > max) max = o[i];
  const k = max <= 1.5 ? 255 : 1;
  const res = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    res[i * 4] = Math.max(0, Math.min(255, o[i] * k));
    res[i * 4 + 1] = Math.max(0, Math.min(255, o[n + i] * k));
    res[i * 4 + 2] = Math.max(0, Math.min(255, o[2 * n + i] * k));
    res[i * 4 + 3] = 255;
  }
  return res;
}

// Модель грузится в память около 10 секунд. Делаем это заранее в фоне,
// чтобы первая же заплатка не заставляла ждать.
async function warm(userData) {
  try {
    if ((await status(userData)).ready) await getSession(userData);
  } catch (e) {
    console.error('Не удалось загрузить нейронку:', e);
  }
}

// «Считать на процессоре» из настроек: видеокарту больше не трогаем
function setCpu(on) {
  if (on && !gpuFailed) { gpuFailed = true; session = null; }
  if (!on && gpuFailed && !process.env.EYEPHOTO_CPU) { gpuFailed = false; session = null; }
}

async function remove(userData) {
  session = null;
  await fsp.rm(modelPath(userData), { force: true });
}

module.exports = { status, has, download, run, warm, setCpu, remove, setModel, getModel, SIZE };
