import type { RunOptions, RunResult } from './types';

export type RunnerState = 'starting' | 'ready' | 'error';

export interface RunnerStatus {
  state: RunnerState;
  detail?: string;
  version?: string;
}

interface Pending {
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Main-thread handle for the Pyodide worker.
 *
 * Runs are serialised so a half-finished run can never interleave with the next
 * one, and a run that exceeds its time budget kills the worker (the only way to
 * stop a synchronous `while True:` in WASM) and transparently respawns it.
 */
export class PythonRunner {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private lastStatus: RunnerStatus = { state: 'starting' };
  private statusHandler: ((status: RunnerStatus) => void) | null = null;

  /** Late subscribers still learn the current state (Python may be ready already). */
  set onStatus(handler: ((status: RunnerStatus) => void) | null) {
    this.statusHandler = handler;
    if (handler) handler(this.lastStatus);
  }

  get onStatus(): ((status: RunnerStatus) => void) | null {
    return this.statusHandler;
  }

  constructor() {
    this.spawn();
  }

  private emitStatus(status: RunnerStatus) {
    this.lastStatus = status;
    this.statusHandler?.(status);
  }

  private spawn() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent) => this.handle(event.data);
    this.worker.onerror = (event) => {
      this.emitStatus({ state: 'error', detail: event.message || 'Python worker crashed' });
    };
    this.emitStatus({ state: 'starting' });
  }

  private handle(data: Record<string, unknown>) {
    switch (data.type) {
      case 'status': {
        if (data.status === 'python-ready') {
          this.emitStatus({ state: 'ready', version: String(data.version ?? ''), detail: String(data.detail ?? '') });
        } else {
          this.emitStatus({ state: 'starting', detail: String(data.detail ?? '') });
        }
        return;
      }
      case 'result': {
        const entry = this.pending.get(Number(data.id));
        if (!entry) return;
        this.pending.delete(Number(data.id));
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve(data.result as RunResult);
        return;
      }
      case 'error': {
        const entry = this.pending.get(Number(data.id));
        if (!entry) return;
        this.pending.delete(Number(data.id));
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(String(data.message ?? 'Python error')));
        return;
      }
      case 'fatal': {
        this.emitStatus({ state: 'error', detail: String(data.message ?? '') });
        return;
      }
      default:
        return;
    }
  }

  run(options: RunOptions): Promise<RunResult> {
    const task = () => this.dispatch(options);
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private dispatch(options: RunOptions): Promise<RunResult> {
    if (this.disposed) return Promise.reject(new Error('Runner disposed'));
    if (!this.worker) this.spawn();
    const id = ++this.seq;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const payload = {
      mode: options.mode,
      code: options.code,
      tests: options.tests ?? [],
      expected_output: options.expectedOutput ?? null,
    };

    return new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.recycle('timeout');
        resolve({
          mode: options.mode,
          status: 'timeout',
          stdout: '',
          stderr: '',
          error: {
            type: 'Timeout',
            message: `Your program was still running after ${Math.round(timeoutMs / 1000)} seconds, so I stopped it. Is there a loop that never ends?`,
            line: null,
            snippet: null,
            traceback: '',
          },
          tests: [],
          output_match: null,
          passed_count: 0,
          test_count: 0,
          duration_ms: timeoutMs,
          timedOut: true,
        });
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.worker?.postMessage({ type: 'run', id, payload });
    });
  }

  /** Kill the wasm instance; a fresh worker starts on the next run. */
  private recycle(reason: string) {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(`Python worker recycled (${reason})`));
      this.pending.delete(id);
    }
    this.worker?.terminate();
    this.worker = null;
    if (!this.disposed) this.spawn();
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
  }
}
