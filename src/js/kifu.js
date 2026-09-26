// 棋譜の日本語表記・KIF / KI2 / CSA / SFEN の読み書き
import {
  Position, BLACK, WHITE, canPromote, relRank, rankOf, fileOf, typeOf, colorOf, mkPiece,
  HANDICAPS, START_SFEN, moveToUsi, ROOK, BISHOP, HORSE, DRAGON, PROMOTE, KING,
} from './shogi.js';

export const ZEN = ['１', '２', '３', '４', '５', '６', '７', '８', '９'];
export const KAN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const KIF_NAME = ['', '歩', '香', '桂', '銀', '角', '飛', '金', '玉', 'と', '成香', '成桂', '成銀', '馬', '龍'];
/** 駒の表面に書く 1 文字 */
export const FACE = ['', '歩', '香', '桂', '銀', '角', '飛', '金', '玉', 'と', '杏', '圭', '全', '馬', '龍'];
const CSA_CODE = ['', 'FU', 'KY', 'KE', 'GI', 'KA', 'HI', 'KI', 'OU', 'TO', 'NY', 'NK', 'NG', 'UM', 'RY'];

const sqJa = s => ZEN[fileOf(s)] + KAN[rankOf(s)];

// ---------------------------------------------------------------- 右・左・上・引・寄・直

/** 指した側から見た縦方向（上 / 引 / 寄） */
function vertOf(c, from, to) {
  const fwd = (rankOf(to) - rankOf(from)) * (c === BLACK ? -1 : 1);
  return fwd > 0 ? '上' : fwd < 0 ? '引' : '寄';
}
/** 指した側から見て右にあるほど大きい値 */
const rightness = (c, s) => (c === BLACK ? -fileOf(s) : fileOf(s));
const isSlider = t => t === ROOK || t === BISHOP || t === HORSE || t === DRAGON;

/** 同じ升に同種の駒が複数動ける場合の区別（例: 右, 左上, 直） */
export function modifiersFor(pos, m) {
  if (m.drop) return '';
  const t = typeOf(pos.board[m.from]);
  const froms = [...new Set(pos.legalMoves()
    .filter(o => !o.drop && o.to === m.to && typeOf(pos.board[o.from]) === t)
    .map(o => o.from))];
  if (froms.length < 2) return '';
  const c = pos.side, me = m.from, to = m.to;
  const V = vertOf(c, me, to);
  const unique = pred => froms.filter(pred).length === 1 && pred(me);
  if (unique(s => vertOf(c, s, to) === V)) return V;
  const straight = s => fileOf(s) === fileOf(to) && vertOf(c, s, to) === '上';
  if (!isSlider(t) && unique(straight)) return '直';
  const rx = rightness(c, me);
  const others = froms.filter(s => s !== me);
  if (others.every(s => rightness(c, s) < rx)) return '右';
  if (others.every(s => rightness(c, s) > rx)) return '左';
  const sameV = others.filter(s => vertOf(c, s, to) === V);
  if (sameV.every(s => rightness(c, s) < rx)) return '右' + V;
  if (sameV.every(s => rightness(c, s) > rx)) return '左' + V;
  return '';
}

/** 指し手を日本語で表記する（例: ▲７六歩, △同　銀右成, ▲５五角打） */
export function moveToJa(pos, m, prevTo = -1, withMark = true, withModifiers = true) {
  const mark = withMark ? (pos.side === BLACK ? '▲' : '△') : '';
  const dest = m.to === prevTo ? '同　' : sqJa(m.to);
  const t = pos.movingType(m);
  const name = KIF_NAME[t];
  if (m.drop) {
    // 盤上の同じ駒でもその升へ行ける場合だけ「打」を付ける
    const ambiguous = pos.legalMoves().some(o => !o.drop && o.to === m.to && typeOf(pos.board[o.from]) === t);
    return mark + dest + name + (ambiguous ? '打' : '');
  }
  let s = mark + dest + name + (withModifiers ? modifiersFor(pos, m) : '');
  if (m.promo) s += '成';
  else if (canPromote(t) && (relRank(pos.side, rankOf(m.from)) <= 2 || relRank(pos.side, rankOf(m.to)) <= 2)) s += '不成';
  return s;
}

