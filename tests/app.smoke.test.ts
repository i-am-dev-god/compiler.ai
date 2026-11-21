// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mounts the real app module against the real index.html with the worker and
 * CodeMirror stubbed out. This catches the class of bug a typecheck cannot see:
 * a missing element id, a handler bound to the wrong node, a mode that never
 * becomes visible, an error card that never fills in.
 */

const code = { value: '' };
const calls = {
  markError: [] as unknown[],
  showFix: [] as unknown[],
  reveal: [] as number[],
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
      markError: (mark: unknown) => {
        calls.markError.push(mark);
      },
      showFix: (fix: unknown) => {
        calls.showFix.push(fix);
      },
      revealLine: (line: number) => {
        calls.reveal.push(line);
      },
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

const scriptError = {
  mode: 'script',
  status: 'error',
  stdout: '',
  stderr: '',
  error: {
    type: 'TypeError',
    message: 'can only concatenate str (not "int") to str',
    line: 2,
    snippet: '    return "You are " + age + " years old"',
    span: { line: 2, col_start: 11, col_end: 27 },
    traceback:
      'Traceback (most recent call last):\n  File "student.py", line 2, in describe_age\n    return "You are " + age + " years old"\n           ~~~~~~~~~~~~^^^\nTypeError: can only concatenate str (not "int") to str',
  },
  tests: [],
  output_match: null,
  passed_count: 0,
  test_count: 0,
  duration_ms: 2,
};

const failedTests = {
  mode: 'tests',
  status: 'failed',
  stdout: '3\n',
  stderr: '',
  error: null,
  tests: [
    { name: 'sum_to(3)', call: 'sum_to(3)', expect: '6', actual: '3', stdout: '', passed: false, error: null },
    { name: 'sum_to(1)', call: 'sum_to(1)', expect: '1', actual: '1', stdout: '', passed: true, error: null },
  ],
  output_match: null,
  passed_count: 1,
  test_count: 2,
  duration_ms: 2,
};

/**
 * Stands in for the Pyodide worker: reports Python as ready, then answers each
 * run with the shape the real harness returns.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor() {
    setTimeout(() => {
      this.onmessage?.({ data: { type: 'status', status: 'python-ready', version: '3.14.2' } } as MessageEvent);
    }, 0);
  }

  postMessage(message: { type: string; id: number; payload?: { mode: string } }) {
    if (message.type !== 'run') return;
    setTimeout(() => {
      this.onmessage?.({
        data: {
          type: 'result',
          id: message.id,
          result: message.payload?.mode === 'tests' ? failedTests : scriptError,
        },
      } as MessageEvent);
    }, 0);
  }

  terminate() {
    /* no resources */
  }
}

