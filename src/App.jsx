import { useEffect, useState } from 'react';
import { attempt, clock, hm, setNotifier } from './lib.js';
import { useNow } from './hooks.js';
import Tracker from './views/Tracker.jsx';
import Timesheet from './views/Timesheet.jsx';
import Reports from './views/Reports.jsx';
import Screenshots from './views/Screenshots.jsx';
import Clients from './views/Clients.jsx';
import Invoices from './views/Invoices.jsx';
import Settings from './views/Settings.jsx';
import logo from './assets/logo.svg';
import {
  CalendarDays, ChartColumn, FileText, Images, Moon, Settings as SettingsIcon, Timer, Users,
} from 'lucide-react';

const TABS = [
  ['tracker', 'Tracker', Tracker, Timer],
  ['timesheet', 'Timesheet', Timesheet, CalendarDays],
  ['screenshots', 'Work diary', Screenshots, Images],
  ['reports', 'Reports', Reports, ChartColumn],
  ['invoices', 'Invoices', Invoices, FileText],
  ['clients', 'Clients & projects', Clients, Users],
  ['settings', 'Settings', Settings, SettingsIcon],
];

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('tracker');
  const [idle, setIdle] = useState(null);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    setNotifier((text, kind) => {
      const id = Math.random();
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
    });
    window.tt.getState().then(setState);
    const offState = window.tt.onState(setState);
    const offIdle = window.tt.onIdle(setIdle);
    return () => { offState(); offIdle(); };
  }, []);

  if (!state) return <div className="loading">Loading…</div>;

  const running = state.running && state.entries.find((e) => e.id === state.running.entryId);
  const View = TABS.find(([k]) => k === tab)[2];

  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">
          <img src={logo} alt="" className="logo" /> TimeTracker
        </div>
        {TABS.map(([key, label, , Icon]) => (
          <button key={key} className={`nav-item ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={17} strokeWidth={1.8} /> {label}
          </button>
        ))}
        {running && <NavTimer start={running.start} onClick={() => setTab('tracker')} />}
      </aside>
      <main className="content">
        <View state={state} goto={setTab} />
      </main>
      {idle && <IdleDialog idle={idle} onDone={() => setIdle(null)} />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function NavTimer({ start, onClick }) {
  const now = useNow();
  return (
    <button className="nav-timer" onClick={onClick}>
      <span className="dot on" /> {clock(now - start)}
    </button>
  );
}

function IdleDialog({ idle, onDone }) {
  const minutes = Math.round((idle.now - idle.since) / 60000);
  const choose = async (action) => {
    await attempt(() => window.tt.resolveIdle(action));
    onDone();
  };
  return (
    <div className="modal-back">
      <div className="modal">
        <h2 className="row gap"><Moon size={20} /> You were idle</h2>
        <p>
          No keyboard or mouse activity since <strong>{hm(idle.since)}</strong> ({minutes} min).
          What should happen to that time?
        </p>
        <div className="row gap end">
          <button onClick={() => choose('keep')}>Keep idle time</button>
          <button onClick={() => choose('discard-stop')}>Discard and stop</button>
          <button className="primary" onClick={() => choose('discard-continue')}>Discard and keep tracking</button>
        </div>
      </div>
    </div>
  );
}
