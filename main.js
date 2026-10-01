// Electron メインプロセス: ウィンドウ・USI エンジンのプロセス管理・ファイル入出力・設定保存
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const engines = new Map();
let nextId = 1;
let win = null;

const storePath = () => path.join(app.getPath('userData'), 'store.json');

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#10131c',
    title: 'Shogi Arena',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 検討・ツリーパネルの切り離し用ウィンドウ（about:blank）だけを許可する
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName === 'shogi-arena-panel') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100, height: 360, minWidth: 500, minHeight: 200,
          title: '検討・ツリー - 将棋アリーナ', autoHideMenuBar: true, backgroundColor: '#10131c',
        },
      };
    }
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ---- USI エンジン ----

ipcMain.handle('engine:start', (_e, exePath) => {
  const id = nextId++;
  let proc;
  if (!exePath || !fs.existsSync(exePath)) return { error: `エンジンが見つかりません: ${exePath}` };
  try {
    proc = spawn(exePath, [], { cwd: path.dirname(exePath), windowsHide: true });
  } catch (err) {
    return { error: err.message };
  }
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      send('engine:line', id, line);
    }
  });
  proc.stderr.on('data', () => {});
  proc.stdin.on('error', () => {});
  proc.on('error', err => {
    engines.delete(id);
    send('engine:exit', id, err.message);
  });
  proc.on('exit', code => {
    engines.delete(id);
    send('engine:exit', id, code);
  });
  engines.set(id, proc);
  return { id };
});

ipcMain.on('engine:send', (_e, id, line) => {
  const p = engines.get(id);
  if (p && p.stdin.writable) p.stdin.write(line + '\n');
});

ipcMain.on('engine:kill', (_e, id) => {
  const p = engines.get(id);
  if (!p) return;
  if (p.stdin.writable) p.stdin.write('quit\n');
  setTimeout(() => { if (!p.killed && p.exitCode === null) p.kill(); }, 1500);
});

/** 同梱・隣接フォルダにある既定エンジン（Sailfish 1.0 と Sailfish 2）を探す */
ipcMain.handle('engine:defaults', () => {
  const candidates = [
    path.join(process.resourcesPath, 'engines', 'sailfish.exe'), // インストール版（同梱）
    path.join(process.resourcesPath, 'engines', 'sailfish2.exe'),
    path.join(__dirname, 'engines', 'sailfish.exe'),
    path.join(__dirname, 'engines', 'sailfish2.exe'),
    path.join(__dirname, '..', 'Sailfish', 'target', 'release', 'sailfish.exe'),
    path.join(__dirname, '..', 'Sailfish2', 'target', 'release', 'sailfish2.exe'),
  ];
  return candidates.filter(p => fs.existsSync(p));
});

ipcMain.handle('engine:exists', (_e, p) => !!p && fs.existsSync(p));

// ---- ファイル ----

