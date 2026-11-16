// После упаковки убираем файлы нейронки для чужих платформ: каждая из них
// весит 60–90 МБ, а установщику под винду не нужны маковские и наоборот.
const fs = require('fs');
const path = require('path');

const KEEP = { win32: 'win32/x64', darwin: 'darwin/arm64', linux: 'linux/x64' };

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const bin = path.join(resources, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (fs.existsSync(bin)) {
    const keep = KEEP[platform];
    for (const os of fs.readdirSync(bin)) {
      for (const arch of fs.readdirSync(path.join(bin, os))) {
        if (`${os}/${arch}` !== keep) fs.rmSync(path.join(bin, os, arch), { recursive: true, force: true });
      }
    }
  }
};
