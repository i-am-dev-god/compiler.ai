import { describe, expect, it } from 'vitest';
import { applyFix, buildFixMessages, extractJsonObject, validateFix } from '../src/ai/fix';
import type { PyError } from '../src/runner/types';

const code = `def describe_age(age):
    return "You are " + age + " years old"


print(describe_age(12))
`;

const error: PyError = {
  type: 'TypeError',
  message: 'can only concatenate str (not "int") to str',
  line: 2,
  snippet: '    return "You are " + age + " years old"',
  span: { line: 2, col_start: 11, col_end: 27 },
  traceback: 'Traceback (most recent call last):\n  File "student.py", line 2, in describe_age\nTypeError: ...',
};

const patch = (line: number, lines: number, replacement: string, why = 'convert the number to text') =>
  JSON.stringify({ line, lines, replacement, why });

describe('fix contract', () => {
  it('accepts the smallest correct edit', () => {
    const result = validateFix(patch(2, 1, '    return "You are " + str(age) + " years old"'), code, error);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.line).toBe(2);
    expect(result.patch.lines).toBe(1);
    expect(result.patch.why).toBe('convert the number to text');

    const applied = applyFix(code, result.patch);
    expect(applied.code).toContain('str(age)');
    expect(applied.code.split('\n')).toHaveLength(code.split('\n').length);
    expect(applied.removed).toEqual(['    return "You are " + age + " years old"']);
  });

  it('survives fences and chatter around the JSON', () => {
    const reply = `Sure! Here is the fix:\n\`\`\`json\n${patch(2, 1, '    return f"You are {age} years old"')}\n\`\`\`\nHope that helps.`;
    const result = validateFix(reply, code, error);
    expect(result.ok).toBe(true);
  });

  it('salvages almost-JSON', () => {
    const reply = `{"line": 2, "lines": 1, "replacement": "    return f\\"You are {age} years old\\"", "why": "use an f-string"}`;
    const result = validateFix(reply, code, error);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.replacement[0]).toContain('f"You are {age} years old"');
  });

  it('supports inserting a missing line', () => {
    const loopCode = `def total_price(prices):
    for price in prices:
        total += price
    return total
`;
    const loopError: PyError = { ...error, type: 'UnboundLocalError', line: 2, snippet: '    for price in prices:' };
    const result = validateFix(patch(2, 0, '    total = 0', 'initialise the accumulator first'), loopCode, loopError);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyFix(loopCode, result.patch);
    expect(applied.code.split('\n')[1]).toBe('    total = 0');
    expect(applied.code.split('\n')[2]).toBe('    for price in prices:');
  });

  it('supports deleting a stray line', () => {
    const strayCode = 'x = 1\nprint(x)\n';
    const strayError: PyError = { ...error, line: 1, snippet: 'x = 1' };
    const result = validateFix(patch(1, 1, ''), strayCode, strayError);
    expect(result.ok).toBe(true);
    if (result.ok) expect(applyFix(strayCode, result.patch).code).toBe('print(x)\n');
  });

  it('refuses a fix on a different part of the program', () => {
    const result = validateFix(patch(5, 1, 'print("something else")'), code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('only applies repairs at the error');
  });

  it('refuses a rewrite of the whole program', () => {
    const result = validateFix(patch(2, 3, 'line a\nline b\nline c\nline d\nline e'), code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than (three|four) lines/);
  });

  it('refuses a line number outside the file', () => {
    const result = validateFix(patch(99, 1, 'x = 1'), code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('program has');
  });

  it('refuses a no-op', () => {
    const result = validateFix(patch(2, 1, '    return "You are " + age + " years old"'), code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('identical');
  });

  it('refuses to unindent a block', () => {
    const result = validateFix(patch(2, 1, 'return str(age)'), code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('indentation');
  });

  it('passes through "needs a larger change" as a message, not a patch', () => {
    const result = validateFix('{"line": 0, "lines": 0, "replacement": "", "why": "needs a larger change"}', code, error);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('needs a larger change');
  });

  it('rejects prose, empty replies and missing line numbers', () => {
    expect(validateFix('I would use an f-string here.', code, error).ok).toBe(false);
    expect(validateFix('   ', code, error).ok).toBe(false);
    expect(validateFix('{"replacement": "x = 1"}', code, error).ok).toBe(false);
  });

  it('trims an over-long explanation', () => {
    const result = validateFix(patch(2, 1, '    return f"You are {age} years old"', 'word '.repeat(40)), code, error);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch.why.split(' ').length).toBeLessThanOrEqual(25);
  });
});

describe('fix prompt', () => {
  it('gives the model the error, the line and the marked expression', () => {
    const messages = buildFixMessages(code, error);
    expect(messages[0].content).toContain('one JSON object');
    expect(messages[0].content).toContain('Fix only the reported error');
    expect(messages[1].content).toContain('1| def describe_age(age):');
    expect(messages[1].content).toContain('AT LINE 2');
    expect(messages[1].content).toContain('THE MARKED EXPRESSION: "You are " + age');
  });

  it('numbers the code so the model can point at a line', () => {
    const body = buildFixMessages(code, error)[1].content;
    expect(body).toContain('1| def describe_age(age):');
    expect(body).toContain('2|     return "You are " + age + " years old"');
  });
});
