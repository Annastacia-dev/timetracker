import { useState } from 'react';
import { FileDown, Plus, Trash2 } from 'lucide-react';
import { addMonths, attempt, dayLabel, decHours, duration, lookup, money, startOfDay, startOfMonth, toast, ymd } from '../lib.js';
import { ClientSelect } from './shared.jsx';

export default function Invoices({ state }) {
  const L = lookup(state);
  const cur = state.settings.currency;
  const lastMonth = addMonths(startOfMonth(Date.now()), -1);
  const [clientId, setClientId] = useState(state.clients[0]?.id || '');
  const [from, setFrom] = useState(ymd(lastMonth));
  const [to, setTo] = useState(ymd(Date.now()));
  const [notes, setNotes] = useState('');

  const fromMs = startOfDay(new Date(`${from}T00:00`).getTime());
  const toMs = startOfDay(new Date(`${to}T00:00`).getTime()) + 86400000;

  const unbilled = state.entries.filter(
    (e) => e.end && !e.invoiceId && e.start >= fromMs && e.start < toMs && L.clientOf(e.projectId)?.id === clientId
  );
  const hours = unbilled.reduce((s, e) => s + duration(e), 0);
  const amount = unbilled.reduce((s, e) => s + decHours(duration(e)) * L.rate(e.projectId), 0);

  const create = async () => {
    const inv = await attempt(() => window.tt.createInvoice({ clientId, from: fromMs, to: toMs, notes }));
    if (inv) { toast(`${inv.number} created`); setNotes(''); }
  };

  const invoices = [...state.invoices].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="page">
      <h1>Invoices</h1>
      <section className="card">
        <h2 className="flat">New invoice from tracked time</h2>
        <div className="row gap wrap">
          <label>Client<ClientSelect state={state} value={clientId} onChange={setClientId} /></label>
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <label>Notes (payment details, thanks…)<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="row between center">
          <span>
            Unbilled: <strong>{decHours(hours).toFixed(2)} h</strong> · about <strong>{money(amount, cur)}</strong>
            <span className="muted small"> ({unbilled.length} entries)</span>
          </span>
          <button className="primary" disabled={!clientId || !unbilled.length} onClick={create}><Plus size={16} /> Create invoice</button>
        </div>
      </section>

      <h2>All invoices</h2>
      {!invoices.length && <p className="muted">No invoices yet.</p>}
      {invoices.length > 0 && (
        <table className="list">
          <thead><tr><th>Number</th><th>Client</th><th>Period</th><th>Issued</th><th className="num">Total</th><th /></tr></thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td><strong>{inv.number}</strong></td>
                <td>{L.clients.get(inv.clientId)?.name || '—'}</td>
                <td>{dayLabel(inv.from)} – {dayLabel(inv.to - 1)}</td>
                <td>{dayLabel(inv.createdAt)}</td>
                <td className="num">{money(inv.total, cur)}</td>
                <td className="num actions">
                  <button className="link" onClick={() => attempt(() => window.tt.invoicePdf(inv.id))}><FileDown size={14} /> Save PDF</button>
                  <button
                    className="link danger"
                    onClick={() => confirm(`Delete ${inv.number}? Its time becomes unbilled again.`) && attempt(() => window.tt.deleteInvoice(inv.id))}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