// ---------------------------------------------------------------- 書き出し

const pad = (s, n) => {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
};

/** 棋譜情報の項目（KIF のヘッダー名） */
export const INFO_FIELDS = [
  ['event', '棋戦'], ['date', '開始日時'], ['place', '場所'], ['timeControl', '持ち時間'], ['note', '備考'],
];

export function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function header(record) {
  const lines = [];
  const info = record.info || {};
  if (!info.date) lines.push(`開始日時：${nowStamp()}`);
  for (const [k, label] of INFO_FIELDS) if (info[k]) lines.push(`${label}：${info[k]}`);
  const hc = HANDICAPS.find(h => h.sfen === record.startSfen);
  if (hc) lines.push(`手合割：${hc.name}`);
  else lines.push(...toBod(Position.fromSfen(record.startSfen)));
  const upper = hc && hc.id !== 'hirate';
  lines.push(`${upper ? '下手' : '先手'}：${record.black || ''}`);
  lines.push(`${upper ? '上手' : '後手'}：${record.white || ''}`);
  return lines;
}

/** 局面図（BOD 形式） */
export function toBod(pos) {
  const handStr = c => {
    const s = [7, 6, 5, 4, 3, 2, 1].map(t => (pos.hands[c][t] ? KIF_NAME[t] + (pos.hands[c][t] > 1 ? KAN[pos.hands[c][t] - 1] || pos.hands[c][t] : '') : '')).filter(Boolean);
    return s.length ? s.join('　') : 'なし';
  };
  const lines = [`後手の持駒：${handStr(WHITE)}`, '  ９ ８ ７ ６ ５ ４ ３ ２ １', '+---------------------------+'];
  for (let r = 0; r < 9; r++) {
    let row = '|';
    for (let f = 8; f >= 0; f--) {
      const p = pos.board[f * 9 + r];
      row += p ? (colorOf(p) === WHITE ? 'v' : ' ') + FACE[typeOf(p)].replace('玉', colorOf(p) === WHITE ? '玉' : '玉') : ' ・';
    }
    lines.push(`${row}|${KAN[r]}`);
  }
  lines.push('+---------------------------+', `先手の持駒：${handStr(BLACK)}`);
  if (pos.side === WHITE) lines.push('後手番');
  return lines;
}

const usiOf = mv => (typeof mv === 'string' ? mv : mv.usi);

/**
 * 棋譜の木構造。ノードは { usi, comment, time, children: [...] }、根は { comment, children }。
 * children[0] が本譜、それ以降が変化。
 */
export function linearTree(moves, comments = {}) {
  const root = { comment: comments[0] || '', children: [] };
  let cur = root;
  moves.forEach((mv, i) => {
    const node = { usi: usiOf(mv), comment: (typeof mv === 'object' && mv.comment) || comments[i + 1] || '', time: mv.time || 0, children: [] };
    cur.children.push(node);
    cur = node;
  });
  return root;
}

/** 本譜（children[0] をたどった手順） */
export function mainLine(tree) {
  const out = [];
  for (let n = tree.children[0]; n; n = n.children[0]) out.push(n.usi);
  return out;
}

const kifMove = (pos, m, prevTo) => {
  const s = moveToJa(pos, m, prevTo, false, false);
  return m.drop ? (s.endsWith('打') ? s : s + '打') : `${s}(${fileOf(m.from) + 1}${rankOf(m.from) + 1})`;
};
const kifTime = ms => {
  const t = Math.round((ms || 0) / 1000);
  return `( ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}/)`;
};

