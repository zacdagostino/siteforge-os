import { spawn } from 'node:child_process';

const workerScripts = [
  ['capture', 'capture-worker.mjs'],
  ['logos', 'logo-worker.mjs'],
  ['audit', 'audit-worker.mjs'],
  ['assets', 'asset-analysis-worker.mjs'],
  ['capabilities', 'capability-analysis-worker.mjs'],
  ['builder', 'builder-worker.mjs'],
];
const restartDelayMs = 2_000;
let stopping = false;
const children = new Set();

function startWorker(name, script) {
  if (stopping) return;
  const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], {
    env: process.env,
    stdio: 'inherit',
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(
      `[worker-supervisor] ${name} stopped (${signal ?? code ?? 'unknown'}); restarting.`,
    );
    setTimeout(() => startWorker(name, script), restartDelayMs);
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  '[worker-supervisor] starting capture, logo, audit, asset-analysis, capability-analysis, and builder workers.',
);
workerScripts.forEach(([name, script]) => startWorker(name, script));
