// CSA サーバー通信対局プロトコル（floodgate など）のクライアント
// 流れ: 接続 → LOGIN → Game_Summary 受信 → AGREE → START → 指し手のやり取り → #WIN/#LOSE/#DRAW

const clients = new Map();
if (window.api?.onCsaLine) {
  window.api.onCsaLine((id, line) => clients.get(id)?._onLine(line));
  window.api.onCsaClose((id, err) => clients.get(id)?._onClose(err));
}

/** Game_Summary を読み取る */
export function parseGameSummary(lines) {
  const s = { names: { '+': '', '-': '' }, time: { unit: 1000, total: 0, byoyomi: 0, increment: 0 }, positionLines: [], myColor: '+' };
  let inTime = false, inPos = false;
  for (const line of lines) {
    if (line === 'BEGIN Time') { inTime = true; continue; }
    if (line === 'END Time') { inTime = false; continue; }
    if (line === 'BEGIN Position') { inPos = true; continue; }
    if (line === 'END Position') { inPos = false; continue; }
    if (inPos) { s.positionLines.push(line); continue; }
    const m = line.match(/^([^:]+):(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (inTime) {
      if (k === 'Time_Unit') {
        const u = v.match(/^(\d*)(msec|sec|min)$/);
        s.time.unit = u ? (+u[1] || 1) * { msec: 1, sec: 1000, min: 60000 }[u[2]] : 1000;
      } else if (k === 'Total_Time') s.time.total = +v;
      else if (k === 'Byoyomi') s.time.byoyomi = +v;
      else if (k === 'Increment') s.time.increment = +v;
      else if (k === 'Least_Time_Per_Move') s.time.least = +v;
      continue;
    }
    if (k === 'Game_ID') s.gameId = v;
    else if (k === 'Name+') s.names['+'] = v;
    else if (k === 'Name-') s.names['-'] = v;
    else if (k === 'Your_Turn') s.myColor = v;
    else if (k === 'To_Move') s.toMove = v;
    else if (k === 'Max_Moves') s.maxMoves = +v;
  }
  return s;
}

export class CsaClient {
  /** h: { onLog, onSummary, onStart, onReject, onMove, onSpecial, onResult, onClose } */
  constructor(h) {
    this.h = h;
    this.summary = null;
    this.collecting = null;
    this.lastSend = 0;
    this.pendingResult = null;
  }

  async connect(host, port) {
    const r = await window.api.csaConnect(host, port);
    if (r.error) throw new Error(r.error);
    this.id = r.id;
    clients.set(this.id, this);
    // 無通信で切断されないよう、30 秒ごとに空行を送る
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastSend > 30000) this.send('');
    }, 5000);
  }

  send(line) {
    if (this.id == null) return;
    window.api.csaSend(this.id, line);
    this.lastSend = Date.now();
    if (line && !line.startsWith('LOGIN ')) this.h.onLog?.(`→ ${line}`);
  }

  login(name, password) {
    this.h.onLog?.(`→ LOGIN ${name} ********`);
    this.send(`LOGIN ${name} ${password}`);
  }

  agree() { this.send(`AGREE ${this.summary?.gameId || ''}`.trim()); }
  resign() { this.send('%TORYO'); }
  declareWin() { this.send('%KACHI'); }
  logout() { this.send('LOGOUT'); }

  close() {
    clearInterval(this.keepAlive);
    if (this.id != null) window.api.csaClose(this.id);
  }

  _onLine(line) {
    if (line === '') return;
    if (this.collecting) {
      this.collecting.push(line);
      if (line === 'END Game_Summary') {
        this.summary = parseGameSummary(this.collecting);
        this.collecting = null;
        this.h.onSummary?.(this.summary);
      }
      return;
    }
    this.h.onLog?.(`← ${line}`);
    if (line.startsWith('LOGIN:')) {
      this.h.onLogin?.(/ OK$/.test(line), line);
    } else if (line === 'BEGIN Game_Summary') {
      this.collecting = [line];
    } else if (line.startsWith('START:')) {
      this.h.onStart?.();
    } else if (line.startsWith('REJECT:')) {
      this.h.onReject?.(line);
    } else if (/^[+-]\d{4}[A-Z]{2}/.test(line)) {
      const [mv, ...rest] = line.split(',');
      const t = rest.find(x => /^T\d+/.test(x));
      this.h.onMove?.(mv, t ? +t.slice(1) : 0);
    } else if (/^%(TORYO|KACHI)/.test(line)) {
      this.h.onSpecial?.(line.split(',')[0]);
    } else if (line.startsWith('#')) {
      const RES = { '#WIN': 'win', '#LOSE': 'lose', '#DRAW': 'draw', '#CENSORED': 'censored', '#CHUDAN': 'chudan' };
      if (RES[line]) {
        this.h.onResult?.(RES[line], this.pendingResult || '');
        this.pendingResult = null;
      } else {
        const REASON = {
          '#RESIGN': '投了', '#TIME_UP': '時間切れ', '#ILLEGAL_MOVE': '反則', '#SENNICHITE': '千日手',
          '#OUTE_SENNICHITE': '連続王手の千日手', '#JISHOGI': '入玉宣言', '#MAX_MOVES': '手数上限',
          '#ILLEGAL_ACTION': '反則',
        };
        this.pendingResult = REASON[line] || line.slice(1);
      }
    }
  }

  _onClose(err) {
    clearInterval(this.keepAlive);
    clients.delete(this.id);
    this.id = null;
    this.h.onClose?.(err);
  }
}
