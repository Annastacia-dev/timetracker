const {
  app, BrowserWindow, ipcMain, powerMonitor, desktopCapturer, screen, Tray, Menu,
  nativeImage, Notification, dialog, protocol, net, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Store, uid, DEFAULTS } = require('./store.cjs');
const { invoiceHtml } = require('./invoice.cjs');
const cloudLib = require('./cloud.cjs');

// Activity/screenshot blocks, aligned to the wall clock. TT_BLOCK_MS shortens them for the smoke test.
const BLOCK_MS = Number(process.env.TT_BLOCK_MS) || 10 * 60 * 1000;
const SYNC_EVERY_MS = 60 * 1000;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const APP_ROOT = path.join(__dirname, '..');

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
    args: `"${APP_ROOT}"`,
    appUserModelId: APP_ID,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    iconIndex: 0,
    description: 'TimeTracker (development build)',
  };
  try {
    const have = fs.existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    const current = have && have.target === want.target && have.icon === want.icon && have.appUserModelId === APP_ID;
    if (!current) shell.writeShortcutLink(lnk, have ? 'replace' : 'create', want);
  } catch (err) {
    console.warn('could not register dev shortcut', err);
  }
  // Toast headers for unpackaged apps come from this per-user registry entry; without it Windows
  // falls back to electron.exe's file description ("Electron").
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const reg = (name, value) =>
    require('node:child_process').execFile('reg.exe', ['add', key, '/v', name, '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { windowsHide: true }, (err) => {
      if (err) console.warn(`could not set ${name}`, err.message);
    });
  reg('DisplayName', 'TimeTracker (dev)');
  reg('IconUri', path.join(__dirname, 'assets', 'icon.png'));
}

// ---------- state ----------
let store = null; // local mode: timetracker.json; cloud mode: one file per user + team
let win, tray, shotsDir, userData, sb = null;
let tickTimer = null;
let block = null; // the open activity block
let idle = null; // { since, prompted } while the user is (or was) away
let quitting = false;

// Who is signed in, which team is open, and how sync is going. Sent to the renderer with the data.
const account = {
  mode: 'local', // 'local' (no Supabase config) | 'cloud'
  user: null, // { id, email, name }
  teams: [], // [{ id, name, role }]
  teamId: null,
  role: 'owner',
  members: [], // [{ userId, role, name, email }]
  invites: [],
  sync: { online: true, syncing: false, lastSyncAt: null, error: null },
};

const S = () => store.data;
const cloud = () => account.mode === 'cloud';
const me = () => account.user?.id || 'local';
const isAdmin = () => !cloud() || account.role !== 'member';
const live = (list) => list.filter((x) => !x.deletedAt);
const mine = (e) => !e.userId || e.userId === me();

const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const runningEntry = () => store && S().running && S().entries.find((e) => e.id === S().running.entryId);
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

// ---------- prefs (last team per user, cached team list for offline start) ----------
let prefs = { lastTeam: {}, teams: {} };
const prefsFile = () => path.join(userData, 'prefs.json');
function loadPrefs() {
  try { prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) }; } catch {}
}
function savePrefs() {
  try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2)); } catch {}
}

// ---------- renderer state ----------
function viewState() {
  const d = store ? store.data : structuredClone(DEFAULTS);
  const pending = store ? d.entries.filter((e) => e.dirty).length + d.blocks.filter((b) => b.dirty).length : 0;
  return {
    ...d,
    entries: live(d.entries),
    blocks: live(d.blocks),
    account: { ...account, me: me(), isAdmin: isAdmin(), ready: !!store, pending },
  };
}
function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', viewState());
}
function toast(text, kind = 'info') {
  if (win && !win.isDestroyed()) win.webContents.send('toast', { text, kind });
}
function commit() {
  if (store) store.save();
  broadcast();
  updateTray();
}

// Marks a record as changed locally so the next sync pushes it.
function touch(rec) {
  if (!cloud() || !rec) return;
  rec.dirty = true;
  rec.rev = (rec.rev || 0) + 1;
  scheduleSync();
}

function removeShotFile(rel) {
  if (!rel) return;
  const file = path.join(shotsDir, rel);
  if (file.startsWith(shotsDir)) fs.rm(file, { force: true }, () => {});
}
function removeLocalShots(b) {
  removeShotFile(b.screenshot);
  removeShotFile(b.thumb);
}

