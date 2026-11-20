// End-to-end smoke test: boots the real app with a temporary data folder, drives it through the
// preload API and the UI, saves a PNG of each page to smoke-out/, and prints a summary.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-smoke-'));
app.setPath('userData', data);
const out = path.join(__dirname, '..', 'smoke-out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

require('../electron/main.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
};

app.on('browser-window-created', (_e, win) => {
  if (win.__smoke || BrowserWindow.getAllWindows().length > 1) return;
  win.__smoke = true;
  win.webContents.once('did-finish-load', () => run(win).catch((err) => {
    console.error(err);
    failed = true;
  }).finally(() => {
    // The data folder holds real screenshots of this desktop: remove it.
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
    console.log(`\nPage captures: ${out}`);
    app.exit(failed ? 1 : 0);
  }));
});

async function run(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  win.webContents.setBackgroundThrottling(false);
  const snap = async (name) => {
    await sleep(400);
    win.webContents.invalidate();
    await sleep(200);
    fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const tab = (label) =>
    js(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim() ===${JSON.stringify(label)}).click()`);

  await sleep(500);
  check(app.getName() === 'TimeTracker', `app name is "${app.getName()}"`);
  if (process.platform === 'win32') {
    const { shell } = require('electron');
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TimeTracker (dev).lnk');
    const sc = fs.existsSync(lnk) && shell.readShortcutLink(lnk);
    check(!!sc && sc.appUserModelId === 'com.local.timetracker', 'dev Start Menu shortcut registered with the app ID');
    check(!!sc && sc.icon.endsWith('icon.ico') && fs.existsSync(sc.icon), 'dev shortcut uses the TimeTracker icon');
  }
  await snap('01-empty');
  check(await js(`document.body.innerText.includes('Track time for your clients')`), 'empty state shows onboarding');

  await js(`window.tt.saveSettings({ idleMinutes: 0, screenshotsEnabled: true, businessName: 'Smoke Test Studio', currency: 'USD' })`);
  const client = await js(`window.tt.saveClient({ name: 'Acme Corp', email: 'billing@acme.test', rate: 50 })`);
  await js(`window.tt.saveProject({ clientId: ${JSON.stringify(client.id)}, name: 'Website redesign', rate: '' })`);
  const p2 = await js(`window.tt.saveProject({ clientId: ${JSON.stringify(client.id)}, name: 'Mobile app', rate: 80 })`);
  await sleep(300);

  // Start the timer through the UI.
  await js(`(() => {
    const input = document.querySelector('input.task');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Homepage layout'); input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button.big.start').click();
  })()`);
  await sleep(1500);
  let s = await js('window.tt.getState()');
  check(!!s.running, 'timer starts from the Start button');
  check(s.entries[0]?.task === 'Homepage layout', 'task text saved on the entry');

  // Run across at least two 20s blocks so blocks close and a screenshot is taken.
  await sleep(43000);
  await snap('02-tracking');
  await js(`document.querySelector('button.big.stop').click()`);
  await sleep(800);
  s = await js('window.tt.getState()');
  check(!s.running && s.entries[0].end > s.entries[0].start, 'timer stops and closes the entry');
  check(s.blocks.length >= 2, `activity blocks recorded (${s.blocks.length})`);
  check(s.blocks.some((b) => b.screenshot), 'at least one screenshot captured');
  const shot = s.blocks.find((b) => b.screenshot);
  if (shot) check(fs.existsSync(path.join(data, 'screenshots', shot.screenshot)), 'screenshot file exists on disk');

  // Manual time on the second project, two hours earlier today (or yesterday after midnight).
  const end = Date.now() - 3600000;
  await js(`window.tt.saveEntry({ projectId: ${JSON.stringify(p2.id)}, task: 'API planning', start: ${end - 5400000}, end: ${end} })`);
  const bad = await js(`window.tt.saveEntry({ projectId: ${JSON.stringify(p2.id)}, start: 2000, end: 1000 }).then(() => 'saved', e => 'rejected')`);
  check(bad === 'rejected', 'entry with end before start is rejected');

  await tab('Tracker'); await snap('03-tracker');
  await tab('Timesheet'); await snap('04-timesheet');
  check(await js(`document.body.innerText.includes('manual')`), 'timesheet labels manual time');
  await tab('Work diary'); await snap('05-work-diary');
  const imgs = await js(`Promise.all([...document.querySelectorAll('.shot-img img')].map(i => i.decode().then(() => i.naturalWidth, () => 0)))`);
  check(imgs.length > 0 && imgs.every((w) => w > 0), `work diary loads screenshots via tt-shot:// (${imgs.length})`);
  await tab('Reports'); await snap('06-reports');
  check(await js(`document.body.innerText.includes('Acme Corp')`), 'report groups time under the client');

  const inv = await js(`window.tt.createInvoice({ clientId: ${JSON.stringify(client.id)}, from: 0, to: Date.now() + 1000, notes: 'Thank you!' })`);
  check(inv.number === 'INV-0001' && inv.lines.length === 2, `invoice created with ${inv.lines.length} lines, total ${inv.total}`);
  const mobile = inv.lines.find((l) => l.description === 'Mobile app');
  check(mobile && mobile.hours === 1.5 && mobile.amount === 120, 'project rate override used (1.5 h × $80 = $120)');
  const again = await js(`window.tt.createInvoice({ clientId: ${JSON.stringify(client.id)}, from: 0, to: Date.now() + 1000 }).then(() => 'created', () => 'rejected')`);
  check(again === 'rejected', 'invoiced time cannot be billed twice');
  await tab('Invoices'); await snap('07-invoices');

  // Render the invoice PDF the same way the app does, without the save dialog.
  const { invoiceHtml } = require('../electron/invoice.cjs');
  const st = await js('window.tt.getState()');
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(invoiceHtml(st.invoices[0], st.clients[0], st.settings)));
  const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  fs.writeFileSync(path.join(out, 'invoice.pdf'), pdf);
  pdfWin.destroy();
  check(pdf.length > 1000, `invoice PDF rendered (${pdf.length} bytes)`);

  await tab('Clients & projects'); await snap('08-clients');
  await tab('Settings'); await snap('09-settings');
}
