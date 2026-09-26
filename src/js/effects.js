// 演出: 効果音（WebAudio で合成）・パーティクル・カットイン・トースト

let theme = 'seigaiha';
const isWa = () => theme === 'wa' || theme === 'seigaiha';
let volume = 0.7;
let actx = null;

export function setEffectTheme(t) { theme = t; }
export function setVolume(v) { volume = v; }

function ac() {
  if (!actx) actx = new AudioContext();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function tone(freq, dur, { type = 'sine', gain = 0.3, when = 0, freqEnd = null, attack = 0.005 } = {}) {
  if (volume <= 0) return;
  const c = ac();
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain * volume, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, { freq = 2000, q = 1, gain = 0.5, when = 0 } = {}) {
  if (volume <= 0) return;
  const c = ac();
  const t0 = c.currentTime + when;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain * volume;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t0);
}

export const sfx = {
  move(strong = false) {
    if (theme === 'cyber') {
      tone(1400, 0.07, { type: 'square', gain: 0.12, freqEnd: 500 });
      if (strong) tone(90, 0.25, { type: 'sawtooth', gain: 0.15, freqEnd: 40 });
    } else if (theme === 'animal') {
      // ぽこっ（木のおもちゃのような音）
      tone(620, 0.09, { type: 'triangle', gain: 0.32, freqEnd: 420 });
      noise(0.03, { freq: 1800, q: 2, gain: 0.35 });
      if (strong) tone(880, 0.12, { type: 'triangle', gain: 0.18, when: 0.06, freqEnd: 1100 });
    } else if (theme === 'pop') {
      tone(520, 0.12, { gain: 0.3, freqEnd: 980 });
      if (strong) tone(1200, 0.15, { type: 'triangle', gain: 0.2, when: 0.05, freqEnd: 1800 });
    } else {
      // 駒音「パチッ」
      noise(0.05, { freq: 2600, q: 1.2, gain: strong ? 1.4 : 0.9 });
      tone(170, 0.08, { gain: strong ? 0.5 : 0.3, freqEnd: 90 });
    }
  },
  select() {
    if (theme === 'cyber') tone(2200, 0.03, { type: 'square', gain: 0.05 });
    else if (theme === 'pop' || theme === 'animal') tone(880, 0.05, { gain: 0.12 });
    else noise(0.02, { freq: 4000, gain: 0.25 });
  },
  capture() {
    if (theme === 'cyber') noise(0.2, { freq: 800, q: 0.5, gain: 0.8 });
    else if (theme === 'animal') { tone(900, 0.16, { gain: 0.2, freqEnd: 520 }); tone(700, 0.18, { gain: 0.15, when: 0.12, freqEnd: 420 }); } // にゃっ・わふっ風
    else if (theme === 'pop') [0, 0.06, 0.12].forEach((w, i) => tone(700 + i * 250, 0.1, { gain: 0.15, when: w }));
    else noise(0.12, { freq: 1200, q: 0.7, gain: 0.7, when: 0.02 });
  },
  promote() {
    [0, 0.07, 0.14, 0.21].forEach((w, i) =>
      tone([523, 659, 784, 1047][i], 0.25, { type: theme === 'cyber' ? 'square' : 'triangle', gain: 0.12, when: w }));
  },
  check() {
    if (theme === 'animal') {
      tone(660, 0.12, { type: 'triangle', gain: 0.2, freqEnd: 880 });
      tone(880, 0.2, { type: 'triangle', gain: 0.2, when: 0.14, freqEnd: 660 });
    } else if (isWa()) {
      tone(98, 0.6, { gain: 0.5, freqEnd: 60 });
      noise(0.3, { freq: 300, q: 0.4, gain: 0.8 });
    } else {
      tone(880, 0.12, { type: 'square', gain: 0.12 });
      tone(660, 0.2, { type: 'square', gain: 0.12, when: 0.13 });
    }
  },
  start() {
    if (isWa()) { tone(392, 0.8, { gain: 0.2 }); tone(587, 1.0, { gain: 0.15, when: 0.15 }); }
    else [0, 0.1, 0.2].forEach((w, i) => tone([440, 554, 659][i], 0.3, { type: 'triangle', gain: 0.15, when: w }));
  },
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.5, { type: 'triangle', gain: 0.18, when: i * 0.1 }));
  },
  lose() {
    [392, 349, 311, 262].forEach((f, i) => tone(f, 0.5, { gain: 0.18, when: i * 0.18 }));
  },
  tick() { tone(1000, 0.05, { type: 'square', gain: 0.06 }); },
  levelUp() {
    [659, 784, 988, 1319, 1568].forEach((f, i) => tone(f, 0.35, { type: 'square', gain: 0.08, when: i * 0.08 }));
  },
  click() { tone(1200, 0.03, { gain: 0.08 }); },
};

// ---- パーティクル ----

const canvas = document.getElementById('fx');
const g2 = canvas.getContext('2d');
const parts = [];
const rings = [];
let running = false;

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
}
addEventListener('resize', resize);
resize();

const PALETTE = {
  wa: ['#f7c6d0', '#f19cb0', '#ffe3ea', '#e8b04a', '#fff3c4'],
  seigaiha: ['#f7c6d0', '#f19cb0', '#ffe3ea', '#e8b04a', '#fff3c4'],
  cyber: ['#34f5ff', '#ff3df2', '#7dff6a', '#ffe14d', '#ffffff'],
  pop: ['#ff6fa5', '#ffc93c', '#6fd6ff', '#8cf07a', '#b88cff'],
  animal: ['#ff8a3d', '#2fa9bf', '#f5b98a', '#8ed8c9', '#ffd23f'],
};

