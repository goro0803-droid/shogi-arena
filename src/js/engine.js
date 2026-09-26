// USI エンジンとの通信。Electron 外（ブラウザ確認用）では簡易な内蔵 AI を使う。
import { parseRecord } from './kifu.js';
import { Position, moveToUsi, typeOf } from './shogi.js';

export const hasApi = !!window.api;
export const MATE_SCORE = 100000;

const registry = new Map();
if (hasApi) {
  window.api.onEngineLine((id, line) => registry.get(id)?._onLine(line));
  window.api.onEngineExit((id, code) => registry.get(id)?._onExit(code));
}

/** info 行を解析する。score は手番側から見た値（詰みは ±(MATE_SCORE - 手数)） */
export function parseInfo(line) {
  const t = line.trim().split(/\s+/);
  const info = {};
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'seldepth': info.seldepth = +t[++i]; break;
      case 'nodes': info.nodes = +t[++i]; break;
      case 'nps': info.nps = +t[++i]; break;
      case 'time': info.time = +t[++i]; break;
      case 'hashfull': info.hashfull = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'score': {
        const kind = t[++i];
        const v = t[++i];
        if (kind === 'cp') info.score = +v;
        else if (kind === 'mate') {
          const neg = v.startsWith('-');
          const n = Math.abs(parseInt(v, 10)) || 0;
          info.mate = neg ? -n : n;
          info.score = neg ? -(MATE_SCORE - n) : MATE_SCORE - n;
        }
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') info.bound = t[++i];
        break;
      }
      case 'pv': info.pv = t.slice(i + 1); i = t.length; break;
      case 'string': info.string = t.slice(i + 1).join(' '); i = t.length; break;
      default: break;
    }
  }
  return info;
}

/** option 行を解析する（例: option name Threads type spin default 4 min 1 max 512） */
export function parseOption(line) {
  const t = line.trim().split(/\s+/);
  const buf = {};
  const vars = [];
  let key = null;
  for (let i = 1; i < t.length; i++) {
    const w = t[i];
    if (['name', 'type', 'default', 'min', 'max', 'var'].includes(w) && !(key === 'name' && !buf.name)) {
      key = w;
      if (w === 'var') vars.push('');
      continue;
    }
    if (key === 'var') vars[vars.length - 1] += (vars[vars.length - 1] ? ' ' : '') + w;
    else if (key) buf[key] = buf[key] ? `${buf[key]} ${w}` : w;
  }
  let def = buf.default ?? '';
  if (def === '<empty>') def = '';
  return {
    name: buf.name || '', type: buf.type || 'string', default: def,
    min: buf.min != null ? +buf.min : null, max: buf.max != null ? +buf.max : null, vars,
  };
}

export class UsiEngine {
  constructor(path) {
    this.path = path;
    this.name = '';
    this.author = '';
    this.options = new Set();
    this.optionDefs = [];
    this.waiters = [];
    this.onInfo = null;
    this.goResolve = null;
    this.searching = false;
    this.alive = false;
  }

  async start(options = {}) {
    const r = await window.api.engineStart(this.path);
    if (r.error) throw new Error(r.error);
    this.id = r.id;
    registry.set(this.id, this);
    this.alive = true;
    this.send('usi');
    await this.waitFor('usiok', 15000);
    for (const [k, v] of Object.entries(options)) {
      const def = this.optionDefs.find(o => o.name === k);
      if (!def || def.type === 'button') continue;
      this.send(`setoption name ${k} value ${v === '' ? '<empty>' : v}`);
    }
    this.send('isready');
    await this.waitFor('readyok', 300000);
    return this;
  }

  /** 探索していないときにオプションを変更する */
  setOption(name, value) {
    if (this.options.has(name)) this.send(`setoption name ${name} value ${value}`);
  }

  /** 詰み探索（go mate）。戻り値 { kind: 'mate'|'nomate'|'timeout'|'notimpl', moves } */
  async goMate(positionCmd, timeMs) {
    if (this.searching) await this.stop();
    this.send(positionCmd);
    this.searching = true;
    return new Promise(res => {
      this.mateResolve = res;
      this.send(`go mate ${timeMs}`);
    });
  }

  stopMate() {
    if (this.mateResolve) this.send('stop');
  }

