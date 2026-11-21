import { describe, expect, it } from 'vitest';
import { applyGuard, cleanText } from '../src/ai/guard';
import challenges from '../src/data/challenges.json';

const sumTo = challenges.find((c) => c.id === 'sum-to')!;
const age = challenges.find((c) => c.id === 'describe-age')!;

const sumToCode = sumTo.starter;
const ageCode = age.starter;

describe('guard: blocks answers, allows teaching', () => {
  it('accepts a short explanation that ends with a question', () => {
    const report = applyGuard(
      'Your loop visited 1 and 2, so the total was 3 instead of 6. The loop stops one number before n. What number would the loop have to reach to include n?',
      { mode: 'explain', studentCode: sumToCode, leakPatterns: sumTo.leakPatterns },
    );
    expect(report.accepted).toBe(true);
    expect(report.endsWithQuestion).toBe(true);
    expect(report.flags).not.toContain('new-code');
  });

  it('rejects a code block', () => {
    const report = applyGuard('Here you go:\n```python\ndef sum_to(n):\n    return n\n```', {
      mode: 'explain',
      studentCode: sumToCode,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(false);
    expect(report.flags).toContain('code-block');
    expect(report.text).not.toContain('def sum_to');
  });

  it('rejects the corrected line even without the word "change"', () => {
    const report = applyGuard('Try range(1, n + 1) instead.', {
      mode: 'hint',
      studentCode: sumToCode,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(false);
    expect(report.flags).toContain('new-code');
    expect(report.flags).toContain('leaks-fix');
  });

  it('rejects imperative fix instructions', () => {
    const report = applyGuard('You should add a line before the loop that sets the total to zero.', {
      mode: 'explain',
      studentCode: sumToCode,
    });
    expect(report.accepted).toBe(false);
    expect(report.flags).toContain('fix-instruction');
  });

  it('rejects a diff-shaped answer', () => {
    const report = applyGuard('- for number in range(1, n):\n+ for number in range(1, n + 1):', {
      mode: 'explain',
      studentCode: sumToCode,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(false);
  });

  it('allows quoting code the student already wrote', () => {
    const report = applyGuard('What does range(1, n) leave out when n is 3?', {
      mode: 'hint',
      studentCode: sumToCode,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(true);
  });

  it('rejects the corrected sentence for the str/int challenge', () => {
    const report = applyGuard('You need to wrap age in str(age) so the types match.', {
      mode: 'explain',
      studentCode: ageCode,
      leakPatterns: age.leakPatterns,
    });
    expect(report.accepted).toBe(false);
    expect(report.flags).toContain('new-code');
  });

  it('trims a hint down to its question', () => {
    const report = applyGuard(
      'Great question. Let me think about the loop. Which number does the loop stop at?',
      { mode: 'hint', studentCode: sumToCode },
    );
    expect(report.text).toBe('Which number does the loop stop at?');
    expect(report.flags).toContain('too-long');
  });

  it('marks a missing question without discarding the explanation', () => {
    const report = applyGuard('Python stops the range before n, so n itself is never added.', {
      mode: 'explain',
      studentCode: sumToCode,
    });
    expect(report.accepted).toBe(true);
    expect(report.flags).toContain('no-question');
  });

  it('rejects a fix smuggled in as a question', () => {
    const report = applyGuard('The loop stops early. What if the loop used n + 1 as its stop value?', {
      mode: 'hint',
      studentCode: sumToCode,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(false);
    expect(report.flags).toContain('leaks-fix');
  });

  it('allows quoting the fix once the student has already written it', () => {
    const fixed = sumToCode.replace('range(1, n)', 'range(1, n + 1)');
    const report = applyGuard('You changed range(1, n + 1) and now the last number is included. What made the difference?', {
      mode: 'explain',
      studentCode: fixed,
      leakPatterns: sumTo.leakPatterns,
    });
    expect(report.accepted).toBe(true);
  });

  it('strips markdown noise and leading labels', () => {
    expect(cleanText('**Hint:** the loop stops early.')).toBe('the loop stops early.');
  });
});
