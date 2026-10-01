// Shogi Arena 本体: 画面遷移・対局 / 検討 / 通信対局の進行・設定・記録
import {
  Position, BLACK, WHITE, START_SFEN, HANDICAPS, moveToUsi, mkPiece, colorOf, typeOf,
  canPromote, unpromote, KING, PAWN, LANCE, KNIGHT, PROMOTE, relRank, rankOf, fileOf,
} from './shogi.js';
import {
  moveToJa, toKif, toKi2, toCsa, toUsi, parseRecord, FACE, csaMoveString, parseCsaMove, INFO_FIELDS, nowStamp,
} from './kifu.js';
import { CsaClient } from './csa.js';
import { drawDiagram } from './diagram.js';
import { animalPieceHtml } from './animal.js';
import { createEngine, hasApi, MATE_SCORE } from './engine.js';
import { BoardView, setPieceStyle } from './board-view.js';
import { EvalGraph, winRate, formatScore, setSigmoid } from './graph.js';
import {
  sfx, burst, ring, confetti, cutIn, toast, setEffectTheme, setVolume, setSpeech, speak, moveReading,
} from './effects.js';
import { S, loadStore, saveStore } from './store.js';
import { LEVELS, TIME_CONTROLS, ACHIEVEMENTS, levelInfo, recordGame, unlock } from './progress.js';
import { situation, commentMove } from './commentary.js';
import {
  loadBook, bookMoves, addBookMove, updateBookMove, deleteBookMove, addLineToBook, pickBookMove,
  bookStats, importYaneuraou, exportYaneuraou,
} from './book.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const THEMES = [
  { id: 'seigaiha', name: '青海波', desc: '紺地に金の波模様（標準）' },
  { id: 'wa', name: '和・雅', desc: '畳の間で榧の盤に向かう' },
  { id: 'cyber', name: 'サイバー', desc: 'ネオンが走る電脳盤' },
  { id: 'pop', name: 'ポップ', desc: 'カラフルで楽しく' },
  { id: 'animal', name: 'どうぶつ', desc: '猫（先手）と犬（後手）の駒で対局' },
];

// =====================================================================
// 画面・モーダル
// =====================================================================

function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  if (name === 'home') renderHome();
  if (name === 'stats') renderStats();
  if (name === 'settings') renderSettings();
}

function modal(html, { cls = '' } = {}) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${cls}">${html}</div>`;
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap && !cls.includes('sticky')) closeModal(); });
  document.body.appendChild(wrap);
  return wrap.querySelector('.modal');
}
function closeModal() { document.querySelectorAll('.modal-wrap').forEach(m => m.remove()); }

function alertBox(title, msg) {
  const m = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p><div class="modal-actions"><button class="btn primary" data-ok>OK</button></div>`);
  m.querySelector('[data-ok]').onclick = closeModal;
}

function confirmBox(title, msg) {
  return new Promise(res => {
    const m = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(msg)}</p>
      <div class="modal-actions"><button class="btn ghost" data-no>キャンセル</button><button class="btn primary" data-yes>OK</button></div>`);
    m.querySelector('[data-yes]').onclick = () => { closeModal(); res(true); };
    m.querySelector('[data-no]').onclick = () => { closeModal(); res(false); };
  });
}

function loading(text) {
  return modal(`<div class="loading"><div class="spinner"></div><div>${esc(text)}</div></div>`, { cls: 'sticky small' });
}

// =====================================================================
// テーマ
// =====================================================================

function applyTheme(id) {
  document.body.dataset.theme = id;
  if (panelWin && !panelWin.closed) panelWin.document.body.dataset.theme = id;
  setEffectTheme(id);
  S.theme = id;
  if (!S.themesUsed.includes(id)) {
    S.themesUsed.push(id);
    if (S.themesUsed.length >= THEMES.length) unlock('themes_all');
  }
  saveStore();
  board.render();
  graph.draw();
  renderThemeSwitch();
}

/** 駒の文字・盤・駒台の見た目を反映する（テーマより優先） */
function applyLook() {
  const b = document.body;
  setPieceStyle(S.pieceStyle || 'one');
  b.dataset.board = S.boardStyle || 'theme';
  b.dataset.piece = S.pieceStyle || 'one';
  if (S.boardStyle === 'image' && S.boardImage) b.style.setProperty('--board-bg', `url("${S.boardImage}") center / cover`);
  else b.style.removeProperty('--board-bg');
  if (S.standImage) b.style.setProperty('--stand-bg', `url("${S.standImage}") center / cover`);
  else b.style.removeProperty('--stand-bg');
  setSigmoid(S.sigmoid || 600);
  board.render();
}

function renderThemeSwitch() {
  $('#theme-switch').innerHTML = THEMES.map(t =>
    `<button class="theme-dot ${S.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}" title="${t.name}"><span class="swatch sw-${t.id}"></span>${t.name}</button>`).join('');
}

// =====================================================================
// エンジン一覧
// =====================================================================

function engineList() {
  if (!hasApi) return [{ id: 'mock', name: '内蔵AI（簡易・ブラウザ用）', path: null }];
  return S.engines;
}

async function probeEngineName(path) {
  const e = createEngine(path);
  try {
    await e.start();
    return e.name || path.split(/[\\/]/).pop();
  } finally {
    e.quit();
  }
}

async function ensureDefaultEngines() {
  if (!hasApi) return;
  const paths = await window.api.engineDefaults();
  // 同梱のエンジン（Sailfish など）の場所が変わったとき（アンインストール、zip 版の移動など）は、
  // 見つからなくなった古い登録を今の場所に付け替え、重複した登録はまとめる
  const bundledName = p => ((/[\\/]resources[\\/]engines[\\/]([^\\/]+)$/i.exec(p || '') || [])[1] || '').toLowerCase();
  for (const cur of paths) {
    const name = bundledName(cur);
    if (!name) continue;
    for (const e of S.engines) {
      if (bundledName(e.path) === name && e.path !== cur && !(await window.api.engineExists(e.path))) e.path = cur;
    }
    const keep = S.engines.find(e => e.path === cur);
    const dupIds = new Set(S.engines.filter(e => e.path === cur && e !== keep).map(e => e.id));
    if (dupIds.size) {
      S.engines = S.engines.filter(e => !dupIds.has(e.id));
      const fix = id => (dupIds.has(id) ? keep.id : id);
      S.analysisEngine = fix(S.analysisEngine);
      if (S.lastPlay) S.lastPlay.engine = fix(S.lastPlay.engine);
      if (S.subEngines) S.subEngines = [...new Set(S.subEngines.map(fix))];
    }
  }
  const fresh = S.engines.length === 0; // 初めての起動（名前はこのあと取るので、取り直しは要らない）
  for (const p of paths) {
    if (S.engines.some(e => e.path === p)) continue;
    let name = 'Sailfish';
    try { name = await probeEngineName(p); } catch { /* 起動できなくても登録だけする */ }
    S.engines.push({ id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6), name, path: p });
  }
  // アプリを更新したあとは、同梱エンジンの表示名（エンジンが名乗る名前）を取り直す
  // （同梱エンジンの版が上がっても、前の版の名前が残らないようにする）
  const ver = await window.api.appVersion();
  if (S.engineNamesVersion !== ver) {
    for (const e of fresh ? [] : S.engines) {
      if (!paths.includes(e.path)) continue;
      try { e.name = await probeEngineName(e.path); } catch { /* 取れなければ今の名前のまま */ }
    }
    S.engineNamesVersion = ver;
  }
  // 検討の初期エンジンは、強いほう（Sailfish 2）があればそちらにする
  if (!S.analysisEngine && S.engines.length) {
    S.analysisEngine = (S.engines.find(e => /sailfish2/i.test(e.path)) || S.engines[0]).id;
  }
  saveStore();
}

const findEngine = id => engineList().find(e => e.id === id) || engineList()[0];

// =====================================================================
// ホーム
// =====================================================================

function profileCardHtml() {
  const p = S.profile, li = levelInfo(p.xp);
  const rate = p.games ? Math.round((p.wins / p.games) * 100) : 0;
  return `
    <div class="avatar"><span>Lv</span><b>${li.level}</b></div>
    <div class="pc-body">
      <div class="pc-name">${esc(p.name)} <span class="pc-title">${li.title}</span></div>
      <div class="xpbar"><div style="width:${(li.cur / li.next) * 100}%"></div></div>
      <div class="pc-stats"><span>EXP ${li.cur} / ${li.next}</span><span>レート <b>${p.rating}</b></span><span>${p.wins}勝 ${p.losses}敗 ${p.draws ? p.draws + '分 ' : ''}(${rate}%)</span></div>
    </div>`;
}

function renderHome() {
  $('#profile-card').innerHTML = profileCardHtml();
  renderThemeSwitch();
  const got = ACHIEVEMENTS.filter(a => S.achievements[a.id]).length;
  $('#home-ach').textContent = `実績 ${got} / ${ACHIEVEMENTS.length}`;
}

// =====================================================================
// 対局状態
// =====================================================================

let G = null;

const board = new BoardView(
  { area: $('#board-area'), board: $('#board'), handTop: $('#hand-top'), handBottom: $('#hand-bottom') },
  {
    onMove: m => onUserMove(m),
    canMove: c => canUserMove(c),
    isEditing: () => G?.mode === 'edit',
    onEdit: ev => onEditInput(ev),
    isPreview: () => !!G?.preview,
    onPreviewClick: () => endPreview(),
    onWheel: dir => { if (G && !G.preview && (G.mode === 'analysis' || G.over)) gotoPly(G.cur + dir); },
  },
);
const graph = new EvalGraph($('#graph'), i => { if (G && (G.mode === 'analysis' || G.over)) gotoPly(i); });

const curPos = () => G.positions[G.cur];
const lastPos = () => G.positions[G.positions.length - 1];
const atEnd = () => G.cur === G.positions.length - 1;

// ---- 棋譜の木構造 ----
// G.root から children をたどる木。G.line は現在表示中の手順（G.line[i] = i 手目のノード）。
// G.moves / G.positions / G.evals / G.best は現在の手順を配列にしたもの。

function newGame(mode, startSfen) {
  const root = { comment: '', children: [], sel: 0, eval: null, best: null };
  G = {
    mode, startSfen, root, line: [root],
    positions: [Position.fromSfen(startSfen)],
    moves: [], evals: [null], best: [null],
    cur: 0, players: [null, null],
    over: false, result: null, token: {},
    live: [], assisted: false, humanMin: 0,
    names: ['', ''], info: { date: nowStamp() },
  };
  $('#tab-live').innerHTML = '';
  $('#board-area .preview-banner')?.remove();
  board.editSel = null;
  board.setArrows([]);
}

/** 現在の手順の末尾にノードをつなぐ（既にある手ならその変化へ進む） */
function pushMove(m, time = 0) {
  const pos = lastPos();
  const parent = G.line[G.line.length - 1];
  const usi = moveToUsi(m);
  let node = parent.children.find(c => c.usi === usi);
  const after = pos.play(m);
  if (!node) {
    const prevTo = G.moves.length ? G.moves[G.moves.length - 1].m.to : -1;
    node = {
      usi, m, ja: moveToJa(pos, m, prevTo), time, captured: pos.capturedOf(m), check: after.inCheck(),
      comment: '', children: [], sel: 0, eval: null, best: null,
    };
    Object.defineProperty(node, 'parent', { value: parent, enumerable: false }); // JSON 化の対象外
    parent.children.push(node);
  } else if (time) node.time = time;
  parent.sel = parent.children.indexOf(node);
  appendNode(node, m, after);
}

function appendNode(node, m, after) {
  node.m = m;
  G.line.push(node);
  G.moves.push(node);
  G.positions.push(after);
  G.evals.push(node.eval ?? null);
  G.best.push(node.best ?? null);
}

/** 表示中の手順を i 手目までに縮める（木のノードは消さない） */
function truncateTo(i) {
  G.line.length = i + 1;
  G.moves.length = i;
  G.positions.length = i + 1;
  G.evals.length = i + 1;
  G.best.length = i + 1;
}

/** 手順の末尾から、各ノードで最後に選んだ変化をたどって延ばす */
function extendLine() {
  for (;;) {
    const n = G.line[G.line.length - 1];
    const next = n.children[n.sel || 0];
    if (!next) break;
    const pos = lastPos();
    const m = pos.findMove(next.usi);
    if (!m) break;
    appendNode(next, m, pos.play(m));
  }
}

/** 評価値・最善手を木のノードへ書き戻す（手順を切り替える前に呼ぶ） */
function syncNodes() {
  G.line.forEach((n, i) => {
    if (G.evals[i] != null) n.eval = G.evals[i];
    if (G.best[i] != null) n.best = G.best[i];
  });
}

/** ply 手目の局面から idx 番目の変化へ切り替える */
function switchBranch(ply, idx) {
  syncNodes();
  const parent = G.line[ply];
  if (!parent.children[idx]) return;
  parent.sel = idx;
  truncateTo(ply);
  extendLine();
  G.cur = -1; // gotoPly で盤を再描画させる
  gotoPly(ply + 1);
}

/** 木の任意のノードへ移動する（その手順に切り替えてから局面を表示） */
function jumpToNode(node) {
  syncNodes();
  const path = [];
  for (let n = node; n && n !== G.root; n = n.parent) path.unshift(n);
  let p = G.root;
  for (const n of path) {
    p.sel = p.children.indexOf(n);
    p = n;
  }
  truncateTo(0);
  extendLine();
  G.cur = -1;
  gotoPly(path.length);
}

// ---- ツリーダイアグラム（検討画面の下部） ----

const TREE_W = 76, TREE_H = 26, TREE_GX = 14, TREE_GY = 10;

// パネルは別ウィンドウへ移動することがあるので、要素への参照で扱う
const treePanel = document.getElementById('tree-panel');
const bottomAnalysis = document.getElementById('bottom-analysis');
let panelWin = null; // 切り離したウィンドウ

// 下のパネルの上端をドラッグして高さを変える（盤はその分小さくなる）
function setTreeHeight(h) {
  if (h) treePanel.style.setProperty('--tree-h', `${h}px`);
  else treePanel.style.removeProperty('--tree-h');
}
$('#tree-resizer').addEventListener('pointerdown', e => {
  e.preventDefault();
  const handle = e.currentTarget;
  const startY = e.clientY, startH = treePanel.getBoundingClientRect().height;
  // 盤が小さくなりすぎないよう、画面の高さから上限を決める
  const maxH = Math.max(140, document.querySelector('#screen-game .game-layout').getBoundingClientRect().height - 280);
  handle.classList.add('dragging');
  const move = ev => {
    S.treeHeight = Math.round(Math.max(120, Math.min(maxH, startH + startY - ev.clientY)));
    setTreeHeight(S.treeHeight);
  };
  const up = () => {
    handle.classList.remove('dragging');
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    saveStore();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#tree-resizer').addEventListener('dblclick', () => {
  delete S.treeHeight;
  setTreeHeight(null);
  saveStore();
});

function renderTree() {
  const panel = treePanel;
  if (!panel) return;
  const inAnalysis = !!G && G.mode === 'analysis';
  const show = inAnalysis && (panelWin || S.showTree !== false);
  document.getElementById('screen-game').classList.toggle('with-tree', !!show && !panelWin);
  panel.classList.toggle('no-game', !inAnalysis);
  panel.querySelector('[data-tree-detach]').textContent = panelWin ? '⇲ 元に戻す' : '⧉ 別ウィンドウ';
  if (panelWin && !inAnalysis) panel.querySelector('.bt-hint').textContent = '検討画面を開くと使えます';
  if (!show) return;
  // 下部パネルのタブ（ツリー / 検討）
  const tab = S.bottomTab === 'analysis' ? 'analysis' : 'tree';
  panel.querySelectorAll('[data-btab]').forEach(b => b.classList.toggle('active', b.dataset.btab === tab));
  panel.querySelectorAll('[data-bpane]').forEach(p => p.classList.toggle('active', p.dataset.bpane === tab));
  panel.querySelector('.bt-hint').textContent = tab === 'tree'
    ? '手をクリックでその局面へ ／ 上の行が本譜、下の行が変化'
    : '読み筋の手をクリックでその局面を表示';
  renderAnalysisTable();
  // 本譜を 0 行目にして、変化ごとに下の行へ並べる
  const items = [];
  let rows = 0;
  const place = (node, ply, row) => {
    node.children.forEach((c, k) => {
      const r = k === 0 ? row : ++rows;
      items.push({ node: c, parentNode: node, ply: ply + 1, row: r, prow: row });
      place(c, ply + 1, r);
    });
  };
  place(G.root, 0, 0);
  const onLine = new Set(G.line);
  const curNode = G.line[G.cur];
  const x = ply => 8 + ply * (TREE_W + TREE_GX);
  const y = row => 16 + row * (TREE_H + TREE_GY);
  const width = x(Math.max(1, ...items.map(i => i.ply)) + 1);
  const height = y(rows + 1);
  let svg = '';
  for (const it of items) {
    const x1 = x(it.ply - 1) + TREE_W, y1 = y(it.prow) + TREE_H / 2;
    const x2 = x(it.ply), y2 = y(it.row) + TREE_H / 2;
    const on = onLine.has(it.node) && onLine.has(it.parentNode) ? ' on' : '';
    // 同じ行は横線、変化は親の下から縦に下ろして横へ
    svg += it.row === it.prow
      ? `<line class="tl${on}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
      : `<path class="tl${on}" d="M${x(it.ply - 1) + TREE_W / 2},${y(it.prow) + TREE_H} V${y2} H${x2}" fill="none"/>`;
  }
  const rootBox = `<div class="tn root ${G.cur === 0 ? 'cur' : 'online'}" data-tn="root" style="left:${x(0)}px;top:${y(0)}px">開始局面</div>`;
  const boxes = items.map((it, i) => {
    const cls = [it.node === curNode ? 'cur' : onLine.has(it.node) ? 'online' : '', it.node.comment ? 'has-cmt' : '', it.row > 0 ? 'var' : ''].join(' ');
    const label = it.node.ja.replace(/^[▲△]/, '');
    const mark = it.node.ja.startsWith('△') ? '△' : '▲';
    return `<div class="tn ${cls}" data-tn="${i}" title="${it.ply}手目 ${esc(it.node.ja)}${it.node.comment ? '\n' + esc(it.node.comment) : ''}" style="left:${x(it.ply)}px;top:${y(it.row)}px"><small>${mark}</small>${esc(label)}</div>`;
  }).join('');
  const plyMarks = Array.from({ length: Math.max(0, ...items.map(i => i.ply)) + 1 }, (_, p) => (p % 10 === 0 && p > 0 ? `<span class="tply" style="left:${x(p)}px">${p}</span>` : '')).join('');
  panel.querySelector('.tree-canvas').innerHTML = `<div class="tree-inner" style="width:${width}px;height:${height}px">
    <svg width="${width}" height="${height}">${svg}</svg>${plyMarks}${rootBox}${boxes}</div>`;
  panel.querySelector('.tree-title').textContent = S.bottomTab === 'analysis' ? '' : `変化 ${rows}`;
  panel._items = items;
  // 現在の手が見えるようにスクロール
  const curEl = panel.querySelector('.tn.cur');
  if (curEl) {
    const c = panel.querySelector('.tree-canvas');
    const left = curEl.offsetLeft - c.clientWidth / 2 + TREE_W / 2;
    const top = curEl.offsetTop - c.clientHeight / 2 + TREE_H / 2;
    c.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' });
  }
}

/** 下部パネルの「検討」タブ（ShogiGUI の検討ウィンドウ風の表） */
function renderAnalysisTable() {
  const box = bottomAnalysis;
  if (!box || !G || G.mode !== 'analysis' || S.bottomTab !== 'analysis') return;
  const ply = G.cur;
  const fmtNodes = n => (n == null ? '—' : n >= 1e8 ? `${(n / 1e8).toFixed(1)}億` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString()}万` : n.toLocaleString());
  const fmtTime = ms => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}秒`);
  const engines = [];
  if (G.analysisEngine) {
    engines.push({ name: G.analysisEngine.name || '検討エンジン', lines: (G.pvLines || []).filter(Boolean), key: k => k, color: k => ARROW_COLORS[k] || 'var(--text-dim)' });
  }
  (G.subEngines || []).forEach((s, i) => engines.push({
    name: s.engine.name || s.ed.name, lines: (s.lines || []).filter(Boolean), key: k => `s${i}_${k}`, color: () => SUB_COLORS[i],
  }));
  const head = `<div class="an-bar">
    <button class="btn small ${G.analyzing ? 'active' : 'primary'}" data-c="analyze">${G.analyzing ? '■ 検討停止' : '▶ 検討開始'}</button>
    <select class="mpv" data-bmpv title="メインエンジンの候補手の数">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${(S.multiPV || 1) === n ? 'selected' : ''}>候補 ${n}</option>`).join('')}</select>
    ${G.subEngines?.length ? `<select class="mpv" data-bsubmpv title="同時検討エンジンの候補手の数">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${(S.subMultiPV || 1) === n ? 'selected' : ''}>サブ候補 ${n}</option>`).join('')}</select>` : ''}
    <select class="mpv" data-bsec title="1 局面あたりの検討時間">${[0, 3, 5, 10, 30, 60].map(n => `<option value="${n}" ${(S.analysisMaxSec || 0) === n ? 'selected' : ''}>${n ? `${n}秒まで` : '時間無制限'}</option>`).join('')}</select>
    <span class="muted small">${ply}手目の局面 ・ ${curPos().side === BLACK ? '先手番' : '後手番'}</span></div>`;
  if (!engines.length) { box.innerHTML = head + '<p class="muted small">検討エンジンがありません（設定でエンジンを追加してください）</p>'; return; }
  const body = engines.map(eng => {
    const first = eng.lines[0];
    const stats = first ? [
      `深さ ${first.depth ?? '-'}${first.seldepth ? '/' + first.seldepth : ''}`,
      first.nodes != null ? `${fmtNodes(first.nodes)}局面` : '',
      first.nps ? `${Math.round(first.nps / 1000).toLocaleString()}k NPS` : '',
      first.time != null ? fmtTime(first.time) : '',
      first.hashfull != null ? `ハッシュ ${(first.hashfull / 10).toFixed(1)}%` : '',
    ].filter(Boolean).join(' ・ ') : (G.analyzing ? '思考中…' : '停止中');
    const rows = eng.lines.map((l, k) => `<tr style="--c:${eng.color(k)}">
      <td class="an-rank">${k + 1}</td><td class="an-score ${l.s > 0 ? 'plus' : l.s < 0 ? 'minus' : ''}">${dispScore(l.s, curPos().side)}</td>
      <td>${l.depth ?? '-'}</td><td>${fmtNodes(l.nodes)}</td><td class="an-pv">${pvSpans(ply, l.pv, eng.key(k), 24)}</td></tr>`).join('');
    return `<div class="an-engine"><div class="an-name"><b>${esc(eng.name)}</b><span>${stats}</span></div>
      ${rows ? `<table class="an-table"><tr><th>候補</th><th>評価値</th><th>深さ</th><th>ノード数</th><th>読み筋</th></tr>${rows}</table>` : ''}</div>`;
  }).join('');
  box.innerHTML = head + body;
  box.dataset.ply = ply;
  box.querySelector('[data-bsubmpv]')?.addEventListener('change', e => setSubMultiPV(+e.target.value));
  box.querySelector('[data-bsec]').onchange = e => {
    S.analysisMaxSec = +e.target.value;
    saveStore();
    if (G.analyzing) restartAnalysis();
  };
  box.querySelector('[data-bmpv]').onchange = e => {
    S.multiPV = +e.target.value;
    saveStore();
    const side = $('#multipv');
    if (side) side.value = e.target.value;
    if (G.analyzing) restartAnalysis();
  };
}

// パネル内のクリックはパネル自身で受ける（別ウィンドウに移っても動くように）
treePanel?.addEventListener('click', e => {
  const bt = e.target.closest('[data-btab]');
  if (bt) {
    S.bottomTab = bt.dataset.btab;
    saveStore();
    renderTree();
    return;
  }
  const t = e.target.closest('[data-tn]');
  if (t && G?.mode === 'analysis') {
    if (t.dataset.tn === 'root') gotoPly(0);
    else jumpToNode(treePanel._items[+t.dataset.tn].node);
    return;
  }
  const pv = e.target.closest('.pv-mv');
  if (pv && G) { onPvClick(pv); return; }
  const c = e.target.closest('[data-c]');
  if (c && !c.disabled) { onControl(c.dataset.c); return; }
  if (e.target.closest('[data-tree-detach]')) {
    if (panelWin) panelWin.close();
    else detachPanel();
    return;
  }
  if (e.target.closest('[data-tree-toggle]')) {
    S.showTree = false;
    saveStore();
    renderTree();
    renderControls();
  }
});

/** 検討・ツリーのパネルを別ウィンドウに切り離す */
function detachPanel() {
  const w = window.open('about:blank', 'shogi-arena-panel', 'width=1100,height=360');
  if (!w) return toast('別ウィンドウを開けませんでした', '', '⚠️');
  const d = w.document;
  d.open();
  d.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>検討・ツリー - 将棋アリーナ</title>
    <link rel="stylesheet" href="${new URL('css/style.css', location.href).href}"></head>
    <body class="panel-window" data-theme="${esc(S.theme)}"><div id="bg"></div></body></html>`);
  d.close();
  panelWin = w;
  treePanel.classList.add('detached');
  d.body.appendChild(d.adoptNode(treePanel));
  d.addEventListener('keydown', onKeyDown);
  w.addEventListener('beforeunload', reattachPanel);
  renderTree();
  renderControls();
  // 盤の大きさを計算し直す
  setTimeout(() => dispatchEvent(new Event('resize')), 50);
}

