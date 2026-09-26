// 将棋のルール（局面・合法手・SFEN・USI 表記）
// 升の番号: sq = (筋-1)*9 + 段(0=一段目)。先手は段が小さくなる方向へ進む。

export const BLACK = 0, WHITE = 1;
export const PAWN = 1, LANCE = 2, KNIGHT = 3, SILVER = 4, BISHOP = 5, ROOK = 6, GOLD = 7, KING = 8;
export const PROMOTE = 8, HORSE = 13, DRAGON = 14;

export const mkPiece = (c, t) => t | (c << 4);
export const colorOf = p => p >> 4;
export const typeOf = p => p & 15;
export const canPromote = t => t >= PAWN && t <= ROOK;
export const unpromote = t => (t > KING ? t - PROMOTE : t);
export const relRank = (c, r) => (c === BLACK ? r : 8 - r);
export const fileOf = s => Math.floor(s / 9);
export const rankOf = s => s % 9;

const DIRS = [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1], [0, 1], [-1, -2], [1, -2]];
const STEP = [0, 1, 0, 0x300, 0b1100111, 0, 0, 0b10011111, 0xff,
  0b10011111, 0b10011111, 0b10011111, 0b10011111, 0b10011001, 0b01100110];
const SLIDE = [0, 0, 1, 0, 0, 0b01100110, 0b10011001, 0, 0, 0, 0, 0, 0, 0b01100110, 0b10011001];

// NB[手番][升][方向] = 移動先（盤外は -1）
const NB = [0, 1].map(c => Array.from({ length: 81 }, (_, s) => DIRS.map(([df, dr]) => {
  if (c) { df = -df; dr = -dr; }
  const f = fileOf(s) + df, r = rankOf(s) + dr;
  return f >= 0 && f < 9 && r >= 0 && r < 9 ? f * 9 + r : -1;
})));

export const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
const HC_BODY = '/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1';

// 駒落ち。上手（後手）が駒を落とし、上手から指す。penalty はレート計算用の補正値。
export const HANDICAPS = [
  { id: 'hirate', name: '平手', sfen: START_SFEN, penalty: 0 },
  { id: 'kyo', name: '香落ち', sfen: 'lnsgkgsn1/1r5b1' + HC_BODY, penalty: 100 },
  { id: 'kaku', name: '角落ち', sfen: 'lnsgkgsnl/1r7' + HC_BODY, penalty: 200 },
  { id: 'hisha', name: '飛車落ち', sfen: 'lnsgkgsnl/7b1' + HC_BODY, penalty: 300 },
  { id: 'hikyo', name: '飛香落ち', sfen: 'lnsgkgsn1/7b1' + HC_BODY, penalty: 380 },
  { id: 'nimai', name: '二枚落ち', sfen: 'lnsgkgsnl/9' + HC_BODY, penalty: 450 },
  { id: 'yonmai', name: '四枚落ち', sfen: '1nsgkgsn1/9' + HC_BODY, penalty: 600 },
  { id: 'rokumai', name: '六枚落ち', sfen: '2sgkgs2/9' + HC_BODY, penalty: 750 },
  { id: 'hachimai', name: '八枚落ち', sfen: '3gkg3/9' + HC_BODY, penalty: 900 },
  { id: 'jumai', name: '十枚落ち', sfen: '4k4/9' + HC_BODY, penalty: 1000 },
];

const SFEN_CH = { P: PAWN, L: LANCE, N: KNIGHT, S: SILVER, B: BISHOP, R: ROOK, G: GOLD, K: KING };
const CH_SFEN = ['', 'P', 'L', 'N', 'S', 'B', 'R', 'G', 'K'];
const HAND_ORDER = [ROOK, BISHOP, GOLD, SILVER, KNIGHT, LANCE, PAWN];

export const sqToUsi = s => `${fileOf(s) + 1}${'abcdefghi'[rankOf(s)]}`;

