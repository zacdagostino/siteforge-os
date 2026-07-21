import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vitePath = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const supervisorPath = fileURLToPath(new URL('./supervisor.mjs', import.meta.url));
const children = [
  spawn(process.execPath, [vitePath, '--host', '0.0.0.0', '--port', '5173', '--strictPort'], {
    env: process.env,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [supervisorPath], { env: process.env, stdio: 'inherit' }),
];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = exitCode;
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
children.forEach((child) =>
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[local-dev] ${signal ?? code ?? 'process'} stopped; shutting down local services.`,
      );
      stop(typeof code === 'number' && code !== 0 ? code : 1);
    }
  }),
);
