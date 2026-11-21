import { describe, expect, it } from 'vitest';
import { scoreHelp } from '../src/ai/rubric';
import challenges from '../src/data/challenges.json';
import { benchCode } from '../src/data/challenges';

/**
 * What a 1.5B coder model plausibly returns, run through the same guard and
 * rubric the app uses. These are the shapes we expect: correct-but-chatty,
 * correct-but-leaky, polite-and-useless, and a wall of code.
 */

const byId = Object.fromEntries(challenges.map((challenge) => [challenge.id, challenge]));

function grade(id: string, mode: 'explain' | 'hint', text: string) {
  const challenge = byId[id];
  return scoreHelp(text, {
    mode,
    studentCode: benchCode(challenge),
    challenge: { concept: challenge.concept, leakPatterns: challenge.leakPatterns },
  });
}

describe('realistic model answers', () => {
  it('rewards a real explanation of the off-by-one', () => {
    const score = grade(
      'sum-to',
      'explain',
      'Your loop uses range(1, n), which stops before n, so with n = 3 you added 1 and 2 but never 3. The total is short by exactly the last number. Which number never made it into the total?',
    );
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(1);
    expect(score.band).toBe('good');
  });

  it('rewards the "best starts at zero" insight', () => {
    const score = grade(
      'find-max',
      'hint',
      'best is set to 0 before the loop, so what happens when every number is negative?',
    );
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(1);
    expect(score.band).toBe('good');
  });

  it('rewards the skipped-element insight', () => {
    const score = grade(
      'drop-negatives',
      'explain',
      'When you remove -1, the list shifts and -4 moves into the position the loop has already passed. Can you see why the next element gets skipped after a removal?',
    );
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(1);
    expect(score.total).toBeGreaterThan(0.8);
  });

  it('rewards naming the unbound local', () => {
    const score = grade(
      'total-price',
      'explain',
      'The error says total is a local variable that was read before anything was assigned to it. Which line is supposed to create it?',
    );
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(1);
  });

  it('rewards naming the type mismatch', () => {
    const score = grade(
      'describe-age',
      'hint',
      'Python will not join text and a number with +. What type is age, and what type does the left side of + expect?',
    );
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(1);
  });

  it('blocks the answer when the model writes the corrected loop', () => {
    const score = grade(
      'sum-to',
      'explain',
      'The problem is that range excludes n. Here is the fix:\n```python\nfor number in range(1, n + 1):\n```\nDo you see the difference?',
    );
    expect(score.accepted).toBe(false);
    expect(score.total).toBeLessThan(0.15);
  });

  it('blocks "you should add a line" style advice', () => {
    const score = grade(
      'total-price',
      'explain',
      'You should add a line at the top of the function that sets total to zero. Does that make sense?',
    );
    expect(score.accepted).toBe(false);
  });

  it('scores a polite non-answer as weak even though it breaks no rules', () => {
    const score = grade('drop-negatives', 'hint', 'There seems to be a problem with your loop. What do you think it is?');
    expect(score.accepted).toBe(true);
    expect(score.conceptScore).toBe(0);
    expect(score.band).toBe('weak');
  });

  it('penalises a correct but rambling answer', () => {
    const rambling = `Loops in Python are built on iterators, and iterators keep an internal position that advances on every step. ${'That position is what makes removal tricky. '.repeat(12)} What happens to that position when an item is removed?`;
    const score = grade('drop-negatives', 'explain', rambling);
    expect(score.formatScore).toBeLessThan(0.7);
  });
});
