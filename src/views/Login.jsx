import { useState } from 'react';
import { LogIn, RefreshCw, UserPlus, Users } from 'lucide-react';
import { attempt, toast } from '../lib.js';
import logo from '../assets/logo.svg';

export function Login() {
  const [mode, setMode] = useState('signin'); // signin | signup | reset
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    if (mode === 'signin') await attempt(() => window.tt.signIn(f));
    if (mode === 'signup') {
      if (f.password.length < 8) toast('Use at least 8 characters for your password.', 'error');
      else {
        const res = await attempt(() => window.tt.signUp(f));
        if (res?.confirm) {
          toast('Check your email and click the link. It opens TimeTracker and signs you in.');
          setMode('signin');
        }
      }
    }
    if (mode === 'reset') {
      const ok = await attempt(() => window.tt.resetPassword(f.email).then(() => true));
      if (ok) { toast('If that address has an account, a reset link is on its way.'); setMode('signin'); }
    }
    setBusy(false);
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <img src={logo} alt="" className="auth-logo" />
        <h1>{mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Sign in to TimeTracker'}</h1>
        {mode === 'signup' && <label>Your name<input autoFocus value={f.name} onChange={set('name')} required /></label>}
        <label>Email<input type="email" autoFocus={mode !== 'signup'} value={f.email} onChange={set('email')} required /></label>
        {mode !== 'reset' && (
          <label>Password
            <input type="password" value={f.password} onChange={set('password')} required minLength={mode === 'signup' ? 8 : undefined} />
          </label>
        )}
        <button className="primary wide" disabled={busy}>
          {mode === 'signup' ? <><UserPlus size={16} /> Create account</> : mode === 'reset' ? 'Send reset link' : <><LogIn size={16} /> Sign in</>}
        </button>
        <div className="auth-links">
          {mode === 'signin' ? (
            <>
              <button type="button" className="link" onClick={() => setMode('signup')}>Create an account</button>
              <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>
            </>
          ) : (
            <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>
          )}
        </div>
      </form>
    </div>
  );
}

export function NoTeam({ state }) {
  const [name, setName] = useState('');
  const { user } = state.account;
  return (
    <div className="auth-wrap">
      <div className="auth-card wide">
        <img src={logo} alt="" className="auth-logo" />
        <h1>Welcome{user.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
        <p className="muted">Join your team or start a new one.</p>
        <section className="card">
          <h2 className="flat row gap"><Users size={18} /> Joining a team?</h2>
          <p className="small">Ask your team admin to invite <strong>{user.email}</strong>, then:</p>
          <button onClick={() => attempt(() => window.tt.refreshTeams())}><RefreshCw size={16} /> Check for invites</button>
        </section>
        <section className="card">
          <h2 className="flat">Start a new team</h2>
          <p className="small muted">You'll be the owner: add clients and projects, invite people, see everyone's time.</p>
          <form className="row gap" onSubmit={(e) => { e.preventDefault(); attempt(() => window.tt.createTeam(name)); }}>
            <input placeholder="Team or company name" value={name} onChange={(e) => setName(e.target.value)} required />
            <button className="primary">Create team</button>
          </form>
        </section>
        <button className="link" onClick={() => attempt(() => window.tt.signOut())}>Sign out</button>
      </div>
    </div>
  );
}
