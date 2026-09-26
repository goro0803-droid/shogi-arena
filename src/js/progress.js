// 成長要素: 経験値・レベル・レート・実績
import { S, saveStore } from './store.js';
import { toast } from './effects.js';

/** エンジンの強さ（depth で読みの深さを制限）。rating はアリーナ独自の目安 */
export const LEVELS = [
  { id: 'nyumon', name: '入門', depth: 1, rating: 400, stars: 1, desc: 'まずはここから' },
  { id: 'shokyu', name: '初級', depth: 2, rating: 700, stars: 2, desc: 'タダ取りは見逃さない' },
  { id: 'chukyu', name: '中級', depth: 3, rating: 1000, stars: 3, desc: '少し先を読んでくる' },
  { id: 'jokyu', name: '上級', depth: 5, rating: 1300, stars: 4, desc: '手強い相手' },
  { id: 'yudan', name: '有段', depth: 8, rating: 1600, stars: 5, desc: '本気の読み' },
  { id: 'saikyo', name: '最強', depth: 0, rating: 1900, stars: 6, desc: '制限なし・全力' },
];

export const TIME_CONTROLS = [
  { id: 'free', name: '時間無制限', main: 0, byo: 0, engineByo: 2000 },
  { id: 'b10', name: '秒読み 10秒', main: 0, byo: 10000 },
  { id: 'b30', name: '秒読み 30秒', main: 0, byo: 30000 },
  { id: 'm5b10', name: '5分 + 秒読み10秒', main: 300000, byo: 10000 },
  { id: 'm10b30', name: '10分 + 秒読み30秒', main: 600000, byo: 30000 },
];

export const ACHIEVEMENTS = [
  { id: 'first_game', icon: '🎌', name: '初陣', desc: 'はじめて対局した' },
  { id: 'first_win', icon: '🥇', name: '初勝利', desc: 'エンジンに初めて勝った' },
  { id: 'win_handicap', icon: '🎯', name: '駒落ちの壁', desc: '駒落ちで勝利した' },
  { id: 'win_hirate', icon: '⚔️', name: '対等の勝負', desc: '平手で勝利した' },
  { id: 'beat_jokyu', icon: '🔥', name: '上級突破', desc: '上級以上のエンジンに勝利した' },
  { id: 'beat_saikyo', icon: '👑', name: '頂点', desc: '最強レベルに平手で勝利した' },
  { id: 'mate_win', icon: '💥', name: '詰み上げ', desc: '相手玉を詰ませて勝った' },
  { id: 'quick_win', icon: '⚡', name: '電光石火', desc: '80手以内で勝利した' },
  { id: 'comeback', icon: '🔄', name: '大逆転', desc: '評価値 -1000 以下から逆転勝ちした' },
  { id: 'pure_win', icon: '🧘', name: '自力勝利', desc: '待った・ヒントなしで中級以上に勝った' },
  { id: 'streak3', icon: '🌟', name: '三連勝', desc: '3連勝した' },
  { id: 'wins10', icon: '🏯', name: '十勝', desc: '通算10勝した' },
  { id: 'games30', icon: '📜', name: '百戦錬磨への道', desc: '30局対局した' },
  { id: 'analyze1', icon: '🔍', name: '研究熱心', desc: '棋譜の全体解析を行った' },
  { id: 'themes_all', icon: '🎨', name: '衣替え', desc: 'すべてのテーマを試した' },
  { id: 'level10', icon: '🏅', name: '中堅棋士', desc: 'レベル10に到達した' },
];

const TITLES = [
  [1, '見習い棋士'], [5, '駆け出し棋士'], [10, '中堅棋士'], [15, '熟練棋士'],
  [20, '達人'], [30, '名人'], [40, '竜王'], [50, '永世名人'],
];

const need = L => 50 * L * (L + 1); // レベル L+1 に必要な累計経験値

export function levelInfo(xp) {
  let L = 1;
  while (xp >= need(L)) L++;
  const base = need(L - 1);
  const title = TITLES.filter(([l]) => L >= l).pop()[1];
  return { level: L, cur: xp - base, next: need(L) - base, title };
}

export function unlock(id) {
  if (S.achievements[id]) return false;
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (!a) return false;
  S.achievements[id] = Date.now();
  toast(`実績解除：${a.name}`, a.desc, a.icon);
  saveStore();
  return true;
}

/**
 * 対局結果を記録し、経験値・レートを更新する。
 * g: { result: 'win'|'loss'|'draw', level, handicap, moves, reason, mateWin, comeback, assisted, engineName, side }
 */
export function recordGame(g) {
  const p = S.profile;
  const before = levelInfo(p.xp);
  const li = LEVELS.indexOf(g.level);

  p.games++;
  if (g.result === 'win') { p.wins++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); }
  else if (g.result === 'loss') { p.losses++; p.streak = 0; }
  else { p.draws++; }
  const bl = (p.byLevel[g.level.name] ||= { w: 0, l: 0, d: 0 });
  bl[g.result[0]]++;

  // レート（Elo）。駒落ちは相手の強さを割り引く
  const opp = g.level.rating - g.handicap.penalty;
  const expected = 1 / (1 + Math.pow(10, (opp - p.rating) / 400));
  const score = g.result === 'win' ? 1 : g.result === 'draw' ? 0.5 : 0;
  let delta = Math.round(32 * (score - expected));
  if (g.assisted && delta > 0) delta = Math.round(delta / 2);
  p.rating += delta;

  // 経験値
  let xp = g.result === 'win' ? 60 + li * 25 : g.result === 'draw' ? 30 : 15 + Math.min(20, Math.floor(g.moves / 5));
  if (g.assisted) xp = Math.round(xp / 2);
  p.xp += xp;

  p.history.unshift({
    date: Date.now(), engine: g.engineName, level: g.level.name, handicap: g.handicap.name,
    result: g.result, moves: g.moves, reason: g.reason, side: g.side,
  });
  p.history.length = Math.min(p.history.length, 50);

  const after = levelInfo(p.xp);
  unlock('first_game');
  if (g.result === 'win') {
    unlock('first_win');
    if (g.handicap.id === 'hirate') unlock('win_hirate'); else unlock('win_handicap');
    if (li >= 3) unlock('beat_jokyu');
    if (g.level.id === 'saikyo' && g.handicap.id === 'hirate') unlock('beat_saikyo');
    if (g.mateWin) unlock('mate_win');
    if (g.moves <= 80) unlock('quick_win');
    if (g.comeback) unlock('comeback');
    if (!g.assisted && li >= 2) unlock('pure_win');
  }
  if (p.streak >= 3) unlock('streak3');
  if (p.wins >= 10) unlock('wins10');
  if (p.games >= 30) unlock('games30');
  if (after.level >= 10) unlock('level10');
  saveStore();
  return { xp, delta, before, after };
}
