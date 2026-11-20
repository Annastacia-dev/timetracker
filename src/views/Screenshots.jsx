import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, dayLabel, hrs, ofUser, startOfDay, ymd } from '../lib.js';
import { MemberSelect, ShotCard } from './shared.jsx';

// Work diary: one card per 10-minute block, grouped by hour.
export default function Screenshots({ state }) {
  const [day, setDay] = useState(startOfDay(Date.now()));
  const [who, setWho] = useState(state.account.me);
  const blocks = state.blocks
    .filter((b) => b.start >= day && b.start < addDays(day, 1))
    .filter(ofUser(state, who))
    .sort((a, b) => a.start - b.start);
  const tracked = blocks.reduce((s, b) => s + (b.end - b.start), 0);
  const avg = tracked ? Math.round(blocks.reduce((s, b) => s + b.activity * (b.end - b.start), 0) / tracked) : 0;

  const hours = new Map();
  for (const b of blocks) {
    const h = new Date(b.start).getHours();
    if (!hours.has(h)) hours.set(h, []);
    hours.get(h).push(b);
  }

  return (
    <div className="page">
      <h1>Work diary</h1>
      <div className="row gap center week-nav">
        <button onClick={() => setDay(addDays(day, -1))}><ChevronLeft size={16} /></button>
        <input type="date" value={ymd(day)} max={ymd(Date.now())} onChange={(e) => e.target.value && setDay(startOfDay(new Date(`${e.target.value}T00:00`).getTime()))} />
        <button onClick={() => setDay(addDays(day, 1))} disabled={day >= startOfDay(Date.now())}><ChevronRight size={16} /></button>
        <strong>{dayLabel(day)}</strong>
        <span className="spacer" />
        <MemberSelect state={state} value={who} onChange={setWho} />
        <span>Tracked <strong>{hrs(tracked)}</strong> · avg activity <strong>{avg}%</strong></span>
      </div>
      {!state.settings.screenshotsEnabled && (
        <p className="notice">Screenshots are off. Activity levels are still recorded. Turn screenshots on in Settings.</p>
      )}
      {!blocks.length && <p className="muted">No tracked activity on this day.</p>}
      {[...hours].map(([h, list]) => (
        <section key={h} className="hour">
          <div className="hour-label">{String(h).padStart(2, '0')}:00</div>
          <div className="shots">
            {list.map((b) => <ShotCard key={b.id} block={b} state={state} showMember={who === ''} />)}
          </div>
        </section>
      ))}
      <p className="muted small">
        Activity = share of minutes in each 10-minute block with keyboard or mouse input. Manual time has no activity.
      </p>
    </div>
  );
}
