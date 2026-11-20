// Supabase connection, record mapping and offline-first sync.
//
// Time entries and activity blocks live in the local store first and carry `dirty`/`rev` flags until
// pushed. Clients, projects, invoices and team settings are pulled from the server (admins edit them
// online). Deletes are soft (`deletedAt`) so they reach every device.
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { createClient } = require('@supabase/supabase-js');

// ---------- config + client ----------
function loadConfig(appRoot) {
  if (process.env.TT_LOCAL === '1') return null; // forced local mode (smoke test)
  if (process.env.TT_SUPABASE_URL && process.env.TT_SUPABASE_ANON_KEY)
    return { url: process.env.TT_SUPABASE_URL, key: process.env.TT_SUPABASE_ANON_KEY };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(appRoot, 'app-config.json'), 'utf8'));
    if (c.supabaseUrl && c.supabaseAnonKey) return { url: c.supabaseUrl.replace(/\/+$/, ''), key: c.supabaseAnonKey };
  } catch {}
  return null;
}

// Session tokens are kept encrypted with the OS keychain (DPAPI on Windows) when available.
function sessionStorage(file) {
  const enc = () => safeStorage.isEncryptionAvailable();
  const read = () => {
    try {
      const buf = fs.readFileSync(file);
      return JSON.parse(enc() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
    } catch {
      return {};
    }
  };
  const write = (obj) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const txt = JSON.stringify(obj);
    fs.writeFileSync(file, enc() ? safeStorage.encryptString(txt) : txt);
  };
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => { const o = read(); o[k] = v; write(o); },
    removeItem: (k) => { const o = read(); delete o[k]; write(o); },
  };
}

