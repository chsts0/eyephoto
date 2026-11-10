const api = window.eyephoto;
const $ = (id) => document.getElementById(id);

const stage = $('stage');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let image = null; // ImageBitmap открытого снимка
let scale = 1;    // экранных пикселей на пиксель снимка
let ox = 0, oy = 0; // сдвиг снимка в CSS-пикселях

// --- Просмотр ---------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(stage.clientWidth * dpr);
  canvas.height = Math.round(stage.clientHeight * dpr);
  draw();
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return;
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
  ctx.imageSmoothingEnabled = scale < 3; // при сильном увеличении показываем честные пиксели
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0);
  $('zoomFit').textContent = Math.round(scale * 100) + '%';
}

function fit() {
  if (!image) return;
  const pad = 32;
  const w = stage.clientWidth, h = stage.clientHeight;
  scale = Math.min((w - pad * 2) / image.width, (h - pad * 2) / image.height, 1);
  ox = (w - image.width * scale) / 2;
  oy = (h - image.height * scale) / 2;
  draw();
}

function zoomAt(x, y, factor) {
  if (!image) return;
  const next = Math.min(32, Math.max(0.02, scale * factor));
  ox = x - (x - ox) * (next / scale);
  oy = y - (y - oy) * (next / scale);
  scale = next;
  draw();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  if (!image) return;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('panning');
});
canvas.addEventListener('pointermove', (e) => {
  if (!canvas.hasPointerCapture(e.pointerId)) return;
  ox += e.movementX;
  oy += e.movementY;
  draw();
});
canvas.addEventListener('pointerup', (e) => {
  canvas.releasePointerCapture(e.pointerId);
  canvas.classList.remove('panning');
});
canvas.addEventListener('dblclick', fit);

const center = () => [stage.clientWidth / 2, stage.clientHeight / 2];
$('zoomIn').onclick = () => zoomAt(...center(), 1.25);
$('zoomOut').onclick = () => zoomAt(...center(), 1 / 1.25);
$('zoomFit').onclick = fit;
window.addEventListener('resize', resize);

// --- Открытие снимка --------------------------------------------------------

async function show(blob, name) {
  try {
    image = await createImageBitmap(blob);
  } catch {
    $('meta').textContent = 'Не получилось открыть файл. Подойдут JPG и PNG.';
    return;
  }
  $('empty').hidden = true;
  $('zoom').hidden = false;
  $('fileName').textContent = name;
  $('meta').textContent = `${image.width} × ${image.height} px`;
  fit();
}

async function openDialog() {
  const file = await api.openImage();
  if (file) show(new Blob([file.data]), file.name);
}
$('openBtn').onclick = openDialog;
$('openBtn2').onclick = openDialog;

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.code === 'KeyO') { e.preventDefault(); openDialog(); }
  if (e.ctrlKey && e.code === 'Digit0') { e.preventDefault(); fit(); }
});

window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('drag'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file) show(file, file.name);
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
  const retry = { label: 'Проверить ещё раз', run: api.checkUpdate };
  switch (s.state) {
    case 'dev': return setUpdate('', 'Режим разработки, обновления выключены');
    case 'checking': return setUpdate('busy', 'Проверяю обновления');
    case 'latest': return setUpdate('ok', 'Установлена последняя версия', { label: 'Проверить', run: api.checkUpdate });
    case 'downloading': return setUpdate('busy', `Скачиваю обновление${s.percent ? ' ' + s.percent + '%' : ''}`);
    case 'ready': return setUpdate('ok', `Версия ${s.version} скачана и поставится при закрытии.`, { label: 'Перезапустить сейчас', run: api.installUpdate });
    case 'error': return setUpdate('err', 'Не получилось проверить обновления. Нужен интернет.', retry);
  }
});

api.version().then((v) => { $('version').textContent = 'Версия ' + v; });

resize();