/** 別ウィンドウを閉じたら元の位置に戻す */
function reattachPanel() {
  if (!panelWin) return;
  panelWin = null;
  treePanel.classList.remove('detached');
  document.querySelector('.game-layout').appendChild(document.adoptNode(treePanel));
  renderTree();
  renderControls();
}

/** 変化を本譜（1 番目）にする */
function promoteBranch(ply, idx) {
  const parent = G.line[ply];
  const [n] = parent.children.splice(idx, 1);
  parent.children.unshift(n);
  parent.sel = 0;
  renderKifu();
  renderBranches();
  toast('本譜にしました', n.ja, '⤴');
}

/** 変化を削除する */
async function deleteBranch(ply, idx) {
  const parent = G.line[ply];
  const n = parent.children[idx];
  if (!await confirmBox('この変化を削除しますか？', `${n.ja} 以降の手順が削除されます。`)) return;
  syncNodes();
  parent.children.splice(idx, 1);
  parent.sel = 0;
  truncateTo(ply);
  extendLine();
  G.cur = -1;
  gotoPly(ply);
}

/** 外部の棋譜の木（{usi, comment, time, children}）を読み込む */
function importTree(src) {
  G.root.comment = src.comment || '';
  G.root.eval = src.eval ?? null;
  G.root.best = src.best ?? null;
  const walk = s => {
    s.children.forEach(c => {
      const depth = G.moves.length;
      const m = lastPos().findMove(c.usi);
      if (!m) return;
      pushMove(m, c.time || 0);
      const node = G.line[G.line.length - 1];
      node.comment = c.comment || '';
      node.bookmark = c.bookmark || '';
      node.eval = c.eval ?? null;
      node.best = c.best ?? null;
      walk(c);
      truncateTo(depth);
    });
  };
  walk(src);
  const resetSel = n => { n.sel = 0; n.children.forEach(resetSel); };
  resetSel(G.root);
  truncateTo(0);
  G.evals[0] = G.root.eval;
  G.best[0] = G.root.best;
  extendLine();
}

function positionCmd(i = G.positions.length - 1) {
  const base = G.startSfen === START_SFEN ? 'position startpos' : `position sfen ${G.startSfen}`;
  const ms = G.moves.slice(0, i).map(x => x.usi);
  return ms.length ? `${base} moves ${ms.join(' ')}` : base;
}

function pvToJa(i, usis, max = 14) {
  let pos = G.positions[i];
  let prevTo = i > 0 ? G.moves[i - 1].m.to : -1;
  const out = [];
  for (const u of usis.slice(0, max)) {
    const m = pos.findMove(u);
    if (!m) break;
    out.push(moveToJa(pos, m, prevTo));
    prevTo = m.to;
    pos = pos.play(m);
  }
  return out.join(' ');
}

function lastKnownEval(i) {
  for (let j = Math.min(i, G.evals.length - 1); j >= 0; j--) if (G.evals[j] != null) return G.evals[j];
  return null;
}

// =====================================================================
// 時計
// =====================================================================

function clockEnabled() { return G && (G.mode === 'play' || G.mode === 'net') && !!G.tc && (G.tc.main > 0 || G.tc.byo > 0 || G.tc.inc > 0); }

/** エンジンに渡す go の時間指定 */
function timeArgs() {
  // 通信対局では通信の遅れを見込んで、エンジンに渡す時間を少し減らす
  const mg = G.mode === 'net' ? (G.netMargin ?? 1000) : 0;
  const r = G.clock.remain.map(x => Math.max(0, Math.round(x - mg)));
  if (G.tc.inc) return `btime ${r[0]} wtime ${r[1]} binc ${G.tc.inc} winc ${G.tc.inc}`;
  return `btime ${r[0]} wtime ${r[1]} byoyomi ${G.tc.byo ? Math.max(500, G.tc.byo - mg) : 0}`;
}

function timeLeft(side) {
  const c = G.clock;
  const running = !G.over && lastPos().side === side && G.turnStart != null;
  const elapsed = running ? performance.now() - G.turnStart : 0;
  const main = c.remain[side] - elapsed;
  return main >= 0 ? { main, byo: G.tc.byo } : { main: 0, byo: G.tc.byo + main };
}

const fmt = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

setInterval(() => {
  if (!G || G.over || G.mode === 'analysis' || G.turnStart == null) return;
  updateClocks();
  if (!clockEnabled()) return;
  const side = lastPos().side;
  const t = timeLeft(side);
  const human = G.players[side].kind === 'human';
  if (human && t.main === 0 && t.byo <= 10000 && t.byo > 0) {
    const sec = Math.ceil(t.byo / 1000);
    if (sec !== G.lastBeep) { G.lastBeep = sec; sfx.tick(); }
  }
  const grace = human ? 0 : 2000;
  if (G.mode !== 'net' && t.byo < -grace) endGame(side ^ 1, '時間切れ'); // 通信対局の時間切れはサーバーが判定する
}, 100);

function updateClocks() {
  for (const side of [BLACK, WHITE]) {
    const el = document.querySelector(`.player-bar[data-side="${side}"] .clock`);
    if (!el) continue;
    if (!clockEnabled()) {
      const running = !G.over && lastPos().side === side && G.turnStart != null;
      el.textContent = running ? fmt(performance.now() - G.turnStart) : '';
      continue;
    }
    const t = timeLeft(side);
    el.innerHTML = t.main > 0 || !G.tc.byo ? fmt(t.main) : `<span class="byo">秒読み ${Math.max(0, Math.ceil(t.byo / 1000))}</span>`;
    el.classList.toggle('danger', t.main === 0 && t.byo <= 10000);
  }
}

// =====================================================================
// 対局の進行
// =====================================================================

function canUserMove(c) {
  if (!G || G.over && G.mode !== 'analysis') return false;
  if (G.mode === 'analysis') return true;
  if (G.waitingStart) return false;
  return (G.mode === 'play' || G.mode === 'net') && atEnd() && G.players[c]?.kind === 'human' && !G.over;
}

async function onUserMove(m) {
  if (G.mode === 'analysis') return analysisMove(m);
  if (G.hintRunning) { await G.players[G.humanSide ^ 1].engine.stop(); G.hintRunning = false; }
  board.setArrows([]);
  if (G.mode === 'net') netSendMove(m, null);
  doMove(m);
}

function doMove(m) {
  const side = lastPos().side;
  const elapsed = G.turnStart != null ? performance.now() - G.turnStart : 0;
  // 通信対局の持ち時間はサーバーから届く消費時間で更新する（netApplyTime）
  if (clockEnabled() && G.mode !== 'net') G.clock.remain[side] = Math.max(0, G.clock.remain[side] - elapsed) + (G.tc.inc || 0);
  pushMove(m, elapsed);
  G.cur = G.positions.length - 1;
  board.setPosition(curPos(), m, true);
  moveEffects(G.moves[G.moves.length - 1]);
  speak(moveReading(G.moves[G.moves.length - 1].ja));
  renderKifu();
  updateEvalUI();
  // 次が人間なら、この手の実況はすぐ出す（評価値の変化はエンジンの手番で判定）
  const next = G.players[curPos().side];
  if (G.mode !== 'analysis' && next?.kind === 'human') announce(G.cur, null);
  startTurn();
}

function moveEffects(mv) {
  sfx.move(!!mv.captured || mv.check);
  setTimeout(() => {
    if (!G) return;
    const c = board.cellCenter(mv.m.to);
    ring(c.x, c.y);
    if (mv.captured) { burst(c.x, c.y, { count: 30, speed: 6 }); sfx.capture(); }
    if (mv.m.promo) {
      burst(c.x, c.y, { count: 20, speed: 4, colors: ['#ffd700', '#fff2a8', '#ffb300'] });
      sfx.promote();
    }
    // 検討モードでは設定で王手の演出（文字と効果音）を消せる
    if (mv.check && !(G.mode === 'analysis' && S.analysisCheckFx === false)) { cutIn('王手', '', 'check'); sfx.check(); }
  }, 190);
}

function startTurn() {
  if (!G || G.over || G.mode === 'analysis') return;
  const pos = lastPos();
  const side = pos.side;
  if (G.mode === 'net') { // 通信対局では詰み・千日手などの判定もサーバーが行う
    if (!G.netStarted) return;
    G.turnStart = performance.now();
    renderPlayers();
    renderControls();
    if (G.players[side].kind === 'engine') engineTurn(side);
    return;
  }
  if (pos.legalMoves().length === 0) return endGame(side ^ 1, '詰み');
  const rep = checkRepetition();
  if (rep) return endGame(rep.winner, rep.reason);
  if (G.moves.length >= 400) return endGame(-1, '手数上限');
  G.turnStart = performance.now();
  G.lastBeep = null;
  renderPlayers();
  renderControls();
  if (G.players[side].kind === 'engine') engineTurn(side);
}

/** 千日手（同一局面 4 回）。連続王手なら王手をかけ続けた側の負け */
function checkRepetition() {
  const key = lastPos().key();
  const idx = [];
  G.positions.forEach((p, i) => { if (p.key() === key) idx.push(i); });
  if (idx.length < 4) return null;
  const from = idx[0], to = G.positions.length - 1;
  for (const checker of [BLACK, WHITE]) {
    let all = true;
    for (let i = from + 1; i <= to; i++) {
      const p = G.positions[i];
      if (p.side !== checker && !p.inCheck()) { all = false; break; }
    }
    if (all) return { winner: checker ^ 1, reason: '連続王手の千日手' };
  }
  return { winner: -1, reason: '千日手' };
}

async function engineTurn(side) {
  const token = G.token;
  const pl = G.players[side];
  if (pl.thinking) return; // すでに考えている（手番の開始が重なった）
  let goArgs;
  if (!clockEnabled()) goArgs = `btime 0 wtime 0 byoyomi ${G.tc.engineByo}`;
  else goArgs = timeArgs();
  if (pl.level.depth) goArgs += ` depth ${pl.level.depth}`;
  const ply = G.positions.length - 1;
  // 定跡を使う設定なら、登録された手から選んで指す
  if (G.useBook) {
    const usi = pickBookMove(lastPos());
    const m = usi && lastPos().findMove(usi);
    if (m) {
      await sleep(600);
      if (G?.token !== token || G.over || G.positions.length - 1 !== ply) return;
      addLive(`${pl.name}：定跡手 ${moveToJa(lastPos(), m, ply > 0 ? G.moves[ply - 1].m.to : -1)}`, 'normal');
      doMove(m);
      return;
    }
  }
  pl.thinking = true;
  renderPlayers();
  renderControls();
  const t0 = performance.now();
  const res = await pl.engine.go(positionCmd(), goArgs, info => onEngineInfo(side, ply, info, token));
  if (G?.token !== token || G.over) return;
  const minDelay = G.mode === 'net' ? 0 : 450;
  const wait = minDelay - (performance.now() - t0);
  if (wait > 0) await sleep(wait);
  pl.thinking = false;
  // 考えているあいだに局面が変わっていたら、その答えは使わない
  if (G?.token !== token || G.over || G.positions.length - 1 !== ply) return;
  G.best[ply] = res.move;
  if (ply > 0) announce(ply, G.evals[ply]);
  if (G.mode === 'net') { // 投了・宣言はサーバーへ送り、結果はサーバーからの通知で終局する
    if (res.move === 'resign') { NET.client?.resign(); addLive('投了しました', 'bad'); return; }
    if (res.move === 'win') { NET.client?.declareWin(); addLive('入玉宣言しました', 'hot'); return; }
  }
  if (res.move === 'resign') return endGame(side ^ 1, res.crashed ? 'エンジン停止' : '投了');
  if (res.move === 'win') return endGame(side, '入玉宣言');
  const m = lastPos().findMove(res.move);
  if (!m) return endGame(side ^ 1, '反則（不正な指し手）');
  if (G.mode === 'net') netSendMove(m, pl.info);
  doMove(m);
}

function onEngineInfo(side, ply, info, token) {
  if (G?.token !== token || G.over) return;
  if (info.score == null || info.bound) return;
  const s = side === BLACK ? info.score : -info.score;
  G.evals[ply] = s;
  G.players[side].info = { ...info, s };
  if (G.mode === 'play') {
    // 逆転勝ちの判定用に、人間から見た最低評価値を記録
    G.humanMin = Math.min(G.humanMin, G.humanSide === BLACK ? s : -s);
  }
  if (info.pv && !(G.mode === 'play' && !S.showEval)) {
    renderPv(side, ply, info);
    logThink(ply, { ...info, s }, G.players[side].name);
  }
  updateEvalUI();
  renderPlayerInfo(side);
}

/** 手の実況。after が null なら評価値の変化は判定しない */
function announce(i, after) {
  const mv = G.moves[i - 1];
  if (!mv || mv.announced) return;
  mv.announced = true;
  const pos = G.positions[i - 1];
  const c = commentMove({
    ja: mv.ja, mover: pos.side, captured: mv.captured, promo: mv.m.promo, check: mv.check,
    before: after == null ? null : lastKnownEval(i - 1), after, ply: i,
  });
  if (!c) return;
  addLive(`${i}手目 ${c.text}`, c.tone);
  if (c.tone === 'bad' || c.tone === 'hot') showBubble(c.text, c.tone);
}

function addLive(text, tone = 'normal') {
  const el = document.createElement('div');
  el.className = `live-item ${tone}`;
  el.textContent = text;
  const box = $('#tab-live');
  box.prepend(el);
  while (box.children.length > 80) box.lastChild.remove();
}

