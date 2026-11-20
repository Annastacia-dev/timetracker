import { useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { useNow } from '../hooks.js';
import {
  actClass, addDays, attempt, dayLabel, entryActivity, fromInputs, hm, hrs, inRange, isMine, lookup, memberName, ofUser, startOfDay, startOfWeek, ymd,
} from '../lib.js';
import { MemberSelect, ProjectSelect } from './shared.jsx';

export default function Timesheet({ state }) {
  const now = useNow(30000);
  const L = lookup(state);
  const [week, setWeek] = useState(startOfWeek(Date.now()));
  const [editing, setEditing] = useState(null); // entry, or {} for new
  const [who, setWho] = useState(state.account.me);
  const showWho = state.account.mode === 'cloud' && who !== state.account.me;
  const entries = inRange(state, week, addDays(week, 7), now).filter(ofUser(state, who));
  const total = entries.reduce((s, e) => s + e.ms, 0);

  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i)).reverse();

  return (
    <div className="page">
      <div className="row between">
        <h1>Timesheet</h1>
        <button className="primary" onClick={() => setEditing({})}><Plus size={16} /> Add manual time</button>
      </div>
      <div className="row gap center week-nav">
        <button onClick={() => setWeek(addDays(week, -7))}><ChevronLeft size={16} /></button>
        <strong>{dayLabel(week)} – {dayLabel(addDays(week, 6))}</strong>
        <button onClick={() => setWeek(addDays(week, 7))} disabled={week >= startOfWeek(now)}><ChevronRight size={16} /></button>
        {week !== startOfWeek(now) && <button className="link" onClick={() => setWeek(startOfWeek(now))}>This week</button>}
        <span className="spacer" />
        <MemberSelect state={state} value={who} onChange={setWho} />
        <span>Week total <strong>{hrs(total)}</strong></span>
      </div>

      {days.map((d) => {
        const list = entries.filter((e) => startOfDay(e.start) === d).sort((a, b) => b.start - a.start);
        if (!list.length) return null;
        return (
          <section key={d} className="day">
            <div className="day-head row between">
              <strong>{dayLabel(d)}</strong>
              <span>{hrs(list.reduce((s, e) => s + e.ms, 0))}</span>
            </div>
            <table className="list">
              <tbody>
                {list.map((e) => {
                  const act = entryActivity(state, e.id);
                  const isRunning = !e.end;
                  return (
                    <tr key={e.id}>
                      <td className="time">{hm(e.start)} – {e.end ? hm(e.end) : 'now'}</td>
                      <td>
                        <div>{L.label(e.projectId)}</div>
                        <div className="muted small">{showWho ? `${memberName(state, e.userId)} · ` : ''}{e.task || '—'}</div>
                      </td>
                      <td>
                        {e.manual && <span className="tag">manual</span>}
                        {!e.manual && act != null && <span className={`tag ${actClass(act)}`}>{act}%</span>}
                        {e.invoiceId && <span className="tag billed">invoiced</span>}
                        {isRunning && <span className="tag act-hi">running</span>}
                      </td>
                      <td className="num">{hrs(e.ms)}</td>
                      <td className="num actions">
                        {!isRunning && !e.invoiceId && (isMine(state, e) || state.account.isAdmin) && (
                          <>
                            <button className="link" onClick={() => setEditing(e)}><Pencil size={14} /> Edit</button>
                            <button
                              className="link danger"
                              onClick={() => confirm('Delete this time entry and its screenshots?') && attempt(() => window.tt.deleteEntry(e.id))}
                            >
                              <Trash2 size={14} /> Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
      {!entries.length && <p className="muted">No time tracked this week.</p>}

      {editing && <EntryDialog state={state} entry={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EntryDialog({ state, entry, onClose }) {
  const isNew = !entry.id;
  const base = entry.start ?? Date.now() - 3600000;
  const [f, setF] = useState({
    projectId: entry.projectId || state.projects.find((p) => !p.archived)?.id || '',
    task: entry.task || '',
    date: ymd(base),
    from: hm(base),
    to: hm(entry.end ?? Date.now()),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target?.value ?? e });

  const save = async () => {
    const start = fromInputs(f.date, f.from);
    let end = fromInputs(f.date, f.to);
    if (end <= start) end += 86400000; // crosses midnight
    const ok = await attempt(() => window.tt.saveEntry({ id: entry.id, projectId: f.projectId, task: f.task, start, end }).then(() => true));
    if (ok) onClose();
  };

  return (
    <div className="modal-back">
      <div className="modal">
        <h2>{isNew ? 'Add manual time' : 'Edit time entry'}</h2>
        {isNew && <p className="muted small">Manual time is labelled as such on reports, without activity or screenshots.</p>}
        <label>Project<ProjectSelect state={state} value={f.projectId} onChange={set('projectId')} /></label>
        <label>Task / memo<input value={f.task} onChange={set('task')} placeholder="What did you work on?" /></label>
        <div className="row gap">
          <label>Date<input type="date" value={f.date} onChange={set('date')} max={ymd(Date.now())} /></label>
          <label>From<input type="time" value={f.from} onChange={set('from')} /></label>
          <label>To<input type="time" value={f.to} onChange={set('to')} /></label>
        </div>
        <div className="row gap end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
