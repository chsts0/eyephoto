// Мелкие кирпичи интерфейса: значки, меню, окна с вопросами, ползунки.

const $ = (id) => document.getElementById(id);

// Значки нарисованы под сетку 20×20, линия 1.5.
const ICONS = {
  move: '<path d="M5 3.5l9.5 5.6-4 1.2 2.3 4.6-1.8.9-2.3-4.6-3 2.9z"/>',
  marquee: '<ellipse cx="10" cy="10" rx="6.5" ry="6.5" stroke-dasharray="2.6 2.2"/>',
  lasso: '<path d="M10 4C6.1 4 3 5.9 3 8.3s3.1 4.3 7 4.3 7-1.9 7-4.3S13.9 4 10 4z"/><path d="M6.3 12c-1.1.9-1 2.3.2 2.7 1 .3 1.9-.4 1.7-1.3M7.6 14.6l-1 2.9"/>',
  patch: '<path d="M4.8 11.2l6.4-6.4a2.8 2.8 0 0 1 4 4l-6.4 6.4a2.8 2.8 0 0 1-4-4z"/><path d="M7.6 8.4l4 4"/><circle cx="10" cy="10" r=".6" class="f"/>',
  stamp: '<path d="M7.8 3.5h4.4l-.8 5h2.4c.9 0 1.7.8 1.7 1.700V13h-11v-2.800C4.500 9.300 5.300 8.500 6.200 8.500h2.400z"/><path d="M4.500 16.500h11"/>',
  brush: '<path d="M14.700 3.300a1.550 1.550 0 0 1 2.200 2.200l-6.300 6.800-2.700-2.700z"/><path d="M7.300 10.800c-1.800 0-2.900 1.200-2.900 2.800 0 1.200-.6 2-1.400 2.500 3.300.9 6.500-.3 6.500-3.100"/>',
  eraser: '<path d="M11.300 4l5.200 5.200-6.800 6.800H6.300L3.500 13.200z"/><path d="M7.400 7.900l5.200 5.200M9.700 16H17"/>',
  burn: '<circle cx="10" cy="10" r="6.500"/><path d="M10 3.500a6.500 6.500 0 0 0 0 13z" class="f"/>',
  pupil: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.700" class="f"/>',
  hand: '<path d="M7 10.500V5.300a1.100 1.100 0 0 1 2.200 0V9.500m0-4.700V4.200a1.100 1.100 0 0 1 2.200 0v5.300m0-4.200a1.100 1.100 0 0 1 2.200 0v4.700m0-2.700a1.100 1.100 0 0 1 2.200 0V12c0 3.100-2.100 5.500-5.300 5.500-2.200 0-3.500-1-4.600-2.900l-1.900-3.200c-.5-.9.700-1.800 1.500-1L7 12.300"/>',
  zoom: '<circle cx="9" cy="9" r="5"/><path d="M12.700 12.700l4.300 4.300"/>',
  eye: '<path d="M2.500 10s2.800-4.800 7.500-4.800 7.500 4.800 7.500 4.800-2.800 4.800-7.500 4.800S2.500 10 2.500 10z"/><circle cx="10" cy="10" r="2.100"/>',
  lock: '<rect x="5" y="9" width="10" height="7" rx="1.500"/><path d="M7.200 9V7a2.800 2.800 0 0 1 5.600 0v2"/>',
  clip: '<path d="M6 4v7.500h7.500M10.500 8.500l3 3-3 3"/>',
  plus: '<path d="M10 4.500v11M4.500 10h11"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.500"/><path d="M13 7V5.500A1.500 1.500 0 0 0 11.500 4h-6A1.500 1.500 0 0 0 4 5.500v6A1.500 1.500 0 0 0 5.500 13H7"/>',
  trash: '<path d="M4.500 6h11M8 6V4.500h4V6M6 6l.700 9.500h6.600L14 6M8.700 8.800v4.400M11.300 8.800v4.400"/>',
  close: '<path d="M5.500 5.500l9 9M14.500 5.500l-9 9"/>',
  sheet: '<rect x="3.500" y="5" width="13" height="10" rx="1"/>',
  folder: '<path d="M3 6.500A1.500 1.500 0 0 1 4.500 5h3.200l1.600 1.800h6.200A1.500 1.500 0 0 1 17 8.300v5.900a1.500 1.500 0 0 1-1.500 1.500h-11A1.500 1.500 0 0 1 3 14.200z"/>',
  open: '<path d="M10 13V4m0 0L6.500 7.500M10 4l3.500 3.500M4 13v2.500h12V13"/>',
};

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// --- Меню сверху ------------------------------------------------------------
// menus: [{ title, items: [id команды | '-'] }], commands: { id: { label, keys, run, enabled } }

