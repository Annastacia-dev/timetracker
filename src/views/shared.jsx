import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { actClass, attempt, hm, isMine, lookup, memberName } from '../lib.js';

export function ProjectSelect({ state, value, onChange, disabled, includeArchived = false, allowAll = false }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {allowAll && <option value="">All projects</option>}
      {!allowAll && !value && <option value="">Select a project…</option>}
      {state.clients.map((c) => {
        const ps = state.projects.filter((p) => p.clientId === c.id && (includeArchived || !p.archived || p.id === value));
        if (!ps.length) return null;
        return (
          <optgroup key={c.id} label={c.name}>
            {ps.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

export function ClientSelect({ state, value, onChange, allowAll = false }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowAll ? 'All clients' : 'Select a client…'}</option>
      {state.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

// Admin-only member picker; renders nothing for members or in local mode.
export function MemberSelect({ state, value, onChange, allowAll = true }) {
  const { account } = state;
  if (account.mode !== 'cloud' || !account.isAdmin || account.members.length < 2) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="member-select">
      {allowAll && <option value="">Everyone</option>}
      {account.members.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.userId === account.me ? `You (${m.name || m.email})` : m.name || m.email}
        </option>
      ))}
    </select>
  );
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
// This PC's full-size screenshot when present, otherwise the uploaded thumbnail (teammates' shots).
const shotSrc = (b) => (b.screenshot ? `tt-shot://shots/${enc(b.screenshot)}` : b.remoteShot ? `tt-shot://shots/remote/${enc(b.remoteShot)}` : null);


export function ShotCard({ block, state, showProject = true, showMember = false }) {
  const [open, setOpen] = useState(false);
  const L = lookup(state);
  const entry = state.entries.find((e) => e.id === block.entryId);
  const src = shotSrc(block);
  const canDelete = isMine(state, block) || state.account.isAdmin;
  return (
    <div className="shot">
      <div className="shot-img" onClick={() => src && setOpen(true)}>
        {src ? <img src={src} alt="" loading="lazy" /> : <span className="muted small">No screenshot</span>}
      </div>
      <div className="shot-meta">
        <div className="row between">
          <span className="small">{hm(block.start)} – {hm(block.end)}</span>
          <span className={`small ${actClass(block.activity)}-text`}>{block.activity}%</span>
        </div>
        <div className="act-bar"><div className={actClass(block.activity)} style={{ width: `${block.activity}%` }} /></div>
        {showMember && <div className="small ellipsis">{memberName(state, block.userId)}</div>}
        {showProject && entry && <div className="muted small ellipsis">{L.label(entry.projectId)}</div>}
      </div>
      {open && (
        <div className="modal-back" onClick={() => setOpen(false)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <img src={src} alt="" />
            <div className="row between">
              <span>
                {hm(block.start)} – {hm(block.end)} · {block.activity}% activity
                {entry ? ` · ${L.label(entry.projectId)}${entry.task ? ' — ' + entry.task : ''}` : ''}
              </span>
              <span className="row gap">
                {canDelete && <button
                  className="danger"
                  onClick={() => attempt(() => window.tt.deleteScreenshot(block.id)).then(() => setOpen(false))}
                >
                  <Trash2 size={14} /> Delete screenshot
                </button>}
                <button onClick={() => setOpen(false)}><X size={14} /> Close</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
