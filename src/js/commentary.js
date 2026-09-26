// 実況コメントの生成（評価値の変化や駒取り・王手から一言を作る）
import { BLACK, typeOf, ROOK, BISHOP, GOLD, SILVER, DRAGON, HORSE } from './shogi.js';
import { MATE_SCORE } from './engine.js';

const pick = a => a[Math.floor(Math.random() * a.length)];

/** 先手から見た評価値を形勢の言葉にする */
export function situation(s) {
  if (s == null) return { level: 0, text: '形勢判断中' };
  const a = Math.abs(s), who = s > 0 ? '先手' : '後手';
  if (a >= MATE_SCORE - 1000) return { level: 4 * Math.sign(s), text: `${who}勝ち（詰みあり）` };
  if (a < 300) return { level: 0, text: '形勢互角' };
  if (a < 800) return { level: Math.sign(s), text: `${who}やや有利` };
  if (a < 2000) return { level: 2 * Math.sign(s), text: `${who}優勢` };
  return { level: 3 * Math.sign(s), text: `${who}勝勢` };
}

const BIG = { [ROOK]: '飛車', [BISHOP]: '角', [DRAGON]: '龍', [HORSE]: '馬', [GOLD]: '金', [SILVER]: '銀' };

/**
 * 1 手ごとの実況。before/after は先手から見た評価値（不明なら null）。
 * 戻り値: { text, tone: 'normal'|'good'|'bad'|'hot' } または null
 */
export function commentMove({ ja, mover, captured, promo, check, before, after, ply }) {
  const who = mover === BLACK ? '先手' : '後手';
  const lines = [];
  let tone = 'normal';

  if (after != null && Math.abs(after) >= MATE_SCORE - 1000) {
    const n = MATE_SCORE - Math.abs(after);
    const winner = after > 0 ? '先手' : '後手';
    lines.push(pick([`${winner}に${n}手詰みが見えた！`, `読み切り！ ${winner}の${n}手詰め`, `${winner}、勝利への${n}手の道筋`]));
    tone = 'hot';
  } else if (before != null && after != null) {
    const gain = (after - before) * (mover === BLACK ? 1 : -1);
    if (gain < -800) { lines.push(pick([`${ja}……これは大悪手か!?`, `${ja}！ 形勢が大きく傾いた`, `${ja}、痛恨のミスか`])); tone = 'bad'; }
    else if (gain < -300) { lines.push(pick([`${ja}、少し疑問の一手`, `${ja}。ここは別の手もあったか`])); tone = 'bad'; }
    else if (gain > 800) { lines.push(pick([`${ja}！ 鋭い一撃が決まった`, `${ja}、好手！`])); tone = 'good'; }
    const b = before, a = after;
    const cb = Math.sign(b) * (Math.abs(b) >= 300), ca = Math.sign(a) * (Math.abs(a) >= 300);
    if (cb !== ca && Math.abs(a) >= 300) lines.push(`形勢は${a > 0 ? '先手' : '後手'}に傾く`);
    else if (cb !== 0 && ca === 0) lines.push('形勢は再び互角に');
  }

  const cap = typeOf(captured);
  if (BIG[cap] && lines.length < 2) {
    lines.push(pick([`${who}、${BIG[cap]}を取った！`, `${BIG[cap]}をもぎ取る${who}`]));
    if (tone === 'normal') tone = 'hot';
  }
  if (promo && lines.length < 2) lines.push(pick([`${who}、成って戦力アップ`, '駒が成った！']));
  if (check && lines.length < 2) {
    lines.push(pick([`${ja}、王手！`, `${who}の王手！ 受けはあるか`]));
    if (tone === 'normal') tone = 'hot';
  }
  if (!lines.length && ply === 1) lines.push(pick(['さあ対局開始です', 'いざ勝負！']));
  if (!lines.length) return null;
  return { text: lines.join(' '), tone };
}
