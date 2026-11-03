// Dev tool: renders every window invisibly and saves PNGs, without touching
// the real foreground window or stealing focus.
//   npx electron . --user-data=.snap-data --snapshot=.snapshots
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function install() {
  const proto = BrowserWindow.prototype;
  const showInactive = proto.showInactive;
  proto.showInactive = function () { this.setOpacity(0); showInactive.call(this); };
  proto.show = function () { this.showInactive(); };
  proto.focus = function () {};
}

const DEMO = [
  {
    process: 'Code.exe', appName: 'Visual Studio Code', pinned: true, tag: 'blue',
    body: '# Sprint plan\n\nShip the **desktop port** of Quick Notes.\n\n- [x] Window tracker (koffi)\n- [ ] Docked bar\n- [ ] Drive sync\n\n| Task | Owner |\n|---|---|\n| Tracker | Kuba |\n| Vault | Kuba |\n\n`npm start` to run it.\n'
  },
  { process: 'Code.exe', appName: 'Visual Studio Code', tag: 'red', body: 'Bugs\n\n- bar flickers on resize\n- ~~double save~~ fixed\n' },
  { process: 'Code.exe', appName: 'Visual Studio Code', body: 'API ideas\n\nexpose `window.qn.on` for plugins' },
  { process: 'notepad.exe', appName: 'Notepad', tag: 'green', body: 'Groceries\n\n- milk\n- eggs' },
  { process: 'WINWORD.EXE', appName: 'Word', body: 'Thesis outline\n\n1. Intro\n2. Method' }
];

async function run({ dir, store, overlay, tracker, toggleDashboard, openSettings, windows }) {
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  const capture = async (win, name, delay = 700) => {
    await wait(delay);
    const img = await win.webContents.capturePage();
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const s = img.getSize();
    shots.push(`${name} ${s.width}x${s.height}${img.isEmpty() ? ' (EMPTY)' : ''}`);
  };

  try {
    tracker.setPaused(true);
    if (!store.list().length) for (const n of DEMO) store.create(n);

    overlay.onTarget({
      hwnd: 1, pid: 1, exePath: process.execPath, process: 'Code.exe', processKey: 'code.exe',
      title: 'main.js - better Quick Notes - Visual Studio Code', className: 'Chrome_WidgetWin_1',
      bounds: { x: 60, y: 40, width: 1500, height: 900 }, minimized: false, maximized: false, visible: true
    });
    await capture(overlay.bar, 'bar-awake', 900);
    console.log('[bar]', await overlay.bar.webContents.executeJavaScript(
      "(() => { const d = document.getElementById('dock'); const cs = getComputedStyle(d); return JSON.stringify({ cls: d.className, opacity: cs.opacity, bg: cs.backgroundColor, theme: document.getElementById('wrap').dataset.theme }); })()"));
    await capture(overlay.bar, 'bar-idle', 2600);

    overlay.expand({ focus: false });
    await capture(overlay.panel, 'panel', 1000);

    overlay.sendPanel({ view: 'menu', toggleMenu: true, focusEditor: false });
    await capture(overlay.panel, 'panel-menu');
    overlay.sendPanel({ view: 'editor', focusEditor: false });

    await overlay.panel.webContents.executeJavaScript("document.getElementById('previewBtn').click()");
    await capture(overlay.panel, 'panel-preview');
    await overlay.panel.webContents.executeJavaScript("document.getElementById('previewBtn').click()");

    store.setPrefs({ theme: 'light' });
    await capture(overlay.panel, 'panel-light');
    store.setPrefs({ theme: 'dark' });

    toggleDashboard(true);
    const { dashboardWin } = windows();
    await capture(dashboardWin, 'dashboard', 1200);

    openSettings();
    const { settingsWin } = windows();
    await capture(settingsWin, 'settings-top', 1500);
    for (const id of ['vault', 'appearance', 'behavior']) {
      await settingsWin.webContents.executeJavaScript(`document.getElementById('${id}').scrollIntoView({behavior:'instant'})`);
      await capture(settingsWin, `settings-${id}`, 400);
    }

    await vaultCheck(store);
  } catch (e) {
    console.error('[snapshot] failed:', e);
  }
  console.log('[snapshot] done:\n  ' + shots.join('\n  '));
  app.isQuitting = true;
  app.quit();
}

// Vault round trip: write, external edit, title rename.
async function vaultCheck(store) {
  const dir = path.join(app.getPath('userData'), 'vault');
  const mdFiles = () => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  store.setSettings({ vaultPath: dir });
  await wait(2000);
  console.log('[vault] files:', mdFiles());
  const grocery = mdFiles().find((f) => f.startsWith('Groceries_'));
  if (!grocery) { console.log('[vault] FAIL: Groceries file missing'); return; }
  const file = path.join(dir, grocery);
  console.log('[vault] ' + grocery + ':\n' + fs.readFileSync(file, 'utf8'));

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('- eggs', '- eggs\n- bread (edited in Obsidian)'));
  await wait(2500);
  const note = store.list().find((n) => n.process === 'notepad.exe');
  console.log('[vault] external edit applied:', /bread/.test(note.body) ? 'OK' : 'FAIL');

  store.update(note.id, { title: 'Shopping list', titleLocked: true });
  await wait(1500);
  const files = mdFiles();
  console.log('[vault] rename:', files.some((f) => f.startsWith('Shopping list_')) && !files.includes(grocery) ? 'OK' : 'FAIL', files);
}

module.exports = { install, run };
