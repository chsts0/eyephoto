// Кнопка «?» в правом нижнем углу: обновления, настройки, помощник,
// что нового и обратная связь. Плюс окно «Что нового» после обновления.

import * as ui from './ui.js';
import { CHANGES, GENERIC, since } from './changelog.js';

const api = window.eyephoto;

function overlay(cls) {
  const o = ui.el('div', 'hp-overlay ' + (cls || ''));
  document.body.appendChild(o);
  const close = () => { o.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', esc, true);
  o.addEventListener('mousedown', (e) => { if (e.target === o) close(); });
  return { o, close };
}

// --- Что нового -------------------------------------------------------------

export function whatsNew(version, prev) {
  let list = prev ? since(prev, version) : CHANGES.filter((c) => c.version === version);
  if (!list.length) list = [{ version, ...GENERIC }];
  const { o, close } = overlay();
  const box = ui.el('div', 'hp-box hp-news');
  box.appendChild(ui.el('div', 'hp-kicker', 'Что нового'));
  for (const c of list.slice(0, 3)) {
    const sec = ui.el('section', 'hp-ver');
    const h = ui.el('h2', '', c.title);
    h.appendChild(ui.el('span', 'hp-vnum', c.version));
    sec.appendChild(h);
    const ul = ui.el('ul');
    for (const it of c.items) ul.appendChild(ui.el('li', '', it));
    sec.appendChild(ul);
    box.appendChild(sec);
  }
  const act = ui.el('div', 'hp-actions');
  const ok = ui.el('button', 'btn primary', 'Понятно');
  ok.onclick = close;
  act.appendChild(ok);
  box.appendChild(act);
  o.appendChild(box);
  ok.focus();
}

// После обновления показываем один раз. При самой первой установке не показываем.
export async function showNewsIfUpdated() {
  const [version, s] = await Promise.all([api.version(), api.settings()]);
  const prev = s.lastVersion;
  if (prev !== version) api.setSettings({ lastVersion: version });
  if (prev && prev !== version) whatsNew(version, prev);
}

// --- Обратная связь ---------------------------------------------------------

const KINDS = [['bug', 'Ошибка'], ['idea', 'Идея'], ['other', 'Другое']];

export function feedback() {
  const { o, close } = overlay();
  const box = ui.el('div', 'hp-box hp-fb');
  box.appendChild(ui.el('h2', '', 'Обратная связь'));
  box.appendChild(ui.el('p', 'hp-sub', 'Напишите как есть: что делали и что пошло не так, или чего не хватает. Версия программы и компьютер подставятся сами.'));
  let kind = 'bug';
  const seg = ui.el('div', 'hp-seg');
  for (const [k, label] of KINDS) {
    const b = ui.el('button', k === kind ? 'on' : '', label);
    b.onclick = () => { kind = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    seg.appendChild(b);
  }
  box.appendChild(seg);
  const text = ui.el('textarea', 'hp-text');
  text.placeholder = 'Например: при сохранении в шаблон «Полароид» глаза съезжают вправо';
  text.maxLength = 4000;
  box.appendChild(text);
  const who = ui.el('input', 'hp-who');
  who.placeholder = 'Как вас зовут (можно не писать)';
  who.maxLength = 80;
  api.settings().then((s) => { if (s.feedbackName) who.value = s.feedbackName; });
  box.appendChild(who);
  const err = ui.el('div', 'hp-err');
  box.appendChild(err);
  const act = ui.el('div', 'hp-actions');
  const cancel = ui.el('button', 'btn', 'Отмена');
  cancel.onclick = close;
  const send = ui.el('button', 'btn primary', 'Отправить');
  send.onclick = async () => {
    const msg = text.value.trim();
    if (msg.length < 3) { err.textContent = 'Напишите хотя бы пару слов'; text.focus(); return; }
    send.disabled = true; send.textContent = 'Отправляю…';
    const name = who.value.trim();
    api.setSettings({ feedbackName: name });
    const r = await api.sendFeedback({ kind: KINDS.find((k) => k[0] === kind)[1], text: msg, name });
    close();
    ui.toast(r && r.sent ? 'Спасибо! Сообщение отправлено' : 'Спасибо! Сообщение сохранено и уйдёт, когда появится интернет');
  };
  act.append(cancel, send);
  box.appendChild(act);
  o.appendChild(box);
  text.focus();
}

// --- Кнопка «?» -------------------------------------------------------------

export function initHelp({ settings, assistant }) {
  const btn = ui.el('button', 'hp-btn', '?');
  btn.title = 'Помощь, обновления и обратная связь';
  (document.querySelector('.status-right') || document.body).appendChild(btn);
  let menu = null;
  const hide = () => { if (menu) { menu.remove(); menu = null; btn.classList.remove('on'); } };
  const item = (label, note, run) => {
    const b = ui.el('button', 'hp-item');
    b.appendChild(ui.el('span', '', label));
    if (note) b.appendChild(ui.el('span', 'hp-note', note));
    b.onclick = () => { hide(); run(); };
    return b;
  };
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (menu) { hide(); return; }
    menu = ui.el('div', 'hp-menu');
    menu.append(
      item('Спросить помощника', 'F1', assistant),
      item('Настройки', api.platform === 'darwin' ? '⌘K' : 'Ctrl+K', settings),
      item('Проверить обновления', '', async () => { ui.toast('Проверяю обновления…'); await api.checkUpdate(); }),
      item('Что нового', '', async () => whatsNew(await api.version())),
      ui.el('div', 'hp-sep'),
      item('Обратная связь', 'ошибка или идея', feedback),
    );
    const ver = ui.el('div', 'hp-ver-line');
    api.version().then((v) => { ver.textContent = 'EyePhoto ' + v; });
    menu.appendChild(ver);
    document.body.appendChild(menu);
    btn.classList.add('on');
  };
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && e.target !== btn) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