function connect(config, sessionFile) {
  return createClient(config.url, config.key, {
    auth: { storage: sessionStorage(sessionFile), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

// ---------- errors ----------
class OfflineError extends Error {}
// PostgREST/Postgres errors carry a code; fetch failures do not.
const isNetwork = (err) => !!err && !err.code && !err.statusCode && /fetch|network|ENOTFOUND|ECONN|timeout|socket/i.test(String(err.message || err));
function must(res) {
  if (res.error) {
    if (isNetwork(res.error)) throw new OfflineError("You're offline. Try again when you're connected.");
    throw new Error(res.error.message || String(res.error));
  }
  return res.data;
}

// ---------- mapping ----------
const ms = (t) => (t ? Date.parse(t) : null);
const iso = (m) => (m == null ? null : new Date(m).toISOString());
const num = (v) => (v == null ? null : Number(v));

const toClient = (r) => ({ id: r.id, name: r.name, email: r.email, address: r.address, rate: Number(r.rate) });
const toProject = (r) => ({ id: r.id, clientId: r.client_id, name: r.name, rate: num(r.rate), archived: r.archived });
const toInvoice = (r) => ({
  id: r.id,
  number: r.number,
  clientId: r.client_id,
  from: ms(r.period_from),
  to: ms(r.period_to),
  lines: (r.lines || []).map((l) => ({ ...l, hours: Number(l.hours), rate: Number(l.rate), amount: Number(l.amount) })),
  total: Number(r.total),
  notes: r.notes,
  createdAt: ms(r.created_at),
  dueAt: ms(r.due_at),
});
const toEntry = (r) => ({
  id: r.id, userId: r.user_id, projectId: r.project_id, task: r.task, start: ms(r.started_at), end: ms(r.ended_at),
  manual: r.manual, invoiceId: r.invoice_id,
});
const toBlock = (r) => ({
  id: r.id, entryId: r.entry_id, userId: r.user_id, start: ms(r.started_at), end: ms(r.ended_at),
  activity: r.activity, remoteShot: r.screenshot_path,
});
const settingsFromTeam = (t) => ({
  idleMinutes: Number(t.idle_minutes),
  screenshotsEnabled: t.screenshots_enabled,
  blurScreenshots: t.blur_screenshots,
  currency: t.currency,
  businessName: t.business_name,
  businessDetails: t.business_details,
  invoiceDueDays: t.invoice_due_days,
});
const teamFromSettings = (s) => ({
  idle_minutes: Math.max(0, Number(s.idleMinutes) || 0),
  screenshots_enabled: !!s.screenshotsEnabled,
  blur_screenshots: !!s.blurScreenshots,
  currency: String(s.currency || 'USD').toUpperCase().slice(0, 3),
  business_name: s.businessName || '',
  business_details: s.businessDetails || '',
  invoice_due_days: Math.max(0, Math.round(Number(s.invoiceDueDays) || 0)),
});

const entryRow = (e, ctx) => ({
  id: e.id,
  team_id: ctx.teamId,
  user_id: e.userId || ctx.userId,
  project_id: e.projectId,
  task: e.task || '',
  started_at: iso(e.start),
  ended_at: e.end != null && e.end > e.start ? iso(e.end) : null,
  manual: !!e.manual,
  deleted_at: iso(e.deletedAt),
});
const blockRow = (b, ctx) => ({
  id: b.id,
  team_id: ctx.teamId,
  user_id: b.userId || ctx.userId,
  entry_id: b.entryId,
  started_at: iso(b.start),
  ended_at: iso(Math.max(b.start, b.end)),
  activity: b.activity,
  screenshot_path: b.remoteShot || null,
  deleted_at: iso(b.deletedAt),
});

const SHOT_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.jpg$/;
const shotPath = (ctx, b) => {
  const d = new Date(b.start);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ctx.teamId}/${b.userId || ctx.userId}/${day}/${b.id}.jpg`;
};

// ---------- push ----------
// Upserts dirty records. A record edited while its push is in flight keeps its newer `rev` and stays dirty.
async function upsertDirty(sb, table, records, toRow, ctx, onRejected) {
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200).map((r) => ({ r, rev: r.rev }));
    const res = await sb.from(table).upsert(batch.map(({ r }) => toRow(r, ctx)), { onConflict: 'id' });
    if (!res.error) {
      for (const { r, rev } of batch) if (r.rev === rev) r.dirty = false;
      continue;
    }
    if (isNetwork(res.error)) throw new OfflineError(res.error.message);
    // One bad row fails the batch: retry one by one so the good rows still sync.
    for (const { r, rev } of batch) {
      const one = await sb.from(table).upsert(toRow(r, ctx), { onConflict: 'id' });
      if (one.error && isNetwork(one.error)) throw new OfflineError(one.error.message);
      if (r.rev === rev) r.dirty = false;
      if (one.error) onRejected(r, one.error.message);
    }
  }
}

async function push(sb, data, ctx, hooks) {
  const rejected = [];
  const onRejected = (r, msg) => rejected.push({ r, msg });

  await upsertDirty(sb, 'time_entries', data.entries.filter((e) => e.dirty), entryRow, ctx, onRejected);

  // Upload screenshot thumbnails before the block rows that point at them.
  for (const b of data.blocks) {
    if (!b.dirty || b.deletedAt || b.remoteShot || !b.thumb || (b.userId && b.userId !== ctx.userId)) continue;
    const file = path.join(ctx.shotsDir, b.thumb);
    if (!fs.existsSync(file)) { b.thumb = null; continue; }
    const p = shotPath(ctx, b);
    const res = await sb.storage.from('screenshots').upload(p, fs.readFileSync(file), { contentType: 'image/jpeg', upsert: false });
    if (res.error && isNetwork(res.error)) throw new OfflineError(res.error.message);
    if (!res.error || /exist|duplicate/i.test(res.error.message)) b.remoteShot = p;
    else console.warn('screenshot upload failed', res.error.message);
  }

  await upsertDirty(sb, 'activity_blocks', data.blocks.filter((b) => b.dirty), blockRow, ctx, onRejected);

  const dels = data.sync.pendingRemoteDeletes;
  if (dels.length) {
    const res = await sb.storage.from('screenshots').remove(dels.slice(0, 100));
    if (res.error && isNetwork(res.error)) throw new OfflineError(res.error.message);
    data.sync.pendingRemoteDeletes = dels.slice(100);
  }

  // Pushed tombstones are no longer needed locally.
  data.entries = data.entries.filter((e) => !(e.deletedAt && !e.dirty));
  data.blocks = data.blocks.filter((b) => !(b.deletedAt && !b.dirty));

  // The server refused these (e.g. invoiced time edited offline): drop local copies so the next pull
  // restores the server's version.
  for (const { r, msg } of rejected) {
    hooks.onRejected?.(msg);
    data.entries = data.entries.filter((e) => e !== r);
    data.blocks = data.blocks.filter((b) => b !== r);
  }
  if (rejected.length) data.sync.entriesCursor = data.sync.blocksCursor = null;
}

// ---------- pull ----------
async function pageAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await query().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function pullTeam(sb, data, ctx) {
  const team = must(await sb.from('teams').select('*').eq('id', ctx.teamId).maybeSingle());
  if (!team) return { removed: true };
  const members = must(await sb.from('team_members').select('user_id, role, joined_at').eq('team_id', ctx.teamId));
  const me = members.find((m) => m.user_id === ctx.userId);
  if (!me) return { removed: true };
  const admin = me.role !== 'member';
  const profiles = must(await sb.from('profiles').select('id, email, full_name').in('id', members.map((m) => m.user_id)));
  const pmap = new Map(profiles.map((p) => [p.id, p]));

  data.settings = { ...data.settings, ...settingsFromTeam(team) };
  data.clients = must(await sb.from('clients').select('*').eq('team_id', ctx.teamId).is('deleted_at', null).order('name')).map(toClient);
  data.projects = must(await sb.from('projects').select('*').eq('team_id', ctx.teamId).is('deleted_at', null).order('name')).map(toProject);
  data.invoices = admin
    ? must(await sb.from('invoices').select('*').eq('team_id', ctx.teamId).order('created_at')).map(toInvoice)
    : [];
  const invites = admin ? must(await sb.from('team_invites').select('id, email, role, created_at').eq('team_id', ctx.teamId)) : [];

  return {
    team: { id: team.id, name: team.name },
    role: me.role,
    members: members
      .map((m) => ({ userId: m.user_id, role: m.role, name: pmap.get(m.user_id)?.full_name || '', email: pmap.get(m.user_id)?.email || '' }))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)),
    invites,
  };
}

// Fetch rows changed since the cursor (with a minute of overlap for in-flight transactions).
async function changedSince(sb, table, ctx, cursor) {
  const since = cursor ? new Date(Date.parse(cursor) - 60000).toISOString() : '1970-01-01T00:00:00Z';
  return pageAll(() => sb.from(table).select('*').eq('team_id', ctx.teamId).gt('updated_at', since).order('updated_at').order('id'));
}
const maxUpdated = (rows, cur) => rows.reduce((m, r) => (!m || r.updated_at > m ? r.updated_at : m), cur);

async function pullTime(sb, data, ctx, hooks) {
  const entries = await changedSince(sb, 'time_entries', ctx, data.sync.entriesCursor);
  const eIdx = new Map(data.entries.map((e) => [e.id, e]));
  const gone = new Set();
  for (const r of entries) {
    const local = eIdx.get(r.id);
    if ((local && local.dirty) || r.id === ctx.runningId) continue;
    if (r.deleted_at) {
      if (local) gone.add(r.id);
      continue;
    }
    if (local) Object.assign(local, toEntry(r));
    else data.entries.push(toEntry(r));
  }
  if (gone.size) {
    data.entries = data.entries.filter((e) => !gone.has(e.id));
    data.blocks = data.blocks.filter((b) => (gone.has(b.entryId) ? (hooks.removeLocalShots(b), false) : true));
  }
  data.sync.entriesCursor = maxUpdated(entries, data.sync.entriesCursor);

  const blocks = await changedSince(sb, 'activity_blocks', ctx, data.sync.blocksCursor);
  const bIdx = new Map(data.blocks.map((b) => [b.id, b]));
  const goneB = new Set();
  for (const r of blocks) {
    const local = bIdx.get(r.id);
    if (local && local.dirty) continue;
    if (r.deleted_at) {
      if (local) goneB.add(r.id);
      continue;
    }
    if (local) Object.assign(local, toBlock(r)); // keeps local screenshot/thumb paths
    else data.blocks.push(toBlock(r));
  }
  if (goneB.size) data.blocks = data.blocks.filter((b) => (goneB.has(b.id) ? (hooks.removeLocalShots(b), false) : true));
  data.sync.blocksCursor = maxUpdated(blocks, data.sync.blocksCursor);
}

// Downloads a teammate's screenshot thumbnail into the local cache and returns its file path.
async function cachedShot(sb, shotsDir, remotePath) {
  if (!SHOT_PATH.test(remotePath)) throw new Error('bad screenshot path');
  const file = path.join(shotsDir, 'remote', ...remotePath.split('/'));
  if (fs.existsSync(file)) return file;
  const { data, error } = await sb.storage.from('screenshots').download(remotePath);
  if (error) throw new Error(error.message || 'download failed');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  return file;
}

module.exports = {
  loadConfig, connect, must, isNetwork, OfflineError,
  push, pullTeam, pullTime, cachedShot,
  iso, toClient, toProject, teamFromSettings, SHOT_PATH,
};
