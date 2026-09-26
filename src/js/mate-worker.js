// 内蔵の詰み探索（王手だけを読む反復深化の AND/OR 探索）。Web Worker で動かす。
import { Position, moveToUsi } from './shogi.js';

function solve(sfen, maxPly, timeMs) {
  const deadline = performance.now() + timeMs;
  const noMate = new Map(); // 局面キー -> 詰まないと分かった残り深さ
  let nodes = 0;
  let timeout = false;

  // 攻め方の手番。詰めば手順（配列）、詰まなければ null
  function attack(p, depth) {
    if ((++nodes & 255) === 0 && performance.now() > deadline) timeout = true;
    if (timeout) return null;
    const key = p.key();
    if ((noMate.get(key) ?? -1) >= depth) return null;
    const checks = [];
    for (const m of p.legalMoves()) {
      const q = p.play(m);
      if (q.inCheck()) checks.push([m, q, q.legalMoves().length]);
    }
    checks.sort((a, b) => a[2] - b[2]); // 応手の少ない王手から
    for (const [m, q] of checks) {
      const r = defend(q, depth - 1);
      if (r) return [m, ...r];
      if (timeout) return null;
    }
    noMate.set(key, depth);
    return null;
  }

  // 玉方の手番。すべての応手で詰めば最長の手順、逃れがあれば null
  function defend(q, depth) {
    const replies = q.legalMoves();
    if (replies.length === 0) return [];
    if (depth <= 0) return null;
    let longest = null;
    for (const m of replies) {
      const r = attack(q.play(m), depth - 1);
      if (!r) return null;
      if (!longest || r.length + 1 > longest.length) longest = [m, ...r];
    }
    return longest;
  }

  const pos = Position.fromSfen(sfen);
  for (let d = 1; d <= maxPly; d += 2) {
    const r = attack(pos, d);
    if (r) return { kind: 'mate', moves: r.map(moveToUsi), nodes };
    if (timeout) return { kind: 'timeout', nodes };
  }
  return { kind: 'nomate', nodes };
}

self.onmessage = e => {
  const { sfen, maxPly, timeMs } = e.data;
  self.postMessage(solve(sfen, maxPly, timeMs));
};
