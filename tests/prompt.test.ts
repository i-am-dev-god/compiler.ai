import { describe, expect, it } from 'vitest';
import { buildMessages, describeOutcome, GENERATION_PARAMS, numberCode } from '../src/ai/prompt';
import type { RunResult } from '../src/runner/types';

const crash: RunResult = {
  mode: 'tests',
  status: 'error',
  stdout: '',
  stderr: '',
  error: {
    type: 'TypeError',
    message: 'can only concatenate str (not "int") to str',
    line: 2,
    snippet: 'return "You are " + age + " years old"',
    traceback: 'Traceback:\n  File "student.py", line 2, in describe_age\nTypeError: can only concatenate str (not "int") to str',
  },
  tests: [],
  output_match: null,
  passed_count: 0,
  test_count: 2,
  duration_ms: 3,
};

const failedTests: RunResult = {
  ...crash,
  status: 'failed',
  error: null,
  tests: [
    { name: 'sum_to(3)', call: 'sum_to(3)', expect: '6', actual: '3', stdout: '', passed: false, error: null },
    { name: 'sum_to(5)', call: 'sum_to(5)', expect: '15', actual: '10', stdout: '', passed: false, error: null },
    { name: 'sum_to(1)', call: 'sum_to(1)', expect: '1', actual: '1', stdout: '', passed: true, error: null },
  ],
};

describe('prompt: what the model is allowed to see', () => {
  it('numbers the code so the model can name a line', () => {
    const text = numberCode('def f():\n    return 1');
    expect(text).toBe('1| def f():\n2|     return 1');
  });

  it('never sends an unbounded program', () => {
    const long = 'x = 1\n'.repeat(600);
    const text = numberCode(long, 500);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('rest of the file omitted');
  });

  it('describes a crash with the exception, line and snippet', () => {
    const text = describeOutcome(crash);
    expect(text).toContain('TypeError');
    expect(text).toContain('line 2');
    expect(text).toContain('return "You are " + age');
  });

  it('describes a wrong answer with input, expected and actual', () => {
    const text = describeOutcome(failedTests);
    expect(text).toContain('2 of 3 tests failed');
    expect(text).toContain('sum_to(3)');
    expect(text).toContain('expected: 6');
    expect(text).toContain('actual: 3');
    expect(text).not.toContain('sum_to(1)');
  });

  it('does not claim correctness on its own', () => {
    const passing: RunResult = { ...failedTests, status: 'passed', tests: [{ ...failedTests.tests[0], passed: true, actual: '6' }] };
    expect(describeOutcome(passing)).toContain('All tests passed');
  });

  it('builds a short prompt with the goal and one mode instruction', () => {
    const messages = buildMessages({
      mode: 'hint',
      code: 'def sum_to(n):\n    return n',
      result: failedTests,
      goal: 'sum every number up to n',
      challengeTitle: 'Sum from 1 to n',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Never write code');
    expect(messages[0].content).toContain('single question');
    expect(messages[1].content).toContain('sum every number up to n');
    expect(messages[1].content).toContain('1| def sum_to(n):');
    expect(messages[1].content).toContain('expected: 6');
    expect(messages[1].content.length).toBeLessThan(3000);
  });

  it('keeps generation tight enough to feel instant', () => {
    expect(GENERATION_PARAMS.hint.maxTokens).toBeLessThanOrEqual(100);
    expect(GENERATION_PARAMS.explain.maxTokens).toBeLessThanOrEqual(250);
    expect(GENERATION_PARAMS.explain.temperature).toBeLessThan(0.5);
  });
});