/** KIF 形式。record: { startSfen, tree または moves, black, white, result }。変化も書き出す */
export function toKif(record) {
  const lines = ['# ---- Shogi Arena 棋譜ファイル ----', ...header(record), '手数----指手---------消費時間--'];
  const tree = record.tree || linearTree(record.moves || []);
  if (tree.comment) tree.comment.split('\n').forEach(c => lines.push('*' + c));

  // parent.children[idx] から始まる一続きの手順を書き、分岐は後ろから順に「変化」として書く
  const emit = (pos, parent, idx, ply, prevTo, isMain) => {
    const forks = [];
    let node = parent.children[idx];
    let first = true;
    while (node) {
      const m = pos.findMove(node.usi);
      if (!m) break;
      if (!first || idx === 0) {
        const alts = parent.children.slice(1);
        if (alts.length) forks.push({ pos, parent, ply, prevTo });
      }
      lines.push(`${String(ply).padStart(4)} ${pad(kifMove(pos, m, prevTo), 14)}${kifTime(node.time)}`);
      if (node.comment) node.comment.split('\n').forEach(c => lines.push('*' + c));
      if (node.bookmark) lines.push('&' + node.bookmark);
      pos = pos.play(m);
      prevTo = m.to;
      parent = node;
      node = node.children[0];
      ply++;
      first = false;
    }
    if (isMain && record.result) lines.push(`${String(ply).padStart(4)} ${record.result}`);
    for (const f of forks.reverse()) {
      for (let k = 1; k < f.parent.children.length; k++) {
        lines.push('', `変化：${f.ply}手`);
        emit(f.pos, f.parent, k, f.ply, f.prevTo, false);
      }
    }
  };
  emit(Position.fromSfen(record.startSfen), tree, 0, 1, -1, true);
  return lines.join('\r\n') + '\r\n';
}

/** KI2 形式 */
export function toKi2(record) {
  const lines = [...header(record), ''];
  let pos = Position.fromSfen(record.startSfen);
  let prevTo = -1, row = [];
  for (const mv of record.moves) {
    const m = pos.findMove(usiOf(mv));
    if (!m) break;
    row.push(pad(moveToJa(pos, m, prevTo), 12));
    if (row.length === 6) { lines.push(row.join('').trimEnd()); row = []; }
    pos = pos.play(m);
    prevTo = m.to;
  }
  if (row.length) lines.push(row.join('').trimEnd());
  if (record.result) lines.push(`まで${record.moves.length}手で${record.result}`);
  return lines.join('\r\n') + '\r\n';
}

/** CSA 形式 */
export function toCsa(record) {
  const lines = ['V2.2', `N+${record.black || ''}`, `N-${record.white || ''}`];
  const start = Position.fromSfen(record.startSfen);
  if (record.startSfen === START_SFEN) lines.push('PI', '+');
  else {
    for (let r = 0; r < 9; r++) {
      let row = `P${r + 1}`;
      for (let f = 8; f >= 0; f--) {
        const p = start.board[f * 9 + r];
        row += p ? (colorOf(p) === BLACK ? '+' : '-') + CSA_CODE[typeOf(p)] : ' * ';
      }
      lines.push(row);
    }
    for (const c of [BLACK, WHITE]) {
      let h = '';
      for (let t = 1; t <= 7; t++) for (let i = 0; i < start.hands[c][t]; i++) h += '00' + CSA_CODE[t];
      if (h) lines.push(`P${c === BLACK ? '+' : '-'}${h}`);
    }
    lines.push(start.side === BLACK ? '+' : '-');
  }
  let pos = start;
  for (const mv of record.moves) {
    const m = pos.findMove(usiOf(mv));
    if (!m) break;
    const sign = pos.side === BLACK ? '+' : '-';
    const from = m.drop ? '00' : `${fileOf(m.from) + 1}${rankOf(m.from) + 1}`;
    const t = pos.movingType(m) + (m.promo ? PROMOTE : 0);
    lines.push(`${sign}${from}${fileOf(m.to) + 1}${rankOf(m.to) + 1}${CSA_CODE[t]}`);
    if (mv.time) lines.push(`T${Math.round(mv.time / 1000)}`);
    pos = pos.play(m);
  }
  const R = { 投了: '%TORYO', 千日手: '%SENNICHITE', 中断: '%CHUDAN', 詰み: '%TSUMI', 時間切れ: '%TIME_UP', 入玉宣言: '%KACHI' };
  const key = Object.keys(R).find(k => (record.result || '').includes(k));
  if (key) lines.push(R[key]);
  return lines.join('\r\n') + '\r\n';
}

