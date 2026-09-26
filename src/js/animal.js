// 「どうぶつ」テーマの駒（オリジナルの猫と犬のイラストを SVG で描く）
// 先手は猫、後手は犬。駒の種類は毛色と首元の名札（駒の字）で見分ける。
import { BLACK, KING, unpromote } from './shogi.js';

const LINE = '#4a3526';

// 駒の種類ごとの毛色 [地の色, 模様・耳の色]
const CAT_COLORS = {
  1: ['#fffaf2', '#f7c9a0'], // 歩: 白猫
  2: ['#d6d6d6', '#9e9e9e'], // 香: 灰猫
  3: ['#f6b26b', '#e07b2a'], // 桂: 茶トラ
  4: ['#f3e3c3', '#c9a77a'], // 銀: クリーム
  5: ['#5a5a5a', '#2f2f2f'], // 角: 黒猫
  6: ['#f19a4b', '#c9651f'], // 飛: 赤トラ
  7: ['#fffaf2', '#f0a35e'], // 金: 三毛
  8: ['#ffffff', '#f7c9a0'], // 玉: 白猫（王冠）
};
const DOG_COLORS = {
  1: ['#e8a35c', '#c47a34'], // 歩: 柴犬
  2: ['#fffaf2', '#d9c7b0'], // 香: 白い犬
  3: ['#a0673a', '#6e4323'], // 桂: 茶色い犬
  4: ['#c7c7c7', '#8f8f8f'], // 銀: 灰色の犬
  5: ['#3d3d3d', '#1f1f1f'], // 角: 黒い犬
  6: ['#f1c27d', '#c9964d'], // 飛: ゴールデン
  7: ['#fffaf2', '#5a5a5a'], // 金: ぶち犬
  8: ['#e8a35c', '#c47a34'], // 王: 柴犬（王冠）
};

const crown = '<path d="M33 17 L37 3 L45 11 L50 1 L55 11 L63 3 L67 17 Z" fill="#ffd23f" stroke="#4a3526" stroke-width="2.5" stroke-linejoin="round"/><circle cx="50" cy="4" r="2.5" fill="#ff5c7a"/>';

function catFace(base, accent, king, calico) {
  return `
    <path d="M17 44 L20 9 L44 27 Z" fill="${base}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M83 44 L80 9 L56 27 Z" fill="${base}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M22 36 L23 17 L36 28 Z" fill="#ffb3c1"/>
    <path d="M78 36 L77 17 L64 28 Z" fill="#ffb3c1"/>
    <ellipse cx="50" cy="55" rx="38" ry="32" fill="${base}" stroke="${LINE}" stroke-width="3"/>
    ${calico ? `<path d="M20 44 Q30 30 44 34 Q40 48 24 52 Z" fill="${accent}"/><path d="M72 40 Q82 44 84 56 Q74 56 68 48 Z" fill="#5a5a5a"/>` : `<path d="M44 26 Q50 34 56 26" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>`}
    <ellipse cx="36" cy="53" rx="5" ry="6.5" fill="#2b2b2b"/><circle cx="37.5" cy="50.5" r="1.8" fill="#fff"/>
    <ellipse cx="64" cy="53" rx="5" ry="6.5" fill="#2b2b2b"/><circle cx="65.5" cy="50.5" r="1.8" fill="#fff"/>
    <circle cx="27" cy="63" r="4.5" fill="#ffb3c1" opacity=".7"/><circle cx="73" cy="63" r="4.5" fill="#ffb3c1" opacity=".7"/>
    <path d="M46.5 61 L53.5 61 L50 65 Z" fill="#ff8fa3" stroke="${LINE}" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M50 65 Q46 71 41 67 M50 65 Q54 71 59 67" fill="none" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M22 58 L8 55 M22 63 L8 65 M78 58 L92 55 M78 63 L92 65" stroke="${LINE}" stroke-width="1.6" stroke-linecap="round"/>
    ${king ? crown : ''}`;
}

function dogFace(base, accent, king, spotted) {
  return `
    <ellipse cx="17" cy="48" rx="10" ry="21" transform="rotate(18 17 48)" fill="${accent}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="83" cy="48" rx="10" ry="21" transform="rotate(-18 83 48)" fill="${accent}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="50" cy="52" rx="35" ry="33" fill="${base}" stroke="${LINE}" stroke-width="3"/>
    ${spotted ? `<ellipse cx="34" cy="40" rx="9" ry="7" fill="${accent}"/><circle cx="68" cy="32" r="5" fill="${accent}"/>` : ''}
    <ellipse cx="50" cy="66" rx="17" ry="13" fill="#fff4e6"/>
    <ellipse cx="37" cy="48" rx="4.8" ry="6" fill="#2b2b2b"/><circle cx="38.4" cy="45.8" r="1.7" fill="#fff"/>
    <ellipse cx="63" cy="48" rx="4.8" ry="6" fill="#2b2b2b"/><circle cx="64.4" cy="45.8" r="1.7" fill="#fff"/>
    <path d="M31 39 Q37 36 42 39 M58 39 Q63 36 69 39" fill="none" stroke="${LINE}" stroke-width="2" stroke-linecap="round" opacity=".6"/>
    <ellipse cx="50" cy="60" rx="6.5" ry="4.8" fill="#2b2b2b"/><ellipse cx="48" cy="58.6" rx="2" ry="1.2" fill="#fff" opacity=".7"/>
    <path d="M50 65 L50 69 M50 69 Q45 74 40 70 M50 69 Q55 74 60 70" fill="none" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="28" cy="62" r="4" fill="#ffb3c1" opacity=".6"/><circle cx="72" cy="62" r="4" fill="#ffb3c1" opacity=".6"/>
    ${king ? crown : ''}`;
}

/** 駒の中身（顔の SVG と名札）を返す */
export function animalPieceHtml(t, c, label) {
  const base = unpromote(t);
  const isCat = c === BLACK;
  const [col, acc] = (isCat ? CAT_COLORS : DOG_COLORS)[base];
  const king = base === KING;
  const face = isCat ? catFace(col, acc, king, base === 7) : dogFace(col, acc, king, base === 7);
  const promoted = t > KING;
  return `<div class="face animal ${isCat ? 'cat' : 'dog'}">
    <svg viewBox="0 0 100 100" class="animal-svg">${face}</svg>
    <span class="badge${promoted ? ' promo' : ''}">${label}</span></div>`;
}
