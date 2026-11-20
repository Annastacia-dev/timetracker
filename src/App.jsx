import { useEffect, useState } from 'react';
import { attempt, clock, hm, setNotifier, toast } from './lib.js';
import { useNow } from './hooks.js';
import Tracker from './views/Tracker.jsx';
import Timesheet from './views/Timesheet.jsx';
import Reports from './views/Reports.jsx';
import Screenshots from './views/Screenshots.jsx';
import Clients from './views/Clients.jsx';
import Invoices from './views/Invoices.jsx';
import Settings from './views/Settings.jsx';
import Team from './views/Team.jsx';
import { Login, NoTeam } from './views/Login.jsx';
import { AppSkeleton, PageSkeleton } from './views/Skeleton.jsx';
import logo from './assets/logo.svg';
import {
  Briefcase, CalendarDays, ChartColumn, Cloud, CloudOff, FileText, Images, LogOut, Moon, RefreshCw,
  Settings as SettingsIcon, Timer, Users,
} from 'lucide-react';

// [key, label, view, icon, who sees it]
const TABS = [
  ['tracker', 'Tracker', Tracker, Timer, 'all'],
  ['timesheet', 'Timesheet', Timesheet, CalendarDays, 'all'],
  ['screenshots', 'Work diary', Screenshots, Images, 'all'],
  ['reports', 'Reports', Reports, ChartColumn, 'all'],
  ['invoices', 'Invoices', Invoices, FileText, 'admin'],
  ['clients', 'Clients & projects', Clients, Briefcase, 'admin'],
  ['team', 'Team', Team, Users, 'cloud'],
  ['settings', 'Settings', Settings, SettingsIcon, 'all'],
];

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('tracker');
  const [idle, setIdle] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    const push = (text, kind) => {
      const id = Math.random();
      setToasts((t) => [...t, { id, text, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    };
    setNotifier(push);
    window.tt.getState().then(setState);
    const offState = window.tt.onState(setState);
    const offIdle = window.tt.onIdle(setIdle);
    const offToast = window.tt.onToast(({ text, kind }) => push(text, kind));
    const offRecovery = window.tt.onRecovery(() => setRecovery(true));
    return () => { offState(); offIdle(); offToast(); offRecovery(); };
  }, []);

  const toastLayer = (
    <>
      {recovery && <NewPassword onDone={() => setRecovery(false)} />}
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </>
  );

  if (!state) return <AppSkeleton label="Starting…" />;
  const { account } = state;
  if (account.phase !== 'ready') return <><AppSkeleton label="Signing you in…" />{toastLayer}</>;
  if (account.mode === 'cloud' && !account.user) return <>{<Login />}{toastLayer}</>;
  if (account.mode === 'cloud' && !account.ready) return <><NoTeam state={state} />{toastLayer}</>;

  const visible = TABS.filter(([, , , , who]) =>
    who === 'all' || (who === 'admin' && account.isAdmin) || (who === 'cloud' && account.mode === 'cloud'));
  const current = visible.find(([k]) => k === tab) || visible[0];
  const View = current[2];
  const running = state.running && state.entries.find((e) => e.id === state.running.entryId);
  // A team that has never finished syncing on this PC would look empty; show placeholders until it has,
  // unless we're offline or sync failed (then show what we have, with the status in the sidebar).
  const firstSync = !account.loaded && account.sync.online && !account.sync.error;

  return (
    <div className="app">
      <aside className="nav">
        <div className="brand">
          <img src={logo} alt="" className="logo" /> TimeTracker
        </div>
        {account.mode === 'cloud' && <TeamSwitcher account={account} />}
        {visible.map(([key, label, , Icon]) => (
          <button key={key} className={`nav-item ${current[0] === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            <Icon size={17} strokeWidth={1.8} /> {label}
          </button>
        ))}
        <div className="nav-foot">
          {running && <NavTimer start={running.start} onClick={() => setTab('tracker')} />}
          {account.mode === 'cloud' && <AccountBox account={account} />}
        </div>
      </aside>
      <main className="content">
        {firstSync ? <PageSkeleton label="Syncing your team's clients, projects and time…" /> : <View state={state} goto={setTab} />}
      </main>
      {idle && <IdleDialog idle={idle} onDone={() => setIdle(null)} />}
      {toastLayer}
    </div>
  );
}

function TeamSwitcher({ account }) {
  if (account.teams.length < 2) {
    const t = account.teams.find((x) => x.id === account.teamId);
    return <div className="team-name ellipsis" title={t?.name}>{t?.name}</div>;
  }
  return (
    <select className="team-switch" value={account.teamId} onChange={(e) => attempt(() => window.tt.switchTeam(e.target.value))}>
      {account.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

function AccountBox({ account }) {
  const now = useNow(30000);
  const { sync, pending } = account;
  const ago = sync.lastSyncAt ? Math.round((now - sync.lastSyncAt) / 60000) : null;
  const status = !sync.online
    ? `Offline${pending ? ` · ${pending} to sync` : ''}`
    : sync.syncing
      ? 'Syncing…'
      : sync.error
        ? 'Sync problem'
        : pending
          ? `${pending} to sync`
          : ago == null ? 'Not synced yet' : ago < 1 ? 'Synced just now' : `Synced ${ago} min ago`;
  return (
    <div className="account-box">
      <div className="account-user">
        <div className="avatar">{(account.user.name || account.user.email)[0].toUpperCase()}</div>
        <div className="ellipsis">
          <div className="ellipsis">{account.user.name || account.user.email}</div>
          <div className="small dim">{account.role[0].toUpperCase() + account.role.slice(1)}</div>
        </div>
      </div>
      <div className="row between">
        <button className={`sync-status ${!sync.online || sync.error ? 'warn' : ''}`} title={sync.error || 'Sync now'} onClick={() => attempt(() => window.tt.syncNow())}>
          {sync.syncing ? <RefreshCw size={13} className="spin" /> : sync.online ? <Cloud size={13} /> : <CloudOff size={13} />} {status}
        </button>
        <button className="icon-btn" title="Sign out" onClick={() => attempt(() => window.tt.signOut())}><LogOut size={15} /></button>
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

// Opened by a password-reset email link; the link has already signed the user in.
function NewPassword({ onDone }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const ok = await attempt(() => window.tt.updatePassword(pw));
    setBusy(false);
    if (ok) { toast('Password updated.'); onDone(); }
  };
  return (
    <div className="modal-back">
      <form className="modal" onSubmit={save}>
        <h2>Choose a new password</h2>
        <label>New password
          <input type="password" autoFocus minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required />
        </label>
        <div className="row gap end">
          <button type="button" onClick={onDone}>Later</button>
          <button className="primary" disabled={busy}>Save password</button>
        </div>
      </form>
    </div>
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