/** 1 手を CSA 形式にする（例: +7776FU）。成りは成った後の駒で書く */
export function csaMoveString(pos, m) {
  const sign = pos.side === BLACK ? '+' : '-';
  const from = m.drop ? '00' : `${fileOf(m.from) + 1}${rankOf(m.from) + 1}`;
  const t = pos.movingType(m) + (m.promo ? PROMOTE : 0);
  return `${sign}${from}${fileOf(m.to) + 1}${rankOf(m.to) + 1}${CSA_CODE[t]}`;
}

/** CSA 形式の 1 手（+7776FU 形式）を局面の合法手に変換する。なければ null */
export function parseCsaMove(pos, s) {
  const mm = s.match(/^([+-])(\d)(\d)(\d)(\d)([A-Z]{2})/);
  if (!mm) return null;
  if ((mm[1] === '+' ? BLACK : WHITE) !== pos.side) return null;
  const to = (+mm[4] - 1) * 9 + (+mm[5] - 1), t = CSA_CODE.indexOf(mm[6]);
  if (mm[2] === '0') return pos.legalMoves().find(x => x.drop === t && x.to === to) || null;
  const from = (+mm[2] - 1) * 9 + (+mm[3] - 1);
  return pos.legalMoves().find(x => x.from === from && x.to === to && (typeOf(pos.board[x.from]) + (x.promo ? PROMOTE : 0)) === t) || null;
}

/** USI の position コマンド */
export function toUsi(record) {
  const base = record.startSfen === START_SFEN ? 'position startpos' : `position sfen ${record.startSfen}`;
  const ms = record.moves.map(usiOf);
  return ms.length ? `${base} moves ${ms.join(' ')}` : base;
}

// ---------------------------------------------------------------- 読み込み

const KIF_TYPES = [
  ['成香', 10], ['成桂', 11], ['成銀', 12], ['杏', 10], ['圭', 11], ['全', 12],
  ['歩', 1], ['香', 2], ['桂', 3], ['銀', 4], ['角', 5], ['飛', 6], ['金', 7], ['玉', 8], ['王', 8],
  ['と', 9], ['馬', 13], ['龍', 14], ['竜', 14],
];
const END_WORDS = ['投了', '中断', '詰み', '千日手', '持将棋', '切れ負け', '反則勝ち', '反則負け', '入玉勝ち', '不戦勝', '不戦敗', '時間切れ'];
const HALF = s => s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/**
 * テキストから棋譜を読み込む。KIF / KI2 / CSA / SFEN / USI に対応。
 * 戻り値: { startSfen, moves: [usi...], comments: {手数: コメント}, black, white, result }
 */
export function parseRecord(text) {
  const rec = parseRecordInner(text);
  rec.tree ||= linearTree(rec.moves, rec.comments || {});
  return rec;
}

function parseRecordInner(text) {
  text = text.replace(/^﻿/, '').trim();
  const usiMatch = text.match(/^(?:position\s+)?(startpos|sfen\s+\S+\s+[bw]\s+\S+(?:\s+\d+)?)(?:\s+moves\s+(.*))?$/s);
  if (usiMatch) {
    const startSfen = usiMatch[1] === 'startpos' ? START_SFEN : usiMatch[1].replace(/^sfen\s+/, '');
    return validate({ startSfen, moves: (usiMatch[2] || '').trim().split(/\s+/).filter(Boolean) });
  }
  if (/^[1-9lnsgkrbpLNSGKRBP+/]+\s+[bw]\s+\S+/.test(text)) return validate({ startSfen: text, moves: [] });
  if (/^(V2|PI|P1|[+-]\d{4}[A-Z]{2}|N[+-])/m.test(text) && !/手数/.test(text)) return parseCsa(text);
  if (!/^\s*\d+\s+\S/m.test(text) && /[▲△☗☖]/.test(text)) return parseKi2(text);
  return parseKif(text);
}

function validate(rec) {
  let pos = Position.fromSfen(rec.startSfen);
  const ok = [];
  for (const u of rec.moves) {
    const m = pos.findMove(u);
    if (!m) break;
    ok.push(u);
    pos = pos.play(m);
  }
  rec.moves = ok;
  rec.comments ||= {};
  return rec;
}

