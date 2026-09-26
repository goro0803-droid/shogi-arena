// 設定・戦績・実績の保存（Electron では userData/store.json、ブラウザでは localStorage）
const KEY = 'shogi-arena';

const DEFAULTS = () => ({
  theme: 'seigaiha',
  volume: 0.7,
  showEval: true,
  speech: false,
  multiPV: 1,
  engines: [], // { id, name, path }
  analysisEngine: null,
  subEngines: [], // 検討で同時に動かすエンジン
  bookUse: false,
  lastPlay: null,
  themesUsed: [],
  profile: {
    name: 'あなた',
    xp: 0,
    rating: 1000,
    games: 0, wins: 0, losses: 0, draws: 0,
    streak: 0, bestStreak: 0,
    analyzed: 0,
    byLevel: {}, // レベル名 -> { w, l, d }
    history: [], // 最近の対局
  },
  achievements: {}, // id -> 獲得日時
});

export let S = DEFAULTS();

export async function loadStore() {
  let data = {};
  try {
    data = window.api ? await window.api.storeGet() : JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { data = {}; }
  const d = DEFAULTS();
  S = { ...d, ...data, profile: { ...d.profile, ...(data.profile || {}) } };
  // 青海波テーマを追加したとき、標準テーマを一度だけ青海波に切り替える
  if (!S.seigaihaDefault) {
    S.theme = 'seigaiha';
    S.seigaihaDefault = true;
  }
  return S;
}

let timer = null;
export function saveStore() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      if (window.api) window.api.storeSet(S);
      else localStorage.setItem(KEY, JSON.stringify(S));
    } catch { /* 保存失敗は無視 */ }
  }, 200);
}