function showBubble(text, tone) {
  const old = $('#board-area .bubble');
  old?.remove();
  const el = document.createElement('div');
  el.className = `bubble ${tone}`;
  el.textContent = text;
  $('#board-area').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function endGame(winner, reason) {
  if (!G || G.over) return;
  G.over = true;
  G.result = { winner, reason };
  G.turnStart = null;
  for (const p of G.players) if (p?.kind === 'engine') { p.thinking = false; p.engine.stop(); }
  renderPlayers();
  renderControls();
  renderKifu();
  const resText = winner < 0 ? `${reason}で引き分け` : `${G.names[winner]}の勝ち（${reason}）`;
  addLive(`終局：${G.moves.length}手で${resText}`, 'hot');
  autoSaveRecord();
  renderInfo();

  if (G.mode === 'play') {
    const h = G.humanSide;
    const result = winner < 0 ? 'draw' : winner === h ? 'win' : 'loss';
    if (result === 'win') { cutIn('勝利', reason, 'win'); confetti(); sfx.win(); }
    else if (result === 'loss') { cutIn('敗北', reason, 'lose'); sfx.lose(); }
    else { cutIn('引き分け', reason, 'draw'); }
    const beforeAch = new Set(Object.keys(S.achievements));
    const rec = recordGame({
      result, level: G.level, handicap: G.handicap, moves: G.moves.length, reason,
      mateWin: result === 'win' && reason === '詰み', comeback: result === 'win' && G.humanMin <= -1000,
      assisted: G.assisted, engineName: G.players[h ^ 1].name, side: h,
    });
    const newAch = Object.keys(S.achievements).filter(k => !beforeAch.has(k));
    await sleep(1900);
    showResult(result, reason, rec, newAch);
  } else if (G.mode === 'net') {
    const my = G.netMy;
    if (winner === my) { cutIn('勝利', reason, 'win'); confetti(); sfx.win(); }
    else if (winner < 0) cutIn('引き分け', reason, 'draw');
    else { cutIn('敗北', reason, 'lose'); sfx.lose(); }
    addLive(`通信対局の結果：${winner === my ? '勝ち' : winner < 0 ? '引き分け' : '負け'}（${reason}）`, 'hot');
  }
}

function showResult(result, reason, rec, newAch) {
  const title = { win: '勝利！', loss: '敗北', draw: '引き分け' }[result];
  const leveled = rec.after.level > rec.before.level;
  const m = modal(`
    <div class="result result-${result}">
      <div class="result-title">${title}</div>
      <div class="result-reason">${esc(reason)} ・ ${G.moves.length}手</div>
      <div class="result-grid">
        <div><span>獲得EXP</span><b>+${rec.xp}</b></div>
        <div><span>レート</span><b>${S.profile.rating} <small class="${rec.delta >= 0 ? 'up' : 'down'}">(${rec.delta >= 0 ? '+' : ''}${rec.delta})</small></b></div>
        <div><span>レベル</span><b>${rec.after.level}</b></div>
      </div>
      <div class="xpbar big"><div id="result-xp" style="width:${leveled ? 0 : ((rec.after.cur - rec.xp) / rec.after.next) * 100}%"></div></div>
      ${leveled ? `<div class="levelup">LEVEL UP!  Lv${rec.before.level} → Lv${rec.after.level}　${rec.after.title}</div>` : ''}
      ${G.assisted ? '<div class="muted small">※ 待った・ヒントを使ったため EXP とレート上昇は半分です</div>' : ''}
      ${newAch.length ? `<div class="new-ach">${newAch.map(id => { const a = ACHIEVEMENTS.find(x => x.id === id); return `<div class="ach got"><span>${a.icon}</span>${a.name}</div>`; }).join('')}</div>` : ''}
      <div class="modal-actions">
        <button class="btn ghost" data-a="home">ホームへ</button>
        <button class="btn ghost" data-a="analyze">検討する</button>
        <button class="btn primary" data-a="again">もう一局</button>
      </div>
    </div>`, { cls: 'sticky' });
  requestAnimationFrame(() => setTimeout(() => {
    const bar = $('#result-xp');
    if (bar) bar.style.width = `${(rec.after.cur / rec.after.next) * 100}%`;
  }, 100));
  if (leveled) setTimeout(() => { sfx.levelUp(); confetti(); }, 700);
  m.querySelector('[data-a=home]').onclick = () => { closeModal(); leaveGame(); };
  m.querySelector('[data-a=analyze]').onclick = () => { closeModal(); analyzeCurrentGame(); };
  m.querySelector('[data-a=again]').onclick = () => { closeModal(); openPlaySetup(); };
}

function stopEngines() {
  // 通信対局の接続とエンジンも終わらせる
  if (NET) {
    NET.closedByUser = true;
    NET.client?.logout();
    const c = NET.client;
    setTimeout(() => c?.close(), 300);
    NET.engine?.quit();
    NET = null;
  }
  if (!G) return;
  G.token = {};
  for (const p of G.players) if (p?.kind === 'engine') p.engine.quit();
  G.analysisEngine?.quit();
  for (const sub of G.subEngines || []) sub.engine.quit();
}

async function leaveGame(force = false) {
  if (!force && G && !G.over && G.mode === 'play' && G.moves.length > 0) {
    if (!await confirmBox('対局を中断しますか？', 'この対局は記録されません。')) return;
  }
  if (!force && G?.mode === 'net' && NET) {
    const msg = G.netStarted && !G.over ? '対局中に切断すると負けになります。' : 'サーバーとの接続を終了します。';
    if (!await confirmBox('通信対局を終了しますか？', msg)) return;
  }
  stopEngines();
  G = null;
  show('home');
}

// =====================================================================
// 対局開始
// =====================================================================

/** エンジン定義に保存されたオプション（未設定なら控えめな既定値） */
function engineOptions(ed, extra = {}) {
  return { USI_Hash: 256, USI_Ponder: 'false', ...(ed?.options || {}), ...extra };
}

/** list: [[engine, エンジン定義, 追加オプション], ...] */
async function startEngines(list) {
  const ld = loading('エンジンを起動しています…（評価関数の読み込みに時間がかかることがあります）');
  const engines = list.map(x => x[0]);
  try {
    for (const [e, ed, extra] of list) { await e.start(engineOptions(ed, extra)); e.newGame(); }
  } catch (err) {
    closeModal();
    engines.forEach(e => e.quit());
    alertBox('エンジンを起動できませんでした', err.message);
    return false;
  }
  ld.closest('.modal-wrap')?.remove();
  return true;
}

/** 持ち時間の入力欄（プリセット + カスタム） */
function timeFieldsHtml(last) {
  const c = last.custom || { main: 10, byo: 30, inc: 0 };
  return `
    <label class="field"><span>持ち時間</span><select id="ps-tc">${TIME_CONTROLS.map(t => `<option value="${t.id}" ${t.id === last.tc ? 'selected' : ''}>${t.name}</option>`).join('')}
      <option value="custom" ${last.tc === 'custom' ? 'selected' : ''}>カスタム…</option></select></label>
    <div class="field-row" id="ps-custom">
      <label class="field"><span>持ち時間（分）</span><input type="number" id="tc-main" min="0" max="600" value="${c.main}"></label>
      <label class="field"><span>秒読み（秒）</span><input type="number" id="tc-byo" min="0" max="600" value="${c.byo}"></label>
      <label class="field"><span>1手ごとの加算（秒）</span><input type="number" id="tc-inc" min="0" max="600" value="${c.inc}"></label>
    </div>`;
}

function readTimeFields(m) {
  return {
    tc: m.querySelector('#ps-tc').value,
    custom: { main: +m.querySelector('#tc-main').value || 0, byo: +m.querySelector('#tc-byo').value || 0, inc: +m.querySelector('#tc-inc').value || 0 },
  };
}

function resolveTc(cfg) {
  if (cfg.tc !== 'custom') return { inc: 0, ...(TIME_CONTROLS.find(t => t.id === cfg.tc) || TIME_CONTROLS[0]) };
  const c = cfg.custom;
  const name = !c.main && !c.byo && !c.inc ? '時間無制限'
    : `${c.main}分${c.byo ? ` + 秒読み${c.byo}秒` : ''}${c.inc ? ` + 加算${c.inc}秒` : ''}${!c.byo && !c.inc ? '（切れ負け）' : ''}`;
  return { id: 'custom', name, main: c.main * 60000, byo: c.byo * 1000, inc: c.inc * 1000, engineByo: 2000 };
}

function bindTimeFields(m) {
  const sel = m.querySelector('#ps-tc'), box = m.querySelector('#ps-custom');
  const sync = () => { box.style.display = sel.value === 'custom' ? '' : 'none'; };
  sel.addEventListener('change', sync);
  sync();
}

/** 対局の設定。startSfen を渡すとその局面から始める */
function openPlaySetup(startSfen = null) {
  const last = S.lastPlay || {};
  const engines = engineList();
  if (!engines.length) return alertBox('エンジンがありません', '設定画面から USI エンジンを追加してください。');
  const m = modal(`
    <h2>対局の設定</h2>
    <label class="field"><span>相手エンジン</span><select id="ps-engine">${engines.map(e => `<option value="${e.id}" ${e.id === last.engine ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
    <div class="field"><span>強さ</span><div class="level-grid" id="ps-level">${LEVELS.map(l => `
      <button class="level-card ${l.id === (last.level || 'shokyu') ? 'active' : ''}" data-id="${l.id}">
        <b>${l.name}</b><span class="stars">${'★'.repeat(l.stars)}</span><small>${l.desc}</small></button>`).join('')}</div></div>
    <div class="field-row">
      <label class="field"><span>開始局面</span><select id="ps-hc">
        ${startSfen ? '<option value="position" selected>指定局面から</option>' : ''}
        ${HANDICAPS.map(h => `<option value="${h.id}" ${!startSfen && h.id === last.handicap ? 'selected' : ''}>${h.name}</option>`).join('')}</select></label>
      <label class="field"><span>あなたの手番</span><select id="ps-side">
        <option value="black" ${last.side === 'black' ? 'selected' : ''}>先手 ☗</option>
        <option value="white" ${last.side === 'white' ? 'selected' : ''}>後手 ☖</option>
        <option value="random" ${last.side === 'random' ? 'selected' : ''}>振り駒（ランダム）</option></select></label>
    </div>
    ${timeFieldsHtml(last)}
    <label class="check"><input type="checkbox" id="ps-book" ${S.bookUse ? 'checked' : ''}> エンジンに登録した定跡を使わせる</label>
    <p class="muted small" id="ps-note"></p>
    <div class="modal-actions"><button class="btn ghost" data-cancel>戻る</button><button class="btn primary big" data-start>対局開始</button></div>`, { cls: 'wide' });
  const hcSel = m.querySelector('#ps-hc'), sideSel = m.querySelector('#ps-side');
  const syncNote = () => {
    const hc = hcSel.value !== 'hirate' && hcSel.value !== 'position';
    sideSel.disabled = hc;
    m.querySelector('#ps-note').textContent = hc ? '駒落ちでは、あなたが下手（☗）、エンジンが上手（☖・先に指す）になります。' : '';
  };
  hcSel.onchange = syncNote;
  syncNote();
  bindTimeFields(m);
  m.querySelectorAll('.level-card').forEach(b => b.onclick = () => {
    m.querySelectorAll('.level-card').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    sfx.click();
  });
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-start]').onclick = () => {
    const cfg = {
      engine: m.querySelector('#ps-engine').value,
      level: m.querySelector('.level-card.active').dataset.id,
      handicap: hcSel.value, side: sideSel.value, ...readTimeFields(m),
    };
    S.bookUse = m.querySelector('#ps-book').checked;
    S.lastPlay = { ...cfg, handicap: cfg.handicap === 'position' ? last.handicap : cfg.handicap };
    saveStore();
    closeModal();
    startPlay({ ...cfg, startSfen: cfg.handicap === 'position' ? startSfen : null });
  };
}

async function startPlay(cfg) {
  if (G) stopEngines();
  const hc = cfg.startSfen
    ? { id: 'position', name: '指定局面', sfen: cfg.startSfen, penalty: 0 }
    : HANDICAPS.find(h => h.id === cfg.handicap);
  const level = LEVELS.find(l => l.id === cfg.level);
  const tc = resolveTc(cfg);
  const ed = findEngine(cfg.engine);
  let human = cfg.side === 'white' ? WHITE : cfg.side === 'random' ? (Math.random() < 0.5 ? BLACK : WHITE) : BLACK;
  if (hc.id !== 'hirate' && hc.id !== 'position') human = BLACK;
  if (cfg.side === 'random') toast('振り駒', human === BLACK ? 'あなたの先手です' : 'あなたの後手です', '🎲');

  const engine = createEngine(ed.path);
  if (!await startEngines([[engine, ed]])) return;

  newGame('play', hc.sfen);
  Object.assign(G, { humanSide: human, level, handicap: hc, tc, clock: { remain: [tc.main, tc.main] }, useBook: S.bookUse });
  const eName = `${engine.name || ed.name}`;
  G.players[human] = { kind: 'human', name: S.profile.name };
  G.players[human ^ 1] = { kind: 'engine', name: eName, engine, level };
  G.names = [G.players[0].name, G.players[1].name];
  Object.assign(G.info, { event: '将棋アリーナ 対局', timeControl: tc.name });
  enterGameScreen(`対局 ・ ${hc.name} ・ ${level.name} ・ ${tc.name}`);
  board.flipped = human === WHITE;
  board.setPosition(curPos());
  cutIn('対局開始', 'よろしくお願いします', 'start');
  sfx.start();
  // 演出のあいだは指せないようにする（ここで指せると、エンジンの手番が二重に始まってしまう）
  G.waitingStart = true;
  const token = G.token;
  await sleep(1200);
  if (G?.token !== token || G.mode !== 'play') return;
  G.waitingStart = false;
  startTurn();
}

function enterGameScreen(title) {
  show('game');
  $('#mode-title').textContent = title;
  selectTab('kifu');
  renderPlayers();
  renderKifu();
  renderControls();
  updateEvalUI();
  $('#tab-pv').innerHTML = '<div class="muted small">エンジンの読み筋がここに表示されます</div>';
  G.think = [];
  renderThink();
  renderInfo();
  renderMarks();
}

// =====================================================================
// 検討
// =====================================================================

// =====================================================================
// 通信対局（CSA サーバー / floodgate）
// =====================================================================

const FLOODGATE = { host: 'wdoor.c.u-tokyo.ac.jp', port: 4081 };
const FLOODGATE_GAMES = [
  { id: 'floodgate-300-10F', name: '5分 + 1手10秒加算（floodgate-300-10F）' },
  { id: 'floodgate-600-10F', name: '10分 + 1手10秒加算（floodgate-600-10F）' },
];

/** 接続中の通信対局。対局をまたいで接続・エンジンを保持する */
let NET = null;

function openNetSetup() {
  if (!hasApi) return alertBox('通信対局はデスクトップ版の機能です', 'ブラウザ版ではサーバーに接続できません。');
  const last = S.lastNet || {};
  const engines = engineList();
  const m = modal(`
    <h2>通信対局の設定</h2>
    <div class="field-row">
      <label class="field"><span>サーバー</span><select id="ns-server">
        <option value="floodgate" ${last.server !== 'custom' ? 'selected' : ''}>floodgate（wdoor.c.u-tokyo.ac.jp:4081）</option>
        <option value="custom" ${last.server === 'custom' ? 'selected' : ''}>その他の CSA サーバー</option></select></label>
    </div>
    <div class="field-row" id="ns-custom">
      <label class="field"><span>ホスト</span><input id="ns-host" value="${esc(last.host || '')}" placeholder="localhost"></label>
      <label class="field"><span>ポート</span><input id="ns-port" type="number" value="${last.port || 4081}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>ログイン名（半角英数字）</span><input id="ns-name" value="${esc(last.name || '')}" placeholder="例: Sailfish_test"></label>
      <label class="field" id="ns-game-f"><span>対局の種類</span><select id="ns-game">${FLOODGATE_GAMES.map(g => `<option value="${g.id}" ${g.id === last.game ? 'selected' : ''}>${g.name}</option>`).join('')}</select></label>
    </div>
    <div class="field-row">
      <label class="field"><span id="ns-pass-label">トリップ（あなたを識別する合言葉）</span><input id="ns-pass" type="password" value="${esc(last.savePass ? last.pass || '' : '')}" autocomplete="off"></label>
      <label class="field"><span>指す人</span><select id="ns-player">
        ${engines.map(e => `<option value="${e.id}" ${e.id === last.player ? 'selected' : ''}>🤖 ${esc(e.name)}</option>`).join('')}
        <option value="human" ${last.player === 'human' ? 'selected' : ''}>👤 自分で指す</option></select></label>
    </div>
    <label class="check"><input type="checkbox" id="ns-eval" ${last.sendEval !== false ? 'checked' : ''}> エンジンの評価値・読み筋をサーバーに送る（floodgate の形式）</label>
    <label class="check"><input type="checkbox" id="ns-repeat" ${last.repeat ? 'checked' : ''}> 終局したら次の対局を自動で待つ</label>
    <label class="check"><input type="checkbox" id="ns-save" ${last.savePass ? 'checked' : ''}> トリップ（パスワード）をこの PC に保存する</label>
    <p class="muted small" id="ns-note"></p>
    <div class="modal-actions"><button class="btn ghost" data-cancel>戻る</button><button class="btn primary big" data-start>接続する</button></div>`, { cls: 'wide' });
  const sync = () => {
    const fg = m.querySelector('#ns-server').value === 'floodgate';
    m.querySelector('#ns-custom').style.display = fg ? 'none' : '';
    m.querySelector('#ns-game-f').style.display = fg ? '' : 'none';
    m.querySelector('#ns-pass-label').textContent = fg ? 'トリップ（あなたを識別する合言葉）' : 'パスワード';
    m.querySelector('#ns-note').textContent = fg
      ? 'floodgate はコンピュータ将棋の対局場です。対局は毎時 00 分と 30 分に組み合わされるので、開始まで最大 30 分ほど待つことがあります。ログイン名とトリップの組み合わせでレーティングが記録されます。'
      : '';
  };
  m.querySelector('#ns-server').onchange = sync;
  sync();
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-start]').onclick = () => {
    const cfg = {
      server: m.querySelector('#ns-server').value,
      host: m.querySelector('#ns-host').value.trim(), port: +m.querySelector('#ns-port').value || 4081,
      name: m.querySelector('#ns-name').value.trim(), game: m.querySelector('#ns-game').value,
      pass: m.querySelector('#ns-pass').value, player: m.querySelector('#ns-player').value,
      sendEval: m.querySelector('#ns-eval').checked, repeat: m.querySelector('#ns-repeat').checked,
      savePass: m.querySelector('#ns-save').checked,
    };
    if (!/^[A-Za-z0-9_\-@.]+$/.test(cfg.name)) return toast('ログイン名は半角英数字で入力してください', '', '⚠️');
    if (!cfg.pass) return toast(cfg.server === 'floodgate' ? 'トリップを入力してください' : 'パスワードを入力してください', '', '⚠️');
    if (cfg.server === 'custom' && !cfg.host) return toast('ホストを入力してください', '', '⚠️');
    S.lastNet = { ...cfg, pass: cfg.savePass ? cfg.pass : '' };
    saveStore();
    closeModal();
    startNet(cfg);
  };
}

async function startNet(cfg) {
  if (G) stopEngines();
  const host = cfg.server === 'floodgate' ? FLOODGATE.host : cfg.host;
  const port = cfg.server === 'floodgate' ? FLOODGATE.port : cfg.port;
  const password = cfg.server === 'floodgate' ? `${cfg.game},${cfg.pass}` : cfg.pass;

  // 指す人（エンジンなら先に起動しておく）
  let engine = null, ed = null;
  if (cfg.player !== 'human') {
    ed = findEngine(cfg.player);
    engine = createEngine(ed.path);
    if (!await startEngines([[engine, ed]])) return;
  }
  NET = { cfg, host, port, engine, ed, client: null, closedByUser: false };
  netWaitingScreen(`${host}:${port} に接続しています…`);

  const client = new CsaClient({
    onLog: line => addLive(line, 'net'),
    onLogin: ok => {
      if (!ok) { netFail('ログインできませんでした（ログイン名・パスワードを確認してください）'); return; }
      netWaitingScreen(cfg.server === 'floodgate'
        ? '対局相手を待っています…（floodgate は毎時 00 分・30 分に組み合わせます）'
        : '対局相手を待っています…');
    },
    onSummary: s => netOnSummary(s),
    onStart: () => netOnStart(),
    onReject: () => { addLive('対局が拒否されました', 'bad'); netWaitingScreen('対局相手を待っています…'); },
    onMove: (mv, t) => netOnMove(mv, t),
    onSpecial: sp => addLive(sp === '%TORYO' ? '投了が送られました' : '入玉宣言が送られました', 'hot'),
    onResult: (res, reason) => netOnResult(res, reason),
    onClose: err => netOnClose(err),
  });
  NET.client = client;
  try {
    await client.connect(host, port);
  } catch (err) {
    netFail(`接続できませんでした：${err.message}`);
    return;
  }
  client.login(cfg.name, password);
}

/** 接続中・対局待ちの画面 */
function netWaitingScreen(text) {
  if (!G || G.mode !== 'net' || G.netStarted) {
    newGame('net', START_SFEN);
    G.players = [{ kind: 'remote', name: '（対局待ち）' }, { kind: 'remote', name: '（対局待ち）' }];
    G.names = ['先手', '後手'];
    G.tc = null;
    enterGameScreen(`通信対局 ・ ${NET.host}`);
    board.flipped = false;
    board.setPosition(curPos());
    selectTab('live');
  }
  G.netWaiting = true;
  let el = $('#board-area .net-banner');
  if (!el) {
    el = document.createElement('div');
    el.className = 'net-banner';
    $('#board-area').appendChild(el);
  }
  el.innerHTML = `<div class="spinner"></div><div>${esc(text)}</div>`;
  renderControls();
}

function netClearBanner() { $('#board-area .net-banner')?.remove(); }

function netFail(msg) {
  netClearBanner();
  alertBox('通信対局', msg);
  NET?.client?.close();
  if (G) { G.netWaiting = false; renderControls(); }
}

/** 対局条件（Game_Summary）を受け取ったら盤を用意して同意する */
function netOnSummary(s) {
  const rec = parseRecord(s.positionLines.join('\n'));
  newGame('net', rec.startSfen);
  importTree(rec.tree);
  const my = s.myColor === '+' ? BLACK : WHITE;
  const cfg = NET.cfg;
  const u = s.time.unit;
  G.tc = { main: s.time.total * u, byo: s.time.byoyomi * u, inc: s.time.increment * u, engineByo: 2000 };
  G.clock = { remain: [G.tc.main, G.tc.main] };
  G.netMargin = 1000;
  G.netMy = my;
  G.netSummary = s;
  G.humanSide = my;
  G.netStarted = false;
  const myName = s.names[s.myColor] || cfg.name;
  G.players[my] = NET.engine
    ? { kind: 'engine', name: myName, engine: NET.engine, level: { depth: 0, stars: 0, name: 'net' } }
    : { kind: 'human', name: myName };
  G.players[my ^ 1] = { kind: 'remote', name: s.names[s.myColor === '+' ? '-' : '+'] || '相手' };
  G.names = [G.players[0].name, G.players[1].name];
  const tcText = `${Math.round(G.tc.main / 60000)}分${G.tc.byo ? ` 秒読み${G.tc.byo / 1000}秒` : ''}${G.tc.inc ? ` 加算${G.tc.inc / 1000}秒` : ''}`;
  Object.assign(G.info, { event: s.gameId || '通信対局', place: `${NET.host}:${NET.port}`, timeControl: tcText });
  enterGameScreen(`通信対局 ・ ${tcText}`);
  board.flipped = my === WHITE;
  board.setPosition(curPos(), G.moves.length ? G.moves[G.moves.length - 1].m : null);
  selectTab('live');
  NET.engine?.newGame();
  addLive(`対局が決まりました：☗${G.names[0]} 対 ☖${G.names[1]}（あなたは${my === BLACK ? '先手' : '後手'}）`, 'hot');
  netWaitingScreen('対局の開始を待っています…');
  NET.client.agree();
}

function netOnStart() {
  netClearBanner();
  G.netWaiting = false;
  G.netStarted = true;
  cutIn('対局開始', `${G.names[0]} vs ${G.names[1]}`, 'start');
  sfx.start();
  renderPlayers();
  startTurn();
}

/** サーバーから届いた消費時間で持ち時間を更新する */
function netApplyTime(color, t) {
  const used = t * (G.netSummary?.time.unit || 1000);
  let r = G.clock.remain[color] - used;
  if (r < 0) r = 0; // 秒読みに入った
  G.clock.remain[color] = r + G.tc.inc;
}

/** 自分の指し手をサーバーへ送る。エンジンなら評価値と読み筋を添える */
function netSendMove(m, info) {
  const pos = lastPos();
  const mv = csaMoveString(pos, m);
  let line = mv;
  if (NET.cfg.sendEval && info?.pv && info.s != null) {
    let s = Math.round(info.s);
    if (Math.abs(s) >= MATE_SCORE - 1000) s = Math.sign(s) * 30000;
    let p = pos.play(m);
    const pv = [];
    for (const u of info.pv.slice(1, 12)) {
      const x = p.findMove(u);
      if (!x) break;
      pv.push(csaMoveString(p, x));
      p = p.play(x);
    }
    line += `,'* ${s}${pv.length ? ' ' + pv.join(' ') : ''}`;
  }
  G.netPending = mv;
  NET.client.send(line);
}

function netOnMove(mv, t) {
  if (!G || G.mode !== 'net') return;
  const color = mv[0] === '+' ? BLACK : WHITE;
  if (G.netPending === mv && color === G.netMy) { // 自分の手の確認（消費時間の反映）
    G.netPending = null;
    netApplyTime(color, t);
    updateClocks();
    return;
  }
  const pos = lastPos();
  const m = parseCsaMove(pos, mv);
  if (!m) { addLive(`受信した手を解釈できません：${mv}`, 'bad'); return; }
  netApplyTime(color, t);
  doMove(m);
}

function netOnResult(res, reason) {
  if (!G || G.mode !== 'net') return;
  const my = G.netMy;
  const winner = res === 'win' ? my : res === 'lose' ? my ^ 1 : -1;
  const why = reason || { draw: '引き分け', censored: '打ち切り', chudan: '中断' }[res] || '終局';
  endGame(winner, why);
  NET.client.logout();
}

function netOnClose(err) {
  if (!NET) return;
  const cfg = NET.cfg;
  if (err) addLive(`切断されました：${err}`, 'bad');
  else addLive('サーバーとの接続を終了しました', 'net');
  if (G?.mode === 'net' && !G.over && G.netStarted) endGame(-1, '接続切断');
  if (G?.mode === 'net') { G.netWaiting = false; netClearBanner(); renderControls(); }
  if (cfg.repeat && !NET.closedByUser && G?.mode === 'net') {
    addLive('10 秒後に次の対局を待ちます', 'net');
    const session = NET;
    setTimeout(() => { if (NET === session && G?.mode === 'net') netReconnect(); }, 10000);
  }
}

/** 同じ設定・同じエンジンで次の対局に接続する */
async function netReconnect() {
  const { cfg, engine, ed } = NET;
  const host = NET.host, port = NET.port;
  NET = { cfg, host, port, engine, ed, client: null, closedByUser: false };
  // エンジンは起動したまま使い回す
  const password = cfg.server === 'floodgate' ? `${cfg.game},${cfg.pass}` : cfg.pass;
  netWaitingScreen(`${host}:${port} に接続しています…`);
  const client = new CsaClient({
    onLog: line => addLive(line, 'net'),
    onLogin: ok => { if (!ok) netFail('ログインできませんでした'); else netWaitingScreen('対局相手を待っています…'); },
    onSummary: s => netOnSummary(s), onStart: () => netOnStart(),
    onReject: () => netWaitingScreen('対局相手を待っています…'),
    onMove: (mv, t) => netOnMove(mv, t),
    onSpecial: sp => addLive(sp, 'hot'),
    onResult: (res, reason) => netOnResult(res, reason),
    onClose: err => netOnClose(err),
  });
  NET.client = client;
  try { await client.connect(host, port); } catch (err) { netFail(`接続できませんでした：${err.message}`); return; }
  client.login(cfg.name, password);
}

/** 接続を切る（対局中なら負けになる） */
async function netDisconnect() {
  if (!NET) return;
  if (G?.netStarted && !G.over && !await confirmBox('接続を切りますか？', '対局中に切断すると負けになります。')) return;
  NET.closedByUser = true;
  NET.client?.logout();
  setTimeout(() => NET?.client?.close(), 500);
}

function analysisEngineDef() {
  return engineList().find(e => e.id === S.analysisEngine) || engineList()[0];
}

async function enterAnalysis(rec, title = '検討') {
  if (G) stopEngines();
  newGame('analysis', rec.startSfen);
  importTree(rec.tree || { comment: '', children: [] });
  G.names = [rec.black || '先手', rec.white || '後手'];
  G.info = { ...(rec.info || {}) };
  G.players = [{ kind: 'human', name: G.names[0] }, { kind: 'human', name: G.names[1] }];
  G.result = rec.result ? { reason: rec.result } : null;
  G.cur = 0;
  G.analyzing = false;
  board.flipped = false;
  enterGameScreen(title);
  gotoPly(G.positions.length - 1);
  const ed = analysisEngineDef();
  if (ed) {
    G.analysisEngine = createEngine(ed.path);
    try {
      await G.analysisEngine.start(engineOptions(ed));
      G.analysisEngine.newGame();
    } catch (err) {
      G.analysisEngine = null;
      toast('検討エンジンを起動できません', err.message, '⚠️');
    }
  }
  // 複数エンジンでの同時検討
  G.subEngines = [];
  const token = G.token;
  for (const id of (S.subEngines || []).filter(x => x !== ed?.id).slice(0, 3)) {
    const sd = engineList().find(e => e.id === id);
    if (!sd) continue;
    const engine = createEngine(sd.path);
    try {
      await engine.start(engineOptions(sd));
      engine.newGame();
      if (G?.token !== token) { engine.quit(); return; }
      G.subEngines.push({ ed: sd, engine, lines: [] });
    } catch (err) {
      engine.quit();
      toast(`${sd.name} を起動できません`, err.message, '⚠️');
    }
  }
  if (G.subEngines.length) toast('複数エンジンで検討します', [ed?.name, ...G.subEngines.map(s => s.ed.name)].join(' ／ '), '🤖');
  renderControls();
}

function analyzeCurrentGame() {
  syncNodes();
  const rec = {
    startSfen: G.startSfen, tree: G.root,
    black: G.names[0], white: G.names[1], info: G.info,
    result: G.result ? G.result.reason : '',
  };
  enterAnalysis(rec, '検討（対局の振り返り）');
}

function analysisMove(m) {
  const next = G.moves[G.cur];
  if (next && next.usi === moveToUsi(m)) return gotoPly(G.cur + 1);
  // 別の手を指したら、元の手順は残したまま変化として追加する
  syncNodes();
  const parent = G.line[G.cur];
  const isNew = !parent.children.some(c => c.usi === moveToUsi(m));
  truncateTo(G.cur);
  pushMove(m);
  extendLine();
  G.cur++;
  board.setPosition(curPos(), m, true);
  moveEffects(G.moves[G.cur - 1]);
  if (isNew && parent.children.length > 1) toast('変化を追加しました', `${G.cur}手目 ${G.moves[G.cur - 1].ja}`, '🌿');
  renderKifu();
  renderBranches();
  updateEvalUI();
  if (G.analyzing) restartAnalysis();
}

function gotoPly(i) {
  if (!G) return;
  if (G.preview) endPreview(false);
  i = Math.max(0, Math.min(G.positions.length - 1, i));
  G.pvLines = [];
  for (const sub of G.subEngines || []) sub.lines = [];
  const forward = i === G.cur + 1;
  G.cur = i;
  const mv = i > 0 ? G.moves[i - 1] : null;
  board.setPosition(curPos(), mv?.m || null, forward);
  if (forward && mv) sfx.move(false);
  showBestArrow();
  renderKifu();
  updateEvalUI();
  if (G.mode === 'analysis') {
    showMoveNote();
    renderBranches();
    const ta = $('#kifu-comment');
    if (ta) ta.value = G.line[G.cur]?.comment || '';
    const mk = $('#kifu-mark');
    if (mk) mk.value = G.line[G.cur]?.bookmark || '';
    if (G.analyzing) restartAnalysis();
  }
}

const ARROW_COLORS = ['var(--arrow)', '#3fa9ff', '#4de07a', '#ffb020', '#b88cff'];
const SUB_COLORS = ['#b04dff', '#00c2a8', '#ff6a3d'];

/**
 * 評価値の表示。内部では先手から見た値 s を持つ。
 * 設定が「手番側から見る」なら、sideToMove が後手のとき符号を反転する。
 */
function dispScore(s, sideToMove) {
  if (s == null) return '—';
  return formatScore(S.evalView === 'each' && sideToMove === WHITE ? -s : s);
}

/** 同時検討エンジンの候補手の数（1〜5）を変える */
function setSubMultiPV(n) {
  S.subMultiPV = n;
  saveStore();
  const side = $('#submultipv');
  if (side) side.value = n;
  const bottom = bottomAnalysis?.querySelector('[data-bsubmpv]');
  if (bottom) bottom.value = n;
  if (G?.analyzing) restartAnalysis();
}

/** 読み筋のキー（メインは "0"〜、サブは "s{エンジン番号}_{候補番号}"）から読み筋を探す */
function lineByKey(k) {
  k = String(k);
  if (!k.startsWith('s')) return G.pvLines?.[+k];
  const [i, n] = k.slice(1).split('_');
  return G.subEngines?.[+i]?.lines?.[+(n || 0)];
}

/** 矢印に出す候補を選ぶ（本数の上限と、最善手との評価値差で絞る） */
function arrowLines(lines, side) {
  const max = S.maxArrows ?? 3, diff = S.arrowDiff ?? 100;
  const valid = lines.filter(Boolean);
  if (!valid.length) return [];
  const sign = side === BLACK ? 1 : -1; // 手番側から見て良い順
  const best = valid[0].s * sign;
  return valid.filter((l, k) => k < max && (k === 0 || best - l.s * sign <= diff));
}

/** 最善手（MultiPV なら上位の候補手）を矢印で示す */
function showBestArrow() {
  if (G.mode !== 'analysis' || G.preview) return;
  const side = curPos().side;
  const lines = (G.pvLines || []).filter(Boolean);
  const arrows = [];
  const label = (l, k) => (S.showArrowScore !== false && l ? dispScore(l.s, side) : k != null ? String(k + 1) : '');
  if (lines.length) {
    arrowLines(lines, side).forEach((l, k) => {
      const m = l.pv?.[0] && curPos().findMove(l.pv[0]);
      if (m) arrows.push({ move: m, color: ARROW_COLORS[k], label: label(l, lines.length > 1 ? k : null) });
    });
  } else {
    const best = G.best[G.cur];
    const m = best && curPos().findMove(best);
    if (m) arrows.push({ move: m, color: 'var(--arrow)', label: '' });
  }
  (G.subEngines || []).forEach((sub, i) => {
    if (!G.analyzing) return;
    const name = (sub.engine.name || sub.ed.name).slice(0, 4);
    const multi = (sub.lines || []).filter(Boolean).length > 1;
    arrowLines(sub.lines || [], side).forEach((l, k) => {
      const m = l.pv?.[0] && curPos().findMove(l.pv[0]);
      const tag = multi ? `${name}${k + 1}` : name;
      if (m) arrows.push({ move: m, color: SUB_COLORS[i], label: S.showArrowScore !== false ? `${tag} ${dispScore(l.s, side)}` : tag });
    });
  });
  board.setArrows(arrows);
}

// ---- 読み筋の盤面再生 ----

/** 読み筋 usis の j 手目までを進めた局面を盤に表示する */
function previewPv(ply, usis, j, k = 0) {
  j = Math.max(0, Math.min(usis.length - 1, j));
  let pos = G.positions[ply];
  let last = null;
  for (const u of usis.slice(0, j + 1)) {
    const m = pos.findMove(u);
    if (!m) break;
    pos = pos.play(m);
    last = m;
  }
  G.preview = { ply, usis, j, k };
  board.setArrows([]);
  board.setPosition(pos, last, false);
  let banner = $('#board-area .preview-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'preview-banner';
    $('#board-area').appendChild(banner);
    banner.onclick = e => {
      const p = G?.preview;
      if (!p) return;
      if (e.target.closest('[data-pv-branch]')) { addPvAsBranch(p.ply, p.usis, p.j + 1); return; }
      if (e.target.closest('[data-pv-comment]')) { addPvAsComment(p.ply, p.k); return; }
      endPreview();
    };
  }
  banner.innerHTML = `読み筋 ${j + 1}手目を表示中 <small>← → で進む・戻る ／ クリックで元の局面へ</small>
    ${G.mode === 'analysis' ? `<button class="btn small" data-pv-branch>🌿 ここまでを変化に追加</button><button class="btn small" data-pv-comment>💬 コメントに追加</button>` : ''}`;
  document.querySelectorAll('.pv-mv.on').forEach(e => e.classList.remove('on'));
  document.querySelectorAll(`.pv-mv[data-j="${j}"][data-k="${k}"]`).forEach(e => e.classList.add('on'));
}

/** 読み筋（usis の先頭 n 手）を、ply 手目からの変化として棋譜に追加する */
function addPvAsBranch(ply, usis, n) {
  endPreview(false);
  syncNodes();
  const parent = G.line[ply];
  const oldSel = parent.sel;
  const hadNext = !!G.line[ply + 1];
  truncateTo(ply);
  let added = 0;
  for (const u of usis.slice(0, n)) {
    const m = lastPos().findMove(u);
    if (!m) break;
    pushMove(m);
    added++;
  }
  // 表示中の手順は元のまま（本譜などを見ていた場合はそこへ戻す）
  if (hadNext) parent.sel = oldSel;
  truncateTo(ply);
  extendLine();
  G.cur = -1;
  gotoPly(ply);
  toast('読み筋を変化として追加しました', `${ply + 1}手目から ${added}手`, '🌿');
}

/** 読み筋を、その局面のコメントに書き足す */
function addPvAsComment(ply, k) {
  const line = lineByKey(k);
  if (!line) return;
  const name = String(k).startsWith('s') ? (G.subEngines[+String(k).slice(1).split('_')[0]].engine.name || '') : (G.analysisEngine?.name || '');
  const text = `${name} 評価値 ${dispScore(line.s, G.positions[ply].side)} 深さ ${line.depth ?? '-'} 読み筋 ${pvToJa(ply, line.pv, 20)}`;
  const node = G.line[ply];
  node.comment = node.comment ? `${node.comment}\n${text}` : text;
  endPreview();
  const ta = $('#kifu-comment');
  if (ta) ta.value = node.comment;
  renderKifu();
  toast('コメントに読み筋を追加しました', '', '💬');
}

function endPreview(restore = true) {
  if (!G?.preview) return;
  G.preview = null;
  $('#board-area .preview-banner')?.remove();
  document.querySelectorAll('.pv-mv.on').forEach(e => e.classList.remove('on'));
  if (restore) {
    board.setPosition(curPos(), G.cur > 0 ? G.moves[G.cur - 1].m : null);
    showBestArrow();
  }
}

function showMoveNote() {
  const i = G.cur;
  const el = $('#move-note');
  if (!el) return;
  if (i === 0) { el.textContent = '開始局面'; return; }
  const mv = G.moves[i - 1];
  const q = moveQuality(i);
  let html = `<b>${i}手目 ${esc(mv.ja)}</b> ${q ? `<span class="q ${q.cls}">${q.label}</span>` : ''}`;
  const bestPrev = G.best[i - 1];
  if (q && bestPrev && bestPrev !== mv.usi) {
    const bm = G.positions[i - 1].findMove(bestPrev);
    if (bm) html += `<div class="small">最善は ${esc(moveToJa(G.positions[i - 1], bm, i > 1 ? G.moves[i - 2].m.to : -1))}</div>`;
  }
  el.innerHTML = html;
}

const QUALITY = [
  { label: '大悪手', cls: 'blunder2', mark: '???', color: '#ff2d8a' },
  { label: '悪手', cls: 'blunder', mark: '??', color: '#ff3b3b' },
  { label: '疑問手', cls: 'dubious', mark: '?', color: '#ffb020' },
  { label: '緩手', cls: 'slack', mark: '?!', color: '#d8c84a' },
];

/** 悪手判定。指した側の期待勝率がどれだけ下がったか（%）で 4 段階に分ける */
function moveQuality(i) {
  const a = G.evals[i - 1], b = G.evals[i];
  if (a == null || b == null) return null;
  const mover = G.positions[i - 1].side;
  const loss = (mover === BLACK ? winRate(a) - winRate(b) : winRate(b) - winRate(a)) * 100;
  const [t1, t2, t3, t4] = S.badMove || [5, 10, 20, 50];
  if (loss >= t4) return { ...QUALITY[0], loss };
  if (loss >= t3) return { ...QUALITY[1], loss };
  if (loss >= t2) return { ...QUALITY[2], loss };
  if (loss >= t1) return { ...QUALITY[3], loss };
  return null;
}

let analysisTimer = null;
function restartAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(async () => {
    const eng = G?.analysisEngine;
    if (!eng || !G.analyzing) return;
    const token = G.token;
    const ply = G.cur;
    await eng.stop();
    if (G?.token !== token || G.cur !== ply || !G.analyzing) return;
    eng.setOption('MultiPV', S.multiPV || 1);
    G.pvLines = [];
    G.think = [];
    // 検討時間の上限（秒）。過ぎたらエンジンを止める（表示は残る）
    clearTimeout(G.analysisLimit);
    if (S.analysisMaxSec > 0) {
      G.analysisLimit = setTimeout(() => {
        if (G?.token !== token || G.cur !== ply) return;
        eng.stop();
        stopSubEngines();
        addLive(`${ply}手目の検討を ${S.analysisMaxSec}秒で終了しました`, 'normal');
      }, S.analysisMaxSec * 1000);
    }
    eng.go(positionCmd(ply), 'infinite', info => {
      if (G?.token !== token || G.cur !== ply || info.score == null || info.bound || !info.pv) return;
      const k = (info.multipv || 1) - 1;
      const s = curPos().side === BLACK ? info.score : -info.score;
      G.pvLines[k] = { ...info, s };
      logThink(ply, { ...info, s }, eng.name);
      if (k === 0) {
        G.evals[ply] = s;
        G.best[ply] = info.pv[0];
        updateEvalUI();
      }
      renderPvLines(ply);
      showBestArrow();
    });
    // サブの検討エンジン（最善手 1 本ずつ）
    for (const sub of G.subEngines || []) {
      await sub.engine.stop();
      if (G?.token !== token || G.cur !== ply || !G.analyzing) return;
      sub.engine.setOption('MultiPV', S.subMultiPV || 1);
      sub.lines = [];
      sub.engine.go(positionCmd(ply), 'infinite', info => {
        if (G?.token !== token || G.cur !== ply || info.score == null || info.bound || !info.pv) return;
        sub.lines[(info.multipv || 1) - 1] = { ...info, s: curPos().side === BLACK ? info.score : -info.score };
        renderPvLines(ply);
        showBestArrow();
      });
    }
  }, 150);
}

async function stopSubEngines() {
  for (const sub of G?.subEngines || []) await sub.engine.stop();
}

async function toggleAnalysis() {
  if (!G.analysisEngine) return toast('検討エンジンがありません', '設定でエンジンを追加してください', '⚠️');
  G.analyzing = !G.analyzing;
  if (G.analyzing) restartAnalysis();
  else { await G.analysisEngine.stop(); await stopSubEngines(); }
  renderControls();
}

async function fullAnalysis() {
  const eng = G.analysisEngine;
  if (!eng) return toast('検討エンジンがありません', '設定でエンジンを追加してください', '⚠️');
  await stopSubEngines();
  G.analyzing = false;
  await eng.stop();
  const token = G.token;
  G.fullRunning = true;
  renderControls();
  const n = G.positions.length;
  for (let i = 0; i < n; i++) {
    if (G?.token !== token || !G.fullRunning) break;
    const prog = $('#full-prog');
    if (prog) prog.style.width = `${(i / n) * 100}%`;
    const pos = G.positions[i];
    if (pos.legalMoves().length === 0) { G.evals[i] = pos.side === BLACK ? -MATE_SCORE : MATE_SCORE; continue; }
    let last = null;
    const res = await eng.go(positionCmd(i), 'btime 0 wtime 0 byoyomi 700', info => {
      if (info.score != null && !info.bound) last = info;
    });
    if (G?.token !== token) return;
    if (last) G.evals[i] = pos.side === BLACK ? last.score : -last.score;
    if (res?.move && res.move !== 'resign') G.best[i] = res.move;
    G.cur = i;
    board.setPosition(pos, i > 0 ? G.moves[i - 1].m : null);
    updateEvalUI();
    renderKifu();
  }
  if (G?.token !== token) return;
  G.fullRunning = false;
  S.profile.analyzed++;
  saveStore();
  unlock('analyze1');
  const bad = G.moves.map((_, k) => moveQuality(k + 1)).filter(Boolean);
  addLive(`全体解析完了：${QUALITY.map(q => `${q.label} ${bad.filter(b => b.cls === q.cls).length}`).join(' ・ ')}`, 'hot');
  toast('全体解析が完了しました', 'グラフの点や棋譜の印から悪手を確認できます', '🔍');
  renderControls();
  gotoPly(G.cur);
}

async function openKifuFile() {
  if (!hasApi) return pasteKifu();
  const r = await window.api.openKifuDialog();
  if (!r) return;
  let text = new TextDecoder('utf-8').decode(r.data);
  if (text.includes('�')) text = new TextDecoder('shift_jis').decode(r.data);
  loadKifuText(text, r.path.split(/[\\/]/).pop());
}

function loadKifuText(text, title = '') {
  try {
    const rec = parseRecord(text);
    enterAnalysis(rec, `検討${title ? ' ・ ' + title : ''}`);
    toast('棋譜を読み込みました', `${rec.moves.length}手`, '📜');
  } catch (err) {
    alertBox('棋譜を読み込めませんでした', err.message);
  }
}

/** クリップボードの棋譜を読む。空なら貼り付け欄を開く */
async function pasteKifu() {
  let text = '';
  try { text = hasApi ? await window.api.clipRead() : await navigator.clipboard.readText(); } catch { /* 読めなければ手入力 */ }
  if (text && text.trim()) {
    try {
      const rec = parseRecord(text);
      if (rec.moves.length || rec.startSfen) { loadKifuText(text, 'クリップボード'); return; }
    } catch { /* 手入力へ */ }
  }
  const m = modal(`<h2>棋譜を貼り付け</h2>
    <p class="muted small">KIF / KI2 / CSA / SFEN / USI（position コマンド）に対応しています。</p>
    <textarea id="paste-text" rows="12" placeholder="例: position startpos moves 7g7f 3c3d ..."></textarea>
    <div class="modal-actions"><button class="btn ghost" data-cancel>キャンセル</button><button class="btn primary" data-ok>読み込む</button></div>`, { cls: 'wide' });
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-ok]').onclick = () => {
    const t = m.querySelector('#paste-text').value;
    closeModal();
    if (t.trim()) loadKifuText(t);
  };
}

