// Renders the cloud-mode sign-in screen against an unreachable Supabase URL and saves a capture.
// Run: npx electron scripts/cloud-ui-shot.cjs  (after npm run build)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.TT_SUPABASE_URL = 'https://example.invalid';
process.env.TT_SUPABASE_ANON_KEY = 'dummy';
delete process.env.TT_LOCAL;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cloudui-'));
app.setPath('userData', data);
require('../electron/main.cjs');

app.on('browser-window-created', (_e, win) => {
  if (BrowserWindow.getAllWindows().length > 1) return;
  win.webContents.setBackgroundThrottling(false);
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const text = await win.webContents.executeJavaScript('document.body.innerText');
    const out = path.join(__dirname, '..', 'smoke-out');
    fs.mkdirSync(out, { recursive: true });
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(out, 'cloud-login.png'), (await win.webContents.capturePage()).toPNG());
    console.log(text.includes('Sign in to TimeTracker') ? 'PASS  cloud mode shows the sign-in screen' : `FAIL  got: ${text.slice(0, 200)}`);
    // Electron still has files open in the temp profile; clean it up after exit.
    process.on('exit', () => { try { fs.rmSync(data, { recursive: true, force: true }); } catch {} });
    app.exit(0);
  });
});