// Removes a block or entry: soft delete in cloud mode so the deletion syncs.
function dropBlock(b) {
  removeLocalShots(b);
  b.screenshot = b.thumb = null;
  if (b.remoteShot) S().sync.pendingRemoteDeletes.push(b.remoteShot);
  if (cloud()) { b.deletedAt = Date.now(); touch(b); }
  else S().blocks = S().blocks.filter((x) => x !== b);
}
function dropEntry(e) {
  for (const b of live(S().blocks).filter((x) => x.entryId === e.id)) dropBlock(b);
  if (cloud()) { e.deletedAt = Date.now(); touch(e); }
  else S().entries = S().entries.filter((x) => x !== e);
}

// ---------- tray ----------
// Teal logo while tracking, grey when stopped. The @2x files are picked up on high-DPI screens.
const asset = (name) => path.join(__dirname, 'assets', name);
let iconOn, iconOff;
const ICON_ON = () => (iconOn ??= nativeImage.createFromPath(asset('tray-on.png')));
const ICON_OFF = () => (iconOff ??= nativeImage.createFromPath(asset('tray-off.png')));
const notify = (title, body, silent = false) => {
  if (Notification.isSupported()) new Notification({ icon: asset('icon.png'), title, body, silent }).show();
};

function fmtElapsed(ms) {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function updateTray() {
  if (!tray) return;
  const e = runningEntry();
  tray.setImage(e ? ICON_ON() : ICON_OFF());
  tray.setToolTip(e ? `${fmtElapsed(Date.now() - e.start)} · ${projectLabel(e.projectId)}` : 'TimeTracker — not tracking');
  const last = store && [...live(S().entries)].reverse().find((x) => !x.manual && mine(x));
  const canResume = last && S().projects.some((p) => p.id === last.projectId && !p.archived);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: e ? `Tracking: ${projectLabel(e.projectId)}` : 'Not tracking', enabled: false },
      e
        ? { label: 'Stop timer', click: () => stopTimer() }
        : canResume
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
    thumb: null,
    shotAt: now + Math.random() * (end - now),
    shooting: false,
  };
}

function closeBlock(at) {
  if (!block) return;
  const b = block;
  block = null;
  if (at <= b.start) return removeLocalShots(b);
  const minutes = Math.max(1, Math.ceil((at - b.start) / 60000));
  const rec = {
    id: b.id,
    entryId: b.entryId,
    userId: me(),
    start: b.start,
    end: at,
    activity: Math.min(100, Math.round((b.activeMinutes.size / minutes) * 100)),
    screenshot: b.screenshot,
    thumb: b.thumb,
  };
  S().blocks.push(rec);
  touch(rec);
}

function startTimer(projectId, task = '') {
  if (!store) throw new Error('Open a team first.');
  if (!S().projects.some((p) => p.id === projectId && !p.archived)) throw new Error('Pick a project first.');
  if (S().running) stopTimer();
  const now = Date.now();
  const entry = {
    id: uid(), userId: me(), projectId, task: String(task || ''), start: now, end: null, manual: false, invoiceId: null,
  };
  S().entries.push(entry);
  S().running = { entryId: entry.id, lastTick: now };
  touch(entry);
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
    for (const b of live(S().blocks)) {
      if (b.entryId !== e.id) continue;
      if (b.start >= at) dropBlock(b);
      else if (b.end > at) { b.end = at; touch(b); }
    }
    e.end = at;
    if (e.end - e.start < 1000) dropEntry(e);
    else touch(e);
  }
  block = null;
  if (store) S().running = null;
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
  notify('You were idle', 'Choose whether to keep or discard the idle time.');
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
  const st = store;
  try {
    const d = screen.getPrimaryDisplay();
    const thumbnailSize = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    if (!src || st !== store) return;
    let img = src.thumbnail;
    if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
    if (S().settings.blurScreenshots) img = img.resize({ width: 120 }).resize({ width: 1600, quality: 'good' });
    const rel = `${ymd()}/${Date.now()}.jpg`;
    const file = path.join(shotsDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, img.toJPEG(70));
    b.screenshot = rel;
    // Teams get a small thumbnail uploaded for admins; the full-size image stays on this PC.
    if (cloud()) {
      const thumbRel = `thumbs/${rel}`;
      fs.mkdirSync(path.dirname(path.join(shotsDir, thumbRel)), { recursive: true });
      fs.writeFileSync(path.join(shotsDir, thumbRel), img.resize({ width: 480, quality: 'good' }).toJPEG(60));
      b.thumb = thumbRel;
    }
    // The block may have closed while we were capturing.
    const saved = S().blocks.find((x) => x.id === b.id);
    if (saved) { saved.screenshot = b.screenshot; saved.thumb = b.thumb; touch(saved); }
    if (!S().entries.some((x) => x.id === b.entryId && !x.deletedAt)) removeLocalShots(b);
    notify('Screenshot captured', projectLabel(entry.projectId), true);
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
  else win.loadFile(path.join(APP_ROOT, 'dist', 'index.html'));

  // Closing the window keeps tracking in the tray, like other desktop trackers.
  win.on('close', (ev) => {
    if (!quitting) {
      ev.preventDefault();
      win.hide();
      if (runningEntry()) notify('Still tracking', 'TimeTracker keeps running in the tray.', true);
    }
  });
}

