"""Дообучение нейронки EyePhoto (LaMa) на глазах студии.

Данные: архив от сборщика (eyes/eye_00001.jpg + eye_00001_mask.png).
Бликов и ресниц на готовых глазах нет, поэтому пары «до/после» не нужны:
на чистый глаз рисуются ненастоящие блики и ресницы такой же формы, как на
снимках студии, и модель учится стирать их обратно.

Запуск (Kaggle, видеокарта T4 или P100):
    python train.py --data /kaggle/input/eyes --out /kaggle/working/out --hours 9

Что получится в папке out:
    eyes_lama.onnx      готовая модель для программы (вход 512×512, как у старой)
    samples/val_*.png   сравнение: вход, старая модель, новая, как было на самом деле
    log.csv             ошибки по ходу обучения
    last.pt             для продолжения, если сессию оборвало (--resume)
"""

import argparse
import csv
import glob
import math
import os
import random
import sys
import time
import urllib.request
import zipfile

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lama_model import FourierUnit, Inpainter, load_biglama  # noqa: E402
from safe_ckpt import load_generator_state  # noqa: E402

BIGLAMA_URL = 'https://huggingface.co/smartywu/big-lama/resolve/main/big-lama.zip'
N = 512


# --- данные -------------------------------------------------------------------

def find_eyes(root):
    if root.endswith('.zip'):
        dst = os.path.join(os.path.dirname(os.path.abspath(root)), 'eyes_unzipped')
        if not os.path.isdir(dst):
            zipfile.ZipFile(root).extractall(dst)
        root = dst
    files = sorted(f for f in glob.glob(os.path.join(root, '**', 'eye_*.jpg'), recursive=True))
    out = [(f, f[:-4] + '_mask.png') for f in files if os.path.exists(f[:-4] + '_mask.png')]
    if not out:
        raise SystemExit(f'В {root} нет глаз от сборщика (eye_00001.jpg + eye_00001_mask.png)')
    return out


