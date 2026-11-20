// Runs the smoke test inside Electron with a throwaway data folder.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env, TT_BLOCK_MS: '20000', TT_LOCAL: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
spawn(electronPath, ['scripts/smoke.cjs'], { stdio: 'inherit', env }).on('exit', (c) => process.exit(c ?? 0));
