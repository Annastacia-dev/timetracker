// Automatic updates from GitHub Releases (packaged builds only).
// electron-builder writes the feed (latest.yml) next to the installer; publish both in a release.
const { app } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let readyVersion = null;
let updater = null;

function start({ onReady, beforeInstall }) {
  if (!app.isPackaged || process.env.TT_NO_UPDATES === '1') return;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // a downloaded update installs on the next quit
  updater.on('error', (err) => console.log('[updates]', err.message));
  updater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    onReady(info.version);
  });
  start.beforeInstall = beforeInstall;
  const check = () => updater.checkForUpdates().catch((err) => console.log('[updates]', err.message));
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}

function install() {
  if (!updater || !readyVersion) return;
  start.beforeInstall?.();
  updater.quitAndInstall(); // fires before-quit, which stops a running timer and saves
}

module.exports = { start, install, ready: () => readyVersion };
