// 定跡: 局面（SFEN の手数なし）ごとに、指し手と回数・評価値・コメントを持つ。
// 保存先は Electron では userData/book.json、ブラウザでは localStorage。
import { Position } from './shogi.js';

const KEY = 'shogi-arena-book';
let book = {}; // { [sfenKey]: { [usi]: { count, eval, depth, comment } } }

export async function loadBook() {
  try {
    book = window.api ? await window.api.bookGet() : JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { book = {}; }
  book ||= {};
  return book;
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      if (window.api) window.api.bookSet(book);
      else localStorage.setItem(KEY, JSON.stringify(book));
    } catch { /* 保存失敗は無視 */ }
  }, 300);
}

const keyOf = pos => pos.key();

/** 局面の定跡手（回数の多い順） */
export function bookMoves(pos) {
  const e = book[keyOf(pos)];
  if (!e) return [];
  return Object.entries(e)
    .filter(([usi]) => pos.findMove(usi))
    .map(([usi, v]) => ({ usi, count: v.count || 0, eval: v.eval ?? null, depth: v.depth ?? null, comment: v.comment || '' }))
    .sort((a, b) => b.count - a.count || (b.eval ?? -1e9) - (a.eval ?? -1e9));
}

export function addBookMove(pos, usi, inc = 1) {
  const e = (book[keyOf(pos)] ||= {});
  const v = (e[usi] ||= { count: 0 });
  v.count += inc;
  save();
}

export function updateBookMove(pos, usi, fields) {
  const e = (book[keyOf(pos)] ||= {});
  e[usi] = { ...(e[usi] || { count: 0 }), ...fields };
  save();
}

export function deleteBookMove(pos, usi) {
  const k = keyOf(pos);
  if (!book[k]) return;
  delete book[k][usi];
  if (!Object.keys(book[k]).length) delete book[k];
  save();
}

/** 手順（USI の配列）をまとめて登録。各局面の指し手の回数を 1 増やす */
export function addLineToBook(startSfen, usis) {
  let pos = Position.fromSfen(startSfen);
  let n = 0;
  for (const u of usis) {
    const m = pos.findMove(u);
    if (!m) break;
    const e = (book[keyOf(pos)] ||= {});
    const v = (e[u] ||= { count: 0 });
    v.count++;
    pos = pos.play(m);
    n++;
  }
  save();
  return n;
}

/** 重みつきで定跡手を 1 つ選ぶ（なければ null） */
export function pickBookMove(pos) {
  const ms = bookMoves(pos).filter(m => m.count > 0);
  if (!ms.length) return null;
  const total = ms.reduce((s, m) => s + m.count, 0);
  let r = Math.random() * total;
  for (const m of ms) if ((r -= m.count) < 0) return m.usi;
  return ms[0].usi;
}

export function bookStats() {
  const positions = Object.keys(book).length;
  const moves = Object.values(book).reduce((s, e) => s + Object.keys(e).length, 0);
  return { positions, moves };
}

export function clearBook() {
  book = {};
  save();
}

// ---- やねうら王の定跡形式（YANEURAOU-DB2016） ----

export function importYaneuraou(text) {
  let cur = null, positions = 0, moves = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (line.startsWith('sfen ')) {
      const f = line.slice(5).trim().split(/\s+/);
      const k = f.slice(0, 3).join(' ');
      cur = (book[k] ||= {});
      positions++;
      continue;
    }
    if (!cur) continue;
    const t = line.split(/\s+/);
    if (!t[0] || t[0] === 'none') continue;
    const v = cur[t[0]] || { count: 0 };
    v.count = Math.max(v.count, +t[4] || 1);
    if (t[2] != null && !Number.isNaN(+t[2])) v.eval = +t[2];
    if (t[3] != null && !Number.isNaN(+t[3])) v.depth = +t[3];
    cur[t[0]] = v;
    moves++;
  }
  save();
  return { positions, moves };
}

export function exportYaneuraou() {
  const out = ['#YANEURAOU-DB2016 1.00'];
  for (const k of Object.keys(book).sort()) {
    out.push(`sfen ${k} 1`);
    const ms = Object.entries(book[k]).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    for (const [usi, v] of ms) out.push(`${usi} none ${v.eval ?? 0} ${v.depth ?? 0} ${v.count || 1}`);
  }
  return out.join('\n') + '\n';
}
