// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Mounts the real app module against the real index.html with the worker and
 * CodeMirror stubbed out. This is the cheapest way to catch the class of bug
 * that a typecheck cannot see: a missing element id, an event handler bound to
 * the wrong node, a mode that never becomes visible.
 */

const code = { value: 'def sum_to(n):\n    return n\n' };

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
    };
  },
}));

/**
 * Stands in for the Pyodide worker. It reports Python as ready and answers a
 * "run" with the same shape the real harness returns, so the run -> render ->
 * help path can be exercised without WASM.
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
          result: {
            mode: message.payload?.mode ?? 'tests',
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
          },
        },
      } as MessageEvent);
    }, 0);
  }

  terminate() {
    /* no resources */
  }
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 5));
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
  // let the microtask queue settle (status replay, dialog checks)
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('app shell', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    localStorage.clear();
  });

  it('renders all five exercises and starts in Playground', async () => {
    await boot();
    expect(document.querySelectorAll('.challenge-item')).toHaveLength(5);
    expect(document.querySelector('[data-mode="playground"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('pane-title')?.textContent).toBe('Playground');
    expect(document.getElementById('rail')?.hidden).toBe(true);
    expect(document.getElementById('expected-block')?.hidden).toBe(false);
    expect(document.getElementById('ai-pill-text')?.textContent).toBe('Local AI off');
  });

  it('switches to Debug Lab with the goal and tests visible', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    expect(document.getElementById('rail')?.hidden).toBe(false);
    expect(document.getElementById('goal')?.hidden).toBe(false);
    expect(document.getElementById('goal')?.textContent).toContain('add every whole number');
    expect(document.getElementById('pane-title')?.textContent).toBe('Sum from 1 to n');
    expect(document.getElementById('pane-sub')?.textContent).toContain('1 of 5');
    expect(document.getElementById('expected-block')?.hidden).toBe(true);
    expect(document.querySelectorAll('.challenge-item')[0].classList.contains('active')).toBe(true);
  });

  it('loads a different exercise into the editor when one is picked', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    const buttons = document.querySelectorAll<HTMLButtonElement>('.challenge-item');
    buttons[3].click();
    expect(document.getElementById('pane-title')?.textContent).toBe('Add up the prices');
    expect(code.value).toContain('def total_price');
    expect(document.getElementById('pane-sub')?.textContent).toContain('4 of 5');
  });

  it('restores the starter code on Reset', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    code.value = 'def sum_to(n)\n  syntax error here';
    (document.getElementById('reset-btn') as HTMLButtonElement).click();
    expect(code.value).toContain('for number in range(1, n):');
  });

  it('enables Run once Python is ready but keeps help disabled until a run', async () => {
    await boot();
    await flush();
    expect((document.getElementById('run-btn') as HTMLButtonElement).disabled).toBe(false);
    expect(document.getElementById('run-status')?.textContent).toContain('Python 3.14.2');
    expect((document.getElementById('explain-btn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('hint-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the Model Lab without touching the AI', async () => {
    await boot();
    (document.querySelector('[data-mode="lab"]') as HTMLButtonElement).click();
    expect(document.getElementById('lab')?.hidden).toBe(false);
    expect(document.getElementById('workbench')?.hidden).toBe(true);
    expect(document.getElementById('lab')?.textContent).toContain('Model Lab');
    expect(document.querySelectorAll('.model-check')).toHaveLength(5);
    expect(document.getElementById('ai-pill-text')?.textContent).toBe('Local AI off');
  });

  it('runs the tests, renders the failure, and offers a built-in hint with no model', async () => {
    await boot();
    (document.querySelector('[data-mode="debug"]') as HTMLButtonElement).click();
    await flush();

    const runButton = document.getElementById('run-btn') as HTMLButtonElement;
    expect(runButton.disabled).toBe(false);
    runButton.click();
    await flush();

    expect(document.getElementById('run-status')?.textContent).toBe('1 of 2 tests passed');
    expect(document.getElementById('test-count')?.textContent).toBe('1/2');
    expect(document.getElementById('tests-view')?.textContent).toContain('expected: 6');
    expect(document.getElementById('tests-view')?.textContent).toContain('actual:   3');

    const hint = document.getElementById('hint-btn') as HTMLButtonElement;
    expect(hint.disabled).toBe(false);
    hint.click();
    await flush();

    const answer = document.getElementById('ai-answer');
    expect(answer?.hidden).toBe(false);
    expect(answer?.textContent).toContain('built-in');
    expect(answer?.textContent).toContain('range(1, n)');
    expect(answer?.textContent).toContain('Which number is missing');
    expect(hint.disabled).toBe(true);
    expect(hint.textContent).toContain('Hint used');
    expect(document.getElementById('ai-pill-text')?.textContent).toBe('Local AI off');
  });
});