export function moveToUsi(m) {
  if (m.drop) return `${CH_SFEN[m.drop]}*${sqToUsi(m.to)}`;
  return sqToUsi(m.from) + sqToUsi(m.to) + (m.promo ? '+' : '');
}

export class Position {
  constructor() {
    this.board = new Array(81).fill(0);
    this.hands = [new Array(8).fill(0), new Array(8).fill(0)];
    this.side = BLACK;
    this.ply = 1;
    this._legal = null;
  }

  clone() {
    const p = new Position();
    p.board = this.board.slice();
    p.hands = [this.hands[0].slice(), this.hands[1].slice()];
    p.side = this.side;
    p.ply = this.ply;
    return p;
  }

  static fromSfen(sfen) {
    const parts = sfen.trim().split(/\s+/);
    if (parts[0] === 'sfen') parts.shift();
    if (parts.length < 3) throw new Error('SFEN が不正です: ' + sfen);
    const p = new Position();
    let r = 0, f = 8, promo = false;
    for (const ch of parts[0]) {
      if (ch === '/') { r++; f = 8; }
      else if (/[1-9]/.test(ch)) f -= +ch;
      else if (ch === '+') promo = true;
      else {
        const t = SFEN_CH[ch.toUpperCase()];
        if (!t || f < 0 || r > 8) throw new Error('SFEN が不正です: ' + sfen);
        p.board[f * 9 + r] = mkPiece(ch === ch.toUpperCase() ? BLACK : WHITE, promo ? t + PROMOTE : t);
        promo = false;
        f--;
      }
    }
    p.side = parts[1] === 'w' ? WHITE : BLACK;
    if (parts[2] !== '-') {
      let n = 0;
      for (const ch of parts[2]) {
        if (/\d/.test(ch)) n = n * 10 + +ch;
        else {
          p.hands[ch === ch.toUpperCase() ? BLACK : WHITE][SFEN_CH[ch.toUpperCase()]] += n || 1;
          n = 0;
        }
      }
    }
    p.ply = +(parts[3] || 1);
    return p;
  }

  toSfen(withPly = true) {
    const rows = [];
    for (let r = 0; r < 9; r++) {
      let row = '', empty = 0;
      for (let f = 8; f >= 0; f--) {
        const pc = this.board[f * 9 + r];
        if (!pc) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        const t = typeOf(pc);
        let ch = CH_SFEN[unpromote(t)];
        if (colorOf(pc) === WHITE) ch = ch.toLowerCase();
        row += (t > KING ? '+' : '') + ch;
      }
      if (empty) row += empty;
      rows.push(row);
    }
    let hand = '';
    for (const c of [BLACK, WHITE]) {
      for (const t of HAND_ORDER) {
        const n = this.hands[c][t];
        if (!n) continue;
        const ch = c === BLACK ? CH_SFEN[t] : CH_SFEN[t].toLowerCase();
        hand += (n > 1 ? n : '') + ch;
      }
    }
    const s = `${rows.join('/')} ${this.side === BLACK ? 'b' : 'w'} ${hand || '-'}`;
    return withPly ? `${s} ${this.ply}` : s;
  }

  /** 千日手判定用のキー */
  key() { return this.toSfen(false); }

  kingSq(c) { return this.board.indexOf(mkPiece(c, KING)); }

  attacked(s, by) {
    const opp = by ^ 1;
    for (let d = 0; d < 10; d++) {
      let a = NB[opp][s][d];
      if (a < 0) continue;
      const pc = this.board[a];
      if (pc) {
        if (colorOf(pc) === by && ((STEP[typeOf(pc)] | SLIDE[typeOf(pc)]) & (1 << d))) return true;
        continue;
      }
      if (d >= 8) continue;
      for (;;) {
        a = NB[opp][a][d];
        if (a < 0) break;
        const q = this.board[a];
        if (q) {
          if (colorOf(q) === by && (SLIDE[typeOf(q)] & (1 << d))) return true;
          break;
        }
      }
    }
    return false;
  }

