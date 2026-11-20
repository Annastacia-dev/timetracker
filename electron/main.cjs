const {
  app, BrowserWindow, ipcMain, powerMonitor, desktopCapturer, screen, Tray, Menu,
  nativeImage, Notification, dialog, protocol, net, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Store, uid } = require('./store.cjs');
const { invoiceHtml } = require('./invoice.cjs');

// Activity/screenshot blocks, aligned to the wall clock. TT_BLOCK_MS shortens them for the smoke test.
const BLOCK_MS = Number(process.env.TT_BLOCK_MS) || 10 * 60 * 1000;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

protocol.registerSchemesAsPrivileged([
  { scheme: 'tt-shot', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Windows uses this ID to group taskbar buttons and to label notifications. It matches build.appId.
const APP_ID = 'com.local.timetracker';
app.setName('TimeTracker');
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) app.quit();

// Windows takes a notification's app name and the taskbar icon from a Start Menu shortcut registered
// under the app ID. The installer creates one; in development we register our own so the bare
// electron.exe does not show up as "Electron" with Electron's logo.
function ensureDevShortcut() {
  if (app.isPackaged || process.platform !== 'win32') return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TimeTracker (dev).lnk');
  const want = {
    target: process.execPath,
    args: `"${path.join(__dirname, '..')}"`,
    appUserModelId: APP_ID,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    iconIndex: 0,
    description: 'TimeTracker (development build)',
  };
  try {
    const have = fs.existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    if (have && have.target === want.target && have.icon === want.icon && have.appUserModelId === APP_ID) return;
    shell.writeShortcutLink(lnk, have ? 'replace' : 'create', want);
  } catch (err) {
    console.warn('could not register dev shortcut', err);
  }
}

let store, win, tray, shotsDir;
let tickTimer = null;
let block = null; // the open activity block
let idle = null; // { since, prompted } while the user is (or was) away
let quitting = false;

// ---------- helpers ----------
const S = () => store.data;
const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const runningEntry = () => S().running && S().entries.find((e) => e.id === S().running.entryId);
const projectLabel = (projectId) => {
  const p = S().projects.find((x) => x.id === projectId);
  const c = p && S().clients.find((x) => x.id === p.clientId);
  return p ? `${c ? c.name + ' · ' : ''}${p.name}` : 'Unknown project';
};
const rateFor = (projectId) => {
  const p = S().projects.find((x) => x.id === projectId);
  const c = p && S().clients.find((x) => x.id === p.clientId);
  return Number(p?.rate ?? c?.rate ?? 0) || 0;
};

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', S());
}
function commit() {
  store.save();
  broadcast();
  updateTray();
}

function removeShotFile(rel) {
  if (!rel) return;
  const file = path.join(shotsDir, rel);
  if (file.startsWith(shotsDir)) fs.rm(file, { force: true }, () => {});
}

// ---------- tray ----------
// Teal logo while tracking, grey when stopped. The @2x files are picked up on high-DPI screens.
const asset = (name) => path.join(__dirname, 'assets', name);
let iconOn, iconOff;
const ICON_ON = () => (iconOn ??= nativeImage.createFromPath(asset('tray-on.png')));
const ICON_OFF = () => (iconOff ??= nativeImage.createFromPath(asset('tray-off.png')));

function fmtElapsed(ms) {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function updateTray() {
  if (!tray) return;
  const e = runningEntry();
  tray.setImage(e ? ICON_ON() : ICON_OFF());
  tray.setToolTip(e ? `${fmtElapsed(Date.now() - e.start)} · ${projectLabel(e.projectId)}` : 'TimeTracker — not tracking');
  const last = [...S().entries].reverse().find((x) => !x.manual);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: e ? `Tracking: ${projectLabel(e.projectId)}` : 'Not tracking', enabled: false },
      e
        ? { label: 'Stop timer', click: () => stopTimer() }
        : last && S().projects.some((p) => p.id === last.projectId && !p.archived)
          ? { label: `Resume ${projectLabel(last.projectId)}`, click: () => startTimer(last.projectId, last.task) }
          : { label: 'Start timer from window', click: showWindow },
      { type: 'separator' },
      { label: 'Open TimeTracker', click: showWindow },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
  if (win && !win.isDestroyed()) win.setTitle(e ? `${fmtElapsed(Date.now() - e.start)} — TimeTracker` : 'TimeTracker');
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

// ---------- tracking ----------
function openBlock(now) {
  const end = Math.floor(now / BLOCK_MS) * BLOCK_MS + BLOCK_MS;
  block = {
    id: uid(),
    entryId: S().running.entryId,
    start: now,
    end,
    activeMinutes: new Set(),
    screenshot: null,
    shotAt: now + Math.random() * (end - now),
    shooting: false,
  };
}

function closeBlock(at) {
  if (!block) return;
  const b = block;
  block = null;
  if (at <= b.start) return removeShotFile(b.screenshot);
  const minutes = Math.max(1, Math.ceil((at - b.start) / 60000));
  S().blocks.push({
    id: b.id,
    entryId: b.entryId,
    start: b.start,
    end: at,
    activity: Math.min(100, Math.round((b.activeMinutes.size / minutes) * 100)),
    screenshot: b.screenshot,
  });
}

function startTimer(projectId, task = '') {
  if (!S().projects.some((p) => p.id === projectId)) throw new Error('Pick a project first.');
  if (S().running) stopTimer();
  const now = Date.now();
  const entry = { id: uid(), projectId, task: String(task || ''), start: now, end: null, manual: false, invoiceId: null };
  S().entries.push(entry);
  S().running = { entryId: entry.id, lastTick: now };
  idle = null;
  openBlock(now);
  clearInterval(tickTimer);
  tickTimer = setInterval(onTick, 1000);
  commit();
}

function stopTimer(at = Date.now()) {
  const e = runningEntry();
  clearInterval(tickTimer);
  tickTimer = null;
  if (e) {
    at = Math.max(e.start, at);
    closeBlock(at);
    // Drop blocks that began after the stop point (e.g. idle time being discarded).
    S().blocks = S().blocks.filter((b) => {
      if (b.entryId === e.id && b.start >= at) { removeShotFile(b.screenshot); return false; }
      if (b.entryId === e.id && b.end > at) b.end = at;
      return true;
    });
    e.end = at;
    if (e.end - e.start < 1000) S().entries = S().entries.filter((x) => x.id !== e.id);
  }
  block = null;
  S().running = null;
  idle = null;
  commit();
}

function onTick() {
  const e = runningEntry();
  if (!e || !block) return;
  const now = Date.now();
  const idleSec = powerMonitor.getSystemIdleTime();

  if (now >= block.end) {
    closeBlock(block.end);
    openBlock(now);
  }
  if (idleSec <= 1) block.activeMinutes.add(Math.floor(now / 60000));

  const set = S().settings;
  if (set.screenshotsEnabled && !block.screenshot && !block.shooting && now >= block.shotAt) {
    captureScreenshot(block, e);
  }

  const limit = Number(set.idleMinutes) * 60;
  if (limit > 0 && !idle && idleSec >= limit)
    idle = { since: Math.max(e.start, now - idleSec * 1000), prompted: false };
  if (idle && !idle.prompted && idleSec <= 1) promptIdle();

  if (now - S().running.lastTick > 15000) {
    S().running.lastTick = now;
    store.save();
  }
  updateTray();
}

function promptIdle() {
  idle.prompted = true;
  showWindow();
  win.webContents.send('idle:detected', { since: idle.since, now: Date.now() });
  if (Notification.isSupported())
    new Notification({ icon: asset('icon.png'), title: 'You were idle', body: 'Choose whether to keep or discard the idle time.' }).show();
}

function resolveIdle(action) {
  const e = runningEntry();
  const since = idle?.since;
  idle = null;
  if (!e || !since || action === 'keep') return;
  const { projectId, task } = e;
  stopTimer(since);
  if (action === 'discard-continue') startTimer(projectId, task);
}

async function captureScreenshot(b, entry) {
  b.shooting = true;
  try {
    const d = screen.getPrimaryDisplay();
    const thumbnailSize = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    if (!src) return;
    let img = src.thumbnail;
    if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
    if (S().settings.blurScreenshots) img = img.resize({ width: 120 }).resize({ width: 1600, quality: 'good' });
    const rel = `${ymd()}/${Date.now()}.jpg`;
    const file = path.join(shotsDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img.toJPEG(70));
    b.screenshot = rel;
    // The block may have closed while we were capturing.
    const saved = S().blocks.find((x) => x.id === b.id);
    if (saved) saved.screenshot = rel;
    if (!S().entries.some((x) => x.id === b.entryId)) removeShotFile(rel);
    if (Notification.isSupported())
      new Notification({ icon: asset('icon.png'), title: 'Screenshot captured', body: projectLabel(entry.projectId), silent: true }).show();
    commit();
  } catch (err) {
    console.error('screenshot failed', err);
  } finally {
    b.shooting = false;
  }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'TimeTracker',
    icon: asset(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => {
    if (!(DEV_URL && url.startsWith(DEV_URL))) ev.preventDefault();
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Closing the window keeps tracking in the tray, like other desktop trackers.
  win.on('close', (ev) => {
    if (!quitting) {
      ev.preventDefault();
      win.hide();
      if (runningEntry() && Notification.isSupported())
        new Notification({ icon: asset('icon.png'), title: 'Still tracking', body: 'TimeTracker keeps running in the tray.', silent: true }).show();
    }
  });
}

// ---------- invoices ----------
function createInvoice({ clientId, from, to, notes }) {
  const client = S().clients.find((c) => c.id === clientId);
  if (!client) throw new Error('Pick a client.');
  const projectIds = new Set(S().projects.filter((p) => p.clientId === clientId).map((p) => p.id));
  const entries = S().entries.filter(
    (e) => projectIds.has(e.projectId) && e.end && !e.invoiceId && e.start >= from && e.start < to
  );
  if (!entries.length) throw new Error('No unbilled time for this client in that period.');

  const byProject = new Map();
  for (const e of entries) byProject.set(e.projectId, (byProject.get(e.projectId) || 0) + (e.end - e.start));
  const lines = [...byProject].map(([projectId, ms]) => {
    const hours = Math.round((ms / 3600000) * 100) / 100;
    const rate = rateFor(projectId);
    const p = S().projects.find((x) => x.id === projectId);
    return { projectId, description: p?.name || 'Project', hours, rate, amount: Math.round(hours * rate * 100) / 100 };
  });
  const now = Date.now();
  const inv = {
    id: uid(),
    number: `INV-${String(S().nextInvoiceNo).padStart(4, '0')}`,
    clientId,
    from,
    to,
    lines,
    total: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    notes: notes || '',
    createdAt: now,
    dueAt: now + (Number(S().settings.invoiceDueDays) || 0) * 86400000,
  };
  S().nextInvoiceNo++;
  for (const e of entries) e.invoiceId = inv.id;
  S().invoices.push(inv);
  commit();
  return inv;
}

async function invoicePdf(id) {
  const inv = S().invoices.find((i) => i.id === id);
  if (!inv) throw new Error('Invoice not found.');
  const client = S().clients.find((c) => c.id === inv.clientId);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${inv.number}${client ? ' - ' + client.name.replace(/[\\/:*?"<>|]/g, '') : ''}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(invoiceHtml(inv, client, S().settings)));
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    fs.writeFileSync(filePath, pdf);
  } finally {
    pdfWin.destroy();
  }
  shell.openPath(filePath);
  return filePath;
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

function registerIpc() {
  handle('state:get', () => S());
  handle('app:paths', () => ({ data: store.file, screenshots: shotsDir }));

  handle('timer:start', (projectId, task) => startTimer(projectId, task));
  handle('timer:stop', () => stopTimer());
  handle('idle:resolve', (action) => resolveIdle(action));

  handle('client:save', (c) => {
    const rec = { id: c.id || uid(), name: String(c.name || '').trim(), email: c.email || '', address: c.address || '', rate: Number(c.rate) || 0 };
    if (!rec.name) throw new Error('Client name is required.');
    const i = S().clients.findIndex((x) => x.id === rec.id);
    i >= 0 ? (S().clients[i] = rec) : S().clients.push(rec);
    commit();
    return rec;
  });
  handle('client:delete', (id) => {
    const pids = S().projects.filter((p) => p.clientId === id).map((p) => p.id);
    if (S().entries.some((e) => pids.includes(e.projectId)))
      throw new Error('This client has tracked time. Archive its projects instead.');
    S().projects = S().projects.filter((p) => p.clientId !== id);
    S().clients = S().clients.filter((c) => c.id !== id);
    commit();
  });

  handle('project:save', (p) => {
    const rec = {
      id: p.id || uid(),
      clientId: p.clientId,
      name: String(p.name || '').trim(),
      rate: p.rate === '' || p.rate == null ? null : Number(p.rate),
      archived: !!p.archived,
    };
    if (!rec.name) throw new Error('Project name is required.');
    if (!S().clients.some((c) => c.id === rec.clientId)) throw new Error('Pick a client.');
    if (rec.archived && runningEntry()?.projectId === rec.id) stopTimer();
    const i = S().projects.findIndex((x) => x.id === rec.id);
    i >= 0 ? (S().projects[i] = rec) : S().projects.push(rec);
    commit();
    return rec;
  });
  handle('project:delete', (id) => {
    if (S().entries.some((e) => e.projectId === id)) throw new Error('This project has tracked time. Archive it instead.');
    S().projects = S().projects.filter((p) => p.id !== id);
    commit();
  });

  handle('entry:save', (e) => {
    const start = Number(e.start), end = Number(e.end);
    if (!S().projects.some((p) => p.id === e.projectId)) throw new Error('Pick a project.');
    if (!(end > start)) throw new Error('End must be after start.');
    if (end > Date.now() + 60000) throw new Error('Time cannot end in the future.');
    const existing = S().entries.find((x) => x.id === e.id);
    if (existing) {
      if (existing.invoiceId) throw new Error('This time is on an invoice. Delete the invoice to edit it.');
      if (S().running?.entryId === existing.id) throw new Error('Stop the timer before editing this entry.');
      Object.assign(existing, { projectId: e.projectId, task: e.task || '', start, end });
      S().blocks = S().blocks.filter((b) => {
        if (b.entryId === existing.id && (b.end <= start || b.start >= end)) { removeShotFile(b.screenshot); return false; }
        return true;
      });
    } else {
      S().entries.push({ id: uid(), projectId: e.projectId, task: e.task || '', start, end, manual: true, invoiceId: null });
    }
    commit();
  });
  handle('entry:delete', (id) => {
    const e = S().entries.find((x) => x.id === id);
    if (!e) return;
    if (e.invoiceId) throw new Error('This time is on an invoice. Delete the invoice first.');
    if (S().running?.entryId === id) stopTimer();
    S().blocks = S().blocks.filter((b) => (b.entryId === id ? (removeShotFile(b.screenshot), false) : true));
    S().entries = S().entries.filter((x) => x.id !== id);
    commit();
  });

  handle('settings:save', (patch) => {
    Object.assign(S().settings, patch);
    commit();
  });

  handle('invoice:create', (args) => createInvoice(args));
  handle('invoice:delete', (id) => {
    for (const e of S().entries) if (e.invoiceId === id) e.invoiceId = null;
    S().invoices = S().invoices.filter((i) => i.id !== id);
    commit();
  });
  handle('invoice:pdf', (id) => invoicePdf(id));

  handle('shot:delete', (blockId) => {
    const b = S().blocks.find((x) => x.id === blockId);
    if (b) { removeShotFile(b.screenshot); b.screenshot = null; commit(); }
  });
  handle('shot:openFolder', () => {
    fs.mkdirSync(shotsDir, { recursive: true });
    shell.openPath(shotsDir);
  });
  handle('file:saveText', async ({ defaultName, content, ext = 'csv' }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, '﻿' + content); // BOM so Excel reads UTF-8
    return filePath;
  });
}

// ---------- lifecycle ----------
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  ensureDevShortcut();
  store = new Store(path.join(app.getPath('userData'), 'timetracker.json'));
  shotsDir = path.join(app.getPath('userData'), 'screenshots');

  // Recover from a crash or power loss: close the open entry at its last heartbeat.
  if (S().running) {
    const e = runningEntry();
    if (e) e.end = Math.max(e.start + 1000, S().running.lastTick);
    S().running = null;
    store.saveNow();
  }

  protocol.handle('tt-shot', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.resolve(shotsDir, rel);
    if (!file.startsWith(shotsDir + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  registerIpc();
  createWindow();
  tray = new Tray(ICON_OFF());
  tray.on('click', showWindow);
  updateTray();

  // Locking or sleeping counts as going idle; ask about it on return.
  const away = () => {
    if (runningEntry() && !idle) idle = { since: Date.now(), prompted: false };
  };
  powerMonitor.on('lock-screen', away);
  powerMonitor.on('suspend', away);
});

app.on('before-quit', () => {
  quitting = true;
  if (store) {
    if (S().running) stopTimer();
    store.saveNow();
  }
});
app.on('window-all-closed', () => {}); // stay alive in the tray
