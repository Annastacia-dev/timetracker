import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { attempt, toast } from '../lib.js';

export default function Settings({ state }) {
  const [f, setF] = useState(state.settings);
  const [paths, setPaths] = useState(null);
  useEffect(() => { window.tt.dataPaths().then(setPaths); }, []);
  useEffect(() => setF(state.settings), [state.settings]);

  const set = (k, v) => setF({ ...f, [k]: v });
  const save = async () => {
    const ok = await attempt(() => window.tt.saveSettings({
      ...f,
      idleMinutes: Math.max(0, Number(f.idleMinutes) || 0),
      invoiceDueDays: Math.max(0, Number(f.invoiceDueDays) || 0),
      currency: String(f.currency || 'USD').toUpperCase().slice(0, 3),
    }).then(() => true));
    if (ok) toast('Settings saved');
  };

  return (
    <div className="page narrow">
      <h1>Settings</h1>

      <section className="card">
        <h2 className="flat">Tracking</h2>
        <label>Idle detection — ask after this many minutes without input (0 = off)
          <input type="number" min="0" value={f.idleMinutes} onChange={(e) => set('idleMinutes', e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={f.screenshotsEnabled} onChange={(e) => set('screenshotsEnabled', e.target.checked)} />
          Take screenshots while the timer runs (one at a random moment in every 10-minute block)
        </label>
        <label className="check">
          <input type="checkbox" checked={f.blurScreenshots} disabled={!f.screenshotsEnabled} onChange={(e) => set('blurScreenshots', e.target.checked)} />
          Blur screenshots (shows roughly what is on screen without readable detail)
        </label>
        <p className="muted small">
          Screenshots capture your primary display and are stored only on this computer. A notification appears after
          each capture, and you can delete any screenshot from the work diary. Only enable this if everyone who uses this
          computer while tracking has agreed to it.
        </p>
      </section>

      <section className="card">
        <h2 className="flat">Invoicing</h2>
        <div className="row gap">
          <label>Currency (ISO code)<input value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value)} /></label>
          <label>Payment due (days)<input type="number" min="0" value={f.invoiceDueDays} onChange={(e) => set('invoiceDueDays', e.target.value)} /></label>
        </div>
        <label>Your business name<input value={f.businessName} onChange={(e) => set('businessName', e.target.value)} /></label>
        <label>Business details on invoices (address, tax ID, bank details)
          <textarea rows={4} value={f.businessDetails} onChange={(e) => set('businessDetails', e.target.value)} />
        </label>
      </section>

      <div className="row gap end"><button className="primary" onClick={save}>Save settings</button></div>

      <section className="card">
        <h2 className="flat">Data</h2>
        {paths && (
          <>
            <p className="small">Data file: <code>{paths.data}</code></p>
            <p className="small">Screenshots: <code>{paths.screenshots}</code></p>
          </>
        )}
        <button onClick={() => window.tt.openScreenshotsFolder()}><FolderOpen size={16} /> Open screenshots folder</button>
      </section>
    </div>
  );
}