/** 保存・コピー用の棋譜。KIF は変化を含む木全体、それ以外は表示中の手順 */
function currentRecord() {
  syncNodes();
  const moves = G.moves.map(x => ({ usi: x.usi, time: x.time, comment: x.comment }));
  return {
    startSfen: G.startSfen, moves, tree: G.root, black: G.names[0], white: G.names[1], info: G.info,
    result: G.result ? G.result.reason : '',
  };
}

const FORMATS = {
  kif: { name: 'KIF', fn: toKif },
  ki2: { name: 'KI2', fn: toKi2 },
  csa: { name: 'CSA', fn: toCsa },
  usi: { name: 'USI（棋譜）', fn: toUsi },
  sfen: { name: 'SFEN（現在の局面）', fn: () => 'sfen ' + curPos().toSfen() },
};

async function copyAs(fmt) {
  const text = FORMATS[fmt].fn(currentRecord());
  if (hasApi) await window.api.clipWrite(text);
  else await navigator.clipboard.writeText(text);
  toast('クリップボードにコピーしました', FORMATS[fmt].name, '📋');
}

function openCopyMenu() {
  const m = modal(`<h2>棋譜・局面をコピー</h2>
    <div class="copy-grid">${Object.entries(FORMATS).map(([k, f]) => `<button class="btn" data-fmt="${k}">${f.name}</button>`).join('')}
      <button class="btn" data-img="clipboard">🖼 盤面を画像でコピー（Ctrl+Shift+C）</button>
      <button class="btn" data-img="file">🖼 盤面を PNG で保存</button>
      <button class="btn" data-diagram>📐 局面図（書籍風）を書き出す</button></div>
    <div class="modal-actions"><button class="btn ghost" data-cancel>閉じる</button></div>`, { cls: 'small' });
  m.querySelectorAll('[data-fmt]').forEach(b => b.onclick = () => { closeModal(); copyAs(b.dataset.fmt); });
  m.querySelectorAll('[data-img]').forEach(b => b.onclick = () => { closeModal(); captureBoard(b.dataset.img); });
  m.querySelector('[data-diagram]').onclick = () => { closeModal(); openDiagramDialog(); };
  m.querySelector('[data-cancel]').onclick = closeModal;
}

