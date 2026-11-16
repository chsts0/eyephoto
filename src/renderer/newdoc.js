// «Новый документ» со своими размерами, как в фотошопе: ширина, высота, единицы,
// разрешение, ориентация, фон. Размеры проверяются заранее, чтобы не получить
// лист, который не откроется: сторона до 20 000 точек, всего до 200 Мп.

import { el } from './ui.js';

const UNITS = {
  px: { label: 'Пиксели', toPx: (v) => v, fromPx: (v) => v, step: 1, digits: 0 },
  mm: { label: 'Миллиметры', toPx: (v, dpi) => (v / 25.4) * dpi, fromPx: (v, dpi) => (v / dpi) * 25.4, step: 0.1, digits: 1 },
  cm: { label: 'Сантиметры', toPx: (v, dpi) => (v / 2.54) * dpi, fromPx: (v, dpi) => (v / dpi) * 2.54, step: 0.01, digits: 2 },
  in: { label: 'Дюймы', toPx: (v, dpi) => v * dpi, fromPx: (v, dpi) => v / dpi, step: 0.01, digits: 2 },
};
const MAX_SIDE = 20000, MAX_AREA = 200e6, MIN_SIDE = 16;

// presets: [{ id, label, w, h, dpi }]; last: прошлые настройки или null.
// Возвращает { name, w, h, dpi, background } или null, если отменили.
export function newDocDialog({ presets, last, defaultName }) {
  return new Promise((resolve) => {
    const st = { unit: 'cm', dpi: 500, bg: 'black', w: presets[0].w, h: presets[0].h, preset: presets[0].id, ...(last || {}) };
    const over = el('div', 'modal nd');
    const box = el('div', 'modal-box nd-box');
    over.appendChild(box);
    box.innerHTML = `
      <h2>Свой размер</h2>
      <div class="nd-grid">
        <label class="nd-row nd-wide"><span>Название</span><input class="nd-in" id="ndName" maxlength="60"></label>
        <label class="nd-row nd-wide"><span>Набор</span><select class="nd-in" id="ndPreset"></select></label>
        <label class="nd-row"><span>Ширина</span><input class="nd-in" id="ndW" type="number" min="0"></label>
        <label class="nd-row"><span>Высота</span><input class="nd-in" id="ndH" type="number" min="0"></label>
        <label class="nd-row"><span>Единицы</span><select class="nd-in" id="ndUnit"></select></label>
        <div class="nd-row"><span>Ориентация</span><div class="seg nd-seg" id="ndOrient"><button data-o="p" title="Книжная">▯</button><button data-o="l" title="Альбомная">▭</button></div></div>
        <label class="nd-row"><span>Разрешение, точек на дюйм</span><input class="nd-in" id="ndDpi" type="number" min="72" max="2400"></label>
        <div class="nd-row nd-wide"><span>Фон</span><div class="seg nd-seg" id="ndBg"><button data-b="black">Чёрный</button><button data-b="white">Белый</button><button data-b="none">Прозрачный</button></div></div>
      </div>
      <div class="nd-sum" id="ndSum"></div>
      <div class="modal-actions"><button class="btn" id="ndCancel">Отмена</button><button class="btn primary" id="ndOk">Создать</button></div>`;
    document.body.appendChild(over);
    const $ = (id) => box.querySelector('#' + id);
    const name = $('ndName'), pre = $('ndPreset'), W = $('ndW'), H = $('ndH'), unit = $('ndUnit'), dpi = $('ndDpi');
    name.value = defaultName;
    for (const p of [...presets, { id: 'custom', label: 'Свой' }]) { const o = el('option', '', p.label); o.value = p.id; pre.appendChild(o); }
    for (const [k, u] of Object.entries(UNITS)) { const o = el('option', '', u.label); o.value = k; unit.appendChild(o); }

    const fmt = (px) => { const u = UNITS[st.unit]; return Number(u.fromPx(px, st.dpi).toFixed(u.digits)); };
    const show = () => {
      pre.value = st.preset; unit.value = st.unit; dpi.value = st.dpi;
      W.value = fmt(st.w); H.value = fmt(st.h);
      W.step = H.step = UNITS[st.unit].step;
      box.querySelectorAll('#ndOrient button').forEach((b) => b.classList.toggle('on', (b.dataset.o === 'l') === (st.w >= st.h)));
      box.querySelectorAll('#ndBg button').forEach((b) => b.classList.toggle('on', b.dataset.b === st.bg));
      check();
    };
    const check = () => {
      const w = Math.round(st.w), h = Math.round(st.h);
      let err = '';
      if (!(w >= MIN_SIDE && h >= MIN_SIDE)) err = `Слишком маленький: меньше ${MIN_SIDE} точек по стороне`;
      else if (w > MAX_SIDE || h > MAX_SIDE) err = `Слишком большой: больше ${MAX_SIDE.toLocaleString('ru')} точек по стороне`;
      else if (w * h > MAX_AREA) err = 'Слишком большой: больше 200 мегапикселей';
      const cm = (px) => ((px / st.dpi) * 2.54).toFixed(1).replace('.', ',');
      $('ndSum').textContent = err || `${w} × ${h} px · ${cm(w)} × ${cm(h)} см · ${((w * h) / 1e6).toFixed(1).replace('.', ',')} Мп`;
      $('ndSum').classList.toggle('err', !!err);
      $('ndOk').disabled = !!err;
      return !err;
    };
    const num = (inp) => { const v = parseFloat(String(inp.value).replace(',', '.')); return Number.isFinite(v) ? v : 0; };

    pre.onchange = () => {
      const p = presets.find((q) => q.id === pre.value);
      st.preset = pre.value;
      if (p) { st.w = p.w; st.h = p.h; st.dpi = p.dpi; }
      show();
    };
    W.oninput = () => { st.w = UNITS[st.unit].toPx(num(W), st.dpi); st.preset = 'custom'; pre.value = 'custom'; check(); show2(); };
    H.oninput = () => { st.h = UNITS[st.unit].toPx(num(H), st.dpi); st.preset = 'custom'; pre.value = 'custom'; check(); show2(); };
    const show2 = () => box.querySelectorAll('#ndOrient button').forEach((b) => b.classList.toggle('on', (b.dataset.o === 'l') === (st.w >= st.h)));
    unit.onchange = () => { st.unit = unit.value; show(); };
    // смена разрешения как в фотошопе: в пикселях размер тот же, в сантиметрах тот же размер на бумаге
    dpi.onchange = () => {
      const v = Math.max(72, Math.min(2400, Math.round(num(dpi)) || 300));
      if (st.unit !== 'px') { st.w = (st.w / st.dpi) * v; st.h = (st.h / st.dpi) * v; }
      st.dpi = v; st.preset = 'custom'; show();
    };
    box.querySelectorAll('#ndOrient button').forEach((b) => (b.onclick = () => {
      const land = b.dataset.o === 'l';
      if ((st.w >= st.h) !== land) { const t = st.w; st.w = st.h; st.h = t; }
      show();
    }));
    box.querySelectorAll('#ndBg button').forEach((b) => (b.onclick = () => { st.bg = b.dataset.b; show(); }));

    const done = (v) => { over.remove(); window.removeEventListener('keydown', key, true); resolve(v); };
    const ok = () => {
      if (!check()) return;
      done({ name: name.value.trim() || defaultName, w: Math.round(st.w), h: Math.round(st.h), dpi: st.dpi, background: st.bg, saved: { unit: st.unit, dpi: st.dpi, bg: st.bg, w: Math.round(st.w), h: Math.round(st.h), preset: st.preset } });
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.stopPropagation(); e.preventDefault(); ok(); }
    };
    window.addEventListener('keydown', key, true);
    $('ndCancel').onclick = () => done(null);
    $('ndOk').onclick = ok;
    over.addEventListener('pointerdown', (e) => { if (e.target === over) done(null); });
    show();
    W.focus(); W.select();
  });
}
