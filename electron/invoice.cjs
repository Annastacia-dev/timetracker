// Renders an invoice as standalone HTML, printed to PDF by the main process.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const money = (n, currency) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
};

// Embed Geist so the PDF matches the app; falls back to system fonts if the file is missing.
let fontFace = '';
try {
  const file = require.resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2');
  const b64 = require('node:fs').readFileSync(file).toString('base64');
  fontFace = `@font-face{font-family:'Geist';font-weight:100 900;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
} catch {}

const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function invoiceHtml(inv, client, settings) {
  const cur = settings.currency;
  const rows = inv.lines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="n">${l.hours.toFixed(2)}</td>
      <td class="n">${money(l.rate, cur)}</td><td class="n">${money(l.amount, cur)}</td></tr>`
    )
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<style>
  ${fontFace}
  body{font-family:Geist,Segoe UI,Arial,sans-serif;color:#1d2433;margin:40px;font-size:13px}
  h1{font-size:28px;margin:0 0 4px;letter-spacing:.5px}
  .muted{color:#6b7385}.top{display:flex;justify-content:space-between;margin-bottom:32px}
  .box{white-space:pre-line}.meta td{padding:2px 12px 2px 0}
  table.lines{width:100%;border-collapse:collapse;margin-top:24px}
  .lines th{text-align:left;border-bottom:2px solid #1d2433;padding:8px 6px;font-size:12px;text-transform:uppercase}
  .lines td{border-bottom:1px solid #e3e6ec;padding:8px 6px}.n{text-align:right}
  .total td{font-weight:700;font-size:16px;border:none;padding-top:16px}
  .notes{margin-top:32px;white-space:pre-line}
</style></head><body>
<div class="top">
  <div><h1>INVOICE</h1><div class="muted">${esc(inv.number)}</div></div>
  <div class="box" style="text-align:right"><strong>${esc(settings.businessName || 'Your business')}</strong>
${esc(settings.businessDetails)}</div>
</div>
<div class="top">
  <div class="box"><div class="muted">Bill to</div><strong>${esc(client?.name)}</strong>
${esc(client?.address || '')}
${esc(client?.email || '')}</div>
  <table class="meta">
    <tr><td class="muted">Issued</td><td>${day(inv.createdAt)}</td></tr>
    <tr><td class="muted">Due</td><td>${day(inv.dueAt)}</td></tr>
    <tr><td class="muted">Period</td><td>${day(inv.from)} – ${day(inv.to - 1)}</td></tr>
  </table>
</div>
<table class="lines">
  <thead><tr><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr class="total"><td colspan="3" class="n">Total</td><td class="n">${money(inv.total, cur)}</td></tr></tfoot>
</table>
${inv.notes ? `<div class="notes"><div class="muted">Notes</div>${esc(inv.notes)}</div>` : ''}
</body></html>`;
}

module.exports = { invoiceHtml };
