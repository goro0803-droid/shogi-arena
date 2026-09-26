// 盤面・駒台の描画と操作（クリック / ドラッグ、成り選択、指し手アニメーション、矢印）
import { BLACK, WHITE, KING, colorOf, typeOf, fileOf, rankOf, mkPiece } from './shogi.js';
import { FACE, ZEN, KAN } from './kifu.js';
import { sfx } from './effects.js';
import { animalPieceHtml } from './animal.js';

const HAND_TYPES = [6, 5, 7, 4, 3, 2, 1]; // 飛 角 金 銀 桂 香 歩
const face = (t, c) => (t === KING ? (c === BLACK ? '玉' : '王') : FACE[t]);
// 二文字駒（成駒は一文字のまま）
const FACE2 = ['', '歩兵', '香車', '桂馬', '銀将', '角行', '飛車', '金将', '', 'と', '杏', '圭', '全', '龍馬', '龍王'];
const face2 = (t, c) => (t === KING ? (c === BLACK ? '玉将' : '王将') : FACE2[t]);

/** 駒の文字の書き方（'one' 一文字 / 'two' 二文字） */
export let pieceStyle = 'one';
export function setPieceStyle(s) { pieceStyle = s; }

export class BoardView {
  /**
   * els: { area, board, handTop, handBottom }
   * cb:  { onMove(m), canMove(color) }
   */
  constructor(els, cb) {
    Object.assign(this, els);
    this.cb = cb;
    this.flipped = false;
    this.pos = null;
    this.lastMove = null;
    this.selected = null; // { from } または { drop }
    this.targets = [];
    this.arrows = [];
    this.build();
    new ResizeObserver(() => this.layout()).observe(this.area);
  }

  build() {
    this.board.innerHTML = `
      <div class="coords coords-files"></div>
      <div class="board-body">
        <div class="grid"></div>
        <svg class="arrows"></svg>
      </div>
      <div class="coords coords-ranks"></div>`;
    this.grid = this.board.querySelector('.grid');
    this.svg = this.board.querySelector('.arrows');
    this.cells = [];
    for (let vi = 0; vi < 81; vi++) {
      const c = document.createElement('div');
      c.className = 'cell';
      c.dataset.vi = vi;
      this.grid.appendChild(c);
      this.cells.push(c);
    }
    for (const [x, y] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.left = `calc(${x} * var(--cell))`;
      s.style.top = `calc(${y} * var(--cell-h))`;
      this.grid.appendChild(s);
    }
    this.grid.addEventListener('pointerdown', e => this.onGridDown(e));
    this.grid.addEventListener('contextmenu', e => e.preventDefault());
    this.grid.addEventListener('wheel', e => this.cb.onWheel?.(e.deltaY > 0 ? 1 : -1), { passive: true });
    for (const h of [this.handTop, this.handBottom]) {
      h.addEventListener('pointerdown', e => this.onHandDown(e, h));
      h.addEventListener('contextmenu', e => e.preventDefault());
    }
    document.addEventListener('pointerdown', e => {
      if (this.promoEl && !this.promoEl.contains(e.target)) this.closePromo();
    }, true);
  }

  /**
   * 盤の大きさを決める。駒台と対局者は盤の左右（後手は左上、先手は右下）に置くので、
   * 高さはほぼすべて盤に使える。横幅は「盤 + 左右の駒台」で割り振る。
   */
  layout() {
    const w = this.area.clientWidth, h = this.area.clientHeight;
    const boardRows = 9 * 1.09 + 0.9; // 升目 + 座標・枠
    const boardCols = 9 + 0.9;
    const gap = 12;
    let cell = Math.min(h / boardRows, (w - 2 * gap) / (boardCols + 2 * 2.7));
    const sideW = Math.max(w < 800 ? 124 : 170, Math.min(260, cell * 2.7)); // 狭いときは左右の欄を細くする
    cell = Math.floor(Math.min(h / boardRows, (w - 2 * sideW - 2 * gap) / boardCols));
    if (cell <= 0) return;
    this.area.style.setProperty('--cell', `${cell}px`);
    this.area.style.setProperty('--cell-h', `${Math.round(cell * 1.09)}px`);
    this.area.style.setProperty('--side-w', `${Math.round(sideW)}px`);
    this.drawArrows();
  }

