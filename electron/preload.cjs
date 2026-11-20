const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('tt', {
  getState: call('state:get'),
  onState: on('state:changed'),
  onIdle: on('idle:detected'),
  onToast: on('toast'),

  signIn: call('auth:signIn'),
  signUp: call('auth:signUp'),
  signOut: call('auth:signOut'),
  resetPassword: call('auth:resetPassword'),
  createTeam: call('team:create'),
  switchTeam: call('team:switch'),
  refreshTeams: call('team:refresh'),
  renameTeam: call('team:rename'),
  inviteMember: call('team:invite'),
  revokeInvite: call('team:revokeInvite'),
  setMemberRole: call('team:setRole'),
  removeMember: call('team:removeMember'),
  syncNow: call('sync:now'),

  startTimer: call('timer:start'),
  stopTimer: call('timer:stop'),
  resolveIdle: call('idle:resolve'),

  saveClient: call('client:save'),
  deleteClient: call('client:delete'),
  saveProject: call('project:save'),
  deleteProject: call('project:delete'),

  saveEntry: call('entry:save'),
  deleteEntry: call('entry:delete'),

  saveSettings: call('settings:save'),

  createInvoice: call('invoice:create'),
  deleteInvoice: call('invoice:delete'),
  invoicePdf: call('invoice:pdf'),

  deleteScreenshot: call('shot:delete'),
  openScreenshotsFolder: call('shot:openFolder'),
  saveTextFile: call('file:saveText'),
  dataPaths: call('app:paths'),
});
