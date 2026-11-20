# TimeTracker

Desktop time tracker for client work (Electron + React). Everything is stored locally.

## Features

- **Clients and projects** with hourly rates (a project rate overrides the client's default rate), archive/restore.
- **Timer**: start or stop from the window or the tray. Closing the window keeps tracking in the tray. The tray tooltip and window title show elapsed time.
- **Idle detection**: after N minutes with no keyboard or mouse input (or a screen lock or sleep), asks you to keep the idle time, discard it and keep tracking, or discard it and stop.
- **Work diary**: time is split into 10-minute blocks aligned to the clock. Each block records activity (the share of minutes with input) and, if enabled, one screenshot taken at a random moment. Screenshots can be blurred or deleted, and a notification appears after each capture.
- **Timesheet**: weekly view, manual time entries (labelled "manual"), edit and delete. Invoiced time is locked.
- **Reports**: this week, last week, this month, last month or a custom range, filterable by client. Shows totals by client and project, earnings, a daily grid, and CSV export.
- **Invoices**: built from unbilled time per client and period, one line per project, saved as PDF. Deleting an invoice makes its time unbilled again.
- **Crash recovery**: a running timer is closed at its last heartbeat (every 15 seconds) if the app dies.

## Commands

```powershell
npm install        # also downloads the Electron binary
npm run dev        # Vite dev server + Electron with hot reload
npm start          # production build, then run
npm run smoke      # end-to-end test in a temp data folder; page captures go to smoke-out/
npm run dist       # Windows installer via electron-builder, written to release/
npm run icons      # regenerate app, tray and favicon PNGs from assets/logo.svg
```

The project `.npmrc` sets `os=win32`, because the global npm config on this machine has `os=linux`, which makes npm skip Windows native binaries (Vite/rolldown, lightningcss).

## Data

- `%APPDATA%\timetracker\timetracker.json`: clients, projects, entries, blocks, invoices, settings
- `%APPDATA%\timetracker\screenshots\YYYY-MM-DD\*.jpg`

Settings → Data shows the exact paths.

## Design

- Typeface: [Geist](https://vercel.com/font) (UI, invoices) and Geist Mono (timers), bundled locally via Fontsource.
- Icons: [Lucide](https://lucide.dev).
- Logo: `assets/logo.svg`; generated icons live in `build/`, `electron/assets/` and `public/`.

## Layout

- `electron/main.cjs`: tracker (blocks, idle, screenshots), tray, IPC, invoices/PDF, `tt-shot://` image protocol
- `electron/store.cjs`: debounced, atomic JSON store
- `electron/preload.cjs`: `window.tt` API (context-isolated, sandboxed)
- `src/views/*`: Tracker, Timesheet, Work diary, Reports, Invoices, Clients & projects, Settings

## Limits

- Screenshots capture the primary display only.
- Activity is based on system idle time (whether there was any input that minute), not keystroke counts.
- Single currency, set in Settings.