  // 表示位置 (vi) と升 (sq) の対応
  sqOf(vi) {
    const col = vi % 9, row = Math.floor(vi / 9);
    return this.flipped ? col * 9 + (8 - row) : (8 - col) * 9 + row;
  }
  viOf(sq) {
    const f = fileOf(sq), r = rankOf(sq);
    return this.flipped ? (8 - r) * 9 + f : r * 9 + (8 - f);
  }
  cellOf(sq) { return this.cells[this.viOf(sq)]; }
  isTop(c) { return (c === WHITE) !== this.flipped; }
  handEl(c) { return this.isTop(c) ? this.handTop : this.handBottom; }

  cellCenter(sq) {
    const r = this.cellOf(sq).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  setFlipped(f) {
    this.flipped = f;
    this.render();
  }

  /** 局面を表示する。animate なら直前の指し手を移動アニメーションさせる */
  setPosition(pos, lastMove = null, animate = false) {
    let srcRect = null;
    if (animate && lastMove && this.pos) {
      const mover = this.pos.side;
      if (lastMove.drop) {
        const el = this.handEl(mover).querySelector(`[data-t="${lastMove.drop}"] .piece`);
        srcRect = el?.getBoundingClientRect();
      } else {
        srcRect = this.cellOf(lastMove.from).querySelector('.piece')?.getBoundingClientRect();
      }
    }
    this.pos = pos;
    this.lastMove = lastMove;
    this.selected = null;
    this.targets = [];
    this.closePromo();
    this.render();
    if (srcRect) {
      const el = this.cellOf(lastMove.to).querySelector('.piece');
      if (el) {
        const dst = el.getBoundingClientRect();
        const dx = srcRect.left - dst.left, dy = srcRect.top - dst.top;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px) scale(1.12)`;
        el.style.zIndex = 5;
        el.getBoundingClientRect();
        el.style.transition = '';
        el.classList.add('moving');
        el.style.transform = '';
        el.addEventListener('transitionend', () => { el.classList.remove('moving'); el.style.zIndex = ''; }, { once: true });
        if (lastMove.promo) el.classList.add('promote-flash');
      }
    }
  }

  pieceEl(p) {
    const t = typeOf(p), c = colorOf(p);
    const el = document.createElement('div');
    el.className = `piece t${t}${t > KING ? ' promoted' : ''}${this.isTop(c) ? ' rev' : ''}${c === WHITE ? ' gote' : ' sente'}`;
    if (document.body.dataset.theme === 'animal') { // どうぶつテーマは猫と犬の駒
      el.innerHTML = animalPieceHtml(t, c, face(t, c));
      return el;
    }
    const two = pieceStyle === 'two' ? face2(t, c) : '';
    el.innerHTML = two.length === 2
      ? `<div class="face"><span class="two">${two[0]}<br>${two[1]}</span></div>`
      : `<div class="face"><span>${two || face(t, c)}</span></div>`;
    return el;
  }

  render() {
    if (!this.pos) return;
    const pos = this.pos;
    // 座標
    const files = this.board.querySelector('.coords-files');
    const ranks = this.board.querySelector('.coords-ranks');
    files.innerHTML = [...Array(9)].map((_, i) => `<span>${ZEN[this.flipped ? i : 8 - i]}</span>`).join('');
    ranks.innerHTML = [...Array(9)].map((_, i) => `<span>${KAN[this.flipped ? 8 - i : i]}</span>`).join('');

    const checkSq = pos.inCheck() ? pos.kingSq(pos.side) : -1;
    const targetSet = new Map(this.targets.map(m => [m.to, m]));
    for (let vi = 0; vi < 81; vi++) {
      const sq = this.sqOf(vi);
      const cell = this.cells[vi];
      cell.className = 'cell';
      cell.textContent = '';
      const p = pos.board[sq];
      if (p) cell.appendChild(this.pieceEl(p));
      if (this.lastMove) {
        if (this.lastMove.to === sq) cell.classList.add('last-to');
        if (!this.lastMove.drop && this.lastMove.from === sq) cell.classList.add('last-from');
      }
      if (this.selected && this.selected.from === sq) cell.classList.add('selected');
      if (this.editSel && this.editSel.kind === 'cell' && this.editSel.sq === sq) cell.classList.add('selected');
      if (targetSet.has(sq)) cell.classList.add(p ? 'target-capture' : 'target');
      if (sq === checkSq) cell.classList.add('check');
    }
    this.renderHand(BLACK);
    this.renderHand(WHITE);
    this.drawArrows();
  }

  renderHand(c) {
    const el = this.handEl(c);
    el.classList.toggle('hand-top', this.isTop(c));
    el.dataset.color = c;
    const items = HAND_TYPES.filter(t => this.pos.hands[c][t] > 0);
    el.innerHTML = `<div class="hand-mark">${c === BLACK ? '☗' : '☖'}</div>` + (items.length ? '' : '<div class="hand-empty">持ち駒なし</div>');
    for (const t of items) {
      const n = this.pos.hands[c][t];
      const item = document.createElement('div');
      item.className = 'hand-piece';
      item.dataset.t = t;
      if (this.selected && this.selected.drop === t && this.pos.side === c) item.classList.add('selected');
      if (this.editSel && this.editSel.kind === 'hand' && this.editSel.c === c && this.editSel.t === t) item.classList.add('selected');
      item.appendChild(this.pieceEl(mkPiece(c, t)));
      if (n > 1) item.insertAdjacentHTML('beforeend', `<span class="count">${n}</span>`);
      el.appendChild(item);
    }
  }

  // ---- 操作 ----

  select(sel) {
    this.selected = sel;
    this.targets = this.pos.legalMoves().filter(m => (sel.drop ? m.drop === sel.drop : m.from === sel.from));
    sfx.select();
    this.render();
  }

  deselect() {
    if (!this.selected) return;
    this.selected = null;
    this.targets = [];
    this.render();
  }

  onGridDown(e) {
    if (!this.pos || this.promoEl) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const sq = this.sqOf(+cell.dataset.vi);
    if (this.cb.isEditing?.()) { this.cb.onEdit({ kind: 'cell', sq, button: e.button }); return; }
    if (this.cb.isPreview?.()) { this.cb.onPreviewClick(); return; }
    if (this.selected && this.targets.some(m => m.to === sq)) {
      this.tryMove(sq);
      return;
    }
    const p = this.pos.board[sq];
    if (p && colorOf(p) === this.pos.side && this.cb.canMove(this.pos.side)) {
      if (this.selected && this.selected.from === sq) { this.deselect(); return; }
      this.select({ from: sq });
      this.startDrag(e, this.cellOf(sq).querySelector('.piece'));
    } else {
      this.deselect();
    }
  }

  onHandDown(e, handEl) {
    if (!this.pos || this.promoEl) return;
    const item = e.target.closest('.hand-piece');
    const c = +handEl.dataset.color;
    if (this.cb.isEditing?.()) { this.cb.onEdit({ kind: 'hand', c, t: item ? +item.dataset.t : null, button: e.button }); return; }
    if (!item || c !== this.pos.side || !this.cb.canMove(c)) return;
    const t = +item.dataset.t;
    if (this.selected && this.selected.drop === t) { this.deselect(); return; }
    this.select({ drop: t });
    this.startDrag(e, this.handEl(c).querySelector(`[data-t="${t}"] .piece`));
  }

  startDrag(e, srcEl) {
    if (!srcEl) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost = null;
    const move = ev => {
      if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6) {
        const r = srcEl.getBoundingClientRect();
        ghost = srcEl.cloneNode(true);
        ghost.classList.add('ghost');
        ghost.style.width = r.width + 'px';
        ghost.style.height = r.height + 'px';
        this.area.appendChild(ghost);
        srcEl.classList.add('dragging');
      }
      if (ghost) {
        const ar = this.area.getBoundingClientRect();
        ghost.style.left = ev.clientX - ar.left + 'px';
        ghost.style.top = ev.clientY - ar.top + 'px';
      }
    };
    const up = ev => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!ghost) return;
      ghost.remove();
      srcEl.classList.remove('dragging');
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.cell');
      if (cell) {
        const sq = this.sqOf(+cell.dataset.vi);
        if (this.targets.some(m => m.to === sq)) { this.tryMove(sq); return; }
      }
      this.deselect();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  tryMove(sq) {
    const cands = this.targets.filter(m => m.to === sq);
    if (cands.length === 1) this.commit(cands[0]);
    else this.showPromo(sq, cands);
  }

  commit(m) {
    this.selected = null;
    this.targets = [];
    this.closePromo();
    this.cb.onMove(m);
  }

  showPromo(sq, cands) {
    const cell = this.cellOf(sq);
    const t = typeOf(this.pos.board[cands[0].from]);
    const c = this.pos.side;
    const box = document.createElement('div');
    box.className = 'promo-chooser';
    for (const m of [...cands].sort((a, b) => b.promo - a.promo)) {
      const b = document.createElement('button');
      b.className = m.promo ? 'promo-yes' : 'promo-no';
      b.appendChild(this.pieceEl(mkPiece(c, m.promo ? t + 8 : t)));
      b.querySelector('.piece').classList.remove('rev');
      b.insertAdjacentHTML('beforeend', `<small>${m.promo ? '成る' : '成らない'}</small>`);
      b.addEventListener('click', () => this.commit(m));
      box.appendChild(b);
    }
    const ar = this.area.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    box.style.left = cr.left - ar.left + cr.width / 2 + 'px';
    box.style.top = cr.top - ar.top + cr.height / 2 + 'px';
    this.area.appendChild(box);
    this.promoEl = box;
  }

  closePromo() {
    this.promoEl?.remove();
    this.promoEl = null;
  }

  // ---- 矢印（最善手の表示） ----

  setArrows(list) {
    this.arrows = list;
    this.drawArrows();
  }

  drawArrows() {
    if (!this.svg || !this.pos) return;
    const br = this.grid.getBoundingClientRect();
    this.svg.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);
    const center = sq => {
      const r = this.cellOf(sq).getBoundingClientRect();
      return [r.left - br.left + r.width / 2, r.top - br.top + r.height / 2];
    };
    let html = '';
    this.arrows.forEach(({ move, color, label }, i) => {
      const [tx, ty] = center(move.to);
      const id = `ah${i}`;
      html += `<defs><marker id="${id}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="${color}"/></marker></defs>`;
      if (move.drop) {
        html += `<circle cx="${tx}" cy="${ty}" r="${br.width / 22}" fill="none" stroke="${color}" stroke-width="5" opacity=".85"/>`;
      } else {
        const [fx, fy] = center(move.from);
        const len = Math.hypot(tx - fx, ty - fy);
        if (!(len > 1)) return; // 盤が表示されていないときは描かない
        const ex = tx - (tx - fx) / len * 10, ey = ty - (ty - fy) / len * 10;
        html += `<line x1="${fx}" y1="${fy}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${br.width / 70}" stroke-linecap="round" marker-end="url(#${id})" opacity=".85"/>`;
      }
      if (label) html += `<text x="${tx}" y="${ty - br.width / 20}" class="arrow-label" fill="${color}">${label}</text>`;
    });
    this.svg.innerHTML = html;
  }
}