export function menubar(root, menus, commands) {
  let open = null;
  const close = () => {
    if (!open) return;
    open.btn.classList.remove('on');
    open.pop.remove();
    open = null;
  };
  const show = (btn, menu) => {
    close();
    const pop = el('div', 'menu-pop');
    for (const id of menu.items) {
      if (id === '-') { pop.appendChild(el('div', 'menu-sep')); continue; }
      const c = commands[id];
      const item = el('button', 'menu-item');
      item.append(el('span', '', c.label), el('kbd', '', c.keys || ''));
      item.disabled = c.enabled ? !c.enabled() : false;
      item.onclick = () => { close(); c.run(); };
      pop.appendChild(item);
    }
    const r = btn.getBoundingClientRect();
    pop.style.left = r.left + 'px';
    pop.style.top = r.bottom + 'px';
    document.body.appendChild(pop);
    btn.classList.add('on');
    open = { btn, pop };
  };
  for (const menu of menus) {
    const btn = el('button', 'menu-btn', menu.title);
    btn.onclick = (e) => { e.stopPropagation(); open && open.btn === btn ? close() : show(btn, menu); };
    btn.onmouseenter = () => { if (open && open.btn !== btn) show(btn, menu); };
    root.appendChild(btn);
  }
  window.addEventListener('pointerdown', (e) => { if (open && !open.pop.contains(e.target) && !root.contains(e.target)) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('blur', close);
}

// Сочетание клавиш из события в том же виде, в каком оно записано у команд.
const CODES = { Semicolon: ';', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backspace: 'Backspace', Delete: 'Del', Enter: 'Enter', Escape: 'Esc' };
export function combo(e) {
  let key = CODES[e.code];
  if (!key && e.code.startsWith('Key')) key = e.code.slice(3);
  if (!key && e.code.startsWith('Digit')) key = e.code.slice(5);
  if (!key) return '';
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + key;
}

// --- Окна с вопросами -------------------------------------------------------

export function ask({ title, text, ok = 'Да', cancel = 'Отмена', input = null }) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text || '';
  $('modalText').hidden = !text;
  $('modalOk').textContent = ok;
  $('modalOk').hidden = false;
  $('modalCancel').textContent = cancel;
  $('modalCancel').hidden = !cancel;
  $('modalProgress').hidden = true;
  const field = $('modalField'), inp = $('modalInput');
  field.hidden = !input;
  $('modalError').textContent = '';
  if (input) {
    $('modalPrefix').textContent = input.prefix || '';
    inp.value = input.value || '';
    inp.maxLength = input.maxLength || 40;
    inp.placeholder = input.placeholder || '';
    $('modalNote').textContent = input.note || '';
  }
  $('modal').hidden = false;
  (input ? inp : $('modalOk')).focus();
  return new Promise((resolve) => {
    const done = (v) => {
      $('modal').hidden = true;
      inp.onkeydown = inp.oninput = null;
      resolve(v);
    };
    const accept = () => {
      if (!input) return done(true);
      const err = input.validate ? input.validate(inp.value) : '';
      if (err) { $('modalError').textContent = err; inp.focus(); return; }
      done(inp.value);
    };
    $('modalOk').onclick = accept;
    $('modalCancel').onclick = () => done(input ? null : false);
    inp.oninput = () => { if (input && input.filter) inp.value = input.filter(inp.value); $('modalError').textContent = ''; };
    inp.onkeydown = (e) => { if (e.key === 'Enter') accept(); if (e.key === 'Escape') done(null); };
  });
}

export const tell = (title, text) => ask({ title, text, ok: 'Понятно', cancel: '' });

export function progress(title, text) {
  $('modalTitle').textContent = title;
  $('modalText').textContent = text;
  $('modalText').hidden = false;
  $('modalOk').hidden = $('modalCancel').hidden = $('modalField').hidden = true;
  $('modalProgress').hidden = false;
  $('modalProgress').firstElementChild.style.width = '0%';
  $('modal').hidden = false;
  return {
    set: (p) => { $('modalProgress').firstElementChild.style.width = p + '%'; },
    close: () => { $('modal').hidden = true; },
  };
}

// Короткое сообщение внизу рабочей области, само пропадает.
let toastTimer = 0;
export function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// --- Ползунок с числом ------------------------------------------------------
// Двойной щелчок по названию возвращает значение по умолчанию.

export function slider({ label, min, max, step = 1, value, unit = '', reset, onInput, onChange }) {
  const row = el('label', 'sl');
  const name = el('span', 'sl-name', label);
  const num = el('input', 'sl-num');
  num.type = 'text';
  num.inputMode = 'numeric';
  const range = el('input', 'sl-range');
  range.type = 'range';
  range.min = min; range.max = max; range.step = step;
  const paint = () => {
    range.style.setProperty('--p', ((range.value - min) / (max - min)) * 100 + '%');
    num.value = String(range.value).replace('.', ',') + unit;
  };
  const set = (v, fire) => {
    range.value = Math.max(min, Math.min(max, v));
    paint();
    if (fire) { onInput && onInput(Number(range.value)); onChange && onChange(Number(range.value)); }
  };
  range.addEventListener('input', () => { paint(); onInput && onInput(Number(range.value)); });
  range.addEventListener('change', () => onChange && onChange(Number(range.value)));
  num.addEventListener('focus', () => num.select());
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); e.stopPropagation(); });
  num.addEventListener('change', () => {
    const v = parseFloat(num.value.replace(',', '.'));
    if (Number.isFinite(v)) set(v, true); else paint();
  });
  if (reset != null) {
    name.title = 'Двойной щелчок: вернуть как было';
    name.addEventListener('dblclick', (e) => { e.preventDefault(); set(reset, true); });
  }
  row.append(name, num, range);
  row.set = (v) => set(v, false);
  set(value, false);
  return row;
}