/** 局面図（書籍風）の書き出し */
function openDiagramDialog() {
  const pos = G.mode === 'edit' ? G.editPos : curPos();
  const node = G.line?.[G.cur];
  const o = S.diagram || { size: 500, font: 'gothic', names: 'player', markLast: true };
  const m = modal(`<h2>局面図の書き出し</h2>
    <div class="diagram-wrap"><canvas id="dg-canvas"></canvas></div>
    <div class="field-row">
      <label class="field"><span>見出し</span><input id="dg-header" value="${esc(node?.bookmark || '')}" placeholder="例: 第1図（しおりがあれば自動で入ります）"></label>
      <label class="field"><span>持駒の表記</span><select id="dg-names"><option value="player" ${o.names === 'player' ? 'selected' : ''}>対局者名</option><option value="side" ${o.names === 'side' ? 'selected' : ''}>先手・後手</option></select></label>
    </div>
    <div class="field-row">
      <label class="field"><span>大きさ</span><select id="dg-size">${[400, 500, 600, 800, 1000].map(s => `<option value="${s}" ${o.size === s ? 'selected' : ''}>${s}px</option>`).join('')}</select></label>
      <label class="field"><span>書体</span><select id="dg-font"><option value="gothic" ${o.font === 'gothic' ? 'selected' : ''}>ゴシック</option><option value="mincho" ${o.font === 'mincho' ? 'selected' : ''}>明朝</option></select></label>
      <label class="field"><span>最終手</span><select id="dg-last"><option value="1" ${o.markLast ? 'selected' : ''}>色を付ける</option><option value="0" ${!o.markLast ? 'selected' : ''}>付けない</option></select></label>
    </div>
    <div class="modal-actions"><button class="btn ghost" data-cancel>閉じる</button><button class="btn" data-copy>📋 画像をコピー</button><button class="btn primary" data-save>💾 PNG で保存</button></div>`, { cls: 'wide' });
  const canvas = m.querySelector('#dg-canvas');
  const draw = () => {
    const opt = {
      size: +m.querySelector('#dg-size').value, font: m.querySelector('#dg-font').value,
      names: m.querySelector('#dg-names').value, markLast: m.querySelector('#dg-last').value === '1',
    };
    S.diagram = opt;
    saveStore();
    drawDiagram(canvas, pos, {
      size: opt.size, font: opt.font, header: m.querySelector('#dg-header').value.trim(),
      names: opt.names === 'player' ? [G.names[0] || '先手', G.names[1] || '後手'] : ['先手', '後手'],
      lastTo: opt.markLast && G.mode !== 'edit' && G.cur > 0 ? G.moves[G.cur - 1].m.to : null,
      flipped: board.flipped,
    });
  };
  m.querySelectorAll('input, select').forEach(el => el.addEventListener('input', draw));
  draw();
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-copy]').onclick = async () => {
    if (!hasApi) return toast('画像のコピーはデスクトップ版の機能です', '', 'ℹ️');
    await window.api.clipWriteImage(canvas.toDataURL('image/png'));
    toast('局面図をコピーしました', '', '📐');
  };
  m.querySelector('[data-save]').onclick = async () => {
    const name = `局面図_${G.cur ?? 0}手目.png`;
    if (hasApi) {
      const p = await window.api.savePng(canvas.toDataURL('image/png'), name);
      if (p) toast('局面図を保存しました', p, '📐');
    } else {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = name;
      a.click();
    }
  };
}

/** 盤と駒台を画像にする（ダイアログが閉じて描画し直されるのを待ってから撮る） */
async function captureBoard(mode = 'clipboard') {
  if (!hasApi) return toast('画像コピーはデスクトップ版の機能です', '', 'ℹ️');
  await sleep(120);
  const els = ['#hand-top', '#board', '#hand-bottom'].map(s => $(s).getBoundingClientRect());
  const pad = 8;
  const x = Math.min(...els.map(r => r.left)) - pad, y = Math.min(...els.map(r => r.top)) - pad;
  const rect = { x, y, width: Math.max(...els.map(r => r.right)) + pad - x, height: Math.max(...els.map(r => r.bottom)) + pad - y };
  const name = `盤面_${G ? G.cur : 0}手目.png`;
  const r = await window.api.captureBoard(rect, mode, name);
  if (r === 'clipboard') toast('盤面画像をコピーしました', 'ペイントや SNS に貼り付けできます', '🖼');
  else if (r) toast('盤面画像を保存しました', r, '🖼');
}

async function saveKifu() {
  const rec = currentRecord();
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  if (hasApi) {
    const p = await window.api.savePathDialog(`${base}.kifu`);
    if (!p) return;
    const ext = p.split('.').pop().toLowerCase();
    const text = ext === 'csa' ? toCsa(rec) : ext.startsWith('ki2') ? toKi2(rec) : ext === 'sfen' || ext === 'usi' ? toUsi(rec) : toKif(rec);
    await window.api.writeText(p, text);
    toast('棋譜を保存しました', p, '💾');
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toKif(rec)], { type: 'text/plain' }));
    a.download = `${base}.kifu`;
    a.click();
  }
}

// ---- 将棋ウォーズ ----
// ウォーズで棋譜（KIF）をコピーしてもらい、クリップボード経由で読み込む

function openWarsDialog() {
  const m = modal(`<h2>将棋ウォーズの棋譜を取り込む</h2>
    <ol class="wars-steps">
      <li>将棋ウォーズ（アプリまたは Web）で、取り込みたい対局の<b>棋譜を開きます</b></li>
      <li>棋譜画面のメニューから<b>棋譜（KIF）をコピー</b>します</li>
      <li>このアプリに戻り「クリップボードから読み込む」（または Ctrl+V）を押します</li>
    </ol>
    <p class="muted small">スマホでコピーした場合は、メモアプリなどで PC に送ってからコピーし直してください。KIF / KI2 / CSA 形式の棋譜を読み込めます。</p>
    <div class="modal-actions"><button class="btn ghost" data-cancel>閉じる</button><button class="btn" data-wsite>🌐 将棋ウォーズを開く</button><button class="btn primary" data-wpaste>📋 クリップボードから読み込む</button></div>`, { cls: 'wide' });
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-wsite]').onclick = () => {
    const url = 'https://shogiwars.heroz.jp/';
    if (hasApi) window.api.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  };
  m.querySelector('[data-wpaste]').onclick = () => { closeModal(); pasteKifu(); };
}

// ---- 詰み探索 ----

let mateWorker = null;
function jsMateSearch(sfen, maxPly, timeMs) {
  mateWorker?.terminate();
  mateWorker = new Worker(new URL('./mate-worker.js', import.meta.url), { type: 'module' });
  return new Promise(res => {
    mateWorker.onmessage = e => { res(e.data); mateWorker.terminate(); mateWorker = null; };
    mateWorker.onerror = () => { res({ kind: 'timeout' }); mateWorker = null; };
    mateWorker.postMessage({ sfen, maxPly, timeMs });
  });
}

async function mateSearch() {
  if (G.mateRunning) return;
  const ply = G.cur;
  const pos = curPos();
  G.mateRunning = true;
  renderControls();
  const wasAnalyzing = G.analyzing;
  G.analyzing = false;
  await stopSubEngines();
  let r = { kind: 'notimpl' };
  const eng = G.analysisEngine;
  if (eng) {
    await eng.stop();
    r = await eng.goMate(positionCmd(ply), 10000);
  }
  let by = eng?.name || 'エンジン';
  if (r.kind === 'notimpl') {
    by = '内蔵ソルバー';
    toast('詰み探索中…', 'エンジンが詰み探索に未対応のため、内蔵ソルバーで探します（最大15手）', '🔎');
    r = await jsMateSearch(pos.toSfen(), 15, 10000);
  }
  G.mateRunning = false;
  if (!G || G.cur !== ply) return;
  G.analyzing = wasAnalyzing;
  renderControls();
  if (G.analyzing) restartAnalysis();
  if (r.kind === 'mate') {
    const ja = pvToJa(ply, r.moves, 99);
    addLive(`${r.moves.length}手詰み：${ja}`, 'hot');
    const m = modal(`<h2>${r.moves.length}手詰み</h2><p class="pv-line">${esc(ja)}</p><p class="muted small">探索：${esc(by)}</p>
      <div class="modal-actions"><button class="btn ghost" data-close>閉じる</button><button class="btn" data-preview>盤で再生</button><button class="btn primary" data-apply>棋譜に入れる</button></div>`);
    m.querySelector('[data-close]').onclick = closeModal;
    m.querySelector('[data-preview]').onclick = () => { closeModal(); previewPv(ply, r.moves, 0); };
    m.querySelector('[data-apply]').onclick = () => {
      closeModal();
      syncNodes();
      truncateTo(ply);
      for (const u of r.moves) pushMove(lastPos().findMove(u));
      G.line[ply + 1].comment ||= `${r.moves.length}手詰み（${by}）`;
      G.cur = -1;
      gotoPly(ply + 1);
      toast('詰み手順を変化として追加しました', '', '🌿');
    };
    sfx.promote();
  } else {
    alertBox(r.kind === 'nomate' ? '詰みはありません' : '詰みが見つかりませんでした',
      r.kind === 'nomate' ? `${by}の探索範囲では詰みませんでした。` : '時間内に詰みを発見できませんでした（長手数の詰み、または詰みなし）。');
  }
}

// =====================================================================
// 描画（プレイヤー・評価値・棋譜・読み筋・操作ボタン）
// =====================================================================

function renderPlayers() {
  if (!G) return;
  const topSide = board.flipped ? BLACK : WHITE;
  for (const [el, side] of [[$('#player-top'), topSide], [$('#player-bottom'), topSide ^ 1]]) {
    const p = G.players[side] || { name: '' };
    const turn = !G.over && G.mode !== 'analysis' && lastPos().side === side;
    const isWinner = G.over && G.result && G.result.winner === side;
    el.dataset.side = side;
    el.className = `player-bar ${el.id === 'player-top' ? 'top' : 'bottom'}${turn ? ' turn' : ''}${p.thinking ? ' thinking' : ''}${isWinner ? ' winner' : ''}`;
    const icon = p.kind === 'engine' ? '🤖' : '👤';
    el.innerHTML = `
      <div class="pb-mark ${side === BLACK ? 'b' : 'w'}">${side === BLACK ? '☗' : '☖'}</div>
      <div class="pb-avatar">${icon}</div>
      <div class="pb-main">
        <div class="pb-name">${esc(p.name)} ${p.level ? `<span class="stars">${'★'.repeat(p.level.stars)}</span>` : ''}</div>
        <div class="pb-info">${p.thinking ? '<span class="think-dots">思考中</span>' : ''}</div>
      </div>
      <div class="clock"></div>`;
    renderPlayerInfo(side);
  }
  updateClocks();
}

function renderPlayerInfo(side) {
  const el = document.querySelector(`.player-bar[data-side="${side}"] .pb-info`);
  const p = G?.players[side];
  if (!el || !p) return;
  const parts = [];
  if (p.thinking) parts.push('<span class="think-dots">思考中</span>');
  if (p.info && (G.mode === 'net' || (G.mode === 'play' && S.showEval))) {
    parts.push(`<span>評価 ${dispScore(p.info.s, side)}</span>`);
    if (p.info.depth) parts.push(`<span>深さ ${p.info.depth}</span>`);
    if (p.info.nps) parts.push(`<span>${(p.info.nps / 10000).toFixed(0)}万局面/秒</span>`);
  }
  el.innerHTML = parts.join('');
}

