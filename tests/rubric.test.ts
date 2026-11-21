import { describe, expect, it } from 'vitest';
import { meanScore, scoreHelp } from '../src/ai/rubric';
import challenges from '../src/data/challenges.json';

const sumTo = challenges.find((c) => c.id === 'sum-to')!;

const context = {
  mode: 'hint' as const,
  studentCode: sumTo.starter,
  challenge: { concept: sumTo.concept, leakPatterns: sumTo.leakPatterns },
};

describe('rubric: rewards hints, punishes answers', () => {
  it('scores a concept-pointing question as good', () => {
    const score = scoreHelp('Which numbers does range(1, n) visit when n is 3, and which one is missing?', context);
    expect(score.conceptScore).toBe(1);
    expect(score.accepted).toBe(true);
    expect(score.band).toBe('good');
  });

  it('scores a leaked fix near zero', () => {
    const score = scoreHelp('Use range(1, n + 1) so the loop includes n.', context);
    expect(score.accepted).toBe(false);
    expect(score.total).toBeLessThan(0.15);
  });

  it('scores a vague but harmless answer as usable at best', () => {
    const score = scoreHelp('There is a problem with your loop. What do you think it is?', context);
    expect(score.conceptScore).toBe(0);
    expect(score.total).toBeLessThan(0.8);
  });

  it('penalises an unasked-for essay', () => {
    const long = `Python has many rules about loops and ranges and here is a long story about them. ${'It keeps going. '.repeat(30)} Why?`;
    const score = scoreHelp(long, { ...context, mode: 'explain' });
    expect(score.formatScore).toBeLessThan(0.6);
    expect(score.wordCount).toBeLessThan(130);
  });

  it('averages scores for the Model Lab table', () => {
    const a = scoreHelp('Which numbers does range(1, n) visit?', context);
    const b = scoreHelp('Use range(1, n + 1).', context);
    expect(meanScore([a, b])).toBeGreaterThan(0);
    expect(meanScore([a, b])).toBeLessThan(a.total);
    expect(meanScore([])).toBe(0);
  });
});