def dedupe(items):
    """Архивы с разных компов могут содержать один и тот же глаз: оставляем один,
    иначе он попадёт и в обучение, и в проверку."""
    kept, prints = [], []
    for img_p, msk_p in items:
        g = read(img_p, cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        c = g.shape[0] // 2
        h = g.shape[0] * 300 // 1024
        t = cv2.resize(g[c - h:c + h, c - h:c + h].astype(np.float32), (9, 8), interpolation=cv2.INTER_AREA)
        fp = (t[:, 1:] > t[:, :-1]).flatten()
        if any((fp != q).sum() <= 6 for q in prints):
            continue
        prints.append(fp)
        kept.append((img_p, msk_p))
    if len(kept) < len(items):
        print(f'Повторов между архивами: {len(items) - len(kept)}', flush=True)
    return kept


def read(path, flag=cv2.IMREAD_COLOR):
    return cv2.imdecode(np.fromfile(path, np.uint8), flag)


class GlareMasks:
    """Маски как на снимках студии: прямоугольные блики от софтбоксов, круглые
    точки, дуги кольцевого света, ресницы, произвольные обводки лассо."""

    def __init__(self, rng):
        self.r = rng

    def __call__(self, side, size):
        """side — сторона квадрата, size — примерный размер пятна (в тех же точках)."""
        r = self.r
        m = np.zeros((side, side), np.uint8)
        c = (side / 2 + r.uniform(-0.15, 0.15) * side, side / 2 + r.uniform(-0.15, 0.15) * side)
        kind = r.choices(['rect', 'dots', 'arc', 'lashes', 'blob', 'combo'], [30, 12, 10, 18, 18, 12])[0]
        if kind in ('rect', 'combo'):
            for _ in range(r.choice([1, 1, 2])):
                w = size * r.uniform(0.25, 0.6)
                h = size * r.uniform(0.7, 1.0)
                ang = r.uniform(-25, 25)
                ox = r.uniform(-0.6, 0.6) * w
                box = cv2.boxPoints(((c[0] + ox, c[1]), (w, h), ang)).astype(np.int32)
                cv2.fillConvexPoly(m, box, 255)
        if kind in ('dots', 'combo'):
            for _ in range(r.randint(1, 4)):
                rr = max(3, size * r.uniform(0.05, 0.2))
                p = (int(c[0] + r.uniform(-1, 1) * size), int(c[1] + r.uniform(-1, 1) * size))
                cv2.circle(m, p, int(rr), 255, -1)
        if kind == 'arc':
            R = size * r.uniform(0.8, 1.6)
            a0 = r.uniform(0, 360)
            cv2.ellipse(m, (int(c[0]), int(c[1])), (int(R), int(R * r.uniform(0.7, 1))), r.uniform(0, 180), a0, a0 + r.uniform(40, 140), 255, max(3, int(size * r.uniform(0.08, 0.2))))
        if kind == 'lashes':
            for _ in range(r.randint(2, 7)):
                p0 = np.array([c[0] + r.uniform(-1, 1) * size, c[1] + r.uniform(-1, 1) * size])
                d = np.array([math.cos(t := r.uniform(0, math.pi)), math.sin(t)]) * size * r.uniform(0.8, 2)
                bend = np.array([-d[1], d[0]]) * r.uniform(-0.3, 0.3)
                pts = [p0 + d * s + bend * 4 * s * (1 - s) for s in np.linspace(0, 1, 16)]
                cv2.polylines(m, [np.array(pts, np.int32)], False, 255, max(2, int(size * r.uniform(0.02, 0.06))))
        if kind == 'blob':
            k = r.randint(6, 12)
            pts = [(c[0] + math.cos(2 * math.pi * i / k) * size * r.uniform(0.25, 0.6),
                    c[1] + math.sin(2 * math.pi * i / k) * size * r.uniform(0.25, 0.6)) for i in range(k)]
            cv2.fillPoly(m, [np.array(pts, np.int32)], 255)
        # запас вокруг, как добавляет программа при выделении
        pad = max(2, int(side / 160))
        m = cv2.dilate(m, np.ones((2 * pad + 1, 2 * pad + 1), np.uint8))
        return m


class EyeSet(torch.utils.data.Dataset):
    def __init__(self, items, seed=None, length=None):
        self.items = items
        self.seed = seed
        self.length = length or len(items) * 50

    def __len__(self):
        return self.length

    def __getitem__(self, i):
        rng = random.Random(self.seed * 100003 + i if self.seed is not None else None)
        for _ in range(20):
            img_p, msk_p = self.items[rng.randrange(len(self.items))]
            img, valid = read(img_p), read(msk_p, cv2.IMREAD_GRAYSCALE)
            S = img.shape[0]
            # поворот вокруг центра (рисунок радужки лучами, поворот естественный) и отражение
            M = cv2.getRotationMatrix2D((S / 2, S / 2), rng.uniform(0, 360), 1)
            img = cv2.warpAffine(img, M, (S, S), flags=cv2.INTER_LINEAR, borderValue=0)
            valid = cv2.warpAffine(valid, M, (S, S), flags=cv2.INTER_NEAREST, borderValue=0)
            if rng.random() < 0.5:
                img, valid = img[:, ::-1], valid[:, ::-1]
            # размер пятна и окно вокруг него, как программа отдаёт место модели:
            # окно в 2,3 раза больше пятна, но не меньше трети глаза
            size = rng.uniform(0.04, 0.35) * S
            win = int(min(S, max(S * 0.33, size * 2.3)))
            x0 = rng.randint(0, S - win)
            y0 = rng.randint(0, S - win)
            v = valid[y0:y0 + win, x0:x0 + win] > 127
            if v.mean() < 0.6:
                continue
            m = GlareMasks(rng)(win, size) > 127
            if m.sum() < 30 or (m & ~v).sum() > 0.1 * m.sum():
                continue                                   # пятно должно лежать на радужке
            crop = np.ascontiguousarray(img[y0:y0 + win, x0:x0 + win])
            crop = cv2.resize(crop, (N, N), interpolation=cv2.INTER_AREA if win > N else cv2.INTER_CUBIC)
            m = cv2.resize(m.astype(np.uint8), (N, N), interpolation=cv2.INTER_NEAREST)
            v = cv2.resize(v.astype(np.uint8), (N, N), interpolation=cv2.INTER_NEAREST)
            x = torch.from_numpy(crop[:, :, ::-1].copy()).permute(2, 0, 1).float() / 255
            if self.seed is None:                          # лёгкий разброс света и цвета
                x = (x * rng.uniform(0.9, 1.1) + rng.uniform(-0.04, 0.04)).clamp(0, 1)
            return x, torch.from_numpy(m)[None].float(), torch.from_numpy(v)[None].float()
        return self.__getitem__(i + 1)


# --- дискриминатор и потери ---------------------------------------------------

class Discriminator(nn.Module):
    """PatchGAN как в LaMa (pix2pixhd_nlayer, 4 слоя), отдаёт и промежуточные карты."""

    def __init__(self, nc=3, ndf=64, n_layers=4):
        super().__init__()
        seq = [nn.Sequential(nn.Conv2d(nc, ndf, 4, 2, 2), nn.LeakyReLU(0.2, True))]
        nf = ndf
        for n in range(1, n_layers):
            p, nf = nf, min(nf * 2, 512)
            seq.append(nn.Sequential(nn.Conv2d(p, nf, 4, 2, 2), nn.BatchNorm2d(nf), nn.LeakyReLU(0.2, True)))
        p, nf = nf, min(nf * 2, 512)
        seq.append(nn.Sequential(nn.Conv2d(p, nf, 4, 1, 2), nn.BatchNorm2d(nf), nn.LeakyReLU(0.2, True)))
        seq.append(nn.Conv2d(nf, 1, 4, 1, 2))
        self.layers = nn.ModuleList(seq)

    def forward(self, x):
        feats = []
        for l in self.layers:
            x = l(x)
            feats.append(x)
        return x, feats[:-1]


class VGGLoss(nn.Module):
    def __init__(self):
        super().__init__()
        import torchvision
        vgg = torchvision.models.vgg16(weights=torchvision.models.VGG16_Weights.IMAGENET1K_V1).features.eval()
        for p in vgg.parameters():
            p.requires_grad_(False)
        self.slices = nn.ModuleList([vgg[:4], vgg[4:9], vgg[9:16], vgg[16:23]])
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def forward(self, a, b, w=None):
        a, b = (a - self.mean) / self.std, (b - self.mean) / self.std
        loss = 0
        for s in self.slices:
            a, b = s(a), s(b)
            d = (a - b).abs()
            if w is not None:
                ww = F.interpolate(w, size=d.shape[-2:], mode='area')
                d = d * ww
            loss = loss + d.mean()
        return loss


def freeze_bn(m):
    """Статистики BatchNorm из исходной модели не трогаем: батч маленький."""
    for mod in m.modules():
        if isinstance(mod, nn.BatchNorm2d):
            mod.eval()


# --- обучение -----------------------------------------------------------------

def get_biglama(cache):
    path = os.path.join(cache, 'big-lama', 'models', 'best.ckpt')
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        z = os.path.join(cache, 'big-lama.zip')
        print('Скачиваю исходные веса LaMa…', flush=True)
        urllib.request.urlretrieve(BIGLAMA_URL, z)
        zipfile.ZipFile(z).extractall(cache)
    return load_biglama(load_generator_state(path))


@torch.no_grad()
def evaluate(net, base, vgg, val, dev, out_dir=None, tag=''):
    net.eval()
    l1s, pls = [], []
    rows = []
    for i, (x, m, v) in enumerate(val):
        x, m, v = x.to(dev), m.to(dev), v.to(dev)
        y = net(x, m)
        l1s.append(((y - x).abs() * m).sum().item() / (m.sum().item() * 3 + 1e-6))
        pls.append(vgg(y, x, F.max_pool2d(m, 9, 1, 4)).item())
        if out_dir and i < 6:
            yb = base(x, m)
            show = x * (1 - m) + m * torch.tensor([1.0, 0.0, 1.0], device=dev).view(1, 3, 1, 1)
            rows.append(torch.cat([show[0], yb[0], y[0], x[0]], 2))
    net.train()
    freeze_bn(net)
    if out_dir and rows:
        grid = (torch.cat(rows, 1).clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
        os.makedirs(out_dir, exist_ok=True)
        cv2.imwrite(os.path.join(out_dir, f'val_{tag}.jpg'), grid[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 90])
    return float(np.mean(l1s)), float(np.mean(pls))


def export_onnx(gen, path):
    """Выгрузка как у модели в программе: входы image и mask 1×3×512×512 / 1×1×512×512."""
    net = Inpainter(gen).eval().cpu()
    FourierUnit.matmul_fft = True
    x = torch.rand(1, 3, N, N)
    m = (torch.rand(1, 1, N, N) > 0.9).float()
    try:
        kw = dict(input_names=['image', 'mask'], output_names=['output'], opset_version=17, do_constant_folding=True)
        try:
            torch.onnx.export(net, (x, m), path, dynamo=False, **kw)
        except TypeError:
            torch.onnx.export(net, (x, m), path, **kw)
        with torch.no_grad():
            ref = net(x, m).numpy()
    finally:
        FourierUnit.matmul_fft = False
    try:
        import onnxruntime as ort
        o = ort.InferenceSession(path, providers=['CPUExecutionProvider']).run(None, {'image': x.numpy(), 'mask': m.numpy()})[0]
        print(f'Проверка ONNX: расхождение {np.abs(o - ref).max():.2e}', flush=True)
    except ImportError:
        print('onnxruntime нет, проверку ONNX пропускаю', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True, help='папка или zip от сборщика')
    ap.add_argument('--out', default='out')
    ap.add_argument('--hours', type=float, default=9, help='сколько часов учить (Kaggle даёт до 12)')
    ap.add_argument('--steps', type=int, default=0, help='или сколько шагов (0 — по времени)')
    ap.add_argument('--batch', type=int, default=2)
    ap.add_argument('--lr', type=float, default=3e-5)
    ap.add_argument('--warmup', type=int, default=600, help='шагов разогрева дискриминатора')
    ap.add_argument('--eval-every', type=int, default=1000)
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--amp', action='store_true', help='половинная точность: быстрее, но на T4 big-lama в ней уходит в nan')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/eyephoto'))
    ap.add_argument('--export-only', action='store_true', help='только выгрузить лучшую модель в ONNX')
    a = ap.parse_args()

    dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    os.makedirs(a.out, exist_ok=True)
    print('Устройство:', dev, torch.cuda.get_device_name(0) if dev.type == 'cuda' else '', flush=True)

    gen = get_biglama(a.cache).to(dev)
    base = Inpainter(get_biglama(a.cache)).to(dev).eval()   # исходная модель для сравнения
    if a.export_only:
        gen.load_state_dict(torch.load(os.path.join(a.out, 'best_gen.pt'), map_location='cpu', weights_only=True))
        export_onnx(gen, os.path.join(a.out, 'eyes_lama.onnx'))
        return

    items = dedupe(find_eyes(a.data))
    rnd = random.Random(7)
    rnd.shuffle(items)
    n_val = max(4, len(items) // 20)
    val_items, train_items = items[:n_val], items[n_val:] or items
    print(f'Глаз: {len(items)}, на проверку отложено {n_val}', flush=True)

    train = torch.utils.data.DataLoader(EyeSet(train_items), batch_size=a.batch, num_workers=a.workers, drop_last=True, pin_memory=dev.type == 'cuda', persistent_workers=a.workers > 0)
    val = torch.utils.data.DataLoader(EyeSet(val_items, seed=1, length=min(96, n_val * 8)), batch_size=1)

    net = Inpainter(gen)
    disc = Discriminator().to(dev)
    vgg = VGGLoss().to(dev)
    opt_g = torch.optim.Adam(gen.parameters(), lr=a.lr, betas=(0.5, 0.999))
    opt_d = torch.optim.Adam(disc.parameters(), lr=a.lr * 3, betas=(0.5, 0.999))
    use_amp = a.amp and dev.type == 'cuda'
    scaler = torch.amp.GradScaler(enabled=use_amp)
    bad = 0
    step, best = 0, None

    last = os.path.join(a.out, 'last.pt')
    if a.resume and os.path.exists(last):
        st = torch.load(last, map_location='cpu', weights_only=True)
        gen.load_state_dict(st['gen']); disc.load_state_dict(st['disc'])
        opt_g.load_state_dict(st['opt_g']); opt_d.load_state_dict(st['opt_d'])
        step, best = int(st['step']), (float(st['best']) if st['best'] >= 0 else None)
        print(f'Продолжаю с шага {step}', flush=True)

    if step == 0:
        b_l1, b_pl = evaluate(base, base, vgg, val, dev, os.path.join(a.out, 'samples'), 'start')
        print(f'Исходная модель: ошибка в пятне {b_l1:.4f}, перцептивная {b_pl:.4f}', flush=True)
        with open(os.path.join(a.out, 'log.csv'), 'w', newline='') as f:
            csv.writer(f).writerow(['step', 'val_l1', 'val_perceptual', 'note'])
            csv.writer(f).writerow([0, b_l1, b_pl, 'исходная'])

    net.train()
    freeze_bn(net)
    t0 = time.time()
    deadline = t0 + a.hours * 3600 - 15 * 60          # запас на выгрузку
    it = iter(train)
    while True:
        if a.steps and step >= a.steps:
            break
        if not a.steps and time.time() > deadline:
            break
        try:
            x, m, v = next(it)
        except StopIteration:
            it = iter(train)
            x, m, v = next(it)
        x, m, v = x.to(dev, non_blocking=True), m.to(dev, non_blocking=True), v.to(dev, non_blocking=True)
        warm = step < a.warmup

        with torch.autocast(dev.type, enabled=use_amp, dtype=torch.float16):
            y = net(x, m)
        y = y.float()
        # сломанный шаг (nan) пропускаем; если их много подряд, останавливаемся, а не жжём часы впустую
        if not torch.isfinite(x).all() or not torch.isfinite(y).all():
            bad += 1
            print(f'шаг {step}: ' + ('битая картинка во входе' if not torch.isfinite(x).all() else 'генератор выдал nan') + ', пропускаю', flush=True)
            if bad >= 5 and use_amp:
                # половинная точность не тянет: дальше в полной, медленнее, но надёжно
                use_amp = False
                scaler = torch.amp.GradScaler(enabled=False)
                print('Перехожу на полную точность', flush=True)
            if bad >= 20:
                raise SystemExit('Обучение сломалось: 20 шагов подряд nan. Пришлите лог.')
            continue
        bad = 0

        # дискриминатор: настоящая радужка против дорисованного места
        x.requires_grad_(step % 4 == 0)
        d_real, _ = disc(x)
        d_fake, _ = disc(y.detach())
        md = F.interpolate(m, size=d_fake.shape[-2:], mode='area')
        loss_d = F.softplus(-d_real).mean() + (F.softplus(d_fake) * md).sum() / (md.sum() + 1) + (F.softplus(-d_fake) * (1 - md)).sum() / ((1 - md).sum() + 1)
        if x.requires_grad:                                # R1, как в LaMa
            g, = torch.autograd.grad(d_real.sum(), x, create_graph=True)
            loss_d = loss_d + 0.001 * 4 * g.pow(2).sum(dim=[1, 2, 3]).mean()
        opt_d.zero_grad(set_to_none=True)
        if not torch.isfinite(loss_d):
            print(f'шаг {step}: nan у дискриминатора, пропускаю', flush=True)
            step += 1
            continue
        loss_d.backward()
        torch.nn.utils.clip_grad_norm_(disc.parameters(), 10.0)
        opt_d.step()
        x = x.detach()

        loss_g = torch.zeros((), device=dev)
        if not warm:
            d_fake, f_fake = disc(y)
            with torch.no_grad():
                _, f_real = disc(x)
            adv = (F.softplus(-d_fake) * md).sum() / (md.sum() + 1)
            fm = sum((ff - fr).abs().mean() for ff, fr in zip(f_fake, f_real)) / len(f_fake)
            l1_known = ((y - x).abs() * (1 - m)).mean()
            l1_hole = ((y - x).abs() * m).sum() / (m.sum() * 3 + 1)
            pl = vgg(y, x, v)
            loss_g = 10 * adv + 100 * fm + 10 * l1_known + 1 * l1_hole + 1 * pl
            opt_g.zero_grad(set_to_none=True)
            if not torch.isfinite(loss_g):
                print(f'шаг {step}: nan у генератора, пропускаю', flush=True)
                step += 1
                continue
            scaler.scale(loss_g).backward()
            scaler.unscale_(opt_g)
            torch.nn.utils.clip_grad_norm_(gen.parameters(), 1.0)
            scaler.step(opt_g)
            scaler.update()

        step += 1
        if step % 50 == 0:
            el = time.time() - t0
            print(f'шаг {step}  D {loss_d.item():.3f}  G {loss_g.item():.3f}  {el / 60:.0f} мин' + ('  (разогрев)' if warm else ''), flush=True)
        if step % a.eval_every == 0 and not warm:
            l1, pl = evaluate(net, base, vgg, val, dev, os.path.join(a.out, 'samples'), f'{step:06d}')
            note = ''
            if best is None or pl < best:
                best = pl
                torch.save(gen.state_dict(), os.path.join(a.out, 'best_gen.pt'))
                note = 'лучшая'
            print(f'Проверка на шаге {step}: в пятне {l1:.4f}, перцептивная {pl:.4f} {note}', flush=True)
            with open(os.path.join(a.out, 'log.csv'), 'a', newline='') as f:
                csv.writer(f).writerow([step, l1, pl, note])
            torch.save({'gen': gen.state_dict(), 'disc': disc.state_dict(), 'opt_g': opt_g.state_dict(), 'opt_d': opt_d.state_dict(), 'step': step, 'best': best if best is not None else -1}, last)

    # итог: лучшая по проверке, если есть, иначе последняя
    bp = os.path.join(a.out, 'best_gen.pt')
    if os.path.exists(bp):
        gen.load_state_dict(torch.load(bp, map_location='cpu', weights_only=True))
    else:
        torch.save(gen.state_dict(), bp)
    export_onnx(gen, os.path.join(a.out, 'eyes_lama.onnx'))
    print('Готово. Файл для программы:', os.path.join(a.out, 'eyes_lama.onnx'), flush=True)


if __name__ == '__main__':
    main()