export function burst(x, y, { count = 24, speed = 5, colors = null, size = 6, gravity = 0.12, life = 60 } = {}) {
  const cols = colors || PALETTE[theme];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random());
    parts.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      size: size * (0.6 + Math.random() * 0.8), color: cols[i % cols.length],
      life, max: life, gravity,
    });
  }
  loop();
}

export function ring(x, y, color = null, maxR = 60) {
  rings.push({ x, y, r: 4, maxR, color: color || PALETTE[theme][0], life: 1 });
  loop();
}

export function confetti() {
  for (let i = 0; i < 6; i++) {
    setTimeout(() => burst(innerWidth * (0.15 + Math.random() * 0.7), innerHeight * 0.25,
      { count: 40, speed: 9, size: 8, gravity: 0.18, life: 140 }), i * 180);
  }
}

function drawPart(p) {
  const alpha = Math.min(1, p.life / p.max * 1.5);
  g2.globalAlpha = alpha;
  g2.fillStyle = p.color;
  g2.save();
  g2.translate(p.x, p.y);
  g2.rotate(p.rot);
  if (isWa()) {
    // 桜の花びら
    g2.beginPath();
    g2.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
    g2.fill();
  } else if (theme === 'animal') {
    // 肉球
    const s = p.size * 0.9;
    g2.beginPath();
    g2.ellipse(0, s * 0.35, s * 0.7, s * 0.6, 0, 0, Math.PI * 2);
    for (const [x, y] of [[-0.75, -0.35], [-0.28, -0.8], [0.28, -0.8], [0.75, -0.35]]) {
      g2.moveTo(x * s + s * 0.28, y * s);
      g2.arc(x * s, y * s, s * 0.28, 0, Math.PI * 2);
    }
    g2.fill();
  } else if (theme === 'cyber') {
    g2.shadowColor = p.color;
    g2.shadowBlur = 12;
    g2.fillRect(-p.size / 2, -1, p.size * 1.6, 2.5);
  } else {
    // 星
    g2.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? p.size * 0.45 : p.size;
      const a = (i / 10) * Math.PI * 2;
      g2.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g2.closePath();
    g2.fill();
  }
  g2.restore();
}

function loop() {
  if (running) return;
  running = true;
  const step = () => {
    g2.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    g2.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.985;
      p.rot += p.vr;
      if (isWa()) p.vx += Math.sin(p.life / 8) * 0.08; // ひらひら
      if (--p.life <= 0) { parts.splice(i, 1); continue; }
      drawPart(p);
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.r += (r.maxR - r.r) * 0.15;
      r.life -= 0.04;
      if (r.life <= 0) { rings.splice(i, 1); continue; }
      g2.globalAlpha = r.life;
      g2.strokeStyle = r.color;
      g2.lineWidth = 3;
      if (theme === 'cyber') { g2.shadowColor = r.color; g2.shadowBlur = 16; }
      g2.beginPath();
      g2.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      g2.stroke();
      g2.shadowBlur = 0;
    }
    g2.globalAlpha = 1;
    if (parts.length || rings.length) requestAnimationFrame(step);
    else running = false;
  };
  requestAnimationFrame(step);
}

// ---- カットイン・トースト ----

/** 画面中央に大きな文字を出す（王手・対局開始・勝敗など） */
export function cutIn(text, sub = '', kind = '') {
  const el = document.createElement('div');
  el.className = `cutin ${kind}`;
  el.innerHTML = `<div class="cutin-band"></div><div class="cutin-text">${text}</div>${sub ? `<div class="cutin-sub">${sub}</div>` : ''}`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

// ---- 読み上げ ----

let speechOn = false;
export function setSpeech(on) { speechOn = on; }

const NUM_READ = { '１': 'いち', '２': 'に', '３': 'さん', '４': 'よん', '５': 'ご', '６': 'ろく', '７': 'なな', '８': 'はち', '９': 'きゅう' };
const KAN_READ = { 一: 'いち', 二: 'に', 三: 'さん', 四: 'よん', 五: 'ご', 六: 'ろく', 七: 'なな', 八: 'はち', 九: 'きゅう' };
const WORD_READ = [
  ['成香', 'なりきょう'], ['成桂', 'なりけい'], ['成銀', 'なりぎん'], ['不成', 'ならず'],
  ['歩', 'ふ'], ['香', 'きょう'], ['桂', 'けい'], ['銀', 'ぎん'], ['金', 'きん'], ['角', 'かく'], ['飛', 'ひしゃ'],
  ['玉', 'ぎょく'], ['王', 'おう'], ['と', 'と'], ['馬', 'うま'], ['龍', 'りゅう'], ['竜', 'りゅう'],
  ['同', 'どう'], ['成', 'なり'], ['打', 'うつ'], ['右', 'みぎ'], ['左', 'ひだり'], ['直', 'すぐ'],
  ['上', 'あがる'], ['引', 'ひく'], ['寄', 'よる'],
];

/** 指し手の表記（▲７六歩 など）を読み上げ用のかなにする */
export function moveReading(ja) {
  let s = ja.replace('▲', 'せんて、').replace('△', 'ごて、').replace(/[\s　]/g, '');
  s = s.replace(/[１-９]/g, d => NUM_READ[d]).replace(/[一二三四五六七八九]/g, d => KAN_READ[d]);
  for (const [w, r] of WORD_READ) s = s.split(w).join(r + ' ');
  return s;
}

export function speak(text) {
  if (!speechOn || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 1.1;
  u.volume = Math.max(0.2, volume);
  const v = speechSynthesis.getVoices().find(x => x.lang.startsWith('ja'));
  if (v) u.voice = v;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function toast(title, desc = '', icon = '🏆') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-icon">${icon}</div><div><div class="toast-title">${title}</div><div class="toast-desc">${desc}</div></div>`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4400);
}