/** 局面図（BOD）を読み込む。見つからなければ null */
function parseBod(lines) {
  const rows = lines.filter(l => /^\|.*\|[一二三四五六七八九]/.test(l.trim()));
  if (rows.length !== 9) return null;
  const pos = new Position();
  rows.forEach((row, r) => {
    const body = row.trim().slice(1, row.trim().lastIndexOf('|'));
    const cells = body.match(/[ v].|・/g) || [];
    let f = 8;
    for (const cell of body.match(/(?:[ v][^ v・|]|\s?・)/g) || cells) {
      const cc = cell.trim();
      if (cc !== '・') {
        const gote = cell.startsWith('v');
        const name = cc.replace('v', '');
        const kt = KIF_TYPES.find(([n]) => n === name) || (name === '王' ? ['王', 8] : null);
        if (kt) pos.board[f * 9 + r] = mkPiece(gote ? WHITE : BLACK, kt[1]);
      }
      f--;
    }
  });
  for (const l of lines) {
    const m = l.match(/^(先手|後手|下手|上手)の持駒[：:](.*)$/);
    if (!m) continue;
    const c = m[1] === '先手' || m[1] === '下手' ? BLACK : WHITE;
    for (const tok of m[2].split(/[\s　]+/)) {
      const kt = KIF_TYPES.find(([n]) => tok.startsWith(n));
      if (!kt) continue;
      const rest = tok.slice(kt[0].length);
      const n = rest ? (KAN.indexOf(rest[rest.length - 1]) + 1 + (rest.startsWith('十') ? 10 : 0) || parseInt(HALF(rest), 10) || 1) : 1;
      pos.hands[c][kt[1]] += rest === '十' ? 10 : n;
    }
  }
  pos.side = lines.some(l => /^(後手番|上手番)/.test(l.trim())) ? WHITE : BLACK;
  return pos.toSfen();
}

function parseHeaderLine(rec, line) {
  let mm;
  if ((mm = line.match(/^手合割[：:]\s*(.+)$/))) {
    const hc = HANDICAPS.find(h => mm[1].trim().startsWith(h.name));
    if (hc) rec.startSfen = hc.sfen;
    return true;
  }
  if ((mm = line.match(/^(?:先手|下手)[：:]\s*(.*)$/))) { rec.black = mm[1]; return true; }
  if ((mm = line.match(/^(?:後手|上手)[：:]\s*(.*)$/))) { rec.white = mm[1]; return true; }
  for (const [k, label] of INFO_FIELDS) {
    if ((mm = line.match(new RegExp(`^${label}[：:]\\s*(.*)$`)))) {
      rec.info ||= {};
      rec.info[k] = mm[1];
      return true;
    }
  }
  return /^[^\s]+[：:]/.test(line);
}

/** KIF を木構造で読み込む（「変化：N手」の分岐も読む） */
function parseKif(text) {
  const rec = { startSfen: START_SFEN, moves: [], black: '', white: '', result: '' };
  const lines = text.split(/\r?\n/);
  const bod = parseBod(lines);
  if (bod) rec.startSfen = bod;
  const root = { comment: '', children: [] };
  let path = [root]; // path[i] = i 手目のノード
  const paths = [];
  let pos = null, prevTo = -1, skip = false;
  const replay = p => {
    let q = Position.fromSfen(rec.startSfen), to = -1;
    for (const n of p.slice(1)) {
      const m = q.findMove(n.usi);
      q = q.play(m);
      to = m.to;
    }
    return [q, to];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('&')) { // しおり
      if (!skip && path.length > 1) path[path.length - 1].bookmark = line.slice(1).trim();
      continue;
    }
    if (line.startsWith('*')) {
      if (skip) continue;
      const node = path[path.length - 1];
      node.comment = (node.comment ? node.comment + '\n' : '') + line.slice(1);
      continue;
    }
    let mm;
    if ((mm = line.match(/^変化[：:]\s*(\d+)/))) {
      const n = +mm[1];
      paths.push(path);
      const base = [...paths].reverse().find(p => p.length > n);
      if (!base) { skip = true; continue; }
      path = base.slice(0, n);
      [pos, prevTo] = replay(path);
      skip = false;
      continue;
    }
    if (!(mm = line.match(/^(\d+)\s+([▲△☗☖]?同[\s　]*\S+|\S+)(.*)$/))) {
      if (!pos) parseHeaderLine(rec, line);
      continue;
    }
    if (skip) continue;
    if (!pos) pos = Position.fromSfen(rec.startSfen);
    const tok = mm[2].replace(/^[▲△☗☖]/, '');
    if (END_WORDS.some(w => tok.startsWith(w))) {
      if (!paths.length) rec.result = tok;
      skip = true;
      continue;
    }
    const m = parseJaMove(pos, tok, prevTo);
    if (!m) { skip = true; continue; }
    const parent = path[path.length - 1];
    const usi = moveToUsi(m);
    let node = parent.children.find(c => c.usi === usi);
    if (!node) {
      const tm = (mm[3] || '').match(/\(\s*(\d+):(\d+)/);
      node = { usi, comment: '', time: tm ? (+tm[1] * 60 + +tm[2]) * 1000 : 0, children: [] };
      parent.children.push(node);
    }
    path.push(node);
    pos = pos.play(m);
    prevTo = m.to;
  }
  rec.tree = root;
  rec.moves = mainLine(root);
  return rec;
}

