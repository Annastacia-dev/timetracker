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
copyFileSync('assets/logo.svg', 'src/assets/logo.svg');
console.log('src/assets/logo.svg');
