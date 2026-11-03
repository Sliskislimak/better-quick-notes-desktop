// Manual smoke test: `npm run smoke:tracker`
// Logs foreground/bounds events for 10 seconds (QN_SMOKE_MS), then exits.
const { app } = require('electron');
const koffi = require('koffi');
const { WindowTracker, describeWindow, foregroundWindow } = require('../services/windowTracker');

app.whenReady().then(() => {
  console.log('foreground now:', describeWindow(foregroundWindow()));
  const FindWindowExW = koffi.load('user32.dll').func('intptr_t __stdcall FindWindowExW(intptr_t, intptr_t, str16, str16)');
  for (let h = 0, i = 0; i < 10; i++) {
    h = Number(FindWindowExW(0, h, 'ApplicationFrameWindow', null));
    if (!h) break;
    const d = describeWindow(h);
    if (d && d.title) console.log('UWP frame:', d.title, '->', d.process, `(frame pid ${d.windowPid}, app pid ${d.pid}, minimized ${d.minimized}, visible ${d.visible})`);
  }
  const t = new WindowTracker();
  const ok = t.start();
  console.log('tracker started:', ok, t.error && t.error.message);
  for (const ev of ['target', 'own-focus', 'target-bounds', 'target-minimized', 'target-title', 'error']) {
    t.on(ev, (info) => console.log(`[${ev}]`, info ? `${info.process || ''} ${JSON.stringify(info.bounds || info.message || '')}` : null));
  }
  setTimeout(() => { t.stop(); app.quit(); }, Number(process.env.QN_SMOKE_MS || 10000));
});
