// 評価値グラフ（先手から見た評価値を勝率に換算して描く）
import { MATE_SCORE } from './engine.js';

// 評価値を期待勝率に変換する係数（設定で変更できる）
let sigmoid = 600;
export function setSigmoid(c) { sigmoid = c > 0 ? c : 600; }
export const winRate = cp => 1 / (1 + Math.exp(-cp / sigmoid));

export function formatScore(s) {
  if (s == null) return '—';
  if (Math.abs(s) >= MATE_SCORE - 1000) {
    const n = MATE_SCORE - Math.abs(s);
    return `${s > 0 ? '+' : '-'}詰${n ? ` ${n}手` : ''}`;
  }
  return (s > 0 ? '+' : '') + s;
}

export class EvalGraph {
  constructor(canvas, onPick) {
    this.canvas = canvas;
    this.values = [];
    this.marks = [];
    this.cur = 0;
    this.onPick = onPick;
    canvas.addEventListener('click', e => {
      if (!this.values.length) return;
      const r = canvas.getBoundingClientRect();
      const n = Math.max(this.values.length - 1, 1);
      const i = Math.round(((e.clientX - r.left) / r.width) * n);
      this.onPick?.(Math.max(0, Math.min(this.values.length - 1, i)));
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(values, cur, marks = []) {
    this.values = values;
    this.cur = cur;
    this.marks = marks;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = w * devicePixelRatio;
    c.height = h * devicePixelRatio;
    const g = c.getContext('2d');
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const css = getComputedStyle(document.body);
    const colB = css.getPropertyValue('--black-color').trim() || '#e33';
    const colW = css.getPropertyValue('--white-color').trim() || '#39f';
    const grid = css.getPropertyValue('--text-dim').trim() || '#888';
    const accent = css.getPropertyValue('--accent').trim() || '#fc0';

    g.clearRect(0, 0, w, h);
    g.globalAlpha = 0.35;
    g.strokeStyle = grid;
    g.lineWidth = 1;
    for (const y of [0.25, 0.5, 0.75]) {
      g.beginPath();
      g.moveTo(0, h * y);
      g.lineTo(w, h * y);
      g.stroke();
    }
    g.globalAlpha = 1;

    const n = Math.max(this.values.length - 1, 1);
    const pts = [];
    let last = 0;
    this.values.forEach((v, i) => {
      if (v != null) last = v;
      pts.push([(i / n) * w, (1 - winRate(last)) * h]);
    });
    if (pts.length > 1) {
      const mid = h / 2;
      for (const [clipTop, col] of [[true, colB], [false, colW]]) {
        g.save();
        g.beginPath();
        if (clipTop) g.rect(0, 0, w, mid); else g.rect(0, mid, w, h - mid);
        g.clip();
        g.beginPath();
        g.moveTo(pts[0][0], mid);
        for (const [x, y] of pts) g.lineTo(x, y);
        g.lineTo(pts[pts.length - 1][0], mid);
        g.closePath();
        g.globalAlpha = 0.35;
        g.fillStyle = col;
        g.fill();
        g.restore();
      }
      g.globalAlpha = 1;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.strokeStyle = accent;
      g.lineWidth = 2;
      g.stroke();
    }
    // 悪手マーク
    for (const { i, color } of this.marks) {
      if (!pts[i]) continue;
      g.fillStyle = color;
      g.beginPath();
      g.arc(pts[i][0], pts[i][1], 3.5, 0, Math.PI * 2);
      g.fill();
    }
    // 現在位置
    const x = (this.cur / n) * w;
    g.strokeStyle = accent;
    g.globalAlpha = 0.9;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, h);
    g.stroke();
    g.setLineDash([]);
  }
}
