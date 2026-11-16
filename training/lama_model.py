# Генератор LaMa (big-lama) на чистом PyTorch, без исходного репозитория и его
# старых зависимостей. Имена слоёв как в оригинале, поэтому веса big-lama
# грузятся как есть.
#
# Быстрое преобразование Фурье два вида: torch.fft для обучения на видеокарте и
# умножение на матрицы для выгрузки в ONNX (обычные MatMul работают везде,
# в том числе на видеокартах через DirectML). Результат одинаковый.

import math
import torch
import torch.nn as nn


class FourierUnit(nn.Module):
    matmul_fft = False  # True при выгрузке в ONNX

    def __init__(self, in_channels, out_channels):
        super().__init__()
        self.conv_layer = nn.Conv2d(in_channels * 2, out_channels * 2, 1, bias=False)
        self.bn = nn.BatchNorm2d(out_channels * 2)
        self.relu = nn.ReLU(True)
        self._mats = {}

    # --- ДПФ умножением на матрицы, norm='ortho' как в оригинале -------------
    def _dft(self, h, w, device, dtype):
        key = (h, w, device, dtype)
        if key not in self._mats:
            wk = w // 2 + 1
            ys = torch.arange(h, dtype=torch.float64)
            xs = torch.arange(w, dtype=torch.float64)
            ks = torch.arange(wk, dtype=torch.float64)
            ang_h = -2 * math.pi * ys[:, None] * ys[None, :] / h          # h×h
            ang_w = -2 * math.pi * xs[:, None] * ks[None, :] / w          # w×wk
            ch, sh = torch.cos(ang_h) / math.sqrt(h), torch.sin(ang_h) / math.sqrt(h)
            cw, sw = torch.cos(ang_w) / math.sqrt(w), torch.sin(ang_w) / math.sqrt(w)
            # обратное: по w половинный спектр, удвоение средних частот
            wgt = torch.full((wk,), 2.0, dtype=torch.float64)
            wgt[0] = 1
            if w % 2 == 0:
                wgt[-1] = 1
            icw = (torch.cos(-ang_w) * wgt[None, :] / math.sqrt(w)).T     # wk×w
            isw = (torch.sin(-ang_w) * wgt[None, :] / math.sqrt(w)).T
            ich, ish = torch.cos(-ang_h) / math.sqrt(h), torch.sin(-ang_h) / math.sqrt(h)
            self._mats[key] = [m.to(device=device, dtype=dtype) for m in (ch, sh, cw, sw, icw, isw, ich, ish)]
        return self._mats[key]

    def _rfft2(self, x):
        h, w = x.shape[-2:]
        ch, sh, cw, sw, *_ = self._dft(h, w, x.device, x.dtype)
        # по строкам (w → половинный спектр), потом по столбцам (h)
        ar, ai = x @ cw, x @ sw
        re = ch @ ar - sh @ ai
        im = ch @ ai + sh @ ar
        return re, im

    def _irfft2(self, re, im, h, w):
        _, _, _, _, icw, isw, ich, ish = self._dft(h, w, re.device, re.dtype)
        # обратное по столбцам (h), потом по строкам (из половинного спектра)
        br = ich @ re - ish @ im
        bi = ich @ im + ish @ re
        return br @ icw - bi @ isw

    def forward(self, x):
        b = x.shape[0]
        h, w = x.shape[-2:]
        if self.matmul_fft:
            re, im = self._rfft2(x.float())
        else:
            f = torch.fft.rfftn(x.float(), dim=(-2, -1), norm='ortho')
            re, im = f.real, f.imag
        f = torch.stack((re, im), dim=2)                       # b c 2 h wk
        f = f.reshape(b, -1, h, f.shape[-1])
        f = self.relu(self.bn(self.conv_layer(f)))
        f = f.reshape(b, -1, 2, h, f.shape[-1])
        re, im = f[:, :, 0], f[:, :, 1]
        if self.matmul_fft:
            return self._irfft2(re, im, h, w)
        return torch.fft.irfftn(torch.complex(re, im), s=(h, w), dim=(-2, -1), norm='ortho')


