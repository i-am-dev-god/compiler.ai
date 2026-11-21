import raw from './challenges.json';
import type { TestSpec } from '../runner/types';

export interface Challenge {
  id: string;
  title: string;
  bugClass: string;
  difficulty: number;
  goal: string;
  /** What the editor opens with. Empty means the student writes it from scratch. */
  starter: string;
  /**
   * The known-broken reference program, kept for the Model Lab and the
   * curriculum proof so that a blank exercise still has something measurable.
   * Never shown in the editor.
   */
  benchStarter?: string;
  tests: TestSpec[];
  /** Regex source describing the idea a good hint must reach. */
  concept: string;
  /** Deterministic hint used when the local model is off or its answer is rejected. */
  fallbackHint: string;
  expectedError: string | null;
  /** Regex sources for the known corrected lines. */
  leakPatterns: string[];
}

export const CHALLENGES: Challenge[] = raw as unknown as Challenge[];

export function challengeById(id: string): Challenge | undefined {
  return CHALLENGES.find((challenge) => challenge.id === id);
}

export const PLAYGROUND_STARTER = `# Compiler: write or paste any Python.
# Compare against expected output if you have it.

def average(numbers):
    total = 0
    for n in numbers:
        total += n
    return total / len(numbers)


print(average([2, 4, 6]))
`;

/** The program to measure against: the shipped starter, or its reference version. */
export function benchCode(challenge: Challenge): string {
  return challenge.benchStarter ?? challenge.starter;
}
