// Окно «Настройки», как в фотошопе: разделы слева, справа настройки раздела,
// сверху поиск по всем настройкам сразу. Последний раздел — помощник по программе.
// Схема настроек приходит из app.js: { id, title, items: [...] }.
// Пункт: { label, hint?, words?, type: 'toggle'|'select'|'number'|'button'|'info', options?, min?, max?, step?, unit?, get(), set(v) }.

import { el, icon } from './ui.js';

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');

export function openSettings(schema, { start, assistant } = {}) {
  const over = el('div', 'modal st');
  const box = el('div', 'st-box');
  over.appendChild(box);
  box.innerHTML = `
    <aside class="st-nav"><div class="st-search"><input id="stQ" placeholder="Поиск по настройкам" spellcheck="false"></div><nav id="stNav"></nav></aside>
    <section class="st-main"><header class="st-head"><h2 id="stTitle"></h2><button class="st-close" id="stClose" title="Закрыть (Esc)">${icon('close')}</button></header><div class="st-body" id="stBody"></div></section>`;
  document.body.appendChild(over);
  const $ = (id) => box.querySelector('#' + id);
  const all = [...schema, { id: 'assistant', title: 'Помощник', items: [], custom: assistant }];
  let cur = start || all[0].id;

  const row = (it) => {
    const r = el('div', 'st-row');
    const text = el('div', 'st-text');
    text.appendChild(el('div', 'st-label', it.label));
    if (it.hint) text.appendChild(el('div', 'st-hint', it.hint));
    r.appendChild(text);
    const ctl = el('div', 'st-ctl');
    if (it.type === 'toggle') {
      const sw = el('button', 'st-switch' + (it.get() ? ' on' : ''));
      sw.onclick = async () => { await it.set(!it.get()); sw.classList.toggle('on', !!it.get()); };
      ctl.appendChild(sw);
    } else if (it.type === 'select') {
      const s = el('select', 'st-in');
      for (const [v, t] of it.options) { const o = el('option', '', t); o.value = String(v); s.appendChild(o); }
      s.value = String(it.get());
      s.onchange = () => { const o = it.options.find(([v]) => String(v) === s.value); it.set(o ? o[0] : s.value); };
      ctl.appendChild(s);
    } else if (it.type === 'number') {
      const i = el('input', 'st-in st-num');
      i.type = 'number'; i.min = it.min; i.max = it.max; i.step = it.step || 1; i.value = it.get();
      i.onchange = () => { const v = Math.max(it.min, Math.min(it.max, Number(i.value) || it.min)); i.value = v; it.set(v); };
      ctl.appendChild(i);
      if (it.unit) ctl.appendChild(el('span', 'st-unit', it.unit));
    } else if (it.type === 'button') {
      const b = el('button', 'btn', it.button);
      b.onclick = async () => { b.disabled = true; try { await it.run(b); } finally { b.disabled = false; } if (it.after) render(); };
      ctl.appendChild(b);
    } else if (it.type === 'info') {
      const v = el('div', 'st-info'); v.textContent = '…';
      Promise.resolve(it.get()).then((t) => { v.textContent = t; });
      ctl.appendChild(v);
    }
    r.appendChild(ctl);
    return r;
  };

  const render = () => {
    const q = norm($('stQ').value.trim());
    const nav = $('stNav'), body = $('stBody');
    nav.textContent = ''; body.textContent = '';
    if (q) {
      // поиск: показываем все совпавшие настройки с названием раздела
      $('stTitle').textContent = 'Найдено';
      let n = 0;
      for (const sec of all) {
        const hits = sec.items.filter((it) => norm(`${it.label} ${it.hint || ''} ${it.words || ''} ${sec.title}`).includes(q));
        if (!hits.length) continue;
        body.appendChild(el('div', 'st-group', sec.title));
        for (const it of hits) body.appendChild(row(it));
        n += hits.length;
      }
      if (!n) {
        body.appendChild(el('div', 'st-empty', 'Ничего не нашлось.'));
        const b = el('button', 'btn', 'Спросить помощника');
        b.onclick = () => { const text = $('stQ').value; $('stQ').value = ''; cur = 'assistant'; render(); setTimeout(() => assistant && assistant.ask && assistant.ask(text), 0); };
        body.appendChild(b);
      }
    }
    for (const sec of all) {
      const b = el('button', 'st-tab' + (!q && sec.id === cur ? ' on' : ''), sec.title);
      b.onclick = () => { $('stQ').value = ''; cur = sec.id; render(); };
      nav.appendChild(b);
    }
    if (q) return;
    const sec = all.find((s) => s.id === cur);
    $('stTitle').textContent = sec.title;
    if (sec.custom) { sec.custom.render(body); return; }
    for (const it of sec.items) {
      if (it.group) { body.appendChild(el('div', 'st-group', it.group)); continue; }
      body.appendChild(row(it));
    }
  };

  const close = () => { over.remove(); window.removeEventListener('keydown', key, true); };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') e.stopPropagation();
  };
  window.addEventListener('keydown', key, true);
  $('stClose').onclick = close;
  over.addEventListener('pointerdown', (e) => { if (e.target === over) close(); });
  $('stQ').oninput = render;
  render();
  if (cur !== 'assistant') $('stQ').focus();
  return { close, show: (id) => { cur = id; render(); } };
}