function mountIndexHtml() {
  const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

async function boot() {
  vi.resetModules();
  mountIndexHtml();
  await import('../src/main');
  await flush();
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 8));
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe('compiler shell', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    calls.markError.length = 0;
    calls.showFix.length = 0;
    calls.reveal.length = 0;
    calls.patches.length = 0;
    localStorage.clear();
    // Pretend the model question has already been answered, so no modal opens.
    localStorage.setItem('tracegym:firstrun:v1', '1');
  });

  it('starts in the compiler with the five exercises available', async () => {
    await boot();
    expect(document.querySelectorAll('.challenge-item')).toHaveLength(5);
    expect(document.querySelector('[data-mode="compiler"]')?.getAttribute('aria-selected')).toBe('true');
    expect($('pane-title').textContent).toBe('Compiler');
    expect($('rail').hidden).toBe(true);
    expect($('expected-block').hidden).toBe(false);
    expect($('ai-pill-text').textContent).toBe('Local AI off');
    expect($('fix-btn').hidden).toBe(false);
    expect($('hint-btn').hidden).toBe(true);
    expect($('error-card').hidden).toBe(true);
  });

  it('enables Run when Python is ready and keeps help disabled until a run', async () => {
    await boot();
    expect($<HTMLButtonElement>('run-btn').disabled).toBe(false);
    expect($('run-status').textContent).toContain('Python 3.14.2');
    expect($<HTMLButtonElement>('explain-btn').disabled).toBe(true);
    expect($<HTMLButtonElement>('fix-btn').disabled).toBe(true);
    expect($<HTMLButtonElement>('highlight-btn').disabled).toBe(true);
  });

  it('shows the error, marks the exact span, and needs a model to fix', async () => {
    await boot();
    $<HTMLButtonElement>('run-btn').click();
    await flush();

    expect($('error-card').hidden).toBe(false);
    expect($('error-type').textContent).toBe('TypeError');
    expect($('error-loc').textContent).toBe('line 2');
    expect($('error-message').textContent).toContain('can only concatenate str');
    expect($('error-span').textContent).toBe('"You are " + age');
    expect(calls.markError).toContainEqual({ line: 2, colStart: 11, colEnd: 27 });
    expect($<HTMLButtonElement>('fix-btn').disabled).toBe(false);
    expect($<HTMLButtonElement>('highlight-btn').disabled).toBe(false);

    $<HTMLButtonElement>('highlight-btn').click();
    expect(calls.reveal).toContain(2);

    $<HTMLButtonElement>('fix-btn').click();
    await flush();
    expect($('ai-answer').textContent).toContain('model off');
    expect($('ai-answer').textContent).toContain('Download the local model');
    // No patch was applied, and nothing was written to the editor.
    expect(calls.patches).toHaveLength(0);
  });

  it('explains without a model using the built-in question', async () => {
    await boot();
    $<HTMLButtonElement>('run-btn').click();
    await flush();
    $<HTMLButtonElement>('explain-btn').click();
    await flush();
    expect($('ai-answer').hidden).toBe(false);
    expect($('ai-answer').textContent).toContain('built-in');
    expect($('ai-answer').textContent).toContain('TypeError');
  });

  it('restores the starter code on Reset', async () => {
    await boot();
    code.value = 'def broken(\n';
    $<HTMLButtonElement>('reset-btn').click();
    expect(code.value).toContain('def average(numbers):');
  });

  it('switches to Debug Lab with goal, tests and no fix button', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    await flush();
    expect($('rail').hidden).toBe(false);
    expect($('goal').hidden).toBe(false);
    expect($('goal').textContent).toContain('add every whole number');
    expect($('pane-title').textContent).toBe('Sum from 1 to n');
    expect($('expected-block').hidden).toBe(true);
    expect($('fix-btn').hidden).toBe(true);
    expect($('hint-btn').hidden).toBe(false);

    $<HTMLButtonElement>('run-btn').click();
    await flush();
    expect($('test-count').textContent).toBe('1/2');
    expect($('tests-view').textContent).toContain('expected: 6');

    $<HTMLButtonElement>('hint-btn').click();
    await flush();
    expect($('ai-answer').textContent).toContain('range(1, n)');
    expect($<HTMLButtonElement>('hint-btn').disabled).toBe(true);
    expect($('hint-btn').textContent).toContain('Hint used');
  });

  it('loads a different exercise into the editor when one is picked', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    await flush();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.challenge-item');
    buttons[3].click();
    await flush();
    expect($('pane-title').textContent).toBe('Add up the prices');
    expect(code.value).toContain('def total_price');
  });

  it('opens the Model Lab without touching the AI', async () => {
    await boot();
    (document.querySelector('[data-mode="lab"]') as HTMLButtonElement).click();
    await flush();
    expect($('lab').hidden).toBe(false);
    expect($('workbench').hidden).toBe(true);
    expect($('lab').textContent).toContain('Model Lab');
    expect(document.querySelectorAll('.model-check')).toHaveLength(5);
    expect($('ai-pill-text').textContent).toBe('Local AI off');
  });
});

describe('first run', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    localStorage.clear();
    // happy-dom may not implement the dialog element's methods.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  it('asks for the model download before anything else', async () => {
    vi.resetModules();
    mountIndexHtml();
    await import('../src/main');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const dialog = $<HTMLDialogElement>('ai-dialog');
    expect(dialog.open || dialog.hasAttribute('open')).toBe(true);
    expect($('dialog-title').textContent).toContain('Download');
    expect($('firstrun-note').hidden).toBe(false);
    expect($('ai-pill-text').textContent).toBe('Local AI off');
  });
});
