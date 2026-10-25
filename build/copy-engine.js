// 配布用に Sailfish 1.0 と Sailfish 2 を engines/ へコピーする（隣のフォルダでビルドしたもの）
// Sailfish 2 は、どの CPU でも動く版（sailfish2.exe）と AVX2 版（sailfish2-avx2.exe）の2つ。AVX2 版は Sailfish2 フォルダで
//   RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --release --target-dir target-avx2
// でビルドしたもの。将棋アリーナは、CPU が対応していれば AVX2 版を使う（main.js の pickEngineExe）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engines = [
  { dir: 'Sailfish', exe: 'sailfish.exe', hint: 'Sailfish フォルダで cargo build --release' },
  { dir: 'Sailfish2', exe: 'sailfish2.exe', hint: 'Sailfish2 フォルダで cargo build --release' },
  { dir: 'Sailfish2', exe: 'sailfish2-avx2.exe', src: 'sailfish2.exe', targets: ['target-avx2'],
    hint: 'Sailfish2 フォルダで RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --release --target-dir target-avx2' },
];

fs.mkdirSync(path.join(root, 'engines'), { recursive: true });
let failed = false;
for (const { dir, exe, src: srcName = exe, targets = ['target', 'target-dev'], hint } of engines) {
  const candidates = targets.map(t => path.join(root, '..', dir, t, 'release', srcName));
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