class SpectralTransform(nn.Module):
    def __init__(self, in_channels, out_channels, stride=1):
        super().__init__()
        self.downsample = nn.AvgPool2d(2, 2) if stride == 2 else nn.Identity()
        self.conv1 = nn.Sequential(
            nn.Conv2d(in_channels, out_channels // 2, 1, bias=False),
            nn.BatchNorm2d(out_channels // 2), nn.ReLU(True))
        self.fu = FourierUnit(out_channels // 2, out_channels // 2)
        self.conv2 = nn.Conv2d(out_channels // 2, out_channels, 1, bias=False)

    def forward(self, x):
        x = self.conv1(self.downsample(x))
        return self.conv2(x + self.fu(x))


class FFC(nn.Module):
    def __init__(self, cin, cout, k, ratio_gin, ratio_gout, stride=1, padding=0, dilation=1):
        super().__init__()
        in_cg = int(cin * ratio_gin); in_cl = cin - in_cg
        out_cg = int(cout * ratio_gout); out_cl = cout - out_cg
        self.ratio_gout = ratio_gout
        conv = lambda a, b: nn.Conv2d(a, b, k, stride, padding, dilation, bias=False, padding_mode='reflect')
        self.convl2l = conv(in_cl, out_cl) if in_cl and out_cl else None
        self.convl2g = conv(in_cl, out_cg) if in_cl and out_cg else None
        self.convg2l = conv(in_cg, out_cl) if in_cg and out_cl else None
        self.convg2g = SpectralTransform(in_cg, out_cg, stride) if in_cg and out_cg else None

    def forward(self, x):
        x_l, x_g = x if isinstance(x, tuple) else (x, 0)
        out_l, out_g = 0, 0
        if self.ratio_gout != 1:
            out_l = (self.convl2l(x_l) if self.convl2l is not None else 0) + (self.convg2l(x_g) if self.convg2l is not None else 0)
        if self.ratio_gout != 0:
            out_g = (self.convl2g(x_l) if self.convl2g is not None else 0) + (self.convg2g(x_g) if self.convg2g is not None else 0)
        return out_l, out_g


class FFC_BN_ACT(nn.Module):
    def __init__(self, cin, cout, k, ratio_gin=0, ratio_gout=0, stride=1, padding=0, dilation=1, act=True):
        super().__init__()
        self.ffc = FFC(cin, cout, k, ratio_gin, ratio_gout, stride, padding, dilation)
        g = int(cout * ratio_gout)
        self.bn_l = nn.BatchNorm2d(cout - g) if ratio_gout != 1 else nn.Identity()
        self.bn_g = nn.BatchNorm2d(g) if ratio_gout != 0 else nn.Identity()
        self.act = act

    def forward(self, x):
        x_l, x_g = self.ffc(x)
        if torch.is_tensor(x_l):
            x_l = self.bn_l(x_l)
            if self.act: x_l = torch.relu(x_l)
        if torch.is_tensor(x_g):
            x_g = self.bn_g(x_g)
            if self.act: x_g = torch.relu(x_g)
        return x_l, x_g


class FFCResnetBlock(nn.Module):
    def __init__(self, dim, ratio):
        super().__init__()
        self.conv1 = FFC_BN_ACT(dim, dim, 3, ratio, ratio, padding=1)
        self.conv2 = FFC_BN_ACT(dim, dim, 3, ratio, ratio, padding=1)

    def forward(self, x):
        x_l, x_g = x
        y_l, y_g = self.conv2(self.conv1((x_l, x_g)))
        return x_l + y_l, x_g + y_g


class ConcatTuple(nn.Module):
    def forward(self, x):
        x_l, x_g = x
        return torch.cat(x, dim=1) if torch.is_tensor(x_g) else x_l


class Generator(nn.Module):
    """FFCResNetGenerator из big-lama: вход 4 канала (картинка с вырезом + маска), выход 3."""

    def __init__(self, ngf=64, n_down=3, n_blocks=18, ratio=0.75):
        super().__init__()
        m = [nn.ReflectionPad2d(3), FFC_BN_ACT(4, ngf, 7)]
        for i in range(n_down):
            mult = 2 ** i
            m.append(FFC_BN_ACT(ngf * mult, ngf * mult * 2, 3, 0, ratio if i == n_down - 1 else 0, stride=2, padding=1))
        dim = ngf * 2 ** n_down
        m += [FFCResnetBlock(dim, ratio) for _ in range(n_blocks)]
        m.append(ConcatTuple())
        for i in range(n_down):
            mult = 2 ** (n_down - i)
            m += [nn.ConvTranspose2d(ngf * mult, ngf * mult // 2, 3, 2, 1, output_padding=1), nn.BatchNorm2d(ngf * mult // 2), nn.ReLU(True)]
        m += [nn.ReflectionPad2d(3), nn.Conv2d(ngf, 3, 7), nn.Sigmoid()]
        self.model = nn.Sequential(*m)

    def forward(self, x):
        return self.model(x)


class Inpainter(nn.Module):
    """Как модель в программе: на входе картинка 0..1 и маска (1 = дорисовать),
    на выходе картинка, где дорисовано только место под маской."""

    def __init__(self, gen):
        super().__init__()
        self.gen = gen

    def forward(self, image, mask):
        masked = image * (1 - mask)
        pred = self.gen(torch.cat([masked, mask], dim=1))
        return mask * pred + (1 - mask) * image


def load_biglama(state):
    g = Generator()
    sd = {k: v for k, v in state.items() if not k.endswith('num_batches_tracked')}
    missing, unexpected = g.load_state_dict(sd, strict=False)
    missing = [k for k in missing if not k.endswith('num_batches_tracked')]
    if missing or unexpected:
        raise RuntimeError(f'веса не подошли: нет {missing[:5]}, лишние {unexpected[:5]}')
    return g
