// JSON-file store kept in the app's userData folder. Writes are debounced and atomic.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  settings: {
    idleMinutes: 5,
    screenshotsEnabled: false,
    blurScreenshots: false,
    currency: 'USD',
    businessName: '',
    businessDetails: '',
    invoiceDueDays: 14,
  },
  clients: [], // { id, name, email, rate, address }
  projects: [], // { id, clientId, name, rate (null = client rate), archived }
  entries: [], // { id, projectId, task, start, end, manual, invoiceId }
  blocks: [], // { id, entryId, start, end, activity (0-100), screenshot (relative path) }
  invoices: [], // { id, number, clientId, from, to, lines, total, notes, createdAt, dueAt }
  running: null, // { entryId, lastTick }
  nextInvoiceNo: 1,
};

const uid = () => crypto.randomUUID();

class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt file: keep a copy instead of silently overwriting it.
        try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      }
    }
    this.data = {
      ...structuredClone(DEFAULTS),
      ...loaded,
      settings: { ...DEFAULTS.settings, ...(loaded.settings || {}) },
    };
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, uid };