// ---------- stores ----------
function recoverRunning() {
  // Recover from a crash or power loss: close the open entry at its last heartbeat.
  if (!S().running) return;
  const e = runningEntry();
  if (e) { e.end = Math.max(e.start + 1000, S().running.lastTick); touch(e); }
  S().running = null;
  store.saveNow();
}

function closeStore() {
  if (!store) return;
  if (S().running) stopTimer();
  store.saveNow();
  store = null;
}

function openLocal() {
  store = new Store(path.join(userData, 'timetracker.json'));
  recoverRunning();
  commit();
}

// ---------- cloud: auth + teams ----------
let syncTimer = null;
let syncing = null;

function scheduleSync(delay = 2000) {
  if (!cloud() || !store) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

// Push local changes, then pull the team, clients/projects/invoices and changed time.
function syncNow() {
  if (!cloud() || !store || !account.teamId || !sb) return Promise.resolve();
  if (syncing) return syncing;
  const st = store;
  const ctx = { teamId: account.teamId, userId: me(), shotsDir, runningId: st.data.running?.entryId };
  syncing = (async () => {
    account.sync.syncing = true;
    broadcast();
    try {
      await cloudLib.push(sb, st.data, ctx, { onRejected: (msg) => toast(`Not synced: ${msg}`, 'error') });
      const info = await cloudLib.pullTeam(sb, st.data, ctx);
      if (info.removed) {
        if (st === store) await leftTeam('You no longer have access to this team.');
        return;
      }
      if (st === store) {
        Object.assign(account, { role: info.role, members: info.members, invites: info.invites });
        const t = account.teams.find((x) => x.id === info.team.id);
        if (t) Object.assign(t, { name: info.team.name, role: info.role });
      }
      await cloudLib.pullTime(sb, st.data, ctx, { removeLocalShots });
      account.sync = { online: true, syncing: false, lastSyncAt: Date.now(), error: null };
    } catch (err) {
      const offline = err instanceof cloudLib.OfflineError || cloudLib.isNetwork(err);
      account.sync = { ...account.sync, online: !offline, error: offline ? null : err.message };
      if (!offline) console.warn('sync failed', err);
    } finally {
      account.sync.syncing = false;
      st.save();
      syncing = null;
      if (st === store) commit();
    }
  })();
  return syncing;
}

async function refreshTeams() {
  const rows = cloudLib.must(await sb.from('team_members').select('role, teams(id, name)').eq('user_id', me()));
  account.teams = rows.filter((r) => r.teams).map((r) => ({ id: r.teams.id, name: r.teams.name, role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  prefs.teams[me()] = account.teams;
  savePrefs();
}

function openTeam(teamId) {
  closeStore();
  const t = account.teams.find((x) => x.id === teamId);
  if (!t) throw new Error('Team not found.');
  Object.assign(account, { teamId, role: t.role, members: [], invites: [] });
  store = new Store(path.join(userData, 'accounts', me(), `${teamId}.json`));
  recoverRunning();
  prefs.lastTeam[me()] = teamId;
  savePrefs();
  commit();
  syncNow();
}

async function leftTeam(message) {
  if (message) toast(message, 'error');
  closeStore();
  account.teamId = null;
  try { await refreshTeams(); } catch {}
  if (account.teams[0]) openTeam(account.teams[0].id);
  else commit();
}

async function afterSignIn(user, { offline = false } = {}) {
  account.user = { id: user.id, email: user.email, name: user.user_metadata?.full_name || '' };
  account.teams = prefs.teams[user.id] || [];
  if (!offline) {
    try {
      cloudLib.must(await sb.rpc('accept_invites'));
      await refreshTeams();
    } catch (err) {
      if (!(err instanceof cloudLib.OfflineError)) toast(err.message, 'error');
    }
  }
  const last = prefs.lastTeam[user.id];
  const pick = account.teams.find((t) => t.id === last) || account.teams[0];
  if (pick) openTeam(pick.id);
  else commit();
}

function afterSignOut() {
  closeStore();
  Object.assign(account, { user: null, teams: [], teamId: null, role: 'member', members: [], invites: [] });
  commit();
}

// Signed-in user from the saved session, even when the token cannot be refreshed offline.
function storedUser() {
  try {
    const ref = new URL(cloudLib.loadConfig(APP_ROOT).url).hostname.split('.')[0];
    const file = path.join(userData, 'session.json');
    const { safeStorage } = require('electron');
    const buf = fs.readFileSync(file);
    const obj = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
    const tok = obj[`sb-${ref}-auth-token`];
    return (typeof tok === 'string' ? JSON.parse(tok) : tok)?.user || null;
  } catch {
    return null;
  }
}

async function initAccount() {
  const config = cloudLib.loadConfig(APP_ROOT);
  if (!config) {
    account.mode = 'local';
    openLocal();
    return;
  }
  account.mode = 'cloud';
  sb = cloudLib.connect(config, path.join(userData, 'session.json'));
  sb.auth.onAuthStateChange((event) => {
    // Supabase calls must not run inside this callback.
    if (event === 'SIGNED_OUT' && account.user) setTimeout(afterSignOut, 0);
  });
  const { data, error } = await sb.auth.getSession();
  if (data?.session) return afterSignIn(data.session.user);
  const offlineUser = error && cloudLib.isNetwork(error) ? storedUser() : null;
  if (offlineUser) return afterSignIn(offlineUser, { offline: true });
  commit();
}

function requireCloudAdmin() {
  if (!store) throw new Error('Open a team first.');
  if (!isAdmin()) throw new Error('Only team admins can do that.');
}

// ---------- invoices ----------
function createInvoiceLocal({ clientId, from, to, notes }) {
  const client = S().clients.find((c) => c.id === clientId);
  if (!client) throw new Error('Pick a client.');
  const projectIds = new Set(S().projects.filter((p) => p.clientId === clientId).map((p) => p.id));
  const entries = live(S().entries).filter(
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

async function createInvoiceCloud({ clientId, from, to, notes }) {
  requireCloudAdmin();
  await syncNow(); // make sure everyone's latest local edits on this device are on the server
  const inv = cloudLib.must(await sb.rpc('create_invoice', {
    p_team: account.teamId, p_client: clientId, p_from: cloudLib.iso(from), p_to: cloudLib.iso(to), p_notes: notes || '',
  }));
  await syncNow();
  return { id: inv.id, number: inv.number };
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
  handle('state:get', () => viewState());
  handle('app:paths', () => ({ data: store?.file || '', screenshots: shotsDir }));

  // --- account ---
  handle('auth:signIn', async ({ email, password }) => {
    const data = cloudLib.must(await sb.auth.signInWithPassword({ email: String(email).trim(), password }));
    await afterSignIn(data.user);
  });
  handle('auth:signUp', async ({ name, email, password }) => {
    if (!String(name || '').trim()) throw new Error('Enter your name.');
    const data = cloudLib.must(await sb.auth.signUp({
      email: String(email).trim(), password, options: { data: { full_name: String(name).trim() } },
    }));
    if (!data.session) return { confirm: true }; // email confirmation is on
    await afterSignIn(data.user);
    return { confirm: false };
  });
  handle('auth:signOut', async () => {
    if (store && S().running) stopTimer();
    await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 8000))]);
    closeStore();
    try { await sb.auth.signOut({ scope: 'local' }); } catch {}
    afterSignOut();
  });
  handle('auth:resetPassword', async (email) => {
    cloudLib.must(await sb.auth.resetPasswordForEmail(String(email).trim()));
  });

  handle('team:create', async (name) => {
    const t = cloudLib.must(await sb.rpc('create_team', { p_name: String(name || '').trim() }));
    await refreshTeams();
    openTeam(t.id);
  });
  handle('team:switch', (teamId) => openTeam(teamId));
  handle('team:refresh', async () => {
    cloudLib.must(await sb.rpc('accept_invites'));
    await refreshTeams();
    if (!store && account.teams[0]) openTeam(account.teams[0].id);
    else { commit(); await syncNow(); }
  });
  handle('team:invite', async ({ email, role }) => {
    requireCloudAdmin();
    cloudLib.must(await sb.rpc('invite_member', { p_team: account.teamId, p_email: email, p_role: role || 'member' }));
    await syncNow();
  });
  handle('team:revokeInvite', async (id) => {
    requireCloudAdmin();
    cloudLib.must(await sb.rpc('revoke_invite', { p_invite: id }));
    await syncNow();
  });
  handle('team:setRole', async ({ userId, role }) => {
    requireCloudAdmin();
    cloudLib.must(await sb.rpc('set_member_role', { p_team: account.teamId, p_user: userId, p_role: role }));
    await syncNow();
  });
  handle('team:removeMember', async (userId) => {
    cloudLib.must(await sb.rpc('remove_member', { p_team: account.teamId, p_user: userId }));
    if (userId === me()) await leftTeam();
    else await syncNow();
  });
  handle('team:rename', async (name) => {
    requireCloudAdmin();
    cloudLib.must(await sb.from('teams').update({ name: String(name || '').trim() }).eq('id', account.teamId));
    await refreshTeams();
    await syncNow();
  });
  handle('sync:now', () => syncNow());

  // --- tracking ---
  handle('timer:start', (projectId, task) => startTimer(projectId, task));
  handle('timer:stop', () => stopTimer());
  handle('idle:resolve', (action) => resolveIdle(action));

  // --- clients / projects (admins; online in cloud mode) ---
  handle('client:save', async (c) => {
    const rec = { name: String(c.name || '').trim(), email: c.email || '', address: c.address || '', rate: Number(c.rate) || 0 };
    if (!rec.name) throw new Error('Client name is required.');
    if (cloud()) {
      requireCloudAdmin();
      const id = c.id || uid();
      if (c.id) cloudLib.must(await sb.from('clients').update(rec).eq('id', id));
      else cloudLib.must(await sb.from('clients').insert({ ...rec, id, team_id: account.teamId }));
      await syncNow();
      return { id, ...rec };
    }
    const full = { id: c.id || uid(), ...rec };
    const i = S().clients.findIndex((x) => x.id === full.id);
    i >= 0 ? (S().clients[i] = full) : S().clients.push(full);
    commit();
    return full;
  });
  handle('client:delete', async (id) => {
    const pids = S().projects.filter((p) => p.clientId === id).map((p) => p.id);
    if (live(S().entries).some((e) => pids.includes(e.projectId)))
      throw new Error('This client has tracked time. Archive its projects instead.');
    if (cloud()) {
      requireCloudAdmin();
      const now = cloudLib.iso(Date.now());
      cloudLib.must(await sb.from('projects').update({ deleted_at: now }).eq('client_id', id));
      cloudLib.must(await sb.from('clients').update({ deleted_at: now }).eq('id', id));
      await syncNow();
      return;
    }
    S().projects = S().projects.filter((p) => p.clientId !== id);
    S().clients = S().clients.filter((c) => c.id !== id);
    commit();
  });

  handle('project:save', async (p) => {
    const rec = {
      clientId: p.clientId,
      name: String(p.name || '').trim(),
      rate: p.rate === '' || p.rate == null ? null : Number(p.rate),
      archived: !!p.archived,
    };
    if (!rec.name) throw new Error('Project name is required.');
    if (!S().clients.some((c) => c.id === rec.clientId)) throw new Error('Pick a client.');
    if (rec.archived && runningEntry()?.projectId === p.id) stopTimer();
    if (cloud()) {
      requireCloudAdmin();
      const row = { client_id: rec.clientId, name: rec.name, rate: rec.rate, archived: rec.archived };
      const id = p.id || uid();
      if (p.id) cloudLib.must(await sb.from('projects').update(row).eq('id', id));
      else cloudLib.must(await sb.from('projects').insert({ ...row, id, team_id: account.teamId }));
      await syncNow();
      return { id, ...rec };
    }
    const full = { id: p.id || uid(), ...rec };
    const i = S().projects.findIndex((x) => x.id === full.id);
    i >= 0 ? (S().projects[i] = full) : S().projects.push(full);
    commit();
    return full;
  });
  handle('project:delete', async (id) => {
    if (live(S().entries).some((e) => e.projectId === id)) throw new Error('This project has tracked time. Archive it instead.');
    if (cloud()) {
      requireCloudAdmin();
      cloudLib.must(await sb.from('projects').update({ deleted_at: cloudLib.iso(Date.now()) }).eq('id', id));
      await syncNow();
      return;
    }
    S().projects = S().projects.filter((p) => p.id !== id);
    commit();
  });

  // --- time entries (offline first) ---
  handle('entry:save', (e) => {
    const start = Number(e.start), end = Number(e.end);
    if (!S().projects.some((p) => p.id === e.projectId)) throw new Error('Pick a project.');
    if (!(end > start)) throw new Error('End must be after start.');
    if (end > Date.now() + 60000) throw new Error('Time cannot end in the future.');
    const existing = live(S().entries).find((x) => x.id === e.id);
    if (existing) {
      if (!mine(existing) && !isAdmin()) throw new Error("You can only edit your own time.");
      if (existing.invoiceId) throw new Error('This time is on an invoice. Delete the invoice to edit it.');
      if (S().running?.entryId === existing.id) throw new Error('Stop the timer before editing this entry.');
      Object.assign(existing, { projectId: e.projectId, task: e.task || '', start, end });
      touch(existing);
      for (const b of live(S().blocks)) if (b.entryId === existing.id && (b.end <= start || b.start >= end)) dropBlock(b);
    } else {
      const rec = { id: uid(), userId: me(), projectId: e.projectId, task: e.task || '', start, end, manual: true, invoiceId: null };
      S().entries.push(rec);
      touch(rec);
    }
    commit();
  });
  handle('entry:delete', (id) => {
    const e = live(S().entries).find((x) => x.id === id);
    if (!e) return;
    if (!mine(e) && !isAdmin()) throw new Error('You can only delete your own time.');
    if (e.invoiceId) throw new Error('This time is on an invoice. Delete the invoice first.');
    if (S().running?.entryId === id) stopTimer();
    dropEntry(e);
    commit();
  });

  // --- settings (team-wide in cloud mode) ---
  handle('settings:save', async (patch) => {
    if (cloud()) {
      requireCloudAdmin();
      cloudLib.must(await sb.from('teams').update(cloudLib.teamFromSettings({ ...S().settings, ...patch })).eq('id', account.teamId));
      await syncNow();
      return;
    }
    Object.assign(S().settings, patch);
    commit();
  });

  // --- invoices ---
  handle('invoice:create', (args) => (cloud() ? createInvoiceCloud(args) : createInvoiceLocal(args)));
  handle('invoice:delete', async (id) => {
    if (cloud()) {
      requireCloudAdmin();
      cloudLib.must(await sb.rpc('delete_invoice', { p_invoice: id }));
      await syncNow();
      return;
    }
    for (const e of S().entries) if (e.invoiceId === id) e.invoiceId = null;
    S().invoices = S().invoices.filter((i) => i.id !== id);
    commit();
  });
  handle('invoice:pdf', (id) => invoicePdf(id));

  // --- screenshots / files ---
  handle('shot:delete', (blockId) => {
    const b = live(S().blocks).find((x) => x.id === blockId);
    if (!b) return;
    if (!mine(b) && !isAdmin()) throw new Error('You can only delete your own screenshots.');
    removeLocalShots(b);
    b.screenshot = b.thumb = null;
    if (b.remoteShot) { S().sync.pendingRemoteDeletes.push(b.remoteShot); b.remoteShot = null; }
    touch(b);
    commit();
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

app.whenReady().then(async () => {
  ensureDevShortcut();
  userData = app.getPath('userData');
  shotsDir = path.join(userData, 'screenshots');
  loadPrefs();

  // tt-shot://shots/<day>/<file>.jpg serves this PC's screenshots;
  // tt-shot://shots/remote/<team>/<user>/<day>/<block>.jpg fetches a teammate's thumbnail (admins).
  protocol.handle('tt-shot', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    try {
      if (rel.startsWith('remote/')) {
        if (!sb) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(await cloudLib.cachedShot(sb, shotsDir, rel.slice(7))).toString());
      }
      const file = path.resolve(shotsDir, rel);
      if (!file.startsWith(shotsDir + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  createWindow();
  tray = new Tray(ICON_OFF());
  tray.on('click', showWindow);
  await initAccount();
  updateTray();
  setInterval(() => syncNow(), SYNC_EVERY_MS);

  // Locking or sleeping counts as going idle; ask about it on return.
  const away = () => {
    if (runningEntry() && !idle) idle = { since: Date.now(), prompted: false };
  };
  powerMonitor.on('lock-screen', away);
  powerMonitor.on('suspend', away);
  powerMonitor.on('resume', () => scheduleSync(5000));
  powerMonitor.on('unlock-screen', () => scheduleSync(2000));
});

app.on('before-quit', () => {
  quitting = true;
  if (store) {
    if (S().running) stopTimer();
    store.saveNow();
  }
});
app.on('window-all-closed', () => {}); // stay alive in the tray
