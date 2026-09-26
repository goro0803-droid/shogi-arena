// アイコン作成: build/icon.svg を 512px の PNG にする（npx electron build/make-icon.js）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const w = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, useContentSize: true });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise(r => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
