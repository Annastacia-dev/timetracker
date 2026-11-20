// Automatic updates from GitHub Releases (packaged builds only).
// electron-builder writes the feed (latest.yml) next to the installer; publish both in a release.
const { app } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let readyVersion = null;
let updater = null;

function start({ onReady, beforeInstall, log = console.log }) {
  if (!app.isPackaged || process.env.TT_NO_UPDATES === '1') return;
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true; // a downloaded update installs on the next quit
  updater.on('error', (err) => log(`update: error ${err.message}`));
  updater.on('checking-for-update', () => log('update: checking'));
  updater.on('update-available', (info) => log(`update: ${info.version} available, downloading`));
  updater.on('update-not-available', () => log('update: up to date'));
  updater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    log(`update: ${info.version} downloaded, installs on quit`);
    onReady(info.version);
  });
  start.beforeInstall = beforeInstall;
  start.log = log;
  const check = () => updater.checkForUpdates().catch((err) => log(`update: check failed ${err.message}`));
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}

function install() {
  if (!updater || !readyVersion) return;
  start.beforeInstall?.();
  start.log?.('update: restart to install');
  updater.quitAndInstall(); // fires before-quit, which stops a running timer and saves
}

module.exports = { start, install, ready: () => readyVersion };
