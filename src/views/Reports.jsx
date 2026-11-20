import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import {
  addDays, addMonths, attempt, csvCell, dayLabel, decHours, entryActivity, hm, hrs, inRange, lookup, money,
  startOfDay, startOfMonth, startOfWeek, toast, ymd,
} from '../lib.js';
import { ClientSelect } from './shared.jsx';

function presetRange(key, now = Date.now()) {
  const w = startOfWeek(now), m = startOfMonth(now);
  switch (key) {
    case 'last-week': return [addDays(w, -7), w];
    case 'month': return [m, addMonths(m, 1)];
    case 'last-month': return [addMonths(m, -1), m];
    default: return [w, addDays(w, 7)];
  }
}

export default function Reports({ state }) {
  const L = lookup(state);
  const cur = state.settings.currency;
  const [preset, setPreset] = useState('week');
  const [custom, setCustom] = useState([ymd(startOfWeek(Date.now())), ymd(Date.now())]);
  const [clientId, setClientId] = useState('');

  const [from, to] =
    preset === 'custom'
      ? [startOfDay(new Date(`${custom[0]}T00:00`).getTime()), addDays(startOfDay(new Date(`${custom[1]}T00:00`).getTime()), 1)]
      : presetRange(preset);

  const entries = useMemo(
    () => inRange(state, from, to).filter((e) => !clientId || L.clientOf(e.projectId)?.id === clientId),
    [state, from, to, clientId]
  );

  // client -> project -> totals
  const tree = new Map();
  for (const e of entries) {
    const c = L.clientOf(e.projectId);
    const ck = c?.id || 'none';
    if (!tree.has(ck)) tree.set(ck, { name: c?.name || 'No client', ms: 0, amount: 0, projects: new Map() });
    const node = tree.get(ck);
    const amount = (e.ms / 3600000) * L.rate(e.projectId);
    node.ms += e.ms;
    node.amount += amount;
    const p = node.projects.get(e.projectId) || { name: L.project(e.projectId)?.name || 'Deleted project', ms: 0, amount: 0, manual: 0 };
    p.ms += e.ms;
    p.amount += amount;
    if (e.manual) p.manual += e.ms;
    node.projects.set(e.projectId, p);
  }
  const totalMs = entries.reduce((s, e) => s + e.ms, 0);
  const totalAmt = [...tree.values()].reduce((s, c) => s + c.amount, 0);

  const nDays = Math.round((to - from) / 86400000);
  const showGrid = nDays <= 7;
  const days = Array.from({ length: nDays }, (_, i) => addDays(from, i));

  const exportCsv = async () => {
    if (!entries.length) return toast('Nothing to export in this range.');
    const head = ['Date', 'Start', 'End', 'Client', 'Project', 'Task', 'Hours', 'Rate', 'Amount', 'Type', 'Activity %', 'Invoiced'];
    const rows = [...entries]
      .sort((a, b) => a.start - b.start)
      .map((e) => {
        const h = decHours(e.ms), rate = L.rate(e.projectId);
        return [
          ymd(e.start), hm(e.start), e.end ? hm(e.end) : '', L.clientOf(e.projectId)?.name || '',
          L.project(e.projectId)?.name || '', e.task, h.toFixed(2), rate.toFixed(2), (h * rate).toFixed(2),
          e.manual ? 'manual' : 'tracked', e.manual ? '' : entryActivity(state, e.id) ?? '',
          e.invoiceId ? state.invoices.find((i) => i.id === e.invoiceId)?.number || 'yes' : '',
        ];
      });
    const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    const saved = await attempt(() => window.tt.saveTextFile({ defaultName: `timesheet ${ymd(from)} to ${ymd(to - 1)}.csv`, content: csv }));
    if (saved) toast(`Saved ${saved}`);
  };

  return (
    <div className="page">
      <div className="row between">
        <h1>Reports</h1>
        <button onClick={exportCsv}><Download size={16} /> Export CSV</button>
      </div>
      <div className="row gap center filters">
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="week">This week</option>
          <option value="last-week">Last week</option>
          <option value="month">This month</option>
          <option value="last-month">Last month</option>
          <option value="custom">Custom range</option>
        </select>
        {preset === 'custom' && (
          <>
            <input type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} />
            <span>to</span>
            <input type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} />
          </>
        )}
        <ClientSelect state={state} value={clientId} onChange={setClientId} allowAll />
        <span className="spacer" />
        <span className="muted">{dayLabel(from)} – {dayLabel(to - 1)}</span>
      </div>

      <div className="stats">
        <div className="stat"><div className="muted small">Hours</div><div className="stat-value">{hrs(totalMs)}</div></div>
        <div className="stat"><div className="muted small">Earnings</div><div className="stat-value">{money(totalAmt, cur)}</div></div>
        <div className="stat"><div className="muted small">Entries</div><div className="stat-value">{entries.length}</div></div>
      </div>

      <h2>By client and project</h2>
      {!entries.length && <p className="muted">No time in this range.</p>}
      {entries.length > 0 && (
        <table className="list report">
          <thead><tr><th>Client / project</th><th className="num">Hours</th><th className="num">Manual</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {[...tree.values()].map((c) => (
              <ClientRows key={c.name} c={c} L={L} cur={cur} />
            ))}
          </tbody>
          <tfoot><tr><td>Total</td><td className="num">{hrs(totalMs)}</td><td /><td /><td className="num">{money(totalAmt, cur)}</td></tr></tfoot>
        </table>
      )}

      {showGrid && entries.length > 0 && (
        <>
          <h2>Daily breakdown</h2>
          <div className="grid-wrap">
            <table className="list grid">
              <thead>
                <tr><th>Project</th>{days.map((d) => <th key={d} className="num">{dayLabel(d)}</th>)}<th className="num">Total</th></tr>
              </thead>
              <tbody>
                {[...new Set(entries.map((e) => e.projectId))].map((pid) => {
                  const pe = entries.filter((e) => e.projectId === pid);
                  return (
                    <tr key={pid}>
                      <td>{L.label(pid)}</td>
                      {days.map((d) => {
                        const ms = pe.filter((e) => startOfDay(e.start) === d).reduce((s, e) => s + e.ms, 0);
                        return <td key={d} className="num">{ms ? hrs(ms) : <span className="muted">–</span>}</td>;
                      })}
                      <td className="num"><strong>{hrs(pe.reduce((s, e) => s + e.ms, 0))}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ClientRows({ c, L, cur }) {
  return (
    <>
      <tr className="group"><td>{c.name}</td><td className="num">{hrs(c.ms)}</td><td /><td /><td className="num">{money(c.amount, cur)}</td></tr>
      {[...c.projects].map(([pid, p]) => (
        <tr key={pid}>
          <td className="indent">{p.name}</td>
          <td className="num">{hrs(p.ms)}</td>
          <td className="num muted">{p.manual ? hrs(p.manual) : '–'}</td>
          <td className="num">{money(L.rate(pid), cur)}/h</td>
          <td className="num">{money(p.amount, cur)}</td>
        </tr>
      ))}
    </>
  );
}
