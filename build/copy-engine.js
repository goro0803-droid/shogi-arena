// 配布用に Sailfish を engines/ へコピーする（隣の Sailfish フォルダでビルドしたもの）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const candidates = [
  path.join(root, '..', 'Sailfish', 'target', 'release', 'sailfish.exe'),
  path.join(root, '..', 'Sailfish', 'target-dev', 'release', 'sailfish.exe'),
];
const src = candidates.filter(p => fs.existsSync(p))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!src) {
  console.error('sailfish.exe が見つかりません。Sailfish フォルダで cargo build --release を実行してください。');
  process.exit(1);
}
fs.mkdirSync(path.join(root, 'engines'), { recursive: true });
fs.copyFileSync(src, path.join(root, 'engines', 'sailfish.exe'));
console.log(`engines/sailfish.exe <- ${src}`);
