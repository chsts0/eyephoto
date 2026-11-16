# Безопасная загрузка весов из чекпойнта Lightning (big-lama best.ckpt).
# Свой распаковщик: настоящими остаются только функции сборки тензоров torch и
# OrderedDict, все остальные классы из файла (колбэки, конфиги) подменяются
# пустыми заглушками. Код из файла не выполняется.
import collections, pickle, sys, zipfile
import torch


class _Stub(dict):
    def __init__(self, *a, **k):
        pass

    def __setstate__(self, state):
        pass

    def __call__(self, *a, **k):
        return _Stub()


_ALLOWED = {
    ('torch._utils', '_rebuild_tensor_v2'): torch._utils._rebuild_tensor_v2,
    ('torch._utils', '_rebuild_parameter'): torch._utils._rebuild_parameter,
    ('collections', 'OrderedDict'): collections.OrderedDict,
    ('torch', 'Size'): torch.Size,
}
for _n in ('FloatStorage', 'DoubleStorage', 'HalfStorage', 'LongStorage', 'IntStorage', 'ByteStorage', 'BoolStorage', 'BFloat16Storage'):
    _ALLOWED[('torch', _n)] = getattr(torch, _n)


def load_generator_state(path):
    zf = zipfile.ZipFile(path)
    pkl = next(n for n in zf.namelist() if n.endswith('data.pkl'))
    prefix = pkl[: -len('data.pkl')]

    class U(pickle.Unpickler):
        def find_class(self, module, name):
            return _ALLOWED.get((module, name), _Stub)

        def persistent_load(self, pid):
            _, storage_type, key, _loc, _numel = pid
            dtype = storage_type(0).dtype if callable(storage_type) else storage_type.dtype
            raw = bytearray(zf.read(f'{prefix}data/{key}'))
            t = torch.frombuffer(raw, dtype=dtype) if raw else torch.empty(0, dtype=dtype)
            return torch.storage.TypedStorage(wrap_storage=t.untyped_storage(), dtype=dtype, _internal=True)

    with zf.open(pkl) as f:
        ck = U(f).load()
    sd = ck['state_dict']
    return {k[len('generator.'):]: v for k, v in sd.items() if k.startswith('generator.')}


if __name__ == '__main__':
    g = load_generator_state(sys.argv[1])
    print(len(g))
    for k in list(g)[:25] + list(g)[-8:]:
        print(k, tuple(g[k].shape))
