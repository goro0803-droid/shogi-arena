// 書籍風の局面図を canvas に描く
import { BLACK, WHITE, KING, colorOf, typeOf, fileOf, rankOf } from './shogi.js';
import { FACE, ZEN, KAN } from './kifu.js';

const HAND_ORDER = [6, 5, 7, 4, 3, 2, 1]; // 飛 角 金 銀 桂 香 歩
const NUM = ['', '', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八'];

function handText(pos, c) {
  const items = HAND_ORDER.filter(t => pos.hands[c][t] > 0).map(t => FACE[t] + NUM[pos.hands[c][t]]);
  return items.length ? items.join('　') : 'なし';
}

/** 縦書きで 1 文字ずつ描く。戻り値は描いた高さ */
function vtext(g, text, x, y, size, rotate = false) {
  let yy = y;
  for (const ch of text) {
    if (rotate) {
      g.save();
      g.translate(x, yy + size / 2);
      g.rotate(Math.PI);
      g.fillText(ch, 0, 0);
      g.restore();
    } else {
      g.fillText(ch, x, yy + size / 2);
    }
    yy += ch === '　' ? size * 0.6 : size * 1.05;
  }
  return yy - y;
}

/**
 * opts: { size, font: 'gothic'|'mincho', header, names: [先手名, 後手名], lastTo, flipped }
 */
export function drawDiagram(canvas, pos, opts = {}) {
  const W = opts.size || 500;
  const font = opts.font === 'mincho' ? '"Yu Mincho", "游明朝", serif' : '"Yu Gothic", "Meiryo", sans-serif';
  const cell = Math.floor(W / 13.2);
  const cellH = Math.round(cell * 1.09);
  const headerH = opts.header ? cell * 1.1 : cell * 0.3;
  const boardW = cell * 9, boardH = cellH * 9;
  const side = (W - boardW) / 2;
  const top = headerH + cell * 0.6;
  const H = Math.round(top + boardH + cell * 0.6);
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#111';
  g.strokeStyle = '#111';
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  if (opts.header) {
    g.font = `700 ${Math.round(cell * 0.55)}px ${font}`;
    g.fillText(opts.header, W / 2, headerH * 0.55);
  }

  const x0 = side, y0 = top;
  // 座標
  g.font = `${Math.round(cell * 0.32)}px ${font}`;
  for (let i = 0; i < 9; i++) {
    const f = opts.flipped ? i : 8 - i;
    g.fillText(ZEN[f], x0 + cell * (i + 0.5), y0 - cell * 0.28);
    const r = opts.flipped ? 8 - i : i;
    g.fillText(KAN[r], x0 + boardW + cell * 0.28, y0 + cellH * (i + 0.5));
  }
  // 最終手の升
  if (opts.lastTo != null) {
    const f = fileOf(opts.lastTo), r = rankOf(opts.lastTo);
    const col = opts.flipped ? f : 8 - f, row = opts.flipped ? 8 - r : r;
    g.fillStyle = '#e6e6e6';
    g.fillRect(x0 + col * cell, y0 + row * cellH, cell, cellH);
    g.fillStyle = '#111';
  }
  // 罫線
  g.lineWidth = 1;
  for (let i = 0; i <= 9; i++) {
    g.beginPath();
    g.moveTo(x0 + i * cell, y0);
    g.lineTo(x0 + i * cell, y0 + boardH);
    g.moveTo(x0, y0 + i * cellH);
    g.lineTo(x0 + boardW, y0 + i * cellH);
    g.stroke();
  }
  g.lineWidth = 2.5;
  g.strokeRect(x0, y0, boardW, boardH);
  // 星
  for (const [a, b] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
    g.beginPath();
    g.arc(x0 + a * cell, y0 + b * cellH, Math.max(2, cell * 0.05), 0, Math.PI * 2);
    g.fill();
  }
  // 駒
  g.font = `${Math.round(cell * 0.68)}px ${font}`;
  for (let sq = 0; sq < 81; sq++) {
    const p = pos.board[sq];
    if (!p) continue;
    const f = fileOf(sq), r = rankOf(sq);
    const col = opts.flipped ? f : 8 - f, row = opts.flipped ? 8 - r : r;
    const cx = x0 + (col + 0.5) * cell, cy = y0 + (row + 0.5) * cellH;
    const t = typeOf(p), c = colorOf(p);
    const ch = t === KING ? (c === BLACK ? '玉' : '王') : FACE[t];
    const rev = (c === WHITE) !== !!opts.flipped;
    g.save();
    g.translate(cx, cy);
    if (rev) g.rotate(Math.PI);
    g.fillText(ch, 0, cell * 0.03);
    g.restore();
  }
  // 持駒（左に上側の手番、右に下側の手番を縦書き）
  const names = opts.names || ['先手', '後手'];
  const fs = Math.round(cell * 0.46);
  g.font = `${fs}px ${font}`;
  const topC = opts.flipped ? BLACK : WHITE, botC = topC ^ 1;
  const label = c => `${c === BLACK ? '▲' : '△'}${names[c]}　持駒　${handText(pos, c)}`;
  vtext(g, label(topC), side / 2, y0, fs);
  // 右側は下寄せ
  const txt = label(botC);
  let h = 0;
  for (const ch of txt) h += ch === '　' ? fs * 0.6 : fs * 1.05;
  vtext(g, txt, W - side / 2, Math.max(y0, y0 + boardH - h), fs);
  return canvas;
}
