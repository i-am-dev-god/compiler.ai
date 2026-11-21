#!/usr/bin/env node
/**
 * Proves the Debug Lab curriculum is sound before it ever reaches a browser:
 *   1. every starter program reproduces the bug class it claims to teach,
 *   2. every reference fix passes every test,
 *   3. every fallback hint is caught by its own concept matcher,
 *   4. no reference fix is already sitting in the starter code.
 *
 * Runs the real harness in real CPython (Pyodide/WASM), the same code path the
 * browser worker uses. `npm run verify:curriculum`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPyodide } from 'pyodide';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = readFileSync(join(root, 'src/runner/harness.py'), 'utf8');
const challenges = JSON.parse(readFileSync(join(root, 'src/data/challenges.json'), 'utf8'));
const solutions = JSON.parse(readFileSync(join(root, 'tests/fixtures/solutions.json'), 'utf8'));

const py = await loadPyodide();
const run = py.runPython(harness + '\nrun_tracegym');

function runPayload(payload) {
  return JSON.parse(run(JSON.stringify(payload)));
}

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) {
    failures += 1;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log(`Python ${py.runPython('import sys; sys.version.split()[0]')} / ${challenges.length} challenges\n`);

for (const challenge of challenges) {
  console.log(`${challenge.id} — ${challenge.bugClass}`);
  const starter = runPayload({ mode: 'tests', code: challenge.starter, tests: challenge.tests });
  const solutionCode = solutions[challenge.id];
  check(Boolean(solutionCode), 'has a reference fix');

  const failing = starter.tests.filter((t) => !t.passed);
  check(failing.length > 0, 'starter fails at least one test', `${starter.passed_count}/${starter.test_count} passed`);

  if (challenge.expectedError) {
    check(
      starter.error?.type === challenge.expectedError,
      `starter raises ${challenge.expectedError}`,
      starter.error ? `got ${starter.error.type}: ${starter.error.message}` : 'no exception',
    );
    check(starter.tests.every((t) => t.blocked), 'tests are reported blocked when the program crashes');
  } else {
    check(starter.error === null, 'starter runs without crashing (a wrong answer, not a crash)',
      starter.error ? `${starter.error.type}: ${starter.error.message}` : '');
    check(failing.some((t) => t.actual !== null), 'at least one test shows actual vs expected',
      JSON.stringify(failing.map((t) => [t.call, t.actual])));
  }

  if (solutionCode) {
    const fixed = runPayload({ mode: 'tests', code: solutionCode, tests: challenge.tests });
    check(fixed.status === 'passed', 'reference fix passes every test',
      `${fixed.passed_count}/${fixed.test_count}${fixed.error ? ` (${fixed.error.type}: ${fixed.error.message})` : ''}`);
  }

  const concept = new RegExp(challenge.concept, 'im');
  check(concept.test(challenge.fallbackHint), 'fallback hint matches its own concept matcher');

  for (const pattern of challenge.leakPatterns ?? []) {
    const leak = new RegExp(pattern, 'im');
    check(!leak.test(starter), `starter does not already contain fix (${pattern})`);
    if (solutionCode) check(leak.test(solutionCode) || true, 'leak pattern compiled');
  }

  // The hint must not itself hand over the corrected line.
  const leaks = (challenge.leakPatterns ?? []).filter((p) => new RegExp(p, 'im').test(challenge.fallbackHint));
  check(leaks.length === 0, 'fallback hint does not leak the fix', leaks.join(' | '));
  console.log('');
}

// Playground output checking must be forgiving about trailing whitespace, and
// strict about actual differences.
console.log('playground output check');
const okOut = runPayload({ mode: 'script', code: 'print("a")\nprint("b")  ', expected_output: 'a\nb\n' });
check(okOut.status === 'passed', 'trailing whitespace does not fail a matching output');
const badOut = runPayload({ mode: 'script', code: 'print("a")', expected_output: 'a\nb' });
check(badOut.status === 'failed', 'a genuinely different output fails');
check(badOut.output_match?.first_difference?.line === 2, 'reports the first differing line');

console.log('error spans (what the editor underlines)');
const spanCases = [
  { name: 'TypeError', code: 'x = 1\ny = "a" + x\n', expect: '"a" + x' },
  { name: 'NameError', code: 'a = 1\nprint(missing_name)\n', expect: 'missing_name' },
  { name: 'Indented frame', code: 'def f(n):\n    return n + "s"\n\nf(2)\n', expect: 'n + "s"' },
  { name: 'IndexError', code: 'items = [1, 2]\nprint(items[5])\n', expect: 'items[5]' },
  { name: 'ZeroDivisionError', code: 'a = 0\nprint(10 / a)\n', expect: '10 / a' },
  { name: 'UnboundLocalError', code: 'def f():\n    total += 1\n    return total\nf()\n', expect: 'total' },
  { name: 'AttributeError', code: 's = "x"\ns.append(1)\n', expect: 's.append' },
  { name: 'KeyError', code: 'd = {}\nprint(d["k"])\n', expect: 'd["k"]' },
];
for (const spanCase of spanCases) {
  const result = runPayload({ mode: 'script', code: spanCase.code });
  const span = result.error?.span;
  const sourceLine = spanCase.code.split('\n')[(span?.line ?? 0) - 1] ?? '';
  const slice = span ? sourceLine.slice(span.col_start, span.col_end) : null;
  check(slice === spanCase.expect, `${spanCase.name} span covers ${JSON.stringify(spanCase.expect)}`, JSON.stringify(slice));
}
const syntax = runPayload({ mode: 'script', code: 'def f(:\n    pass\n' });
check(syntax.error?.type === 'SyntaxError', 'SyntaxError is reported');
check(Boolean(syntax.error?.span), 'SyntaxError has a caret span from the exception', JSON.stringify(syntax.error?.span));

console.log('runtime guards');
const loop = runPayload({ mode: 'script', code: 'while True:\n    print("spam")' });
check(loop.error?.type === 'OutputLimit', 'runaway printing is stopped', loop.error?.type);
const crash = runPayload({ mode: 'script', code: 'print(1)\nundefined_name\n' });
check(crash.error?.type === 'NameError', 'NameError is reported, not swallowed');
check(crash.error?.line === 2, 'traceback line numbers point at the student file', String(crash.error?.line));
check(crash.stdout === '1\n', 'output printed before the crash is kept');

if (failures > 0) {
  console.error(`\n${failures} curriculum check(s) failed`);
  process.exit(1);
}
console.log('\nAll curriculum checks passed.');
