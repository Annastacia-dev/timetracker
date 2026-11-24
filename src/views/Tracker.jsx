import { useEffect, useState } from 'react';
import { Play, Square, RotateCcw } from 'lucide-react';
import { useNow } from '../hooks.js';
import {
  actClass, addDays, attempt, clock, duration, entryActivity, hm, hrs, inRange, isMine, lookup, money, startOfDay, startOfWeek,
} from '../lib.js';
import { ProjectSelect, ScreenshotsOff, ShotCard } from './shared.jsx';

export default function Tracker({ state, goto }) {
  const now = useNow();
  const L = lookup(state);
  const running = state.running && state.entries.find((e) => e.id === state.running.entryId);
  const active = state.projects.filter((p) => !p.archived);

  const myEntries = state.entries.filter((e) => isMine(state, e));
  const last = [...myEntries].reverse().find((e) => active.some((p) => p.id === e.projectId));
  const [projectId, setProjectId] = useState(running?.projectId || last?.projectId || active[0]?.id || '');
  const [task, setTask] = useState(running?.task || '');

  useEffect(() => {
    if (running) { setProjectId(running.projectId); setTask(running.task); }
  }, [running?.id]);
  useEffect(() => {
    if (!projectId && active[0]) setProjectId(active[0].id);
  }, [active.length]);

  const today = startOfDay(now);
  const week = startOfWeek(now);
  const todayEntries = inRange(state, today, addDays(today, 1), now).filter((e) => isMine(state, e));
  const weekEntries = inRange(state, week, addDays(week, 7), now).filter((e) => isMine(state, e));
  const sum = (list) => list.reduce((s, e) => s + e.ms, 0);
  const earn = (list) => list.reduce((s, e) => s + (e.ms / 3600000) * L.rate(e.projectId), 0);
  const todayBlocks = state.blocks.filter((b) => b.start >= today && isMine(state, b)).sort((a, b) => b.start - a.start).slice(0, 6);

  if (!state.clients.length || !active.length) {
    return (
      <div className="empty-hero">
        <h1>Track time for your clients</h1>
        {state.account.isAdmin ? (
          <>
            <p>Add a client and a project to start the timer.</p>
            <button className="primary" onClick={() => goto('clients')}>Add a client</button>
          </>
        ) : (
          <p>Your team admin hasn't added any projects yet. They'll appear here once they do.</p>
        )}
      </div>
    );
  }

  const toggle = () =>
    attempt(() => (running ? window.tt.stopTimer() : window.tt.startTimer(projectId, task)));

  return (
    <div className="page">
      <section className={`timer-card ${running ? 'running' : ''}`}>
        <div className="timer-fields">
          <ProjectSelect state={state} value={projectId} onChange={setProjectId} disabled={!!running} />
          <input
            className="task"
            placeholder="What are you working on?"
            value={task}
            disabled={!!running}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !running && toggle()}
          />
        </div>
        <div className="timer-clock">{clock(running ? now - running.start : 0)}</div>
        <button className={`big ${running ? 'stop' : 'start'}`} onClick={toggle} disabled={!projectId}>
          {running ? <><Square size={16} fill="currentColor" /> Stop</> : <><Play size={16} fill="currentColor" /> Start</>}
        </button>
      </section>
      {running && (
        <p className="muted small">
          Tracking {L.label(running.projectId)} since {hm(running.start)}.
          {state.settings.screenshotsEnabled ? ' Screenshots are on (one random capture per 10 minutes).' : ''}
          {Number(state.settings.idleMinutes) > 0 ? ` Idle check after ${state.settings.idleMinutes} min.` : ''}
        </p>
      )}

      <div className="stats">
        <Stat label="Today" value={hrs(sum(todayEntries))} sub={money(earn(todayEntries), state.settings.currency)} />
        <Stat label="This week" value={hrs(sum(weekEntries))} sub={money(earn(weekEntries), state.settings.currency)} />
        <Stat
          label="Unbilled (all time)"
          value={hrs(myEntries.filter((e) => e.end && !e.invoiceId).reduce((s, e) => s + duration(e), 0))}
          sub="ready to invoice"
        />
      </div>

      <h2>Today</h2>
      {todayEntries.length === 0 ? (
        <p className="muted">Nothing tracked yet today.</p>
      ) : (
        <table className="list">
          <tbody>
            {[...todayEntries].reverse().map((e) => {
              const act = entryActivity(state, e.id);
              return (
                <tr key={e.id}>
                  <td className="time">{hm(e.start)} – {e.end ? hm(e.end) : 'now'}</td>
                  <td>
                    <div>{L.label(e.projectId)}</div>
                    <div className="muted small">{e.task || '—'}</div>
                  </td>
                  <td>{e.manual ? <span className="tag">manual</span> : act != null && <span className={`tag ${actClass(act)}`}>{act}% activity</span>}</td>
                  <td className="num">{hrs(e.ms)}</td>
                  <td className="num">
                    {!running && !e.manual && L.project(e.projectId) && !L.project(e.projectId).archived && (
                      <button className="link" onClick={() => attempt(() => window.tt.startTimer(e.projectId, e.task))}>
                        <RotateCcw size={14} /> Resume
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {todayBlocks.length > 0 && (
        <>
          <h2 className="row between">
            Latest activity <button className="link" onClick={() => goto('screenshots')}>Open work diary</button>
          </h2>
          <ScreenshotsOff state={state} goto={goto} />
          <div className="shots">
            {todayBlocks.map((b) => <ShotCard key={b.id} block={b} state={state} />)}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="muted small">{sub}</div>
    </div>
  );
}
