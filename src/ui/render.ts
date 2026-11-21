import type { RunResult, TestResult } from '../runner/types';

/** Tiny DOM helper: text always goes through textContent, never innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function statusLabel(result: RunResult | null): { text: string; tone: 'idle' | 'ok' | 'fail' | 'error' } {
  if (!result) return { text: 'not run yet', tone: 'idle' };
  if (result.status === 'timeout') return { text: 'stopped (too slow)', tone: 'error' };
  if (result.error) return { text: result.error.type, tone: 'error' };
  if (result.mode === 'tests') {
    return {
      text: `${result.passed_count} of ${result.test_count} tests passed`,
      tone: result.passed_count === result.test_count ? 'ok' : 'fail',
    };
  }
  if (result.output_match) {
    return { text: result.output_match.match ? 'output matches' : 'output differs', tone: result.output_match.match ? 'ok' : 'fail' };
  }
  return { text: 'ran without errors', tone: 'ok' };
}

function pre(text: string, className: string): HTMLElement {
  const node = el('pre', className);
  node.textContent = text.replace(/\s+$/, '');
  return node;
}

/** The Output tab: what CPython printed, or the traceback it raised. */
export function renderConsole(container: HTMLElement, result: RunResult | null) {
  clear(container);
  if (!result) {
    container.append(
      el('p', 'placeholder', 'Press Run (or ⌘/Ctrl + Enter) to execute your program. Python runs in a worker on this device.'),
    );
    return;
  }

  if (result.stdout.trim()) {
    container.append(el('div', 'section-label', 'Printed output'));
    container.append(pre(result.stdout, 'stdout'));
  }

  if (result.stderr.trim()) {
    container.append(el('div', 'section-label', 'Warnings on stderr'));
    container.append(pre(result.stderr, 'stderr'));
  }

  if (result.error) {
    container.append(el('div', 'section-label', result.timedOut ? 'Stopped' : 'Traceback'));
    if (result.timedOut || !result.error.traceback) {
      container.append(el('p', 'error-message', result.error.message));
    } else {
      container.append(pre(result.error.traceback, 'traceback'));
    }
  }

  if (result.output_match) {
    const match = result.output_match;
    container.append(el('div', 'section-label', match.match ? 'Output check' : 'Output check — first difference'));
    if (!match.match) {
      const diff = el('div', 'diff');
      const limit = Math.max(match.actual_lines.length, match.expected_lines.length);
      for (let i = 0; i < limit; i += 1) {
        const actual = match.actual_lines[i];
        const expected = match.expected_lines[i];
        if (actual === expected) {
          diff.append(el('div', 'diff-line', `  ${actual ?? ''}`));
        } else {
          if (expected !== undefined) diff.append(el('div', 'diff-line removed', `- ${expected}`));
          if (actual !== undefined) diff.append(el('div', 'diff-line added', `+ ${actual}`));
        }
      }
      container.append(diff);
    } else {
      container.append(el('p', 'muted', 'Your output matches, ignoring trailing spaces.'));
    }
  }

  if (!result.stdout.trim() && !result.stderr.trim() && !result.error && result.status !== 'timeout') {
    container.append(el('p', 'placeholder', 'The program ran and printed nothing. That is fine — but check whether you expected some output.'));
  }
}

/** The Tests tab: one card per test, in the order the challenge lists them. */
export function renderTests(container: HTMLElement, result: RunResult | null, goal?: string) {
  clear(container);
  if (goal) container.append(el('p', 'goal-note', goal));
  if (!result) {
    container.append(el('p', 'placeholder', 'Run the tests to see which cases pass and which fail.'));
    return;
  }
  if (result.error) {
    container.append(
      el('p', 'placeholder', `The tests could not run because the program raised ${result.error.type}. Fix the crash first — the traceback is in the Output tab.`),
    );
    return;
  }
  if (result.tests.length === 0) {
    container.append(el('p', 'placeholder', 'The compiler runs whole programs, so there are no tests here. Use the Output tab, or pick an exercise in Debug Lab to see individual test cases.'));
    return;
  }

  const summary = el('div', 'test-summary');
  summary.append(
    el(
      'strong',
      result.passed_count === result.test_count ? 'tone-ok' : 'tone-fail',
      `${result.passed_count} of ${result.test_count} passing`,
    ),
  );
  container.append(summary);

  for (const test of result.tests) {
    container.append(testCard(test));
  }
}

function testCard(test: TestResult): HTMLElement {
  const card = el('div', `test-card ${test.passed ? 'pass' : 'fail'}`);
  const head = el('div', 'test-head');
  head.append(el('span', 'test-mark', test.passed ? '✓' : '✕'));
  head.append(el('code', 'test-call', test.call));
  card.append(head);

  if (test.passed) {
    card.append(el('div', 'test-detail', `returned ${test.actual}`));
    return card;
  }
  if (test.error) {
    card.append(el('div', 'test-detail', `raised ${test.error.type}: ${test.error.message}`));
    if (test.error.line) card.append(el('div', 'test-detail faint', `line ${test.error.line}`));
    return card;
  }
  if (test.expect_output !== null && test.expect_output !== undefined) {
    const expected = el('pre', 'test-io', `expected output:\n${test.expect_output.replace(/\s+$/, '')}`);
    const actual = el('pre', 'test-io', `actual output:\n${(test.stdout || '(nothing printed)').replace(/\s+$/, '')}`);
    card.append(expected, actual);
    return card;
  }
  card.append(el('div', 'test-io-line', `expected: ${test.expect ?? '(none)'}`));
  card.append(el('div', 'test-io-line', `actual:   ${test.actual ?? '(nothing)'}`));
  return card;
}
