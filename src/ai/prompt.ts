import type { RunResult } from '../runner/types';

export type HelpMode = 'explain' | 'hint';
/** Everything the local model is asked to generate. */
export type GenMode = HelpMode | 'fix';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HelpContext {
  mode: HelpMode;
  code: string;
  result: RunResult;
  goal?: string | null;
  challengeTitle?: string | null;
}

const SYSTEM_TUTOR = `You are TraceGym's debugging tutor. A beginner wrote the Python program and has just run it. You can see their code and the evidence from the run. They pressed a button to ask you about one error; they did not ask for a review.

Hard rules:
1. Never write code. No code blocks, no corrected lines, no diffs, no "change this to that".
2. You may quote a few words of their existing code, but never new code they have not written.
3. Say what Python actually did: which line, which value, which rule was broken.
4. Talk only about the error you were given. Do not review the rest of the program, do not add advice, do not ask them to run something else.
5. Short and simple: two sentences, the words a beginner already knows. Explain a term only if you have to use it. No preamble, no lists, no summaries.
6. If you are not sure, ask a question instead of guessing.
7. Never say the program is correct or incorrect - the tests decide that.`;

const MODE_RULES: Record<HelpMode, string> = {
  explain:
    'Explain what went wrong in at most 2 short sentences, then ask exactly one short question that helps them find the fix themselves. Never state the fix.',
  hint:
    'Give exactly one hint, phrased as a single question of at most 25 words. No explanation, no preamble, no code. End with a question mark.',
};

/** Trim a program to something a 4k-context model can chew on. */
export function numberCode(code: string, maxChars = 1800): string {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const numbered: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = `${i + 1}| ${lines[i]}`;
    if (used + line.length > maxChars) {
      truncated = true;
      break;
    }
    numbered.push(line);
    used += line.length + 1;
  }
  if (truncated) numbered.push('... (rest of the file omitted)');
  return numbered.join('\n');
}

/** The single most useful traceback frame, without the harness noise. */
function lastFrame(error: RunResult['error']): string {
  if (!error) return '';
  if (!error.traceback) return `${error.type}: ${error.message}`;
  const lines = error.traceback.trimEnd().split('\n');
  return lines.slice(-6).join('\n');
}

/** Plain-text evidence block. Also reused by the UI and by the Model Lab. */
export function describeOutcome(result: RunResult): string {
  if (result.status === 'timeout') {
    return 'The program was stopped after running too long. It may contain a loop that never ends.';
  }
  if (result.error) {
    const where = result.error.line ? ` at line ${result.error.line}` : '';
    const snippet = result.error.snippet ? `\nThat line is: ${result.error.snippet}` : '';
    return `The program crashed${where} with:\n${result.error.type}: ${result.error.message}${snippet}\nTraceback (last frames):\n${lastFrame(result.error)}`;
  }
  if (result.mode === 'tests' && result.tests.length > 0) {
    const failed = result.tests.filter((test) => !test.passed);
    if (failed.length === 0) return 'All tests passed.';
    const details = failed
      .slice(0, 3)
      .map((test) => {
        if (test.error) {
          return `Test ${test.call} raised ${test.error.type}: ${test.error.message}`;
        }
        const expected = test.expect ?? test.expect_output ?? '(none)';
        return `Test ${test.call}\nexpected: ${expected}\nactual: ${test.actual ?? '(nothing returned)'}`;
      })
      .join('\n\n');
    return `The program did not crash, but ${failed.length} of ${result.tests.length} tests failed.\n\n${details}`;
  }
  if (result.output_match && !result.output_match.match) {
    const diff = result.output_match.first_difference;
    return `The program ran, but its output did not match.\nExpected output:\n${result.output_match.expected_lines.join('\n')}\nActual output:\n${result.output_match.actual_lines.join('\n')}${
      diff ? `\nFirst difference is on line ${diff.line}.` : ''
    }`;
  }
  return 'The program ran without an error.';
}

export function buildMessages(context: HelpContext): ChatMessage[] {
  const { mode, code, result, goal, challengeTitle } = context;
  const parts: string[] = [];
  if (challengeTitle) parts.push(`EXERCISE: ${challengeTitle}`);
  if (goal) parts.push(`GOAL: ${goal}`);
  parts.push(`THE STUDENT'S PROGRAM (line numbers added by the editor):\n${numberCode(code)}`);
  parts.push(`WHAT HAPPENED WHEN IT RAN:\n${describeOutcome(result)}`);
  parts.push(
    mode === 'explain'
      ? 'In 3 sentences or fewer: what did Python actually do, and why? Then one question that helps them find the fix. No code.'
      : 'One hint only, as a single question of 25 words or fewer. No code, no explanation.',
  );

  return [
    { role: 'system', content: `${SYSTEM_TUTOR}\n\n${MODE_RULES[mode]}` },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export const GENERATION_PARAMS: Record<GenMode, { maxTokens: number; temperature: number; topP: number }> = {
  explain: { maxTokens: 220, temperature: 0.2, topP: 0.9 },
  hint: { maxTokens: 96, temperature: 0.25, topP: 0.9 },
  // A patch is short and must be exact: low temperature, no room to ramble.
  fix: { maxTokens: 280, temperature: 0.1, topP: 0.9 },
};
