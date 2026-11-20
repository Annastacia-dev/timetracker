import { useState } from 'react';
import { LogOut, Mail, Pencil, Plus, UserMinus, X } from 'lucide-react';
import { attempt, dayLabel, duration, hrs, startOfWeek, toast } from '../lib.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' };

export default function Team({ state }) {
  const { account } = state;
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [renaming, setRenaming] = useState(null);
  const [newTeam, setNewTeam] = useState(null);
  const team = account.teams.find((t) => t.id === account.teamId);
  const admin = account.isAdmin;
  const owner = account.role === 'owner';
  const week = startOfWeek(Date.now());
  const weekMs = (userId) =>
    state.entries.filter((e) => e.userId === userId && e.start >= week).reduce((s, e) => s + duration(e), 0);

  const invite = async (e) => {
    e.preventDefault();
    const ok = await attempt(() => window.tt.inviteMember({ email, role }).then(() => true));
    if (ok) { toast(`Invited ${email}. They can sign up or sign in with that address to join.`); setEmail(''); }
  };

  return (
    <div className="page">
      <div className="row between">
        <h1 className="row gap">
          {team?.name}
          {admin && <button className="link" onClick={() => setRenaming(team?.name || '')}><Pencil size={14} /> Rename</button>}
        </h1>
        <button onClick={() => setNewTeam('')}><Plus size={16} /> New team</button>
      </div>

      <h2>Members</h2>
      <table className="list">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th>{admin && <th className="num">This week</th>}<th /></tr></thead>
        <tbody>
          {account.members.map((m) => {
            const self = m.userId === account.me;
            const canEdit = admin && !self && (owner || m.role !== 'owner');
            return (
              <tr key={m.userId}>
                <td>{m.name || '—'}{self && <span className="tag">you</span>}</td>
                <td className="muted">{m.email}</td>
                <td>
                  {canEdit ? (
                    <select value={m.role} onChange={(e) => attempt(() => window.tt.setMemberRole({ userId: m.userId, role: e.target.value }))}>
                      {owner && <option value="owner">Owner</option>}
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                    </select>
                  ) : ROLE_LABEL[m.role]}
                </td>
                {admin && <td className="num">{hrs(weekMs(m.userId))}</td>}
                <td className="num actions">
                  {canEdit && (
                    <button className="link danger" onClick={() => confirm(`Remove ${m.name || m.email} from the team? Their tracked time stays.`) && attempt(() => window.tt.removeMember(m.userId))}>
                      <UserMinus size={14} /> Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {admin && (
        <>
          <h2>Invite people</h2>
          <form className="card row gap" onSubmit={invite}>
            <input type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 140 }}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className="primary"><Mail size={16} /> Invite</button>
          </form>
          <p className="muted small">
            No email is sent. Tell them to install TimeTracker and sign up (or sign in) with this address; they join automatically.
          </p>
          {account.invites.length > 0 && (
            <table className="list">
              <thead><tr><th>Pending invite</th><th>Role</th><th>Sent</th><th /></tr></thead>
              <tbody>
                {account.invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{ROLE_LABEL[i.role]}</td>
                    <td className="muted">{dayLabel(Date.parse(i.created_at))}</td>
                    <td className="num actions">
                      <button className="link danger" onClick={() => attempt(() => window.tt.revokeInvite(i.id))}><X size={14} /> Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h2>Your access</h2>
      <section className="card">
        <p className="small">
          You are <strong>{ROLE_LABEL[account.role]}</strong> of this team.{' '}
          {admin
            ? 'You manage clients, projects, rates and invoices, and can see everyone’s time and screenshots.'
            : 'You track time on team projects. Only you and team admins can see your time and screenshots.'}
        </p>
        <button className="danger" onClick={() => confirm(`Leave ${team?.name}? You will lose access to its projects.`) && attempt(() => window.tt.removeMember(account.me))}>
          <LogOut size={16} /> Leave team
        </button>
      </section>

      {renaming != null && (
        <Prompt title="Rename team" value={renaming} onClose={() => setRenaming(null)}
          onSave={(v) => attempt(() => window.tt.renameTeam(v).then(() => setRenaming(null)))} />
      )}
      {newTeam != null && (
        <Prompt title="Create a new team" label="Team name" value={newTeam} onClose={() => setNewTeam(null)}
          onSave={(v) => attempt(() => window.tt.createTeam(v).then(() => setNewTeam(null)))} />
      )}
    </div>
  );
}

function Prompt({ title, label = 'Name', value, onSave, onClose }) {
  const [v, setV] = useState(value);
  return (
    <div className="modal-back">
      <form className="modal" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
        <h2>{title}</h2>
        <label>{label}<input autoFocus value={v} onChange={(e) => setV(e.target.value)} required /></label>
        <div className="row gap end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Save</button>
        </div>
      </form>
    </div>
  );
}

