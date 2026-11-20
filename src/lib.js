// Shared formatting and calculation helpers for the renderer.
export const DAY = 86400000;

export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const hm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromInputs = (date, time) => new Date(`${date}T${time}`).getTime();

export function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 3600)}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}
export function hrs(ms) {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}
export const decHours = (ms) => Math.round((ms / 3600000) * 100) / 100;

export function money(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n || 0);
  } catch {
    return `${currency} ${(n || 0).toFixed(2)}`;
  }
}

export const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// Weeks start on Monday.
export const startOfWeek = (ms) => {
  const d = new Date(startOfDay(ms));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};
export const addDays = (ms, n) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
export const startOfMonth = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};
export const addMonths = (ms, n) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
};
export const dayLabel = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export const entryEnd = (e, now = Date.now()) => e.end ?? now;
export const duration = (e, now) => entryEnd(e, now) - e.start;

export function lookup(state) {
  const projects = new Map(state.projects.map((p) => [p.id, p]));
  const clients = new Map(state.clients.map((c) => [c.id, c]));
  const project = (id) => projects.get(id);
  const clientOf = (projectId) => clients.get(projects.get(projectId)?.clientId);
  const rate = (projectId) => {
    const p = projects.get(projectId);
    return Number(p?.rate ?? clients.get(p?.clientId)?.rate ?? 0) || 0;
  };
  const label = (projectId) => {
    const p = projects.get(projectId);
    const c = clients.get(p?.clientId);
    return p ? `${c ? c.name + ' · ' : ''}${p.name}` : 'Deleted project';
  };
  return { project, clientOf, rate, label, clients, projects };
}

// Average activity for an entry from its 10-minute blocks (time-weighted).
export function entryActivity(state, entryId) {
  let w = 0, sum = 0;
  for (const b of state.blocks) {
    if (b.entryId !== entryId) continue;
    const len = b.end - b.start;
    w += len;
    sum += b.activity * len;
  }
  return w ? Math.round(sum / w) : null;
}

export function inRange(state, from, to, now = Date.now()) {
  return state.entries.filter((e) => e.start >= from && e.start < to).map((e) => ({ ...e, ms: duration(e, now) }));
}

export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function actClass(pct) {
  if (pct == null) return '';
  if (pct >= 60) return 'act-hi';
  if (pct >= 30) return 'act-mid';
  return 'act-lo';
}

let notify = (msg) => console.warn(msg);
export const setNotifier = (fn) => { notify = fn; };
export const toast = (msg, kind = 'info') => notify(msg, kind);

// Runs an IPC call and shows its error message as a toast instead of throwing.
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  }
}