function parseKi2(text) {
  const rec = { startSfen: START_SFEN, moves: [], comments: {}, black: '', white: '', result: '' };
  const lines = text.split(/\r?\n/);
  const bod = parseBod(lines);
  if (bod) rec.startSfen = bod;
  let body = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('*')) continue;
    if (line.startsWith('まで')) { const r = line.match(/で(.*)$/); rec.result = r ? r[1] : ''; continue; }
    if (/[▲△☗☖]/.test(line) && !/[：:]/.test(line)) { body += ' ' + line; continue; }
    parseHeaderLine(rec, line);
  }
  let pos = Position.fromSfen(rec.startSfen), prevTo = -1;
  for (let tok of body.split(/[▲△☗☖]/).slice(1)) {
    tok = tok.trim().replace(/^同[\s　]+/, '同').replace(/[\s　].*$/, '');
    if (!tok) continue;
    const m = parseJaMove(pos, tok.replace(/^同/, '同　'), prevTo);
    if (!m) break;
    rec.moves.push(moveToUsi(m));
    pos = pos.play(m);
    prevTo = m.to;
  }
  return rec;
}

/** 日本語の指し手 1 つ（KIF / KI2 共通）を解釈する */
function parseJaMove(pos, tok, prevTo) {
  let to, rest;
  tok = tok.replace(/^[▲△☗☖]/, '');
  if (tok.startsWith('同')) {
    to = prevTo;
    rest = tok.slice(1).replace(/^[\s　]+/, '');
  } else {
    const f = ZEN.indexOf(tok[0]) >= 0 ? ZEN.indexOf(tok[0]) : '123456789'.indexOf(tok[0]);
    const r = KAN.indexOf(tok[1]);
    if (f < 0 || r < 0) return null;
    to = f * 9 + r;
    rest = tok.slice(2);
  }
  let from = -1;
  const fm = rest.match(/\((\d)(\d)\)/);
  if (fm) {
    from = (+fm[1] - 1) * 9 + (+fm[2] - 1);
    rest = rest.replace(/\(.*$/, '');
  }
  const kt = KIF_TYPES.find(([n]) => rest.startsWith(n));
  if (!kt) return null;
  const suffix = rest.slice(kt[0].length);
  const drop = suffix.includes('打');
  const promo = /成$/.test(suffix) && !/不成$/.test(suffix);
  const c = pos.side;
  let cands = pos.legalMoves().filter(m => {
    if (m.to !== to || m.promo !== promo) return false;
    if (from >= 0) return m.from === from;
    if (drop) return m.drop === kt[1];
    return !m.drop && typeOf(pos.board[m.from]) === kt[1];
  });
  if (from < 0 && !drop && cands.length > 1) {
    // KI2 の相対表記で絞り込む
    const V = suffix.match(/[上引寄]/)?.[0];
    if (V) cands = cands.filter(m => vertOf(c, m.from, to) === V);
    if (suffix.includes('直')) cands = cands.filter(m => fileOf(m.from) === fileOf(to) && vertOf(c, m.from, to) === '上');
    if (suffix.includes('右')) { const mx = Math.max(...cands.map(m => rightness(c, m.from))); cands = cands.filter(m => rightness(c, m.from) === mx); }
    if (suffix.includes('左')) { const mn = Math.min(...cands.map(m => rightness(c, m.from))); cands = cands.filter(m => rightness(c, m.from) === mn); }
  }
  if (!cands.length && from < 0 && !drop) {
    const d = pos.legalMoves().find(m => m.to === to && m.drop === kt[1]); // 「打」の省略
    if (d) return d;
  }
  return cands[0] || null;
}

function parseCsa(text) {
  const rec = { startSfen: START_SFEN, moves: [], comments: {}, black: '', white: '', result: '' };
  const stmts = text.split(/\r?\n/).flatMap(l => (l.startsWith("'") ? [l] : l.split(',')));
  let pos = null;
  const setup = new Position();
  let hasSetup = false;
  const RES = { '%TORYO': '投了', '%CHUDAN': '中断', '%SENNICHITE': '千日手', '%TIME_UP': '時間切れ', '%TSUMI': '詰み', '%KACHI': '入玉宣言', '%ILLEGAL_MOVE': '反則' };
  const code = s => CSA_CODE.indexOf(s);
  for (const raw of stmts) {
    const l = raw.trim();
    if (!l || l.startsWith("'") || l.startsWith('V') || l.startsWith('$') || l.startsWith('T')) continue;
    if (l.startsWith('N+')) { rec.black = l.slice(2); continue; }
    if (l.startsWith('N-')) { rec.white = l.slice(2); continue; }
    if (l.startsWith('PI')) {
      const p = Position.fromSfen(START_SFEN);
      for (let i = 2; i + 4 <= l.length; i += 4) {
        const f = +l[i] - 1, r = +l[i + 1] - 1;
        p.board[f * 9 + r] = 0;
      }
      setup.board = p.board;
      hasSetup = true;
      continue;
    }
    if (/^P[1-9]/.test(l)) {
      const r = +l[1] - 1;
      for (let k = 0; k < 9; k++) {
        const cell = l.slice(2 + k * 3, 5 + k * 3);
        const f = 8 - k;
        setup.board[f * 9 + r] = cell.trim() === '*' || !cell.trim() ? 0 : mkPiece(cell[0] === '+' ? BLACK : WHITE, code(cell.slice(1)));
      }
      hasSetup = true;
      continue;
    }
    if (/^P[+-]/.test(l)) {
      const c = l[1] === '+' ? BLACK : WHITE;
      for (let i = 2; i + 4 <= l.length; i += 4) {
        const sq = l.slice(i, i + 2), t = code(l.slice(i + 2, i + 4));
        if (sq === '00' && t > 0 && t < KING) setup.hands[c][t]++;
        else if (t > 0) setup.board[(+sq[0] - 1) * 9 + (+sq[1] - 1)] = mkPiece(c, t);
      }
      hasSetup = true;
      continue;
    }
    if (l === '+' || l === '-') {
      setup.side = l === '+' ? BLACK : WHITE;
      if (hasSetup) rec.startSfen = setup.toSfen();
      continue;
    }
    if (l.startsWith('%')) { rec.result = RES[l] || l; break; }
    const mm = l.match(/^[+-](\d)(\d)(\d)(\d)([A-Z]{2})/);
    if (mm) {
      if (!pos) pos = Position.fromSfen(rec.startSfen);
      const to = (+mm[3] - 1) * 9 + (+mm[4] - 1), t = code(mm[5]);
      const m = mm[1] === '0'
        ? pos.legalMoves().find(x => x.drop === t && x.to === to)
        : pos.legalMoves().find(x => x.from === (+mm[1] - 1) * 9 + (+mm[2] - 1) && x.to === to && (typeOf(pos.board[x.from]) + (x.promo ? PROMOTE : 0)) === t);
      if (!m) break;
      rec.moves.push(moveToUsi(m));
      pos = pos.play(m);
    }
  }
  return rec;
}
