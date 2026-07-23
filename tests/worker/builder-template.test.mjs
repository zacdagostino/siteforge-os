import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const templateDirectory = new URL('../../worker/builder-template/', import.meta.url);

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Builder template build exited with ${code}.`));
    });
  });
}

test('builds the isolated static preview foundation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siteforge-builder-template-test-'));
  try {
    await cp(templateDirectory, directory, { recursive: true });
    await runNode(['scripts/build.mjs'], directory);
    const output = await stat(join(directory, 'dist', 'index.html'));
    assert.equal(output.isFile(), true);
    const runtime = await readFile(join(directory, 'dist', 'main.js'), 'utf8');
    assert.match(runtime, /IntersectionObserver/);
    assert.match(runtime, /prefers-reduced-motion/);
    assert.match(runtime, /data-counter/);
    await assert.rejects(stat(join(directory, 'dist', 'assets', '.gitkeep')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