  inCheck(c = this.side) {
    const k = this.kingSq(c);
    return k >= 0 && this.attacked(k, c ^ 1);
  }

  pseudoMoves() {
    const us = this.side, out = [];
    const push = (from, to, t) => {
      if (canPromote(t) && (relRank(us, rankOf(from)) <= 2 || relRank(us, rankOf(to)) <= 2)) {
        out.push({ from, to, promo: true, drop: 0 });
        const rr = relRank(us, rankOf(to));
        const must = (t === PAWN || t === LANCE) ? rr === 0 : t === KNIGHT ? rr <= 1 : false;
        if (!must) out.push({ from, to, promo: false, drop: 0 });
      } else out.push({ from, to, promo: false, drop: 0 });
    };
    for (let from = 0; from < 81; from++) {
      const pc = this.board[from];
      if (!pc || colorOf(pc) !== us) continue;
      const t = typeOf(pc);
      for (let d = 0; d < 10; d++) {
        if (STEP[t] & (1 << d)) {
          const to = NB[us][from][d];
          if (to >= 0 && (!this.board[to] || colorOf(this.board[to]) !== us)) push(from, to, t);
        }
        if (SLIDE[t] & (1 << d)) {
          let s = from;
          for (;;) {
            const to = NB[us][s][d];
            if (to < 0) break;
            const q = this.board[to];
            if (q) { if (colorOf(q) !== us) push(from, to, t); break; }
            push(from, to, t);
            s = to;
          }
        }
      }
    }
    const pawnFiles = new Set();
    for (let s = 0; s < 81; s++) if (this.board[s] === mkPiece(us, PAWN)) pawnFiles.add(fileOf(s));
    for (let t = PAWN; t <= GOLD; t++) {
      if (!this.hands[us][t]) continue;
      for (let to = 0; to < 81; to++) {
        if (this.board[to]) continue;
        const rr = relRank(us, rankOf(to));
        if ((t === PAWN || t === LANCE) && rr === 0) continue;
        if (t === KNIGHT && rr <= 1) continue;
        if (t === PAWN && pawnFiles.has(fileOf(to))) continue;
        out.push({ from: -1, to, promo: false, drop: t });
      }
    }
    return out;
  }

  /** 指し手を適用した新しい局面を返す（自身は変更しない） */
  play(m) {
    const p = this.clone();
    const us = this.side;
    if (m.drop) {
      p.hands[us][m.drop]--;
      p.board[m.to] = mkPiece(us, m.drop);
    } else {
      const pc = p.board[m.from];
      const cap = p.board[m.to];
      if (cap) p.hands[us][unpromote(typeOf(cap))]++;
      p.board[m.from] = 0;
      p.board[m.to] = m.promo ? pc + PROMOTE : pc;
    }
    p.side ^= 1;
    p.ply++;
    return p;
  }

  legalMoves(skipUchifuzume = false) {
    if (this._legal && !skipUchifuzume) return this._legal;
    const us = this.side, res = [];
    for (const m of this.pseudoMoves()) {
      const p = this.play(m);
      if (p.inCheck(us)) continue;
      if (!skipUchifuzume && m.drop === PAWN) {
        const ek = p.kingSq(us ^ 1);
        if (ek >= 0 && NB[us][m.to][0] === ek && p.legalMoves(true).length === 0) continue; // 打ち歩詰め
      }
      res.push(m);
    }
    if (!skipUchifuzume) this._legal = res;
    return res;
  }

  findMove(usi) {
    return this.legalMoves().find(m => moveToUsi(m) === usi) || null;
  }

  movingType(m) { return m.drop ? m.drop : typeOf(this.board[m.from]); }
  capturedOf(m) { return m.drop ? 0 : this.board[m.to]; }
}
