// Помощник по программе: небольшая языковая модель (Qwen2.5 3B) работает прямо
// на компьютере, без интернета и без оплаты. Отвечает по справке программы
// (help-ru.md): к каждому вопросу подкладываем подходящие разделы справки.
// Файл модели около 2 ГБ, скачивается один раз по кнопке.

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { net } = require('electron');

const MODEL_FILE = 'qwen2.5-3b-instruct-q4_k_m.gguf';
const MODEL_BYTES = 2104932768;
// с Hugging Face целиком; запасной путь — наш релиз, файл разрезан на две части
// (на GitHub один файл не больше 2 ГБ)
const SOURCES = [
  ['https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/' + MODEL_FILE],
  ['https://github.com/chsts0/eyephoto/releases/download/models-llm-v1/' + MODEL_FILE + '.part1',
    'https://github.com/chsts0/eyephoto/releases/download/models-llm-v1/' + MODEL_FILE + '.part2'],
];

const modelPath = (userData) => process.env.EYEPHOTO_LLM || path.join(userData, 'models', MODEL_FILE);

async function status(userData) {
  try {
    const st = await fsp.stat(modelPath(userData));
    return { ready: st.size === MODEL_BYTES || !!process.env.EYEPHOTO_LLM, bytes: MODEL_BYTES };
  } catch {
    return { ready: false, bytes: MODEL_BYTES };
  }
}

let downloading = null;
function download(userData, onProgress) {
  if (downloading) return downloading;
  downloading = (async () => {
    const file = modelPath(userData), tmp = file + '.part';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    let lastError;
    for (const urls of SOURCES) {
      try {
        const out = fs.createWriteStream(tmp);
        let got = 0, last = -1;
        try {
          for (const url of urls) {
            const res = await net.fetch(url);
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            for await (const chunk of res.body) {
              got += chunk.length;
              if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
              const pct = Math.floor((got / MODEL_BYTES) * 100);
              if (pct !== last) { last = pct; onProgress(pct); }
            }
          }
        } finally {
          await new Promise((r) => out.end(r));
        }
        if (got !== MODEL_BYTES) throw new Error('файл скачался не полностью');
        await fsp.rename(tmp, file);
        return { ok: true };
      } catch (e) {
        lastError = e;
        await fsp.rm(tmp, { force: true });
      }
    }
    return { ok: false, message: String(lastError && lastError.message) };
  })().finally(() => { downloading = null; });
  return downloading;
}

async function remove(userData) {
  await unload();
  await fsp.rm(modelPath(userData), { force: true });
}

// --- справка: разделы и выбор подходящих к вопросу -----------------------------
let sections = null;
function helpSections() {
  if (sections) return sections;
  const text = fs.readFileSync(path.join(__dirname, 'help-ru.md'), 'utf8');
  sections = text.split(/\n(?=## )/).filter((s) => s.startsWith('## ')).map((s) => ({ text: s.trim(), words: stems(s) }));
  return sections;
}
// грубая «основа слова»: первые 5 букв, этого хватает, чтобы «зрачок» нашёл «зрачка»
function stems(s) {
  return new Set((s.toLowerCase().match(/[a-zа-яё0-9+]+/g) || []).filter((w) => w.length > 2).map((w) => w.slice(0, 5)));
}
function pickSections(question, n = 3) {
  const q = stems(question);
  const scored = helpSections().map((s) => ({ s, score: [...q].filter((w) => s.words.has(w)).length }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score > 0).slice(0, n).map((x) => x.s.text);
  return top.length ? top : [helpSections()[0].text, helpSections()[1].text];
}

const SYSTEM = 'Ты помощник в программе EyePhoto для студии фотографии радужки глаза. '
  + 'Отвечай по-русски, коротко и по делу, простыми словами, как коллега. '
  + 'Опирайся только на справку, которую дают вместе с вопросом. Называй точные кнопки и клавиши из справки. '
  + 'Если в справке ответа нет, честно скажи, что не знаешь, и предложи написать тому, кто настраивал программу. '
  + 'Не выдумывай функции, которых нет в справке.';

// --- модель -----------------------------------------------------------------
// Модель крутит отдельная программа llama-server из llama.cpp (лежит рядом с EyePhoto
// в resources/llama). Отдельный процесс: внутри Electron движок падает, а так,
// даже если помощник споткнётся, программа продолжит работать.
const { spawn } = require('node:child_process');
const netMod = require('node:net');

function serverBin() {
  if (process.env.EYEPHOTO_LLAMA_SERVER) return process.env.EYEPHOTO_LLAMA_SERVER;
  const { app } = require('electron');
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'llama') : path.join(__dirname, '..', 'vendor', 'llama');
  return path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = netMod.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

let proc = null, base = '', starting = null, onDevice = '';
const history = []; // прошлые вопросы и ответы без справки, для «а как ещё»

async function startServer(userData, gpuLayers) {
  const bin = serverBin();
  if (!fs.existsSync(bin)) throw new Error('в этой сборке нет движка помощника');
  const port = await freePort();
  const args = ['-m', modelPath(userData), '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '-ngl', String(gpuLayers), '--no-webui'];
  const p = spawn(bin, args, { cwd: path.dirname(bin), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let log = '';
  p.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  // ждём, пока модель загрузится (до 3 минут на медленном диске)
  while (Date.now() - t0 < 180000) {
    if (p.exitCode != null) throw new Error('движок помощника не запустился: ' + log.split('\n').filter(Boolean).slice(-2).join(' '));
    try { const r = await fetch(url + '/health'); if (r.ok) { proc = p; base = url; onDevice = gpuLayers ? 'gpu' : 'cpu'; return; } } catch { /* ещё грузится */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  p.kill();
  throw new Error('движок помощника слишком долго запускается');
}

async function load(userData) {
  if (proc && proc.exitCode == null) return;
  if (starting) return starting;
  starting = (async () => {
    // сначала с видеокартой (Metal на маке, Vulkan на винде), не вышло — на процессоре
    try { await startServer(userData, 99); } catch { await startServer(userData, 0); }
  })().finally(() => { starting = null; });
  return starting;
}

async function unload() {
  if (proc) { try { proc.kill(); } catch { /* уже закрыт */ } }
  proc = null;
}

let busy = Promise.resolve();
// Вопрос → ответ кусками через onChunk.
function ask(userData, question, onChunk) {
  const run = async () => {
    await load(userData);
    const help = pickSections(question).join('\n\n');
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history.slice(-6),
      { role: 'user', content: `Справка по программе:\n${help}\n\nВопрос: ${question}` },
    ];
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true, max_tokens: 500, temperature: 0.3, cache_prompt: true }),
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    let answer = '', buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const t = JSON.parse(data).choices[0].delta.content;
          if (t) { answer += t; onChunk(t); }
        } catch { /* служебная строка */ }
      }
    }
    history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    return { ok: true, answer, device: onDevice };
  };
  const p = busy.then(run, run);
  busy = p.catch(() => {});
  return p.catch((e) => ({ ok: false, message: String(e && e.message ? e.message : e) }));
}

async function reset() { history.length = 0; }

module.exports = { status, download, remove, ask, reset, unload, pickSections };
