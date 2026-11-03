// Builds assets/ from icons/: `npx electron scripts/make-icons.js`
// electron-builder needs a 256x256 Windows icon; the extension ships 128px.
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const src = path.join(__dirname, '..', 'icons');
const out = path.join(__dirname, '..', 'assets');

app.whenReady().then(() => {
  fs.mkdirSync(out, { recursive: true });
  const big = nativeImage.createFromPath(path.join(src, 'icon128.png'));
  const mid = nativeImage.createFromPath(path.join(src, 'icon48.png'));
  const small = nativeImage.createFromPath(path.join(src, 'icon16.png'));
  fs.writeFileSync(path.join(out, 'icon.png'), big.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  fs.writeFileSync(path.join(out, 'tray.png'), small.toPNG());
  fs.writeFileSync(path.join(out, 'tray@2x.png'), mid.resize({ width: 32, height: 32, quality: 'best' }).toPNG());
  console.log('icons written to', out);
  app.quit();
});
