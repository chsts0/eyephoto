"""Сборщик глаз для обучения нейронки EyePhoto.

Проходит по папке с готовыми фото (месяцы, дни, внутри JPEG вроде 4-1233.jpg),
находит на каждом листе глаза: круги радужки с чёрным зрачком, на чёрном или
белом фоне шаблона, по одному или парой по углам. Каждый глаз вырезается
квадратом, рядом кладётся маска: где настоящая радужка, а где фон, обрезка
по краю места или соседний глаз. Повторы одного и того же глаза из разных
шаблонов отбрасываются. В конце всё складывается в один архив zip.

Запуск: двойной щелчок (окно с выбором папок) или из командной строки:
    collect.py ПАПКА_С_ФОТО ПАПКА_КУДА [--max 0]
"""

import csv
import datetime
import os
import sys
import threading
import zipfile

import cv2
import numpy as np

EXTS = ('.jpg', '.jpeg', '.png', '.tif', '.tiff')
OUT_SIDE = 1024          # сторона вырезки, точек
MIN_R = 220              # радиус радужки в исходнике меньше этого не берём: мелко
PUPIL_K = 4.3            # радиус радужки / радиус зрачка на готовых работах студии
MIN_VALID = 0.80         # хотя бы 80% круга должно быть настоящей радужкой


def read_image(path):
    data = np.fromfile(path, dtype=np.uint8)            # пути с русскими буквами
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def find_eyes(img):
    """Возвращает [(cx, cy, R)] в координатах исходника."""
    H, W = img.shape[:2]
    k = min(1.0, 1400 / max(H, W))
    small = cv2.resize(img, (int(W * k), int(H * k)), interpolation=cv2.INTER_AREA) if k < 1 else img
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2].astype(np.int32)
    s = hsv[:, :, 1].astype(np.int32)
    h, w = v.shape
    colored = (v > 45) & ~((v > 235) & (s < 25))          # не чёрное и не белая бумага
    dark = (v < 40).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(dark, 8)
    eyes = []
    ang = np.linspace(0, 2 * np.pi, 96, endpoint=False)
    for i in range(1, n):
        x, y, bw, bh, area = st[i]
        if area < 150 or bw < 12 or bh < 12:
            continue
        if abs(bw - bh) > 0.25 * max(bw, bh) or area < 0.6 * np.pi * (max(bw, bh) / 2) ** 2:
            continue                                      # не круглое: не зрачок
        cx, cy = cen[i]
        r0 = (bw + bh) / 4
        # вокруг зрачка должна быть цветная радужка
        ring = [(int(cx + 2 * r0 * np.cos(a)), int(cy + 2 * r0 * np.sin(a))) for a in ang]
        ok = [colored[yy, xx] for xx, yy in ring if 0 <= xx < w and 0 <= yy < h]
        if len(ok) < 40 or np.mean(ok) < 0.75:
            continue
        # край радужки: лучами до первого чёрного или белого
        rs = []
        for a in ang:
            r = int(1.6 * r0)
            miss = 0
            while True:
                xx, yy = int(cx + r * np.cos(a)), int(cy + r * np.sin(a))
                if not (0 <= xx < w and 0 <= yy < h):
                    break
                miss = 0 if colored[yy, xx] else miss + 1
                if miss >= 4:
                    rs.append(r - 4)
                    break
                r += 1
                if r > 8 * r0:
                    break
        guess = PUPIL_K * r0
        rs = np.array([r for r in rs if 0.7 * guess < r < 1.3 * guess])
        R = float(np.percentile(rs, 80)) if len(rs) >= 20 else guess
        if not (0.75 * guess < R < 1.25 * guess):
            continue
        eyes.append((cx / k, cy / k, R / k))
    # один и тот же глаз не считаем дважды
    out = []
    for e in sorted(eyes, key=lambda e: -e[2]):
        if all(np.hypot(e[0] - o[0], e[1] - o[1]) > 0.5 * o[2] for o in out):
            out.append(e)
    return out