// Помощник: чат по программе. api — методы из preload.
export function assistantPanel(api) {
  const msgs = []; // { who: 'me'|'bot', text }
  let body = null, list = null, input = null, sending = false, seq = 0, live = null;
  api.onAssistantChunk(({ id, t }) => { if (live && live.id === id) { live.msg.text += t; live.node.textContent = live.msg.text; list.scrollTop = list.scrollHeight; } });

  const panel = {
    async render(root) {
      body = root;
      const st = await api.assistantStatus();
      root.textContent = '';
      if (!st.ready) {
        const w = el('div', 'as-get');
        w.appendChild(el('p', '', 'Помощник отвечает на вопросы по программе: где что лежит, как сделать, что делать, если не работает. Работает на этом компьютере, без интернета и бесплатно.'));
        w.appendChild(el('p', 'st-hint', `Нужно один раз скачать файл ${(st.bytes / 1e9).toFixed(1).replace('.', ',')} ГБ.`));
        const b = el('button', 'btn primary', 'Скачать помощника');
        const bar = el('div', 'as-bar'); bar.hidden = true; const fill = el('i'); bar.appendChild(fill);
        const err = el('p', 'modal-error');
        b.onclick = async () => {
          b.disabled = true; bar.hidden = false; err.textContent = '';
          api.onAssistantProgress((p) => { fill.style.width = p + '%'; b.textContent = `Скачиваю ${p}%`; });
          const r = await api.assistantDownload();
          if (r.ok) panel.render(root);
          else { b.disabled = false; b.textContent = 'Скачать ещё раз'; err.textContent = 'Не получилось скачать. Проверьте интернет.'; }
        };
        w.append(b, bar, err);
        root.appendChild(w);
        return;
      }
      list = el('div', 'as-list');
      if (!msgs.length) list.appendChild(el('div', 'as-hello', 'Спросите что угодно про программу. Например: «как убрать блик», «где поменять номер точки», «почему не сохраняется».'));
      for (const m of msgs) list.appendChild(el('div', 'as-msg ' + m.who, null)).textContent = m.text;
      const form = el('div', 'as-form');
      input = el('textarea', 'st-in as-in');
      input.rows = 2; input.placeholder = 'Ваш вопрос… (Enter — отправить)';
      input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); panel.ask(input.value); } };
      const send = el('button', 'btn primary', 'Спросить');
      send.onclick = () => panel.ask(input.value);
      const fresh = el('button', 'btn', 'Новый разговор');
      fresh.onclick = async () => { msgs.length = 0; await api.assistantReset(); panel.render(root); };
      form.append(input, el('div', 'as-btns')); form.lastChild.append(fresh, send);
      root.append(list, form);
      list.scrollTop = list.scrollHeight;
      input.focus();
    },
    async ask(text) {
      text = (text || '').trim();
      if (!text || sending || !body) return;
      sending = true;
      if (input) input.value = '';
      msgs.push({ who: 'me', text });
      const bot = { who: 'bot', text: '' };
      msgs.push(bot);
      await panel.render(body);
      const nodes = list.querySelectorAll('.as-msg.bot');
      const node = nodes[nodes.length - 1];
      node.classList.add('wait');
      const id = ++seq;
      live = { id, msg: bot, node };
      const r = await api.assistantAsk(id, text);
      node.classList.remove('wait');
      if (!r.ok) { bot.text = 'Не получилось ответить: ' + r.message; node.textContent = bot.text; }
      else if (!bot.text) { bot.text = r.answer; node.textContent = r.answer; }
      live = null; sending = false;
    },
  };
  return panel;
}
