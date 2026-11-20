import logo from '../assets/logo.svg';

// Grey placeholder shapes shown while data is on its way, so an empty list never looks like lost data.
const Bar = ({ w = '100%', h = 12, style }) => <span className="sk" style={{ width: w, height: h, ...style }} />;

export function PageSkeleton({ label = 'Loading your team…' }) {
  return (
    <div className="page" aria-busy="true" aria-label={label}>
      <div className="row between sk-head">
        <Bar w={180} h={22} />
        <Bar w={110} h={32} />
      </div>
      <div className="sk-stats">
        {[0, 1, 2].map((i) => (
          <div className="card" key={i}><Bar w="40%" h={10} /><Bar w="65%" h={22} style={{ marginTop: 12 }} /></div>
        ))}
      </div>
      <div className="card">
        {[72, 58, 80, 46, 66].map((w, i) => (
          <div className="sk-row" key={i}>
            <Bar w={28} h={28} style={{ borderRadius: 8 }} />
            <div className="sk-lines"><Bar w={`${w}%`} /><Bar w={`${w / 2}%`} h={10} /></div>
            <Bar w={64} />
          </div>
        ))}
      </div>
      <p className="small dim sk-note">{label}</p>
    </div>
  );
}

export function AppSkeleton({ label }) {
  return (
    <div className="app">
      <aside className="nav">
        <div className="brand"><img src={logo} alt="" className="logo" /> TimeTracker</div>
        {[70, 82, 64, 76, 58].map((w, i) => <Bar key={i} w={`${w}%`} h={14} style={{ margin: '11px 12px' }} />)}
      </aside>
      <main className="content"><PageSkeleton label={label} /></main>
    </div>
  );
}
