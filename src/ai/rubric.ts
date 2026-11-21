import { applyGuard, type GuardFlag } from './guard';
import type { HelpMode } from './prompt';

/**
 * Deterministic scoring for tutor answers.
 *
 * There is no judge model here on purpose: a scorer the student can inspect is
 * more trustworthy than a second LLM, and it makes model comparison (Model Lab)
 * reproducible offline. Three things are measured:
 *
 *   concept  - did it point at the actual idea behind this bug?  (what we buy)
 *   guard    - did it avoid code, diffs, and fix instructions?   (a gate, not a virtue)
 *   format   - is it short and does it end with a question, as asked?
 *
 * Guard compliance is deliberately not worth much on its own: a model that says
 * "have another look at your loop?" breaks no rules and teaches nothing.
 */

export interface RubricChallenge {
  concept: string;
  leakPatterns?: string[];
}

export interface RubricContext {
  mode: HelpMode;
  studentCode: string;
  challenge?: RubricChallenge;
  errorType?: string | null;
  /**
   * When there is no challenge to match against (Playground), this substring
   * must appear for the concept point - normally the exception type.
   */
  expectedConcept?: string | null;
}

export interface HelpScore {
  total: number;
  guardScore: number;
  conceptScore: number;
  formatScore: number;
  accepted: boolean;
  flags: GuardFlag[];
  wordCount: number;
  rawWordCount: number;
  endsWithQuestion: boolean;
  band: 'good' | 'usable' | 'weak';
}

function conceptScore(text: string, context: RubricContext): number {
  if (context.challenge) {
    try {
      return new RegExp(context.challenge.concept, 'i').test(text) ? 1 : 0;
    } catch {
      return 0;
    }
  }
  const needle = context.expectedConcept ?? context.errorType ?? null;
  if (!needle) return 0.5;
  return text.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0;
}

/**
 * Length is measured on what the model actually produced, not on the trimmed
 * text we end up showing: a model that needs four paragraphs to say one thing
 * should not look as good as a model that says it in two sentences.
 */
function formatScore(raw: string, mode: HelpMode, wordCount: number, endsWithQuestion: boolean): number {
  if (mode === 'hint') {
    return (endsWithQuestion ? 0.6 : 0) + (wordCount <= 35 ? 0.4 : 0.15);
  }
  const sentenceCount = raw.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  const conciseness = wordCount <= 70 ? 0.4 : wordCount <= 100 ? 0.2 : 0;
  const structure = sentenceCount >= 2 && sentenceCount <= 4 ? 0.3 : sentenceCount <= 6 ? 0.15 : 0;
  return (endsWithQuestion ? 0.3 : 0) + conciseness + structure;
}

export function scoreHelp(raw: string, context: RubricContext): HelpScore {
  const report = applyGuard(raw, {
    mode: context.mode,
    studentCode: context.studentCode,
    leakPatterns: context.challenge?.leakPatterns,
  });
  const guardScore = report.accepted ? 1 : 0;
  const concept = conceptScore(raw, context);
  const rawWordCount = raw.trim().split(/\s+/).filter(Boolean).length;
  const format = formatScore(raw, context.mode, rawWordCount, report.endsWithQuestion);
  const total = report.accepted ? 0.25 * guardScore + 0.55 * concept + 0.2 * format : 0.1 * concept;
  return {
    total: Math.round(total * 1000) / 1000,
    guardScore,
    conceptScore: concept,
    formatScore: Math.round(format * 1000) / 1000,
    accepted: report.accepted,
    flags: report.flags,
    wordCount: report.wordCount,
    rawWordCount,
    endsWithQuestion: report.endsWithQuestion,
    band: total >= 0.8 ? 'good' : total >= 0.5 ? 'usable' : 'weak',
  };
}

export function meanScore(scores: HelpScore[]): number {
  if (scores.length === 0) return 0;
  return Math.round((scores.reduce((sum, score) => sum + score.total, 0) / scores.length) * 1000) / 1000;
}