function updateEvalUI() {
  if (!G) return;
  const hidden = G.mode === 'play' && !S.showEval && !G.over;
  const s = hidden ? null : lastKnownEval(G.mode === 'analysis' || G.over ? G.cur : G.positions.length - 1);
  const sit = situation(s);
  $('#eval-num').textContent = hidden ? '？？？' : dispScore(s, curPos().side);
  $('#eval-sit').textContent = hidden ? '評価値は非表示です' : sit.text;
  $('#eval-sit').dataset.level = sit.level;
  // ゲージ（下側のプレイヤーの勝率）
  const wr = s == null ? 0.5 : winRate(s);
  const bottomWr = board.flipped ? 1 - wr : wr;
  $('#gauge').style.setProperty('--wr', bottomWr);
  $('#gauge').classList.toggle('flipped', board.flipped);
  // 上端に上側、下端に下側の対局者の勝率（☗ 先手 / ☖ 後手）
  const pct = v => (hidden ? '?' : `${Math.round(v * 100)}%`);
  const [topMark, bottomMark] = board.flipped ? ['☗', '☖'] : ['☖', '☗'];
  $('#gauge-top').textContent = `${topMark} ${pct(1 - bottomWr)}`;
  $('#gauge-bottom').textContent = `${bottomMark} ${pct(bottomWr)}`;
  const marks = [];
  if (G.mode === 'analysis') {
    G.moves.forEach((_, k) => {
      const q = moveQuality(k + 1);
      if (q) marks.push({ i: k + 1, color: q.color });
    });
  }
  graph.set(hidden ? [] : G.evals, G.cur, marks);
}

function renderKifu() {
  if (!G) return;
  const ol = $('#tab-kifu');
  const clickable = G.mode === 'analysis' || G.over;
  let html = `<li class="${G.cur === 0 ? 'cur' : ''}" data-i="0"><span class="n">0</span><span class="mv">開始局面</span></li>`;
  G.moves.forEach((mv, k) => {
    const i = k + 1;
    const q = G.mode === 'analysis' ? moveQuality(i) : null;
    const ev = G.evals[i];
    const siblings = G.line[k]?.children.length || 1;
    const isVar = G.line[k] && G.line[k].children.indexOf(mv) > 0;
    html += `<li class="${G.cur === i ? 'cur' : ''} ${q ? q.cls : ''} ${isVar ? 'var' : ''}" data-i="${i}">
      <span class="n">${i}</span><span class="mv">${esc(mv.ja)}${q ? `<em>${q.mark}</em>` : ''}${siblings > 1 ? `<b class="fork" title="変化 ${siblings}通り">+${siblings - 1}</b>` : ''}${mv.comment ? '<b class="cmt" title="コメントあり">💬</b>' : ''}${mv.bookmark ? `<b class="mark">🔖${esc(mv.bookmark)}</b>` : ''}</span>
      <span class="ev">${G.mode === 'analysis' && ev != null ? dispScore(ev, G.positions[i].side) : ''}</span>${S.showMoveTime !== false && mv.time ? `<span class="tm">${fmtMoveTime(mv.time)}</span>` : ''}</li>`;
  });
  if (G.over && G.result) html += `<li class="end"><span class="n">${G.moves.length + 1}</span><span class="mv">${esc(G.result.reason)}</span></li>`;
  ol.innerHTML = html;
  ol.classList.toggle('clickable', clickable);
  ol.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  renderBook();
  renderTree();
  renderMarks();
}

// ---- 定跡タブ ----

function renderBook() {
  const box = $('#tab-book');
  if (!box || !G) return;
  const pos = G.mode === 'edit' ? G.editPos : curPos();
  if (!pos) return;
  const ms = bookMoves(pos);
  const total = ms.reduce((s, m) => s + m.count, 0);
  const prevTo = G.mode !== 'edit' && G.cur > 0 ? G.moves[G.cur - 1].m.to : -1;
  const canAdd = G.mode === 'analysis' || G.over;
  const st = bookStats();
  box.innerHTML = `
    <div class="book-head"><span>この局面の定跡 ${ms.length}手</span><small>登録 ${st.positions.toLocaleString()}局面・${st.moves.toLocaleString()}手</small></div>
    ${ms.length ? `<table class="book-table"><tr><th>指し手</th><th>回数</th><th>採用率</th><th>評価</th><th></th></tr>
      ${ms.map(b => {
        const m = pos.findMove(b.usi);
        return `<tr class="book-row" data-busi="${b.usi}" title="${esc(b.comment)}">
          <td class="bm">${esc(moveToJa(pos, m, prevTo))}${b.comment ? ' 💬' : ''}</td><td>${b.count}</td>
          <td><div class="minibar"><div style="width:${total ? (b.count / total) * 100 : 0}%"></div></div>${total ? Math.round((b.count / total) * 100) : 0}%</td>
          <td>${b.eval != null ? formatScore(b.eval) : '—'}</td>
          <td class="book-acts"><button class="br-act" data-bedit="${b.usi}" title="編集">✎</button><button class="br-act" data-bdel="${b.usi}" title="削除">✕</button></td></tr>`;
      }).join('')}</table>` : '<p class="muted small">この局面の定跡はまだありません</p>'}
    ${canAdd ? `<div class="ctl-row">
      <button class="btn small" data-badd ${G.moves[G.cur] ? '' : 'disabled'}>次の手を登録</button>
      <button class="btn small" data-bline>この手順を全部登録</button></div>` : ''}
    <div class="ctl-row"><button class="btn small ghost" data-bimport>📂 やねうら王形式を読込</button><button class="btn small ghost" data-bexport>💾 書き出し</button></div>`;
  box.querySelectorAll('.book-row .bm').forEach(td => td.onclick = () => {
    const usi = td.parentElement.dataset.busi;
    const m = curPos().findMove(usi);
    if (m && G.mode === 'analysis') analysisMove(m);
  });
  box.querySelectorAll('[data-bdel]').forEach(b => b.onclick = () => { deleteBookMove(pos, b.dataset.bdel); renderBook(); });
  box.querySelectorAll('[data-bedit]').forEach(b => b.onclick = () => editBookMove(pos, b.dataset.bedit));
  box.querySelector('[data-badd]')?.addEventListener('click', () => {
    addBookMove(curPos(), G.moves[G.cur].usi);
    toast('定跡に登録しました', G.moves[G.cur].ja, '📖');
    renderBook();
  });
  box.querySelector('[data-bline]')?.addEventListener('click', () => {
    const n = addLineToBook(G.startSfen, G.moves.map(x => x.usi));
    toast('手順を定跡に登録しました', `${n}手`, '📖');
    renderBook();
  });
  box.querySelector('[data-bimport]').onclick = async () => {
    const text = window.api ? await window.api.bookImport() : null;
    if (!text) return;
    const r = importYaneuraou(text);
    toast('定跡を読み込みました', `${r.positions.toLocaleString()}局面・${r.moves.toLocaleString()}手`, '📖');
    renderBook();
  };
  box.querySelector('[data-bexport]').onclick = async () => {
    const p = window.api ? await window.api.bookExport(exportYaneuraou()) : null;
    if (p) toast('定跡を書き出しました', p, '💾');
  };
}

function editBookMove(pos, usi) {
  const b = bookMoves(pos).find(x => x.usi === usi);
  if (!b) return;
  const m = modal(`<h2>定跡の編集</h2><p><b>${esc(moveToJa(pos, pos.findMove(usi)))}</b></p>
    <div class="field-row"><label class="field"><span>回数（採用の重み）</span><input type="number" id="bk-count" min="0" value="${b.count}"></label>
    <label class="field"><span>評価値</span><input type="number" id="bk-eval" value="${b.eval ?? ''}" placeholder="なし"></label></div>
    <label class="field"><span>コメント</span><input id="bk-comment" value="${esc(b.comment)}"></label>
    <div class="modal-actions"><button class="btn ghost" data-cancel>キャンセル</button><button class="btn primary" data-ok>保存</button></div>`);
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-ok]').onclick = () => {
    const ev = m.querySelector('#bk-eval').value;
    updateBookMove(pos, usi, {
      count: +m.querySelector('#bk-count').value || 0,
      eval: ev === '' ? null : +ev,
      comment: m.querySelector('#bk-comment').value,
    });
    closeModal();
    renderBook();
  };
}

function renderKifuMarks() {
  const li = document.querySelector(`#tab-kifu li[data-i="${G.cur}"] .mv`);
  if (!li || G.cur === 0) return;
  const has = !!G.line[G.cur].comment;
  const el = li.querySelector('.cmt');
  if (has && !el) li.insertAdjacentHTML('beforeend', '<b class="cmt" title="コメントあり">💬</b>');
  if (!has && el) el.remove();
}

/** 検討モード: 現在の局面から分かれる変化の一覧 */
function renderBranches() {
  const box = $('#branches');
  if (!box || !G || G.mode !== 'analysis') return;
  const node = G.line[G.cur];
  const kids = node?.children || [];
  if (kids.length < 2) { box.innerHTML = ''; return; }
  const selected = G.line[G.cur + 1];
  box.innerHTML = `<div class="br-head">次の手の変化（${kids.length}通り）</div>` + kids.map((c, k) => `
    <div class="br-item ${c === selected ? 'on' : ''}">
      <button class="br-move" data-br="${k}">${k === 0 ? '<small>本譜</small>' : `<small>変化${k}</small>`}${esc(c.ja)}</button>
      ${k > 0 ? `<button class="br-act" data-brup="${k}" title="本譜にする">⤴</button>` : ''}
      <button class="br-act" data-brdel="${k}" title="この変化を削除">✕</button>
    </div>`).join('');
  box.querySelectorAll('[data-br]').forEach(b => b.onclick = () => switchBranch(G.cur, +b.dataset.br));
  box.querySelectorAll('[data-brup]').forEach(b => b.onclick = () => promoteBranch(G.cur, +b.dataset.brup));
  box.querySelectorAll('[data-brdel]').forEach(b => b.onclick = () => deleteBranch(G.cur, +b.dataset.brdel));
}

function renderPv(side, ply, info) {
  const who = G.players[side]?.name || (side === BLACK ? '先手' : '後手');
  const s = side === BLACK ? info.score : -info.score;
  $('#tab-pv').innerHTML = `
    <div class="pv-head"><b>${esc(G.mode === 'analysis' ? (G.analysisEngine?.name || '検討エンジン') : who)}</b>
      <span>評価 ${dispScore(s, G.positions[ply]?.side)}</span><span>深さ ${info.depth ?? '-'}</span>
      ${info.nodes ? `<span>${info.nodes.toLocaleString()} 局面</span>` : ''}</div>
    <div class="pv-line">${esc(pvToJa(ply, info.pv || []))}</div>`;
}

/** 読み筋の各手を、クリックで盤面再生できる要素にする */
function pvSpans(ply, usis, k, max = 16) {
  let pos = G.positions[ply];
  let prevTo = ply > 0 ? G.moves[ply - 1].m.to : -1;
  const out = [];
  usis.slice(0, max).forEach((u, j) => {
    const m = pos.findMove(u);
    if (!m) return;
    out.push(`<span class="pv-mv" data-k="${k}" data-j="${j}">${esc(moveToJa(pos, m, prevTo))}</span>`);
    prevTo = m.to;
    pos = pos.play(m);
  });
  return out.join(' ');
}

/** 検討モードの候補手一覧（MultiPV） */
function renderPvLines(ply) {
  const lines = G.pvLines || [];
  const first = lines.find(Boolean);
  const eng = G.analysisEngine;
  const multiNote = (S.multiPV || 1) > 1 && eng && !eng.options.has('MultiPV')
    ? '<div class="muted small">※ このエンジンは複数候補（MultiPV）に未対応です</div>' : '';
  $('#tab-pv').innerHTML = `
    <div class="pv-head"><b>${esc(eng?.name || '検討エンジン')}</b>
      ${first ? `<span>深さ ${first.depth ?? '-'}${first.seldepth ? '/' + first.seldepth : ''}</span>
      ${first.nodes ? `<span>${first.nodes.toLocaleString()} 局面</span>` : ''}
      ${first.nps ? `<span>${Math.round(first.nps / 1000).toLocaleString()}k NPS</span>` : ''}
      ${first.hashfull != null ? `<span>ハッシュ ${(first.hashfull / 10).toFixed(1)}%</span>` : ''}` : ''}</div>
    ${multiNote}
    ${lines.map((l, k) => l ? `<div class="pv-cand" style="--c:${ARROW_COLORS[k] || 'var(--text-dim)'}">
      <div class="pv-rank">${k + 1}</div><div class="pv-score">${dispScore(l.s, curPos().side)}</div>
      <div class="pv-line">${pvSpans(ply, l.pv, k)}</div></div>` : '').join('')}
    ${(G.subEngines || []).map((sub, i) => {
      const sl = sub.lines || [];
      const top = sl.find(Boolean);
      return `
      <div class="pv-head sub"><b>${esc(sub.engine.name || sub.ed.name)}</b>${top ? `<span>深さ ${top.depth ?? '-'}</span>${top.nps ? `<span>${Math.round(top.nps / 1000).toLocaleString()}k NPS</span>` : ''}` : '<span>思考中…</span>'}</div>
      ${sl.map((l, k) => (l ? `<div class="pv-cand" style="--c:${SUB_COLORS[i]}"><div class="pv-rank">${k + 1}</div><div class="pv-score">${dispScore(l.s, curPos().side)}</div>
        <div class="pv-line">${pvSpans(ply, l.pv, `s${i}_${k}`)}</div></div>` : '')).join('')}`;
    }).join('')}
    <div class="muted small">読み筋の手をクリックすると、その局面を盤に表示します</div>`;
  $('#tab-pv').dataset.ply = ply;
  renderAnalysisTable();
}

// ---- 思考履歴タブ ----

/** エンジンの思考（info）を履歴に残す。新しいものが上 */
function logThink(ply, info, engineName) {
  if (!G) return;
  if (G.thinkPly !== ply) { G.think = []; G.thinkPly = ply; }
  G.think ||= [];
  G.think.unshift({ ...info, engine: engineName, ply });
  if (G.think.length > 300) G.think.length = 300;
  clearTimeout(G.thinkTimer);
  G.thinkTimer = setTimeout(renderThink, 150); // 描画をまとめる
}

