/// <reference lib="webworker" />
import harnessSource from './harness.py?raw';

/**
 * Python runner worker.
 *
 * Pyodide is loaded as a plain ES module from /pyodide/ (vendored from the npm
 * package by scripts/vendor-pyodide.mjs) so that the app shell, the interpreter
 * and the stdlib are all same-origin and cacheable. If the vendored copy is
 * missing we fall back to the matching jsDelivr build so `npm run dev` still
 * works in a fresh clone.
 */

const PYODIDE_VERSION = '314.0.8';
// Vite rewrites BASE_URL for whatever subpath the site is deployed under.
const LOCAL_BASE = `${import.meta.env.BASE_URL}pyodide/`;
const CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

type PyodideAPI = {
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  globals: { set: (key: string, value: unknown) => void };
  version: string;
};

let pyodide: PyodideAPI | null = null;
let loading: Promise<PyodideAPI> | null = null;
let runTracegym: ((payload: string) => string) | null = null;

function post(message: unknown) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

async function resolveBase(): Promise<string> {
  try {
    const head = await fetch(`${LOCAL_BASE}pyodide-lock.json`, { method: 'HEAD' });
    if (head.ok) return LOCAL_BASE;
  } catch {
    /* fall through to CDN */
  }
  return CDN_BASE;
}

async function ensurePyodide(): Promise<PyodideAPI> {
  if (pyodide) return pyodide;
  if (loading) return loading;
  loading = (async () => {
    const base = await resolveBase();
    post({ type: 'status', status: 'loading-python', detail: base === LOCAL_BASE ? 'local' : 'cdn' });
    const url = new URL(`${base}pyodide.mjs`, self.location.href).href;
    // Resolved at runtime: never bundled, so the wasm/stdlib paths stay intact.
    const mod = (await import(/* @vite-ignore */ url)) as {
      loadPyodide: (opts: Record<string, unknown>) => Promise<PyodideAPI>;
    };
    const api = await mod.loadPyodide({
      indexURL: base,
      stdout: (line: string) => post({ type: 'interpreter-out', line }),
      stderr: (line: string) => post({ type: 'interpreter-out', line, err: true }),
    });
    api.runPython(harnessSource);
    const fn = api.runPython('run_tracegym');
    runTracegym = fn as (payload: string) => string;
    pyodide = api;
    post({ type: 'status', status: 'python-ready', version: api.version });
    return api;
  })();
  return loading;
}

self.onmessage = async (event: MessageEvent) => {
  const data = event.data as
    | { type: 'run'; id: number; payload: Record<string, unknown> }
    | { type: 'ping' };

  if (data.type === 'ping') {
    try {
      await ensurePyodide();
      post({ type: 'pong', version: pyodide?.version ?? null });
    } catch (error) {
      post({ type: 'fatal', message: describe(error) });
    }
    return;
  }

  if (data.type !== 'run') return;

  try {
    await ensurePyodide();
    if (!runTracegym) throw new Error('Python harness failed to initialise');
    const started = performance.now();
    const raw = runTracegym(JSON.stringify(data.payload));
    const result = JSON.parse(raw) as Record<string, unknown>;
    result.duration_ms = Math.round((performance.now() - started) * 100) / 100;
    post({ type: 'result', id: data.id, result });
  } catch (error) {
    post({ type: 'error', id: data.id, message: describe(error) });
  }
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// Warm the interpreter as soon as the worker is created: by the time the
// student presses Run, Python is usually already up.
void ensurePyodide().catch((error) => post({ type: 'fatal', message: describe(error) }));
