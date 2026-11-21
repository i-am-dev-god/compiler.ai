// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End-to-end of the compiler's core promise: the model proposes a minimal patch,
 * the patch is shown as a diff, applying it edits only that line, and Python
 * re-runs to say whether the error is gone.
 */

const code = { value: '' };
const calls = {
  showFix: [] as Record<string, unknown>[],
  patches: [] as { line: number; count: number; replacement: string[] }[],
};

vi.mock('../src/ui/editor', () => ({
  mountEditor: (_parent: HTMLElement, initial: string) => {
    code.value = initial;
    return {
      get: () => code.value,
      set: (next: string) => {
        code.value = next;
      },
      focus: () => undefined,
      destroy: () => undefined,
      markError: () => undefined,
      showFix: (fix: Record<string, unknown> | null) => {
        if (fix) calls.showFix.push(fix);
      },
      revealLine: () => undefined,
      replaceLines: (line: number, count: number, replacement: string[]) => {
        const lines = code.value.split('\n');
        lines.splice(line - 1, count, ...replacement);
        code.value = lines.join('\n');
        calls.patches.push({ line, count, replacement });
        return code.value;
      },
    };
  },
}));

// A stand-in for the on-device model: it always answers with the same patch.
vi.mock('../src/ai/client', () => ({
  AIClient: class {
    modelId = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC';
    static async webgpuAvailable() {
      return { ok: true, detail: 'WebGPU ready on a test adapter' };
    }
    static async isCached() {
      return true;
    }
    static async removeFromDevice() {
      /* noop */
    }
    async load() {
      /* already loaded */
    }
    async unload() {
      /* noop */
    }
    async complete() {
      return {
        text: JSON.stringify({
          line: 2,
          lines: 1,
          replacement: '    return "You are " + str(age) + " years old"',
          why: 'age is an int; str() turns it into text',
        }),
        modelId: this.modelId,
        ttftMs: 20,
        totalMs: 120,
        tokens: 40,
        tokensPerSecond: 14,
      };
    }
  },
}));

let runCount = 0;

const errorResult = {
  mode: 'script',
  status: 'error',
  stdout: '',
  stderr: '',
  error: {
    type: 'TypeError',
    message: 'can only concatenate str (not "int") to str',
    line: 2,
    snippet: '    total = 0',
    span: { line: 2, col_start: 4, col_end: 11 },
    traceback: 'Traceback ...',
  },
  tests: [],
  output_match: null,
  passed_count: 0,
  test_count: 0,
  duration_ms: 1,
};

const okResult = {
  mode: 'script',
  status: 'ok',
  stdout: 'Hello\n',
  stderr: '',
  error: null,
  tests: [],
  output_match: null,
  passed_count: 0,
  test_count: 0,
  duration_ms: 1,
};

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    setTimeout(() => {
      this.onmessage?.({ data: { type: 'status', status: 'python-ready', version: '3.14.2' } } as MessageEvent);
    }, 0);
  }

  postMessage(message: { type: string; id: number }) {
    if (message.type !== 'run') return;
    runCount += 1;
    const result = runCount === 1 ? errorResult : okResult;
    setTimeout(() => {
      this.onmessage?.({ data: { type: 'result', id: message.id, result } } as MessageEvent);
    }, 0);
  }

  terminate() {
    /* noop */
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe('fix this error', () => {
  beforeEach(async () => {
    vi.stubGlobal('Worker', FakeWorker);
    calls.showFix.length = 0;
    calls.patches.length = 0;
    runCount = 0;
    localStorage.clear();
    localStorage.setItem('tracegym:firstrun:v1', '1');

    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
    vi.resetModules();
    await import('../src/main');
    await flush();
  });

  it('proposes a diff, applies it to one line, and re-runs Python', async () => {
    $<HTMLButtonElement>('run-btn').click();
    await flush();
    expect($('error-type').textContent).toBe('TypeError');

    $<HTMLButtonElement>('fix-btn').click();
    await flush();

    expect($('ai-answer').textContent).toContain('fix proposed');
    expect($('ai-answer').textContent).toContain('str() turns it into text');
    expect(calls.showFix).toHaveLength(1);

    const fix = calls.showFix[0] as unknown as {
      line: number;
      lines: number;
      removed: string[];
      added: string[];
      onApply: () => void;
    };
    expect(fix.line).toBe(2);
    expect(fix.lines).toBe(1);
    expect(fix.added).toEqual(['    return "You are " + str(age) + " years old"']);

    fix.onApply();
    await flush();

    expect(calls.patches).toEqual([
      { line: 2, count: 1, replacement: ['    return "You are " + str(age) + " years old"'] },
    ]);
    expect(code.value).toContain('str(age)');
    // The program was re-run after applying, and the error is gone.
    expect(runCount).toBe(2);
    expect($('error-card').hidden).toBe(true);
    expect($('run-status').textContent).toContain('ran without errors');
  });
});