function renderThink() {
  const box = $('#tab-think');
  if (!box || !G) return;
  if (!(S.panes?.top === 'think' || S.panes?.bottom === 'think')) return;
  const rows = (G.think || []).slice(0, 120);
  if (!rows.length) { box.innerHTML = '<p class="muted small">エンジンが考えると、ここに思考の履歴（新しい順）が出ます</p>'; return; }
  const side = G.positions[rows[0].ply]?.side;
  const fmtN = n => (n == null ? '' : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString()}万` : n.toLocaleString());
  box.innerHTML = `<table class="an-table think-table"><tr><th>時間</th><th>深さ</th><th>候補</th><th>評価値</th><th>局面数</th><th>読み筋</th></tr>
    ${rows.map(r => `<tr><td>${r.time != null ? (r.time / 1000).toFixed(1) + 's' : ''}</td><td>${r.depth ?? ''}${r.seldepth ? '/' + r.seldepth : ''}</td>
      <td>${r.multipv || 1}</td><td class="an-score">${dispScore(r.s, side)}</td><td>${fmtN(r.nodes)}</td>
      <td class="an-pv">${esc(pvToJa(r.ply, r.pv || [], S.maxPvText || 12))}</td></tr>`).join('')}</table>`;
}

// ---- 棋譜情報タブ ----

function renderInfo() {
  const box = $('#tab-info');
  if (!box || !G) return;
  const hc = HANDICAPS.find(h => h.sfen === G.startSfen);
  box.innerHTML = `<div class="info-form">
    <label><span>先手</span><input data-name="0" value="${esc(G.names[0])}"></label>
    <label><span>後手</span><input data-name="1" value="${esc(G.names[1])}"></label>
    ${INFO_FIELDS.map(([k, label]) => `<label><span>${label}</span><input data-info="${k}" value="${esc(G.info?.[k] || '')}"></label>`).join('')}
    <label><span>手合割</span><input value="${hc ? hc.name : '指定局面'}" disabled></label>
    <label><span>手数</span><input value="${G.moves.length}手${G.result ? ` ・ ${esc(G.result.reason)}` : ''}" disabled></label>
  </div>`;
  box.querySelectorAll('[data-name]').forEach(el => el.oninput = () => {
    G.names[+el.dataset.name] = el.value;
    if (G.players[+el.dataset.name]) G.players[+el.dataset.name].name = el.value;
    renderPlayers();
  });
  box.querySelectorAll('[data-info]').forEach(el => el.oninput = () => { (G.info ||= {})[el.dataset.info] = el.value; });
}

// ---- しおり一覧タブ ----

function renderMarks() {
  const box = $('#tab-marks');
  if (!box || !G) return;
  if (!(S.panes?.top === 'marks' || S.panes?.bottom === 'marks')) return;
  const list = [];
  const walk = (n, ply) => n.children.forEach(c => { if (c.bookmark) list.push({ node: c, ply: ply + 1 }); walk(c, ply + 1); });
  walk(G.root, 0);
  if (!list.length) { box.innerHTML = '<p class="muted small">しおりはまだありません。検討画面の「🔖 しおり」欄に見出しを入れると、ここに一覧が出ます。</p>'; return; }
  box.innerHTML = `<ul class="mark-list">${list.map((x, i) => `<li data-mk="${i}"><b>🔖 ${esc(x.node.bookmark)}</b><span>${x.ply}手目 ${esc(x.node.ja)}</span></li>`).join('')}</ul>`;
  box.querySelectorAll('[data-mk]').forEach(li => li.onclick = () => { if (G.mode === 'analysis' || G.over) jumpToNode(list[+li.dataset.mk].node); });
}

// ---- 自動保存 ----

/** ファイル名のひな形（{datetime} {date} {sente} {gote} {title}）を展開する */
function recordFileName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const t = S.fileTemplate || '{datetime}_{sente}_{gote}';
  const name = t
    .replace(/\{datetime\}/g, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`)
    .replace(/\{date\}/g, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`)
    .replace(/\{sente\}/g, G.names[0] || '先手').replace(/\{gote\}/g, G.names[1] || '後手')
    .replace(/\{title\}/g, G.info?.event || '');
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'kifu';
}

async function autoSaveRecord() {
  if (!hasApi || !S.autoSave || !S.autoSaveDir || !G?.moves.length) return;
  const text = toKif(currentRecord());
  const p = await window.api.autoSave(S.autoSaveDir, `${recordFileName()}.kifu`, text);
  if (p) addLive(`棋譜を自動保存しました：${p}`, 'normal');
}

const fmtMoveTime = ms => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---- 右パネルの上下 2 段タブ ----

const PANE_TABS = [
  ['kifu', '棋譜'], ['chart', 'グラフ'], ['pv', '読み筋'], ['think', '思考'],
  ['live', '実況'], ['book', '定跡'], ['info', '棋譜情報'], ['marks', 'しおり'],
];

/** S.panes = { top, bottom } の通りにタブの中身を配置する */
function layoutPanes() {
  S.panes ||= { top: 'kifu', bottom: 'chart' };
  for (const area of ['top', 'bottom']) {
    const bar = document.querySelector(`.tabs[data-area="${area}"]`);
    const body = document.querySelector(`.tab-body[data-area="${area}"]`);
    bar.innerHTML = PANE_TABS.map(([id, name]) =>
      `<button data-tab="${id}" data-area="${area}" class="${S.panes[area] === id ? 'active' : ''}">${name}</button>`).join('');
    const want = $('#tab-' + S.panes[area]);
    if (body.firstElementChild !== want) {
      [...body.children].forEach(c => $('#pane-store').appendChild(c));
      body.appendChild(want);
    }
  }
  $('#split').style.setProperty('--split', `${S.panelSplit ?? 55}%`);
  graph.draw();
  if (S.panes.top === 'think' || S.panes.bottom === 'think') renderThink();
  if (S.panes.top === 'info' || S.panes.bottom === 'info') renderInfo();
  if (S.panes.top === 'marks' || S.panes.bottom === 'marks') renderMarks();
}

/** area のタブを name にする。もう片方に出ていたら入れ替える */
function selectTabIn(area, name) {
  const other = area === 'top' ? 'bottom' : 'top';
  S.panes ||= { top: 'kifu', bottom: 'chart' };
  if (S.panes[other] === name) S.panes[other] = S.panes[area];
  S.panes[area] = name;
  saveStore();
  layoutPanes();
}

/** name のタブを見えるようにする（どちらかに出ていれば何もしない） */
function selectTab(name) {
  S.panes ||= { top: 'kifu', bottom: 'chart' };
  if (S.panes.top === name || S.panes.bottom === name) return;
  selectTabIn('bottom', name);
}

// 上下の境界をドラッグして大きさを変える
$('#splitter').addEventListener('pointerdown', e => {
  const split = $('#split');
  const r = split.getBoundingClientRect();
  e.preventDefault();
  const move = ev => {
    const pct = Math.max(15, Math.min(85, ((ev.clientY - r.top) / r.height) * 100));
    S.panelSplit = Math.round(pct);
    split.style.setProperty('--split', `${S.panelSplit}%`);
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    saveStore();
    graph.draw();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

function renderControls() {
  const box = $('#controls');
  if (!G) { box.innerHTML = ''; return; }
  const btn = (a, label, cls = '', dis = false) => `<button class="btn ${cls}" data-c="${a}" ${dis ? 'disabled' : ''}>${label}</button>`;
  let html = '';
  const engThinking = G.players.some(p => p?.thinking);
  if (G.mode === 'edit') {
    html = renderEditControls();
  } else if (G.mode === 'play' && !G.over) {
    const myTurn = lastPos().side === G.humanSide;
    html = `<div class="ctl-row">${btn('resign', '🏳 投了', 'danger')}${btn('undo', '↶ 待った', '', !myTurn || G.moves.length < 1)}${btn('hint', '💡 ヒント', '', !myTurn)}</div>
      <div class="ctl-row">${btn('moveNow', '⏩ すぐ指させる', 'ghost', !engThinking)}${btn('toggleEval', S.showEval ? '評価値を隠す' : '評価値を表示', 'ghost')}${btn('flip', '⇅ 盤反転', 'ghost')}</div>`;
  } else if (G.mode === 'net' && !G.over) {
    html = G.netStarted
      ? `<div class="ctl-row">${btn('resign', '🏳 投了', 'danger')}${btn('moveNow', '⏩ すぐ指させる', '', !engThinking)}</div>
         <div class="ctl-row">${btn('flip', '⇅ 盤反転', 'ghost')}${btn('copy', '📋 コピー', 'ghost')}${btn('netClose', '🔌 切断', 'ghost')}</div>`
      : `<div class="ctl-row">${btn('netClose', '🔌 接続をやめる', 'danger')}</div>`;
  } else if (G.mode === 'analysis') {
    html = `<div id="move-note" class="move-note"></div>
      <div id="branches" class="branches"></div>
      <input id="kifu-mark" class="kifu-mark" placeholder="🔖 しおり（この局面に付ける見出し）" value="${esc(G.line[G.cur]?.bookmark || '')}">
      <textarea id="kifu-comment" class="kifu-comment" rows="2" placeholder="この手へのコメント（棋譜に保存されます）">${esc(G.line[G.cur]?.comment || '')}</textarea>
      <div class="ctl-row nav">${btn('first', '⏮')}${btn('prev', '◀')}${btn('next', '▶')}${btn('last', '⏭')}</div>
      <div class="ctl-row">${btn('analyze', G.analyzing ? '■ 検討停止' : '▶ 検討開始', G.analyzing ? 'active' : 'primary')}
        <select id="multipv" class="mpv" title="メインエンジンの候補手の数">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${(S.multiPV || 1) === n ? 'selected' : ''}>候補 ${n}</option>`).join('')}</select>
        ${G.subEngines?.length ? `<select id="submultipv" class="mpv" title="同時検討エンジンの候補手の数">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${(S.subMultiPV || 1) === n ? 'selected' : ''}>サブ ${n}</option>`).join('')}</select>` : ''}
        ${btn('mate', G.mateRunning ? '探索中…' : '🎯 詰み探索', '', G.mateRunning)}</div>
      <div class="ctl-row">${G.fullRunning ? btn('fullStop', '全体解析を中止', 'danger') : btn('full', '📈 全体解析')}${btn('edit', '✎ 局面編集')}${S.showTree === false ? btn('tree', '🌳', 'ghost') : ''}</div>
      ${G.fullRunning ? '<div class="progress"><div id="full-prog"></div></div>' : ''}
      <div class="ctl-row">${btn('menuFile', '📁 棋譜 ▾', 'ghost')}${btn('menuFrom', '⚔ この局面から ▾', 'ghost')}${btn('flip', '⇅', 'ghost')}</div>`;
  } else {
    // 終局後
    html = `<div class="ctl-row">${btn('again', '🔁 もう一局', 'primary')}${btn('toAnalysis', '🔍 検討する')}</div>
      <div class="ctl-row nav">${btn('first', '⏮')}${btn('prev', '◀')}${btn('next', '▶')}${btn('last', '⏭')}</div>
      <div class="ctl-row">${btn('copy', '📋 コピー', 'ghost')}${btn('save', '💾 棋譜保存', 'ghost')}${btn('flip', '⇅ 盤反転', 'ghost')}</div>`;
  }
  box.innerHTML = html;
  if (G.mode === 'analysis') {
    showMoveNote();
    $('#submultipv')?.addEventListener('change', e => setSubMultiPV(+e.target.value));
    $('#multipv').onchange = e => {
      S.multiPV = +e.target.value;
      saveStore();
      if (G.analyzing) restartAnalysis();
    };
    $('#kifu-mark').oninput = e => {
      G.line[G.cur].bookmark = e.target.value.trim();
      renderKifu();
      renderMarks();
    };
    $('#kifu-comment').oninput = e => {
      G.line[G.cur].comment = e.target.value.trim() ? e.target.value : '';
      renderKifuMarks();
    };
    renderBranches();
    renderAnalysisTable();
  }
  if (G.mode === 'edit') bindEditControls();
}

/** 小さなメニュー（項目を選ぶと onControl を呼ぶ） */
function openMenu(items) {
  const m = modal(`<div class="menu-list">${items.map(([a, label]) => `<button class="btn" data-menu="${a}">${label}</button>`).join('')}</div>`, { cls: 'small' });
  m.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => { closeModal(); onControl(b.dataset.menu); });
}

async function onControl(a) {
  sfx.click();
  switch (a) {
    case 'resign':
      if (!await confirmBox('投了しますか？', '')) break;
      if (G.mode === 'net') NET?.client?.resign();
      else endGame(G.humanSide ^ 1, '投了');
      break;
    case 'netClose': netDisconnect(); break;
    case 'undo': {
      if (G.over || G.moves.length < 1) return;
      const eng = G.players[G.humanSide ^ 1].engine;
      G.token = {};
      await eng.stop();
      do { truncateTo(G.moves.length - 1); } while (G.moves.length > 0 && lastPos().side !== G.humanSide);
      if (lastPos().side !== G.humanSide) { // 相手の初手まで戻った場合
        G.cur = G.positions.length - 1;
        board.setPosition(curPos());
        startTurn();
        return;
      }
      G.assisted = true;
      G.cur = G.positions.length - 1;
      board.setPosition(curPos(), G.moves.length ? G.moves[G.moves.length - 1].m : null);
      board.setArrows([]);
      G.turnStart = performance.now();
      renderKifu();
      updateEvalUI();
      renderControls();
      toast('待った', 'EXP とレートの上昇が半分になります', '↶');
      break;
    }
    case 'hint': {
      const eng = G.players[G.humanSide ^ 1].engine;
      const ply = G.positions.length - 1;
      G.assisted = true;
      G.hintRunning = true;
      toast('ヒントを考えています…', '', '💡');
      const res = await eng.go(positionCmd(), 'btime 0 wtime 0 byoyomi 1500', () => {});
      G.hintRunning = false;
      if (!G || G.over || G.positions.length - 1 !== ply) return;
      const m = res && curPos().findMove(res.move);
      if (m) {
        board.setArrows([{ move: m, color: 'var(--arrow)', label: 'ヒント' }]);
        addLive(`ヒント：${moveToJa(curPos(), m, ply > 0 ? G.moves[ply - 1].m.to : -1)}`, 'good');
      }
      break;
    }
    case 'toggleEval':
      S.showEval = !S.showEval;
      saveStore();
      updateEvalUI();
      renderPlayers();
      renderControls();
      break;
    case 'flip':
      board.setFlipped(!board.flipped);
      renderPlayers();
      updateEvalUI();
      break;
    case 'save': saveKifu(); break;
    case 'first': gotoPly(0); break;
    case 'prev': gotoPly(G.cur - 1); break;
    case 'next': gotoPly(G.cur + 1); break;
    case 'last': gotoPly(G.positions.length - 1); break;
    case 'analyze': toggleAnalysis(); break;
    case 'full': fullAnalysis(); break;
    case 'fullStop': G.fullRunning = false; renderControls(); break;
    case 'open': openKifuFile(); break;
    case 'paste': pasteKifu(); break;
    case 'again':
      if (G.mode === 'net') { if (NET) netReconnect(); else openNetSetup(); }
      else openPlaySetup();
      break;
    case 'toAnalysis': analyzeCurrentGame(); break;
    case 'moveNow':
      for (const p of G.players) if (p?.thinking) p.engine.send('stop');
      break;
    case 'copy': openCopyMenu(); break;
    case 'wars': openWarsDialog(); break;
    case 'menuFile':
      openMenu([
        ['open', '📂 棋譜ファイルを開く'], ['paste', '📋 貼り付け（Ctrl+V）'], ['wars', '📥 将棋ウォーズから'],
        ['copy', '📄 コピー・画像・局面図'], ['save', '💾 棋譜を保存'],
      ]);
      break;
    case 'menuFrom':
      openMenu([['playFrom', '⚔ この局面から対局'], ['edit', '✎ この局面を編集']]);
      break;
    case 'tree':
      S.showTree = true;
      saveStore();
      renderTree();
      renderControls();
      break;
    case 'mate': mateSearch(); break;
    case 'edit': enterEditor(curPos()); break;
    case 'playFrom': openPlaySetup(curPos().toSfen()); break;
    default: break;
  }
}

// =====================================================================
// 局面編集
// =====================================================================

const PIECE_TOTAL = [0, 18, 4, 4, 4, 2, 2, 4, 2]; // 歩 香 桂 銀 角 飛 金 玉
const BOX_TYPES = [8, 6, 5, 7, 4, 3, 2, 1];

/** 駒箱に残っている枚数（盤上・持ち駒に使われていない数） */
function boxCounts(pos) {
  const used = new Array(9).fill(0);
  for (const p of pos.board) if (p) used[unpromote(typeOf(p))]++;
  for (const c of [BLACK, WHITE]) for (let t = 1; t <= 7; t++) used[t] += pos.hands[c][t];
  return PIECE_TOTAL.map((n, t) => n - used[t]);
}

function enterEditor(pos) {
  if (G) stopEngines();
  const start = pos.clone();
  newGame('edit', start.toSfen());
  G.editPos = start;
  G.editSel = null;
  G.editColor = BLACK;
  G.players = [{ kind: 'human', name: '先手' }, { kind: 'human', name: '後手' }];
  G.names = ['先手', '後手'];
  enterGameScreen('局面編集');
  refreshEditor();
  toast('局面編集', 'クリックで駒を選んで移動 ／ 右クリックで成り・先後を切り替え', '✎');
}

function refreshEditor() {
  const p = G.editPos;
  p._legal = null;
  board.editSel = G.editSel;
  board.pos = p;
  board.lastMove = null;
  board.selected = null;
  board.targets = [];
  board.setArrows([]);
  board.render();
  renderControls();
  renderBook();
}

function onEditInput(ev) {
  const p = G.editPos;
  const sel = G.editSel;
  if (ev.kind === 'cell') {
    const cur = p.board[ev.sq];
    if (ev.button === 2) {
      // 右クリック: 先手 → 先手成 → 後手 → 後手成 → 先手
      if (!cur) return;
      const t = typeOf(cur), base = unpromote(t), c = colorOf(cur);
      const toPromote = canPromote(base) && t === base;
      p.board[ev.sq] = toPromote ? mkPiece(c, base + PROMOTE) : mkPiece(c ^ 1, base);
      sfx.select();
      return refreshEditor();
    }
    if (!sel) {
      if (cur) { G.editSel = { kind: 'cell', sq: ev.sq }; sfx.select(); }
      return refreshEditor();
    }
    if (sel.kind === 'cell' && sel.sq === ev.sq) { G.editSel = null; return refreshEditor(); }
    // 移動先に駒があれば駒箱へ戻す
    let piece;
    if (sel.kind === 'cell') { piece = p.board[sel.sq]; p.board[sel.sq] = 0; }
    else if (sel.kind === 'hand') { p.hands[sel.c][sel.t]--; piece = mkPiece(sel.c, sel.t); }
    else { piece = mkPiece(G.editColor, sel.t); }
    p.board[ev.sq] = piece;
    G.editSel = null;
    sfx.move();
    return refreshEditor();
  }
  if (ev.kind === 'hand') {
    if (sel && sel.kind === 'cell') {
      const piece = p.board[sel.sq];
      const t = unpromote(typeOf(piece));
      if (t === KING) { toast('玉は持ち駒にできません', '', '⚠️'); return; }
      p.board[sel.sq] = 0;
      p.hands[ev.c][t]++;
      G.editSel = null;
      sfx.move();
      return refreshEditor();
    }
    if (sel && sel.kind === 'box') {
      if (sel.t === KING) { toast('玉は持ち駒にできません', '', '⚠️'); return; }
      p.hands[ev.c][sel.t]++;
      if (boxCounts(p)[sel.t] <= 0) G.editSel = null;
      return refreshEditor();
    }
    if (ev.t) {
      if (ev.button === 2) { p.hands[ev.c][ev.t]--; return refreshEditor(); } // 右クリックで駒箱へ
      G.editSel = sel && sel.kind === 'hand' && sel.c === ev.c && sel.t === ev.t ? null : { kind: 'hand', c: ev.c, t: ev.t };
      sfx.select();
      return refreshEditor();
    }
  }
}

function renderEditControls() {
  const p = G.editPos;
  const box = boxCounts(p);
  const sel = G.editSel;
  const boxHtml = BOX_TYPES.map(t => `<button class="box-piece ${sel?.kind === 'box' && sel.t === t ? 'selected' : ''}" data-box="${t}" ${box[t] <= 0 ? 'disabled' : ''}>
    <span class="bp-face">${t === KING ? (G.editColor === BLACK ? '玉' : '王') : FACE[t]}</span><small>${box[t]}</small></button>`).join('');
  return `<div class="edit-help small muted">駒を選んでから置き場所をクリック。盤上の駒を駒台へ動かすと持ち駒になります。<br>右クリック：成る／先後の切り替え（駒台では 1 枚を駒箱へ）。</div>
    <div class="card-lite"><div class="small muted">駒箱（ここから置く駒の色：
      <button class="btn small ${G.editColor === BLACK ? 'active' : ''}" data-ecolor="0">☗先手</button>
      <button class="btn small ${G.editColor === WHITE ? 'active' : ''}" data-ecolor="1">☖後手</button>）</div>
      <div class="box-grid">${boxHtml}</div>
      ${sel?.kind === 'cell' ? '<button class="btn small danger" data-ebox>選択中の駒を駒箱へ</button>' : ''}</div>
    <div class="ctl-row"><button class="btn small" data-epreset="hirate">平手</button><button class="btn small" data-epreset="tsume">詰将棋用</button><button class="btn small" data-epreset="clear">全部駒箱へ</button></div>
    <div class="ctl-row"><span class="small muted" style="align-self:center">手番</span>
      <button class="btn small ${p.side === BLACK ? 'active' : ''}" data-eside="0">☗先手番</button>
      <button class="btn small ${p.side === WHITE ? 'active' : ''}" data-eside="1">☖後手番</button>
      <button class="btn small ghost" data-c="flip">⇅</button></div>
    <div class="ctl-row"><button class="btn primary" data-edone="analysis">この局面で検討</button><button class="btn" data-edone="play">この局面から対局</button></div>`;
}

function bindEditControls() {
  const box = $('#controls');
  const p = G.editPos;
  box.querySelectorAll('[data-box]').forEach(b => b.onclick = () => {
    const t = +b.dataset.box;
    G.editSel = G.editSel?.kind === 'box' && G.editSel.t === t ? null : { kind: 'box', t };
    sfx.select();
    refreshEditor();
  });
  box.querySelectorAll('[data-ecolor]').forEach(b => b.onclick = () => { G.editColor = +b.dataset.ecolor; refreshEditor(); });
  box.querySelectorAll('[data-eside]').forEach(b => b.onclick = () => { p.side = +b.dataset.eside; refreshEditor(); });
  box.querySelector('[data-ebox]')?.addEventListener('click', () => {
    p.board[G.editSel.sq] = 0;
    G.editSel = null;
    refreshEditor();
  });
  box.querySelectorAll('[data-epreset]').forEach(b => b.onclick = () => {
    const k = b.dataset.epreset;
    const np = k === 'hirate' ? Position.fromSfen(START_SFEN) : new Position();
    if (k === 'tsume') {
      np.board[4 * 9 + 0] = mkPiece(WHITE, KING); // 5一玉
      for (let t = 1; t <= 7; t++) np.hands[WHITE][t] = PIECE_TOTAL[t];
    }
    G.editPos = np;
    G.editSel = null;
    refreshEditor();
  });
  box.querySelectorAll('[data-edone]').forEach(b => b.onclick = () => finishEdit(b.dataset.edone));
}

/** 局面の妥当性を確認して、検討・対局へ進む */
function finishEdit(next) {
  const p = G.editPos;
  p._legal = null;
  const errors = [];
  for (const c of [BLACK, WHITE]) {
    if (p.board.filter(x => x === mkPiece(c, KING)).length > 1) errors.push(`${c === BLACK ? '先手' : '後手'}の玉が2枚あります`);
    for (let f = 0; f < 9; f++) {
      let n = 0;
      for (let r = 0; r < 9; r++) if (p.board[f * 9 + r] === mkPiece(c, PAWN)) n++;
      if (n > 1) errors.push(`${f + 1}筋に${c === BLACK ? '先手' : '後手'}の二歩があります`);
    }
  }
  for (let s = 0; s < 81; s++) {
    const x = p.board[s];
    if (!x) continue;
    const t = typeOf(x), rr = relRank(colorOf(x), rankOf(s));
    if (((t === PAWN || t === LANCE) && rr === 0) || (t === KNIGHT && rr <= 1)) errors.push(`${fileOf(s) + 1}${rankOf(s) + 1}の駒は動けない位置にあります`);
  }
  if (p.inCheck(p.side ^ 1)) errors.push('手番でない側の玉に王手がかかっています');
  if (errors.length) return alertBox('この局面は使えません', errors.slice(0, 4).join(' ／ '));
  const sfen = p.toSfen(false) + ' 1';
  if (next === 'analysis') enterAnalysis({ startSfen: sfen, moves: [] }, '検討 ・ 編集局面');
  else { leaveEditor(); openPlaySetup(sfen); }
}

function leaveEditor() {
  board.editSel = null;
  G = null;
  show('home');
}

// =====================================================================
// 記録画面
// =====================================================================

function renderStats() {
  const p = S.profile;
  const rate = p.games ? Math.round((p.wins / p.games) * 100) : 0;
  const tiles = [
    ['対局数', p.games], ['勝率', rate + '%'], ['レート', p.rating],
    ['最高連勝', p.bestStreak], ['全体解析', p.analyzed],
  ];
  const rows = LEVELS.map(l => {
    const b = p.byLevel[l.name] || { w: 0, l: 0, d: 0 };
    const n = b.w + b.l + b.d;
    return `<tr><td>${l.name} <span class="stars">${'★'.repeat(l.stars)}</span></td><td>${b.w}</td><td>${b.l}</td><td>${b.d}</td>
      <td><div class="minibar"><div style="width:${n ? (b.w / n) * 100 : 0}%"></div></div></td></tr>`;
  }).join('');
  const hist = p.history.slice(0, 15).map(h => {
    const d = new Date(h.date);
    const r = { win: '勝ち', loss: '負け', draw: '引分' }[h.result];
    return `<li class="${h.result}"><span>${d.getMonth() + 1}/${d.getDate()}</span><b>${r}</b><span>${esc(h.engine)}（${h.level}・${h.handicap}）</span><span>${h.moves}手 ${esc(h.reason)}</span></li>`;
  }).join('') || '<li class="muted">まだ対局がありません</li>';
  const ach = ACHIEVEMENTS.map(a => {
    const got = S.achievements[a.id];
    return `<div class="ach ${got ? 'got' : ''}" title="${esc(a.desc)}"><span>${got ? a.icon : '🔒'}</span><div><b>${a.name}</b><small>${a.desc}</small></div></div>`;
  }).join('');
  $('#stats-body').innerHTML = `
    <div class="profile-card big">${profileCardHtml()}</div>
    <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    <div class="stats-cols">
      <div class="card"><h3>強さ別の成績</h3><table class="lv-table"><tr><th></th><th>勝</th><th>負</th><th>分</th><th>勝率</th></tr>${rows}</table></div>
      <div class="card"><h3>最近の対局</h3><ul class="hist">${hist}</ul></div>
    </div>
    <div class="card"><h3>実績 <small>${ACHIEVEMENTS.filter(a => S.achievements[a.id]).length} / ${ACHIEVEMENTS.length}</small></h3><div class="ach-grid">${ach}</div></div>`;
}

// =====================================================================
// 設定画面
// =====================================================================

function renderSettings() {
  const themeCards = THEMES.map(t => `
    <button class="theme-card ${S.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}">
      <div class="theme-preview" data-theme="${t.id}">
        <div class="tp-board">${t.id === 'animal'
          ? `<div class="piece sente">${animalPieceHtml(6, BLACK, '飛')}</div><div class="piece gote rev">${animalPieceHtml(8, WHITE, '王')}</div><div class="piece sente promoted">${animalPieceHtml(14, BLACK, '龍')}</div>`
          : '<div class="piece sente"><div class="face"><span>飛</span></div></div><div class="piece gote rev"><div class="face"><span>角</span></div></div><div class="piece sente promoted"><div class="face"><span>龍</span></div></div>'}</div>
      </div>
      <b>${t.name}</b><small>${t.desc}</small></button>`).join('');
  const engines = hasApi ? S.engines.map(e => `
    <li><div><b>${esc(e.name)}</b><small>${esc(e.path)}</small></div>
      <label class="radio" title="検討・全体解析・詰み探索に使うメインのエンジン"><input type="radio" name="ae" value="${e.id}" ${S.analysisEngine === e.id ? 'checked' : ''}> 検討メイン</label>
      <label class="radio" title="検討のときに一緒に考えさせるエンジン（最大3つ）"><input type="checkbox" data-sub="${e.id}" ${(S.subEngines || []).includes(e.id) ? 'checked' : ''}> 同時検討</label>
      <button class="btn small" data-opt="${e.id}">⚙ 設定</button>
      <button class="btn ghost small" data-del="${e.id}">削除</button></li>`).join('') || '<li class="muted">登録されたエンジンはありません</li>'
    : '<li class="muted">ブラウザ版では内蔵AIのみ使えます（デスクトップ版で USI エンジンを追加できます）</li>';
  $('#settings-body').innerHTML = `
    <div class="card"><h3>テーマ</h3><div class="theme-cards">${themeCards}</div></div>
    <div class="stats-cols">
      <div class="card"><h3>プレイヤー</h3>
        <label class="field"><span>名前</span><input id="set-name" value="${esc(S.profile.name)}" maxlength="16"></label>
        <label class="field"><span>音量</span><input id="set-vol" type="range" min="0" max="1" step="0.05" value="${S.volume}"></label>
        <label class="check"><input type="checkbox" id="set-speech" ${S.speech ? 'checked' : ''}> 指し手を読み上げる</label>
      </div>
      <div class="card"><h3>USI エンジン</h3>
        <p class="muted small">Sailfish は最初から入っています。ほかのエンジン（やねうら王 など）はダウンロードして「エンジンを追加」から登録できます。</p>
        <ul class="engine-list">${engines}</ul>
        ${hasApi ? '<button class="btn primary" id="add-engine">＋ エンジンを追加</button>' : ''}</div>
    </div>
    <div class="stats-cols">
      <div class="card"><h3>駒と盤</h3>
        <label class="field"><span>駒の文字</span><select data-set="pieceStyle">
          <option value="one" ${S.pieceStyle !== 'two' ? 'selected' : ''}>一文字駒（歩・飛・角）</option>
          <option value="two" ${S.pieceStyle === 'two' ? 'selected' : ''}>二文字駒（歩兵・飛車・角行）</option></select></label>
        <label class="field"><span>盤</span><select data-set="boardStyle">
          ${[['theme', 'テーマに合わせる'], ['kaya', '明るい榧'], ['kaya-dark', '濃い本榧'], ['plain', '白（シンプル）'], ['green', '緑'], ['image', '画像ファイル']]
            .map(([v, n]) => `<option value="${v}" ${(S.boardStyle || 'theme') === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="ctl-row">${hasApi ? '<button class="btn small" id="set-board-img">🖼 盤の画像を選ぶ</button><button class="btn small" id="set-stand-img">🖼 駒台の画像を選ぶ</button>' : ''}
          <button class="btn small ghost" id="set-img-clear">画像を外す</button></div>
      </div>
      <div class="card"><h3>検討・評価値の表示</h3>
        <label class="field"><span>評価値の向き</span><select data-set="evalView">
          <option value="black" ${S.evalView !== 'each' ? 'selected' : ''}>常に先手から見た値</option>
          <option value="each" ${S.evalView === 'each' ? 'selected' : ''}>手番側から見た値</option></select></label>
        <div class="field-row">
          <label class="field"><span>矢印の最大数</span><input type="number" min="1" max="5" data-set="maxArrows" value="${S.maxArrows ?? 3}"></label>
          <label class="field"><span>最善手との差（以内を表示）</span><input type="number" min="0" max="3000" step="10" data-set="arrowDiff" value="${S.arrowDiff ?? 100}"></label>
        </div>
        <label class="check"><input type="checkbox" data-set="showArrowScore" ${S.showArrowScore !== false ? 'checked' : ''}> 矢印に評価値を表示する</label>
        <label class="check"><input type="checkbox" data-set="showMoveTime" ${S.showMoveTime !== false ? 'checked' : ''}> 棋譜欄に消費時間を表示する</label>
        <label class="check"><input type="checkbox" data-set="analysisCheckFx" ${S.analysisCheckFx !== false ? 'checked' : ''}> 検討モードで王手の演出（文字・効果音）を出す</label>
        <div class="field-row">
          <label class="field"><span>勝率換算の係数</span><input type="number" min="100" max="3000" step="10" data-set="sigmoid" value="${S.sigmoid ?? 600}"></label>
        </div>
        <div class="field"><span>悪手判定（期待勝率の損失 %）</span><div class="field-row">
          ${['緩手', '疑問手', '悪手', '大悪手'].map((n, i) => `<label class="field"><span>${n}</span><input type="number" min="1" max="100" data-bad="${i}" value="${(S.badMove || [5, 10, 20, 50])[i]}"></label>`).join('')}
        </div></div>
      </div>
    </div>
    <div class="card"><h3>棋譜の自動保存</h3>
      <label class="check"><input type="checkbox" data-set="autoSave" ${S.autoSave ? 'checked' : ''}> 対局・通信対局が終わったら棋譜を自動で保存する</label>
      <div class="field-row">
        <label class="field"><span>保存先フォルダ</span><input id="set-dir" value="${esc(S.autoSaveDir || '')}" placeholder="フォルダを選んでください" readonly></label>
        ${hasApi ? '<button class="btn small" id="set-dir-btn" style="align-self:flex-end;margin-bottom:14px">📂 選ぶ</button>' : ''}
      </div>
      <label class="field"><span>ファイル名（{datetime} {date} {sente} {gote} {title} が使えます）</span><input data-set="fileTemplate" value="${esc(S.fileTemplate || '{datetime}_{sente}_{gote}')}"></label>
    </div>
    <div class="card danger-card"><h3>記録のリセット</h3>
      <p class="muted small">記録画面の内容を消して、最初からやり直せます。消した記録は元に戻せません。プレイヤー名・設定・エンジン・定跡は消えません。</p>
      <label class="check"><input type="checkbox" id="rs-games" checked> 戦績・レート・対局履歴（強さ別の成績、連勝記録、全体解析の回数を含む）</label>
      <label class="check"><input type="checkbox" id="rs-level" checked> レベル・経験値・称号</label>
      <label class="check"><input type="checkbox" id="rs-ach" checked> 実績</label>
      <button class="btn danger" id="rs-run">🗑 選んだ記録をリセット</button>
    </div>`;
  $('#rs-run').onclick = async () => {
    const games = $('#rs-games').checked, level = $('#rs-level').checked, ach = $('#rs-ach').checked;
    if (!games && !level && !ach) return toast('リセットする項目を選んでください', '', 'ℹ️');
    const what = [games && '戦績・レート', level && 'レベル・経験値', ach && '実績'].filter(Boolean).join('、');
    if (!await confirmBox('記録をリセットしますか？', `${what}を消します。元に戻せません。`)) return;
    const p = S.profile;
    if (games) {
      Object.assign(p, { rating: 1000, games: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, analyzed: 0, byLevel: {}, history: [] });
    }
    if (level) p.xp = 0;
    if (ach) { S.achievements = {}; S.themesUsed = [S.theme]; }
    saveStore();
    toast('記録をリセットしました', what, '🗑');
    renderSettings();
  };
  // 設定項目（data-set）の保存
  $('#settings-body').querySelectorAll('[data-set]').forEach(el => el.addEventListener('change', () => {
    const k = el.dataset.set;
    S[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
    saveStore();
    applyLook();
    if (G) { renderKifu(); updateEvalUI(); showBestArrow?.(); }
  }));
  $('#settings-body').querySelectorAll('[data-bad]').forEach(el => el.addEventListener('change', () => {
    S.badMove = [...$('#settings-body').querySelectorAll('[data-bad]')].map(x => +x.value);
    saveStore();
  }));
  $('#set-board-img')?.addEventListener('click', async () => {
    const url = await window.api.openImage();
    if (!url) return;
    S.boardImage = url;
    S.boardStyle = 'image';
    saveStore();
    applyLook();
    renderSettings();
  });
  $('#set-stand-img')?.addEventListener('click', async () => {
    const url = await window.api.openImage();
    if (!url) return;
    S.standImage = url;
    saveStore();
    applyLook();
  });
  $('#set-img-clear').onclick = () => {
    S.boardImage = null;
    S.standImage = null;
    if (S.boardStyle === 'image') S.boardStyle = 'theme';
    saveStore();
    applyLook();
    renderSettings();
  };
  $('#set-dir-btn')?.addEventListener('click', async () => {
    const d = await window.api.openDirDialog('棋譜の保存先フォルダ');
    if (!d) return;
    S.autoSaveDir = d;
    saveStore();
    $('#set-dir').value = d;
  });
  $('#set-speech').onchange = e => {
    S.speech = e.target.checked;
    setSpeech(S.speech);
    saveStore();
    speak('読み上げをオンにしました');
  };
  $('#settings-body').querySelectorAll('[data-opt]').forEach(b => b.onclick = () => openEngineOptions(S.engines.find(x => x.id === b.dataset.opt)));
  $('#settings-body').querySelectorAll('.theme-card').forEach(b => b.onclick = () => { applyTheme(b.dataset.themeId); renderSettings(); });
  $('#set-name').onchange = e => { S.profile.name = e.target.value.trim() || 'あなた'; saveStore(); };
  $('#set-vol').oninput = e => { S.volume = +e.target.value; setVolume(S.volume); saveStore(); };
  $('#set-vol').onchange = () => sfx.move();
  $('#settings-body').querySelectorAll('[name=ae]').forEach(r => r.onchange = () => { S.analysisEngine = r.value; saveStore(); });
  $('#settings-body').querySelectorAll('[data-sub]').forEach(c => c.onchange = () => {
    const id = c.dataset.sub;
    S.subEngines = (S.subEngines || []).filter(x => x !== id);
    if (c.checked) {
      if (S.subEngines.length >= 3) { c.checked = false; toast('同時検討は3つまでです', '', 'ℹ️'); return; }
      S.subEngines.push(id);
    }
    saveStore();
  });
  $('#settings-body').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    S.engines = S.engines.filter(e => e.id !== b.dataset.del);
    if (S.analysisEngine === b.dataset.del) S.analysisEngine = S.engines[0]?.id || null;
    saveStore();
    renderSettings();
  });
  $('#add-engine')?.addEventListener('click', async () => {
    const path = await window.api.openEngineDialog();
    if (!path) return;
    const ld = loading('エンジンを確認しています…');
    try {
      const name = await probeEngineName(path);
      S.engines.push({ id: 'e' + Date.now(), name, path });
      if (!S.analysisEngine) S.analysisEngine = S.engines[S.engines.length - 1].id;
      saveStore();
      ld.closest('.modal-wrap')?.remove();
      toast('エンジンを追加しました', name, '🤖');
      renderSettings();
    } catch (err) {
      closeModal();
      alertBox('USI エンジンとして起動できませんでした', err.message);
    }
  });
}