ipcMain.handle('dialog:openEngine', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'USI エンジンを選択',
    filters: [{ name: '実行ファイル', extensions: ['exe'] }, { name: 'すべて', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:openKifu', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '棋譜を開く',
    filters: [{ name: '棋譜', extensions: ['kif', 'kifu', 'sfen', 'txt', 'usi'] }, { name: 'すべて', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return null;
  const data = fs.readFileSync(r.filePaths[0]);
  return { path: r.filePaths[0], data: new Uint8Array(data) };
});

/** 棋譜の保存。拡張子で形式を決めるため、選ばれたパスを返してから書き込む */
ipcMain.handle('dialog:savePath', async (_e, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '棋譜を保存',
    defaultPath: defaultName,
    filters: [
      { name: 'KIF (UTF-8)', extensions: ['kifu'] },
      { name: 'KI2 (UTF-8)', extensions: ['ki2u'] },
      { name: 'CSA', extensions: ['csa'] },
      { name: 'SFEN / USI', extensions: ['sfen'] },
    ],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

ipcMain.handle('file:writeText', (_e, p, text) => {
  fs.writeFileSync(p, text, 'utf8');
  return true;
});

// ---- 定跡 ----
const bookPath = () => path.join(app.getPath('userData'), 'book.json');

ipcMain.handle('book:get', () => {
  try { return JSON.parse(fs.readFileSync(bookPath(), 'utf8')); } catch { return {}; }
});

ipcMain.handle('book:set', (_e, data) => {
  const tmp = bookPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, bookPath());
  return true;
});

ipcMain.handle('book:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '定跡ファイルを読み込む（やねうら王形式）',
    filters: [{ name: '定跡', extensions: ['db', 'txt'] }, { name: 'すべて', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : fs.readFileSync(r.filePaths[0], 'utf8');
});

ipcMain.handle('book:export', async (_e, text) => {
  const r = await dialog.showSaveDialog(win, {
    title: '定跡を書き出す（やねうら王形式）', defaultPath: 'user_book.db',
    filters: [{ name: '定跡', extensions: ['db'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});

// ---- 自動保存・画像出力 ----

ipcMain.handle('dialog:openDir', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/** 棋譜を dir に保存する（同名があれば番号を付ける） */
ipcMain.handle('file:autosave', (_e, dir, name, text) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(name), base = path.basename(name, ext);
    let p = path.join(dir, name);
    for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base}(${i})${ext}`);
    fs.writeFileSync(p, text, 'utf8');
    return p;
  } catch {
    return null;
  }
});

/** data URL の PNG を保存する */
ipcMain.handle('file:savePng', async (_e, dataUrl, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: '局面図を保存', defaultPath: defaultName, filters: [{ name: 'PNG 画像', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return r.filePath;
});

ipcMain.handle('clip:writeImage', (_e, dataUrl) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
  return true;
});

/** 盤・駒台の画像ファイルを data URL で読む */
ipcMain.handle('file:openImage', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '画像を選択', filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }], properties: ['openFile'],
  });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}`;
});

// ---- 通信対局（CSA プロトコル） ----
const sockets = new Map();
let nextSock = 1;

ipcMain.handle('csa:connect', (_e, host, port) => new Promise(resolve => {
  const id = nextSock++;
  let done = false;
  const s = net.createConnection({ host, port }, () => {
    done = true;
    resolve({ id });
  });
  s.setEncoding('utf8');
  s.setKeepAlive(true, 30000);
  let buf = '';
  s.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      send('csa:line', id, line);
    }
  });
  s.on('error', err => {
    if (!done) { done = true; resolve({ error: err.message }); }
    send('csa:close', id, err.message);
  });
  s.on('close', () => {
    sockets.delete(id);
    send('csa:close', id, null);
  });
  s.setTimeout(20000, () => { if (!done) { done = true; s.destroy(); resolve({ error: '接続がタイムアウトしました' }); } });
  sockets.set(id, s);
}));

ipcMain.on('csa:send', (_e, id, line) => {
  const s = sockets.get(id);
  if (s && !s.destroyed) s.write(line + '\n');
});

ipcMain.on('csa:close', (_e, id) => {
  const s = sockets.get(id);
  if (s) s.end();
});

// ---- 外部サイト ----
/** 将棋ウォーズを既定のブラウザで開く（許可したサイトのみ） */
ipcMain.handle('open:external', (_e, url) => {
  if (!/^https:\/\/shogiwars\.heroz\.jp\//.test(url)) return false;
  shell.openExternal(url);
  return true;
});

// ---- 盤面の画像 ----
/** rect（CSS ピクセル）の範囲を画像にして、クリップボードへコピーまたは PNG 保存する */
ipcMain.handle('capture:board', async (_e, rect, mode, defaultName) => {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  const img = await win.webContents.capturePage(r);
  if (mode === 'clipboard') {
    clipboard.writeImage(img);
    return 'clipboard';
  }
  const s = await dialog.showSaveDialog(win, {
    title: '盤面画像を保存', defaultPath: defaultName, filters: [{ name: 'PNG 画像', extensions: ['png'] }],
  });
  if (s.canceled || !s.filePath) return null;
  fs.writeFileSync(s.filePath, img.toPNG());
  return s.filePath;
});

// ---- クリップボード ----
ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(text); return true; });

// ---- 設定・戦績の保存 ----

ipcMain.handle('store:get', () => {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {};
  }
});

ipcMain.handle('store:set', (_e, data) => {
  const tmp = storePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, storePath());
  return true;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  for (const p of engines.values()) {
    try { p.stdin.write('quit\n'); p.kill(); } catch { /* 終了済み */ }
  }
  app.quit();
});