  waitFor(word, timeout) {
    return new Promise((resolve, reject) => {
      const w = { word, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(`エンジンの応答がありません (${word})`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  send(line) {
    if (this.alive) window.api.engineSend(this.id, line);
  }

  _onLine(line) {
    if (line.startsWith('id name ')) this.name = line.slice(8).trim();
    else if (line.startsWith('id author ')) this.author = line.slice(10).trim();
    else if (line.startsWith('option name ')) {
      const def = parseOption(line);
      this.options.add(def.name);
      this.optionDefs.push(def);
    } else if (line.startsWith('info ')) this.onInfo?.(parseInfo(line));
    else if (line.startsWith('checkmate')) {
      const t = line.trim().split(/\s+/);
      const kind = { nomate: 'nomate', timeout: 'timeout', notimplemented: 'notimpl' }[t[1]] || 'mate';
      this.searching = false;
      const r = this.mateResolve;
      this.mateResolve = null;
      r?.({ kind, moves: kind === 'mate' ? t.slice(1) : [] });
    }
    else if (line.startsWith('bestmove')) {
      if (this.mateResolve) return; // 詰み探索中の bestmove は無視
      const t = line.trim().split(/\s+/);
      this.searching = false;
      const r = this.goResolve;
      this.goResolve = null;
      r?.({ move: t[1], ponder: t[3] || null });
    }
    for (const w of [...this.waiters]) {
      if (line.startsWith(w.word)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter(x => x !== w);
        w.resolve(line);
      }
    }
  }

  _onExit() {
    this.alive = false;
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error('エンジンが終了しました')); }
    this.waiters = [];
    const r = this.goResolve;
    this.goResolve = null;
    this.searching = false;
    r?.({ move: 'resign', crashed: true });
    this.mateResolve?.({ kind: 'notimpl', moves: [] });
    this.mateResolve = null;
    registry.delete(this.id);
  }

  newGame() { this.send('usinewgame'); }

  /** 思考させて bestmove を待つ */
  async go(positionCmd, goArgs, onInfo) {
    if (this.searching) await this.stop();
    this.onInfo = onInfo;
    this.send(positionCmd);
    this.searching = true;
    return new Promise(res => {
      this.goResolve = res;
      this.send('go ' + goArgs);
    });
  }

  stop() {
    if (!this.searching) return Promise.resolve(null);
    return new Promise(res => {
      const prev = this.goResolve;
      this.goResolve = r => { prev?.(r); res(r); };
      this.send('stop');
    });
  }

  quit() {
    if (!this.alive) return;
    this.onInfo = null;
    window.api.engineKill(this.id);
    this.alive = false;
  }
}

// ---- ブラウザ確認用の内蔵 AI（駒得を狙うだけの簡易版） ----

const VAL = [0, 1, 3, 4, 5, 8, 10, 6, 100, 6, 6, 6, 6, 10, 12];

class MockEngine {
  constructor() { this.name = '内蔵AI（簡易）'; this.searching = false; this.alive = true; this.options = new Set(); this.optionDefs = []; }
  async start() { return this; }
  newGame() {}
  send(line) { if (line === 'stop') this.stop(); }
  setOption() {}
  async goMate() { return { kind: 'notimpl', moves: [] }; }
  stopMate() {}
  go(positionCmd, goArgs, onInfo) {
    this.searching = true;
    this.onInfo = onInfo;
    return new Promise(res => {
      this.goResolve = res;
      const rec = parseRecord(positionCmd.replace(/^position\s+/, ''));
      let pos = Position.fromSfen(rec.startSfen);
      for (const u of rec.moves) pos = pos.play(pos.findMove(u));
      const moves = pos.legalMoves();
      if (!moves.length) { this._finish({ move: 'resign' }); return; }
      let best = null, bestScore = -1e9;
      for (const m of moves) {
        const after = pos.play(m);
        let s = VAL[typeOf(pos.capturedOf(m))] * 10 + (m.promo ? 3 : 0) + Math.random() * 2;
        if (after.legalMoves().length === 0) s += 10000;
        if (after.inCheck()) s += 1;
        if (s > bestScore) { bestScore = s; best = m; }
      }
      const usi = moveToUsi(best);
      setTimeout(() => {
        onInfo?.({ depth: 1, score: Math.round(bestScore * 10), pv: [usi], nodes: moves.length });
        if (/infinite/.test(goArgs)) this.pending = { move: usi };
        else this._finish({ move: usi });
      }, 250);
    });
  }
  _finish(r) { this.searching = false; const f = this.goResolve; this.goResolve = null; f?.(r); }
  stop() {
    if (!this.searching) return Promise.resolve(null);
    const r = this.pending || { move: 'resign' };
    this.pending = null;
    return new Promise(res => { const f = this.goResolve; this.goResolve = null; this.searching = false; f?.(r); res(r); });
  }
  quit() { this.alive = false; }
}

export function createEngine(path) {
  return hasApi && path ? new UsiEngine(path) : new MockEngine();
}