/** エンジンの USI オプションを編集する（エンジンを起動して項目を取得） */
async function openEngineOptions(ed) {
  if (!ed) return;
  const ld = loading('エンジンの設定項目を取得しています…');
  const e = createEngine(ed.path);
  let defs;
  try {
    await e.start();
    defs = e.optionDefs.filter(o => o.type !== 'button');
  } catch (err) {
    closeModal();
    e.quit();
    return alertBox('エンジンを起動できませんでした', err.message);
  }
  e.quit();
  ld.closest('.modal-wrap')?.remove();
  const saved = ed.options || {};
  const val = o => (saved[o.name] ?? o.default);
  const input = o => {
    const v = val(o);
    if (o.type === 'check') return `<input type="checkbox" data-o="${esc(o.name)}" ${String(v) === 'true' ? 'checked' : ''}>`;
    if (o.type === 'spin') return `<input type="number" data-o="${esc(o.name)}" value="${esc(v)}" ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''}>`;
    if (o.type === 'combo') return `<select data-o="${esc(o.name)}">${o.vars.map(x => `<option ${x === String(v) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;
    return `<input type="text" data-o="${esc(o.name)}" value="${esc(v)}">`;
  };
  const m = modal(`<h2>${esc(ed.name)} の設定</h2>
    <p class="muted small">${esc(ed.path)}</p>
    <div class="opt-grid">${defs.map(o => `<label class="opt-row ${String(val(o)) !== String(o.default) ? 'changed' : ''}"><span>${esc(o.name)}${o.type === 'spin' && o.min != null ? `<small>${o.min}〜${o.max}</small>` : ''}</span>${input(o)}</label>`).join('') || '<p class="muted">設定項目がありません</p>'}</div>
    <div class="modal-actions"><button class="btn ghost" data-reset>既定値に戻す</button><button class="btn ghost" data-cancel>キャンセル</button><button class="btn primary" data-ok>保存</button></div>`, { cls: 'wide' });
  m.querySelector('[data-cancel]').onclick = closeModal;
  m.querySelector('[data-reset]').onclick = () => { ed.options = {}; saveStore(); closeModal(); toast('既定値に戻しました', ed.name, '⚙'); };
  m.querySelector('[data-ok]').onclick = () => {
    const opts = {};
    m.querySelectorAll('[data-o]').forEach(el => {
      const o = defs.find(d => d.name === el.dataset.o);
      const v = el.type === 'checkbox' ? String(el.checked) : el.value;
      if (String(v) !== String(o.default)) opts[o.name] = v; // 既定値と違うものだけ保存
    });
    ed.options = opts;
    saveStore();
    closeModal();
    toast('エンジン設定を保存しました', `${Object.keys(opts).length} 項目を変更`, '⚙');
  };
}

// =====================================================================
// イベント
// =====================================================================

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) {
    sfx.click();
    const t = go.dataset.go;
    if (t === 'play') openPlaySetup();
    else if (t === 'analysis') enterAnalysis({ startSfen: START_SFEN, moves: [] }, '検討');
    else if (t === 'edit') enterEditor(Position.fromSfen(START_SFEN));
    else if (t === 'net') openNetSetup();
    else show(t);
    return;
  }
  const th = e.target.closest('#theme-switch [data-theme-id]');
  if (th) { applyTheme(th.dataset.themeId); sfx.move(); return; }
  if (treePanel?.contains(e.target)) return; // パネル内はパネル側で処理する
  const c = e.target.closest('[data-c]');
  if (c && !c.disabled) { onControl(c.dataset.c); return; }
  const tab = e.target.closest('.tabs button[data-area]');
  if (tab) { selectTabIn(tab.dataset.area, tab.dataset.tab); return; }
  const li = e.target.closest('#tab-kifu.clickable li[data-i]');
  if (li) { gotoPly(+li.dataset.i); return; }
  const pv = e.target.closest('#tab-pv .pv-mv');
  if (pv && G) onPvClick(pv);
});

/** 読み筋の手をクリックしたら、その局面を盤に表示する */
function onPvClick(pv) {
  const k = pv.dataset.k, j = +pv.dataset.j;
  const ply = +pv.closest('[data-ply]').dataset.ply;
  const line = lineByKey(k);
  if (line && ply === G.cur) previewPv(ply, line.pv, j, k);
}

$('#btn-home').onclick = () => leaveGame();
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show('home'));

document.addEventListener('keydown', onKeyDown);

// 棋譜ファイルを画面にドラッグ＆ドロップすると開く
document.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer.files?.[0];
  if (!f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf);
  if (G?.mode === 'play' && !G.over) return toast('対局中は棋譜を開けません', '', '⚠️');
  loadKifuText(text, f.name);
});

function onKeyDown(e) {
  if (!G || !$('#screen-game').classList.contains('active')) return;
  if (e.target.matches('input, textarea, select')) return;
  if (G.preview) {
    const { ply, usis, j, k } = G.preview;
    if (e.key === 'ArrowRight') previewPv(ply, usis, j + 1, k);
    else if (e.key === 'ArrowLeft') { if (j > 0) previewPv(ply, usis, j - 1, k); else endPreview(); }
    else if (e.key === 'Escape') endPreview();
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'v' && G.mode !== 'play') { pasteKifu(); return; }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') { captureBoard('clipboard'); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && G.mode !== 'edit') { copyAs('kif'); return; }
  if (!(G.mode === 'analysis' || G.over)) return;
  if (e.key === 'ArrowLeft') gotoPly(G.cur - 1);
  else if (e.key === 'ArrowRight') gotoPly(G.cur + 1);
  else if (e.key === 'Home') gotoPly(0);
  else if (e.key === 'End') gotoPly(G.positions.length - 1);
}

// =====================================================================
// 起動
// =====================================================================

(async () => {
  await loadStore();
  await loadBook();
  document.body.dataset.theme = S.theme;
  setEffectTheme(S.theme);
  setVolume(S.volume);
  setSpeech(S.speech);
  layoutPanes();
  applyLook();
  setTreeHeight(S.treeHeight);
  if (!S.themesUsed.includes(S.theme)) S.themesUsed.push(S.theme);
  board.setPosition(Position.fromSfen(START_SFEN));
  show('home');
  await ensureDefaultEngines();
})();
