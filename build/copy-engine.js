// 配布用に Sailfish 1.0 と Sailfish 2 を engines/ へコピーする（隣のフォルダでビルドしたもの）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engines = [
  { dir: 'Sailfish', exe: 'sailfish.exe', hint: 'Sailfish フォルダで cargo build --release' },
  { dir: 'Sailfish2', exe: 'sailfish2.exe', hint: 'Sailfish2 フォルダで cargo build --release' },
];

fs.mkdirSync(path.join(root, 'engines'), { recursive: true });
let failed = false;
for (const { dir, exe, hint } of engines) {
  const candidates = [
    path.join(root, '..', dir, 'target', 'release', exe),
    path.join(root, '..', dir, 'target-dev', 'release', exe),
  ];
  const src = candidates.filter(p => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!src) {
    console.error(`${exe} が見つかりません。${hint} を実行してください。`);
    failed = true;
    continue;
  }
  fs.copyFileSync(src, path.join(root, 'engines', exe));
  console.log(`engines/${exe} <- ${src}`);
}
if (failed) process.exit(1);
