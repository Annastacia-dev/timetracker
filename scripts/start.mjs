// Launches Electron against the production build in dist/.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
spawn(electronPath, ['.'], { stdio: 'inherit', env }).on('exit', (c) => process.exit(c ?? 0));
