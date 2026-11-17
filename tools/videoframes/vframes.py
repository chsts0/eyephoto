# VideoFrames: превращает видео-инструкции в листы кадров и лёгкий звук.
# Видео целиком не нужно: по кадрам видно, что делает дизайнер, а картинки
# и mp3 весят в сотни раз меньше и спокойно грузятся куда угодно.
#
# Для каждого видео рядом появляется папка «<имя> — кадры»:
#   лист_001.jpg … — по 4 кадра на лист, кадр раз в 2 секунды, с временем
#   звук.mp3       — голос, если он есть (моно, 32 кбит/с: час ≈ 14 МБ)

import os, subprocess, sys, threading, shutil

STEP = 2          # секунд между кадрами
TILE = (2, 2)     # кадров на листе
WIDTH = 960       # ширина кадра: чтобы читались цифры в панелях фотошопа
VIDEO_EXT = ('.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm')


def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which('ffmpeg') or 'ffmpeg'


def font():
    for f in ('/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc',
              'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if os.path.exists(f):
            return f
    return None


def run(args):
    flags = 0x08000000 if sys.platform == 'win32' else 0   # без чёрного окна на винде
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)


def process(path, log):
    ff = ffmpeg()
    name = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(os.path.dirname(path), f'{name} — кадры')
    os.makedirs(out, exist_ok=True)
    log(f'{name}: кадры…')
    vf = f'fps=1/{STEP},scale={WIDTH}:-2'
    f = font()
    if f:
        # время кадра в углу, чтобы можно было сослаться: «на 3:40»
        fe = f.replace('\\', '/').replace(':', '\\:')
        vf += f",drawtext=fontfile='{fe}':text='%{{pts\\:hms}}':x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6"
    vf += f',tile={TILE[0]}x{TILE[1]}:padding=4:color=black'
    r = run([ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', vf, '-q:v', '4', os.path.join(out, 'лист_%03d.jpg')])
    if r.returncode and f:
        # если подписи не получились, без них
        vf = f'fps=1/{STEP},scale={WIDTH}:-2,tile={TILE[0]}x{TILE[1]}:padding=4:color=black'
        r = run([ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', vf, '-q:v', '4', os.path.join(out, 'лист_%03d.jpg')])
    if r.returncode:
        log(f'{name}: не получилось — {r.stderr.decode(errors="ignore")[-300:]}')
        return
    log(f'{name}: звук…')
    a = run([ff, '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '22050', '-b:a', '32k', os.path.join(out, 'звук.mp3')])
    if a.returncode:
        try: os.remove(os.path.join(out, 'звук.mp3'))
        except OSError: pass
    n = len([x for x in os.listdir(out) if x.endswith('.jpg')])
    log(f'{name}: готово, листов {n}' + ('' if a.returncode else ', звук есть'))
    return out


class App:
    # окно; tkinter берём только здесь, чтобы режим без окна работал везде
    def __init__(self, root):
        self.root = root
        root.title('VideoFrames')
        root.geometry('560x380')
        f = ttk.Frame(root, padding=16)
        f.pack(fill='both', expand=True)
        ttk.Label(f, text='Видео-инструкции → листы кадров и звук', font=('', 14, 'bold')).pack(anchor='w')
        ttk.Label(f, text='Выберите видео или папку с ними. Рядом с каждым видео появится\nпапка «… — кадры». Её и закидывайте на Google Диск целиком.', justify='left').pack(anchor='w', pady=(6, 12))
        b = ttk.Frame(f)
        b.pack(anchor='w')
        self.b1 = ttk.Button(b, text='Выбрать видео…', command=self.pick_files)
        self.b1.pack(side='left')
        self.b2 = ttk.Button(b, text='Выбрать папку…', command=self.pick_dir)
        self.b2.pack(side='left', padx=8)
        self.text = tk.Text(f, height=12, wrap='word')
        self.text.pack(fill='both', expand=True, pady=(12, 0))

    def log(self, s):
        self.root.after(0, lambda: (self.text.insert('end', s + '\n'), self.text.see('end')))

    def pick_files(self):
        ps = filedialog.askopenfilenames(title='Видео', filetypes=[('Видео', ' '.join('*' + e for e in VIDEO_EXT)), ('Все', '*.*')])
        if ps: self.start(list(ps))

    def pick_dir(self):
        d = filedialog.askdirectory(title='Папка с видео')
        if not d: return
        ps = []
        for root, _, files in os.walk(d):
            if root.endswith(' — кадры'): continue
            ps += [os.path.join(root, x) for x in sorted(files) if x.lower().endswith(VIDEO_EXT)]
        if not ps: self.log('В папке нет видео'); return
        self.start(ps)

    def start(self, ps):
        self.b1.state(['disabled']); self.b2.state(['disabled'])
        def work():
            for p in ps:
                try: process(p, self.log)
                except Exception as e: self.log(f'{os.path.basename(p)}: ошибка {e}')
            self.log('Всё. Закиньте папки «… — кадры» на Google Диск и пришлите ссылку.')
            self.root.after(0, lambda: (self.b1.state(['!disabled']), self.b2.state(['!disabled'])))
        threading.Thread(target=work, daemon=True).start()


def gui():
    global tk, filedialog, ttk
    import tkinter as tk
    from tkinter import filedialog, ttk
    root = tk.Tk(); App(root); root.mainloop()


if __name__ == '__main__':
    if len(sys.argv) > 1:   # без окна: vframes.py видео1 видео2 …
        for p in sys.argv[1:]: process(p, print)
    else:
        gui()
