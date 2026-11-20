import { useState } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react';
import { attempt, duration, hrs, money } from '../lib.js';

export default function Clients({ state }) {
  const [editClient, setEditClient] = useState(null);
  const [editProject, setEditProject] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const cur = state.settings.currency;
  const tracked = (pid) => state.entries.filter((e) => e.projectId === pid).reduce((s, e) => s + duration(e), 0);

  return (
    <div className="page">
      <div className="row between">
        <h1>Clients & projects</h1>
        <div className="row gap">
          <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          <button className="primary" onClick={() => setEditClient({})}><Plus size={16} /> New client</button>
        </div>
      </div>
      {!state.clients.length && <p className="muted">No clients yet. Add one to start tracking.</p>}

      {state.clients.map((c) => {
        const projects = state.projects.filter((p) => p.clientId === c.id && (showArchived || !p.archived));
        return (
          <section key={c.id} className="card">
            <div className="row between">
              <div>
                <h2 className="flat">{c.name}</h2>
                <div className="muted small">{[c.email, `${money(c.rate, cur)}/h default`].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="row gap">
                <button className="link" onClick={() => setEditProject({ clientId: c.id })}><Plus size={14} /> Project</button>
                <button className="link" onClick={() => setEditClient(c)}><Pencil size={14} /> Edit</button>
                <button className="link danger" onClick={() => confirm(`Delete ${c.name}?`) && attempt(() => window.tt.deleteClient(c.id))}><Trash2 size={14} /> Delete</button>
              </div>
            </div>
            {projects.length > 0 && (
              <table className="list">
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} className={p.archived ? 'archived' : ''}>
                      <td>{p.name} {p.archived && <span className="tag">archived</span>}</td>
                      <td className="num">{p.rate != null ? `${money(p.rate, cur)}/h` : <span className="muted">client rate</span>}</td>
                      <td className="num">{hrs(tracked(p.id))} tracked</td>
                      <td className="num actions">
                        <button className="link" onClick={() => setEditProject(p)}><Pencil size={14} /> Edit</button>
                        <button className="link" onClick={() => attempt(() => window.tt.saveProject({ ...p, archived: !p.archived }))}>
                          {p.archived ? <><ArchiveRestore size={14} /> Restore</> : <><Archive size={14} /> Archive</>}
                        </button>
                        {!tracked(p.id) && (
                          <button className="link danger" onClick={() => attempt(() => window.tt.deleteProject(p.id))}><Trash2 size={14} /> Delete</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {editClient && <ClientDialog client={editClient} cur={cur} onClose={() => setEditClient(null)} />}
      {editProject && <ProjectDialog state={state} project={editProject} cur={cur} onClose={() => setEditProject(null)} />}
    </div>
  );
}

function ClientDialog({ client, cur, onClose }) {
  const [f, setF] = useState({ name: '', email: '', address: '', rate: '', ...client });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => (await attempt(() => window.tt.saveClient(f))) && onClose();
  return (
    <div className="modal-back">
      <div className="modal">
        <h2>{client.id ? 'Edit client' : 'New client'}</h2>
        <label>Name<input autoFocus value={f.name} onChange={set('name')} /></label>
        <label>Email<input type="email" value={f.email} onChange={set('email')} /></label>
        <label>Billing address<textarea rows={3} value={f.address} onChange={set('address')} /></label>
        <label>Default hourly rate ({cur})<input type="number" min="0" step="0.01" value={f.rate} onChange={set('rate')} /></label>
        <div className="row gap end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ProjectDialog({ state, project, cur, onClose }) {
  const [f, setF] = useState({ name: '', rate: '', archived: false, ...project, rate: project.rate ?? '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => (await attempt(() => window.tt.saveProject(f))) && onClose();
  return (
    <div className="modal-back">
      <div className="modal">
        <h2>{project.id ? 'Edit project' : 'New project'}</h2>
        <label>Client
          <select value={f.clientId} onChange={set('clientId')}>
            {state.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Project name<input autoFocus value={f.name} onChange={set('name')} /></label>
        <label>Hourly rate ({cur}) — leave empty to use the client rate
          <input type="number" min="0" step="0.01" value={f.rate} onChange={set('rate')} />
        </label>
        <div className="row gap end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
