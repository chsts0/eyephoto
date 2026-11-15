// Панели справа как в фотошопе: панель перетаскивается за заголовок выше или ниже,
// двойной щелчок по заголовку сворачивает её, ширина колонки меняется за левый край.
// Всё запоминается. Минимальные размеры такие, чтобы ничего не обрезалось.

export const DOCK_MIN = 280, DOCK_MAX = 520, DOCK_DEFAULT = 300;

export function initDock({ dock, load, save }) {
  const panels = () => [...dock.querySelectorAll(':scope > .panel')];
  const state = { w: DOCK_DEFAULT, order: panels().map((p) => p.id), collapsed: [] };
  const DEFAULT_ORDER = state.order.slice();

  const apply = () => {
    document.body.style.setProperty('--dock-w', state.w + 'px');
    const byId = Object.fromEntries(panels().map((p) => [p.id, p]));
    for (const id of state.order) if (byId[id]) dock.appendChild(byId[id]);
    for (const p of panels()) if (!state.order.includes(p.id)) dock.appendChild(p); // новые панели из обновлений
    dock.appendChild(grip);
    for (const p of panels()) p.classList.toggle('collapsed', state.collapsed.includes(p.id));
  };
  const store = () => save({ w: state.w, order: panels().map((p) => p.id), collapsed: state.collapsed });

  // ширина: левый край колонки
  const grip = document.createElement('div');
  grip.className = 'dock-grip';
  grip.title = 'Ширина панелей';
  dock.appendChild(grip);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = state.w;
    // только ширина: перестановка панелей во время тяги сбила бы захват мыши
    const move = (ev) => { state.w = Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, w0 + x0 - ev.clientX))); document.body.style.setProperty('--dock-w', state.w + 'px'); window.dispatchEvent(new Event('resize')); };
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); store(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => { state.w = DOCK_DEFAULT; apply(); store(); window.dispatchEvent(new Event('resize')); });

  // перетаскивание за заголовок
  const line = document.createElement('div');
  line.className = 'dock-drop';
  for (const p of panels()) {
    const head = p.querySelector(':scope > header') || p;
    head.classList.add('dock-handle');
    if (head !== p) head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select')) return;
      const i = state.collapsed.indexOf(p.id);
      if (i >= 0) state.collapsed.splice(i, 1); else state.collapsed.push(p.id);
      apply(); store();
    });
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('input, select, .eye-chip')) return;
      const y0 = e.clientY;
      let dragging = false, at = -1;
      const move = (ev) => {
        if (!dragging) {
          if (Math.abs(ev.clientY - y0) < 6) return;
          dragging = true;
          p.classList.add('dragging');
          document.body.classList.add('dock-dragging');
          dock.appendChild(line);
        }
        const others = panels().filter((q) => q !== p && !q.hidden);
        at = others.findIndex((q) => { const r = q.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (at < 0) at = others.length;
        const ref = others[at], last = others[others.length - 1];
        const dr = dock.getBoundingClientRect();
        const y = ref ? ref.getBoundingClientRect().top - 3 : last.getBoundingClientRect().bottom + 3;
        line.style.top = (y - dr.top + dock.scrollTop) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (!dragging) return;
        p.classList.remove('dragging');
        document.body.classList.remove('dock-dragging');
        line.remove();
        const others = panels().filter((q) => q !== p && !q.hidden);
        const ref = others[at];
        if (ref) dock.insertBefore(p, ref); else if (others.length) others[others.length - 1].after(p);
        dock.appendChild(grip);
        state.order = panels().map((q) => q.id);
        store();
        // щелчок после перетаскивания не должен нажать вкладку или кнопку в заголовке
        window.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  const saved = load();
  if (saved) {
    if (typeof saved.w === 'number') state.w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, saved.w));
    if (Array.isArray(saved.order)) state.order = saved.order;
    if (Array.isArray(saved.collapsed)) state.collapsed = saved.collapsed;
  }
  apply();

  return {
    reset() { state.w = DOCK_DEFAULT; state.order = DEFAULT_ORDER.slice(); state.collapsed = []; apply(); store(); window.dispatchEvent(new Event('resize')); },
    restore(s) { if (!s) return; if (typeof s.w === 'number') state.w = Math.max(DOCK_MIN, Math.min(DOCK_MAX, s.w)); if (Array.isArray(s.order)) state.order = s.order; if (Array.isArray(s.collapsed)) state.collapsed = s.collapsed; apply(); window.dispatchEvent(new Event('resize')); },
  };
}
