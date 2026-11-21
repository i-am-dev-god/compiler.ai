// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderConsole, renderTests, statusLabel } from '../src/ui/render';
import type { RunResult } from '../src/runner/types';

function host(): HTMLElement {
  const node = document.createElement('div');
  document.body.append(node);
  return node;
}

const crash: RunResult = {
  mode: 'script',
  status: 'error',
  stdout: 'before the crash\n',
  stderr: '',
  error: {
    type: 'NameError',
    message: "name 'undefined_name' is not defined",
    line: 2,
    snippet: 'undefined_name',
    traceback: 'Traceback (most recent call last):\n  File "student.py", line 2, in <module>\n    undefined_name\nNameError: name \'undefined_name\' is not defined',
  },
  tests: [],
  output_match: null,
  passed_count: 0,
  test_count: 0,
  duration_ms: 1,
};

const failed: RunResult = {
  mode: 'tests',
  status: 'failed',
  stdout: '',
  stderr: '',
  error: null,
  tests: [
    { name: 'sum_to(3)', call: 'sum_to(3)', expect: '6', actual: '3', stdout: '', passed: false, error: null },
    { name: 'sum_to(1)', call: 'sum_to(1)', expect: '1', actual: '1', stdout: '', passed: true, error: null },
  ],
  output_match: null,
  passed_count: 1,
  test_count: 2,
  duration_ms: 1,
};

describe('output panel', () => {
  it('asks for a run before there is a result', () => {
    const node = host();
    renderConsole(node, null);
    expect(node.textContent).toContain('Press Run');
  });

  it('keeps output printed before a crash and shows the traceback', () => {
    const node = host();
    renderConsole(node, crash);
    expect(node.textContent).toContain('before the crash');
    expect(node.textContent).toContain("NameError: name 'undefined_name'");
    expect(node.querySelector('.traceback')).not.toBeNull();
  });

  it('renders markup in program output as text, not HTML', () => {
    const node = host();
    const result: RunResult = { ...crash, stdout: '<img src=x onerror=alert(1)>', error: null, status: 'ok' };
    renderConsole(node, result);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img src=x');
  });

  it('shows the first differing line of output as a diff', () => {
    const node = host();
    const result: RunResult = {
      ...crash,
      status: 'failed',
      error: null,
      output_match: {
        match: false,
        actual_lines: ['a', 'c'],
        expected_lines: ['a', 'b'],
        first_difference: { line: 2, actual: 'c', expected: 'b' },
      },
    };
    renderConsole(node, result);
    expect(node.querySelectorAll('.diff-line.removed')).toHaveLength(1);
    expect(node.querySelectorAll('.diff-line.added')).toHaveLength(1);
    expect(node.textContent).toContain('- b');
    expect(node.textContent).toContain('+ c');
  });
});

describe('tests panel', () => {
  it('shows every test with expected vs actual', () => {
    const node = host();
    renderTests(node, failed);
    expect(node.textContent).toContain('1 of 2 passing');
    expect(node.textContent).toContain('expected: 6');
    expect(node.textContent).toContain('actual:   3');
    expect(node.querySelectorAll('.test-card')).toHaveLength(2);
    expect(node.querySelectorAll('.test-card.pass')).toHaveLength(1);
  });

  it('explains that a crash blocked the tests', () => {
    const node = host();
    renderTests(node, { ...crash, mode: 'tests' });
    expect(node.textContent).toContain('could not run');
    expect(node.textContent).toContain('NameError');
  });
});

describe('status line', () => {
  it('summarises each outcome', () => {
    expect(statusLabel(null).text).toBe('not run yet');
    expect(statusLabel(crash).text).toBe('NameError');
    expect(statusLabel(failed).text).toBe('1 of 2 tests passed');
    expect(statusLabel({ ...failed, status: 'passed', passed_count: 2 }).tone).toBe('ok');
    expect(statusLabel({ ...crash, status: 'timeout', timedOut: true }).text).toContain('stopped');
  });
});