def cut_eye(img, eye, others):
    """Квадрат с глазом и маска настоящей радужки. None, если глаз сильно обрезан."""
    H, W = img.shape[:2]
    cx, cy, R = eye
    half = int(round(R * 1.04))
    x0, y0 = int(round(cx)) - half, int(round(cy)) - half
    side = 2 * half
    crop = np.zeros((side, side, 3), np.uint8)
    sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(W, x0 + side), min(H, y0 + side)
    if sx1 <= sx0 or sy1 <= sy0:
        return None
    crop[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
    yy, xx = np.mgrid[0:side, 0:side]
    inside = (xx - half) ** 2 + (yy - half) ** 2 <= (R * 0.985) ** 2
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    v, s = hsv[:, :, 2], hsv[:, :, 1]
    background = (v < 18) | ((v > 240) & (s < 18))
    # тёмный зрачок внутри — это не фон
    pupil = (xx - half) ** 2 + (yy - half) ** 2 <= (R / PUPIL_K * 1.25) ** 2
    background &= ~pupil
    background = cv2.morphologyEx(background.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)) > 0
    valid = inside & ~background
    for ox, oy, oR in others:                              # место, где лежит соседний глаз
        valid &= (xx + x0 - ox) ** 2 + (yy + y0 - oy) ** 2 > (oR * 1.01) ** 2
    frac = valid.sum() / max(1, inside.sum())
    if frac < MIN_VALID:
        return None
    if side != OUT_SIDE:
        crop = cv2.resize(crop, (OUT_SIDE, OUT_SIDE), interpolation=cv2.INTER_AREA if side > OUT_SIDE else cv2.INTER_CUBIC)
        valid = cv2.resize(valid.astype(np.uint8) * 255, (OUT_SIDE, OUT_SIDE), interpolation=cv2.INTER_NEAREST) > 127
    return crop, valid, frac


def fingerprint(crop, valid):
    """Отпечаток глаза для поиска повторов: 64 бита по середине радужки."""
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g[~valid] = np.nan
    c = OUT_SIDE // 2
    g = g[c - 300:c + 300, c - 300:c + 300]
    g = np.nan_to_num(g, nan=float(np.nanmean(g)))
    t = cv2.resize(g, (9, 8), interpolation=cv2.INTER_AREA)
    return np.packbits((t[:, 1:] > t[:, :-1]).flatten()).tobytes()


def hamming(a, b):
    return int(np.unpackbits(np.frombuffer(a, np.uint8) ^ np.frombuffer(b, np.uint8)).sum())


def collect(src, dst, log=print, progress=lambda i, n: None, stop=lambda: False, limit=0):
    files = []
    for root, _dirs, names in os.walk(src):
        for n in names:
            if n.lower().endswith(EXTS) and not n.startswith('.'):
                files.append(os.path.join(root, n))
    files.sort()
    log(f'Файлов с картинками: {len(files)}')
    out_dir = os.path.join(dst, 'eyes')
    os.makedirs(out_dir, exist_ok=True)
    kept = {}        # отпечаток -> (имя, R)
    rows = []
    skipped_small = skipped_cut = dupes = 0
    for i, path in enumerate(files):
        if stop():
            log('Остановлено.')
            break
        progress(i, len(files))
        try:
            img = read_image(path)
        except Exception:
            img = None
        if img is None:
            continue
        eyes = find_eyes(img)
        for j, e in enumerate(eyes):
            if e[2] < MIN_R:
                skipped_small += 1
                continue
            res = cut_eye(img, e, [o for t, o in enumerate(eyes) if t != j])
            if res is None:
                skipped_cut += 1
                continue
            crop, valid, frac = res
            fp = fingerprint(crop, valid)
            same = next((k for k in kept if hamming(k, fp) <= 6), None)
            if same is not None:
                dupes += 1
                name, oldR = kept[same]
                if e[2] <= oldR:
                    continue                               # уже есть такой же или крупнее
                del kept[same]                             # этот крупнее: заменяем
            else:
                name = f'eye_{len(kept) + dupes + 1:05d}'
            cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tofile(os.path.join(out_dir, name + '.jpg'))
            cv2.imencode('.png', valid.astype(np.uint8) * 255)[1].tofile(os.path.join(out_dir, name + '_mask.png'))
            kept[fp] = (name, e[2])
            rows.append([name, os.path.relpath(path, src), round(e[0]), round(e[1]), round(e[2]), round(frac, 3)])
        if limit and len(kept) >= limit:
            break
    progress(len(files), len(files))
    names = {v[0] for v in kept.values()}
    with open(os.path.join(dst, 'eyes.csv'), 'w', newline='', encoding='utf-8') as f:
        wr = csv.writer(f)
        wr.writerow(['name', 'source', 'cx', 'cy', 'radius', 'valid'])
        last = {}
        for r in rows:                                     # по одной строке на глаз: откуда взята оставленная версия
            last[r[0]] = r
        wr.writerows(r for n, r in sorted(last.items()) if n in names)
    log(f'Глаз собрано: {len(names)}. Повторов отброшено: {dupes}, мелких: {skipped_small}, сильно обрезанных: {skipped_cut}.')
    stamp = datetime.date.today().isoformat()
    zpath = os.path.join(dst, f'eyes_dataset_{stamp}.zip')
    log('Складываю в архив…')
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_STORED) as z:      # JPEG и так сжаты
        z.write(os.path.join(dst, 'eyes.csv'), 'eyes.csv')
        for n in sorted(os.listdir(out_dir)):
            if n.rsplit('_mask', 1)[0].rsplit('.', 1)[0] in names:
                z.write(os.path.join(out_dir, n), 'eyes/' + n)
    log(f'Готово: {zpath}')
    return zpath, len(names)


