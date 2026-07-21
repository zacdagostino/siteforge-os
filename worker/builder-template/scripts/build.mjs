import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, relative } from 'node:path';

const sourceDirectory = new URL('../src/', import.meta.url);
const outputDirectory = new URL('../dist/', import.meta.url);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(sourceDirectory, outputDirectory, {
  recursive: true,
  filter: (source) => basename(source) !== '.gitkeep',
});

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = new URL(entry.name, directory);
    if (entry.isDirectory()) files.push(...(await collectFiles(file)));
    if (entry.isFile()) files.push(file);
  }
  return files;
}

const files = await collectFiles(outputDirectory);
const indexFile = new URL('index.html', outputDirectory);
if (!(await stat(indexFile)).isFile())
  throw new Error('src/index.html is required for a private preview.');
if (!files.some((file) => relative(outputDirectory.pathname, file.pathname).endsWith('.html'))) {
  throw new Error('The private preview must contain at least one HTML page.');
}

console.log(`Built ${files.length} private preview files.`);
