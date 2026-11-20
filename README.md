# TimeTracker

Desktop time tracker for client work and teams (Electron + React + Supabase).

It runs in one of two modes:

- **Team mode**, when `app-config.json` points at a Supabase project. Members sign in, track time against team projects and sync. Admins manage clients, projects, rates and invoices, and see everyone's time and screenshots.
- **Local mode**, with no config: a single user, and everything stays on this computer.

## Features

- **Teams and roles**: owner, admin and member. Admins invite people by email; invitees join automatically when they sign up or sign in with that address. You can belong to several teams and switch between them in the sidebar.
- **Privacy**: members see only their own time and screenshots. Admins see everyone's. The database's row-level security enforces this, not just the app.
- **Offline first**: the timer always works. Changes queue locally and sync every minute, on wake/unlock and after edits. The sidebar shows sync status.
- **Clients and projects** with hourly rates (a project rate overrides the client's default rate), archive/restore.
- **Timer**: start or stop from the window or the tray. Closing the window keeps tracking in the tray.
- **Idle detection**: after N minutes with no input (or a screen lock or sleep), asks whether to keep or discard the idle time.
- **Work diary**: 10-minute blocks with activity % and, if enabled, one screenshot per block. Full-size images stay on the member's PC; a roughly 40 KB thumbnail is uploaded for admins. Screenshots can be blurred or deleted.
- **Timesheet**: weekly view, manual entries, edit/delete. Admins can view any member. Invoiced time is locked.
- **Reports**: date ranges, client and member filters, totals by member, client and project, a daily grid, and CSV export.
- **Invoices** (admins): built on the server from unbilled time, numbered per team, saved as PDF.

## Team setup (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. In **SQL Editor → New query**, paste all of [supabase/schema.sql](supabase/schema.sql) and run it once.
3. In **Project Settings → API**, copy the Project URL and the **anon / publishable** key (never the `service_role` / secret key). Save them as `app-config.json` in the project root, following `app-config.example.json`. This file is git-ignored and bundled into the installer. The anon key is safe to ship in the app because row-level security protects the data.
4. **Authentication → Sign In / Providers → Email**: for an internal team you can turn off **Confirm email**. If you leave it on, people click the emailed link, then sign in from the app.
5. Run `npm run dev`, create an account, create your team, then invite teammates from **Team**.

`npm run test:schema` loads the schema into an in-process Postgres (PGlite) and checks 52 access rules: members can't read each other's time, can't change rates or invoices, outsiders see nothing, invoiced time is locked, and so on.

## Commands

```powershell
npm install          # also downloads the Electron binary
npm run dev          # Vite dev server + Electron with hot reload
npm start            # production build, then run
npm run smoke        # end-to-end test (local mode) in a temp data folder; captures go to smoke-out/
npm run test:schema  # Supabase schema + security rules against PGlite
npm run ui:cloud     # renders the team-mode sign-in screen against a dummy URL
npm run dist         # Windows installer via electron-builder, written to release/
npm run icons        # regenerate app, tray and favicon icons from assets/logo.svg
```

The project `.npmrc` sets `os=win32`, because the global npm config on this machine has `os=linux`, which makes npm skip Windows native binaries (Vite/rolldown, lightningcss).

## Installing and sharing

`npm run dist` builds `release\TimeTracker Setup <version>.exe`, a per-user install that needs no admin rights. Share it through GitHub Releases. Until the installer is code-signed, Windows SmartScreen asks people to click **More info → Run anyway**.

## Data

- Local mode: `%APPDATA%\TimeTracker\timetracker.json`
- Team mode: `%APPDATA%\TimeTracker\accounts\<user>\<team>.json` (offline cache and pending changes), plus `session.json` (sign-in tokens, encrypted with Windows DPAPI)
- Screenshots: `%APPDATA%\TimeTracker\screenshots\` (full size), `thumbs\` (uploaded copies), `remote\` (teammates' thumbnails cached for admins)

## Design

- Typeface: [Geist](https://vercel.com/font) (UI, invoices) and Geist Mono (timers), bundled locally via Fontsource.
- Icons: [Lucide](https://lucide.dev).
- Logo: `assets/logo.svg`; generated icons live in `build/`, `electron/assets/` and `public/`.
- Windows takes the taskbar icon and notification name from the app ID (`com.local.timetracker`). The installer registers `TimeTracker`. Dev runs register `TimeTracker (dev)` (a Start Menu shortcut plus `HKCU\Software\Classes\AppUserModelId\com.local.timetracker`).

## Layout

- `electron/main.cjs`: tracker (blocks, idle, screenshots), tray, accounts/teams, sync scheduling, IPC, invoices/PDF, `tt-shot://` image protocol
- `electron/cloud.cjs`: Supabase client, encrypted session storage, record mapping, push/pull sync
- `electron/store.cjs`: debounced, atomic JSON store
- `electron/preload.cjs`: `window.tt` API (context-isolated, sandboxed)
- `supabase/schema.sql`: tables, row-level security, team and invoice functions, screenshot bucket
- `src/views/*`: Login, Tracker, Timesheet, Work diary, Reports, Invoices, Clients & projects, Team, Settings

## Limits

- Admin actions (clients, projects, settings, invites, invoices) need a connection; tracking does not.
- Invites are not emailed; tell people to sign up with the invited address.
- Screenshots capture the primary display only. Activity is based on whether there was any input each minute, not keystroke counts.
- One currency per team.
