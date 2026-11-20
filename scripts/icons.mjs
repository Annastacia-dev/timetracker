// Generates every app icon from assets/logo.svg. Run after changing the logo: npm run icons
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const svg = readFileSync('assets/logo.svg', 'utf8');
// Grey variant for the tray while the timer is stopped.
const grey = svg.replace('#17bfa6', '#9aa1b0').replace('#0a6e61', '#5d6475');

const png = (src, size) => sharp(Buffer.from(src), { density: 384 }).resize(size, size).png().toBuffer();

mkdirSync('build', { recursive: true });
mkdirSync('electron/assets', { recursive: true });
mkdirSync('src/assets', { recursive: true });

const out = {
  'build/icon.png': [svg, 512], // electron-builder: installer + exe icon
  'electron/assets/icon.png': [svg, 256], // window / taskbar
  'electron/assets/tray-on.png': [svg, 16],
  'electron/assets/tray-on@2x.png': [svg, 32],
  'electron/assets/tray-off.png': [grey, 16],
  'electron/assets/tray-off@2x.png': [grey, 32],
  'public/favicon.png': [svg, 64],
};
mkdirSync('public', { recursive: true });
for (const [file, [src, size]] of Object.entries(out)) {
  writeFileSync(file, await png(src, size));
  console.log(`${file} (${size}px)`);
}
// Multi-size .ico (PNG-compressed entries) for Windows shortcuts, the taskbar and the installer.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((s) => png(svg, s)));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
  header.writeUInt8(s >= 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
const ico = Buffer.concat([header, ...images]);
for (const file of ['build/icon.ico', 'electron/assets/icon.ico']) {
  writeFileSync(file, ico);
  console.log(`${file} (${sizes.join(', ')}px)`);
}

copyFileSync('assets/logo.svg', 'src/assets/logo.svg');
console.log('src/assets/logo.svg');