def gui():
    import tkinter as tk
    from tkinter import filedialog, ttk

    win = tk.Tk()
    win.title('Сборщик глаз для обучения')
    win.geometry('620x380')
    src = tk.StringVar()
    dst = tk.StringVar(value=os.path.join(os.path.expanduser('~'), 'Desktop', 'eyes_dataset'))
    pad = dict(padx=12, pady=6)

    def row(label, var, pick):
        f = tk.Frame(win)
        f.pack(fill='x', **pad)
        tk.Label(f, text=label, width=22, anchor='w').pack(side='left')
        tk.Entry(f, textvariable=var).pack(side='left', fill='x', expand=True)
        tk.Button(f, text='Выбрать…', command=pick).pack(side='left', padx=6)

    row('Папка с готовыми фото', src, lambda: src.set(filedialog.askdirectory() or src.get()))
    row('Куда сохранить', dst, lambda: dst.set(filedialog.askdirectory() or dst.get()))
    bar = ttk.Progressbar(win, mode='determinate')
    bar.pack(fill='x', **pad)
    logbox = tk.Text(win, height=10, state='disabled')
    logbox.pack(fill='both', expand=True, **pad)
    btn = tk.Button(win, text='Собрать')
    btn.pack(pady=8)
    state = {'stop': False, 'running': False}

    def log(t):
        def f():
            logbox.configure(state='normal')
            logbox.insert('end', t + '\n')
            logbox.see('end')
            logbox.configure(state='disabled')
        win.after(0, f)

    def progress(i, n):
        win.after(0, lambda: bar.configure(maximum=max(1, n), value=i))

    def run():
        if state['running']:
            state['stop'] = True
            return
        if not os.path.isdir(src.get()):
            log('Выберите папку с готовыми фото.')
            return
        os.makedirs(dst.get(), exist_ok=True)
        state.update(stop=False, running=True)
        btn.configure(text='Остановить')

        def work():
            try:
                collect(src.get(), dst.get(), log, progress, lambda: state['stop'])
                if sys.platform == 'win32':
                    os.startfile(dst.get())
            except Exception as e:  # покажем, что сломалось
                log('Ошибка: ' + repr(e))
            finally:
                state['running'] = False
                win.after(0, lambda: btn.configure(text='Собрать'))
        threading.Thread(target=work, daemon=True).start()

    btn.configure(command=run)
    log('Выберите папку, где лежат папки месяцев с готовыми фото, и нажмите «Собрать».')
    win.mainloop()


if __name__ == '__main__':
    if len(sys.argv) >= 3:
        lim = int(sys.argv[sys.argv.index('--max') + 1]) if '--max' in sys.argv else 0
        collect(sys.argv[1], sys.argv[2], limit=lim)
    else:
        gui()
