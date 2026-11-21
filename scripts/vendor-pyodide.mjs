#!/usr/bin/env node
/**
 * Copies the Pyodide runtime out of node_modules into public/pyodide/ so the
 * interpreter is served from our own origin: cacheable, offline-capable, and
 * not dependent on a CDN being reachable. Runs on postinstall and prebuild.
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules/pyodide');
const target = join(root, 'public/pyodide');

const FILES = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'pyodide-lock.json',
  'python_stdlib.zip',
  'package.json',
];

if (!existsSync(source)) {
  console.warn('[vendor-pyodide] pyodide is not installed yet; skipping.');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const workerSource = readFileSync(join(root, 'src/runner/worker.ts'), 'utf8');
const pinned = workerSource.match(/PYODIDE_VERSION = '([^']+)'/)?.[1];

if (pinned && pinned !== pkg.version) {
  console.error(`[vendor-pyodide] version mismatch: worker pins ${pinned}, npm has ${pkg.version}`);
  console.error('[vendor-pyodide] update PYODIDE_VERSION in src/runner/worker.ts (CDN fallback must match).');
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const file of FILES) {
  const from = join(source, file);
  if (!existsSync(from)) {
    console.error(`[vendor-pyodide] missing ${file}`);
    process.exit(1);
  }
  copyFileSync(from, join(target, file));
}
// Keep the vendored copy out of git; it is reproducible from package-lock.json.
writeFileSync(join(target, '.gitignore'), '*\n');
writeFileSync(join(target, 'VERSION'), `${pkg.version}\n`);
rmSync(join(target, '.DS_Store'), { force: true });
console.log(`[vendor-pyodide] pyodide ${pkg.version} → public/pyodide/`);
