import type { HelpMode } from './prompt';

/**
 * TraceGym's promise is that the local model never edits the code and never
 * decides correctness. A system prompt is a request, not a guarantee - small
 * models will happily emit a fix. This module is the enforcement layer: every
 * word the model produces passes through here before it is shown, and anything
 * that hands over the answer is discarded in favour of the built-in hint.
 */

export type GuardFlag =
  | 'code-block'
  | 'new-code'
  | 'fix-instruction'
  | 'leaks-fix'
  | 'too-long'
  | 'no-question';

export interface GuardReport {
  text: string;
  accepted: boolean;
  flags: GuardFlag[];
  reasons: string[];
  wordCount: number;
  endsWithQuestion: boolean;
}

export interface GuardOptions {
  mode: HelpMode;
  studentCode: string;
  /** Regex sources from the challenge definition (known corrected lines). */
  leakPatterns?: string[];
}

const CODE_FENCE = /```|~~~|\b(?:def|class|import|from)\s+\w+\s*[(.]/;

/** A line that only makes sense as Python the student has not written yet. */
const STATEMENT_LINE = /^\s{0,8}(?:def |class |return |elif |else:|for \w+ in .*:|while .*:|if .*:|try:|except\b|with .*:|print\(|[A-Za-z_]\w*\s*(?:[-+*/]|\/\/|%)?=(?!=))/m;

const NEW_EXPRESSION = /\b(?:range|str|int|len|sorted|sum|list|enumerate|sorted|max|min|abs|round|float|bool)\s*\([^)]*\)/g;

const FIX_PHRASES: RegExp[] = [
  /\b(?:the )?(?:fix|solution|correct(?:ed)? (?:code|version|line))\b/i,
  /\bhere(?:'s| is) (?:the|your) (?:corrected|fixed|working)\b/i,
  /\byou (?:just )?(?:need|have) to\b/i,
  /\byou should (?:add|use|change|replace|move|delete|remove|write|put)\b/i,
  /\btry (?:adding|changing|replacing|using|putting)\b/i,
  /\b(?:add|insert|delete|remove|move) (?:a|an|the|one) (?:line|colon|bracket|parenthes|comma)\b/i,
  /\b(?:change|replace|swap|edit|rewrite|modify|update)\b[^.!?]{0,70}\b(?:to|with|into)\b/i,
  /\b(?:it|this) (?:should|needs to|has to) be\b/i,
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalise(code: string): string {
  return code.replace(/\s+/g, '');
}

/** Strip formatting the UI would render wrong, without rewriting meaning. */
export function cleanText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' [code removed] ')
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:hint|explanation|answer|response)\s*[:\-–]\s*/i, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function limit(text: string, mode: HelpMode): { text: string; truncated: boolean } {
  const parts = sentences(text);
  if (mode === 'hint') {
    // A hint is one question. If the model wrote a preamble, keep the question.
    const question = parts.find((part) => part.endsWith('?'));
    if (question && parts.length > 1) return { text: question, truncated: true };
    if (parts.length > 2) return { text: parts.slice(-2).join(' '), truncated: true };
    return { text, truncated: false };
  }
  // Two sentences of explanation plus one question. Anything past that is the
  // model lecturing, which is the thing students stop reading. Keep the
  // question even when it came last: dropping it turns advice into a command.
  if (parts.length > 3) {
    const question = parts.find((part) => part.endsWith('?'));
    const body = parts.filter((part) => !part.endsWith('?')).slice(0, 2);
    const kept = question ? [...body, question] : body.slice(0, 3);
    return { text: kept.join(' '), truncated: true };
  }
  return { text, truncated: false };
}

export function applyGuard(raw: string, options: GuardOptions): GuardReport {
  const flags: GuardFlag[] = [];
  const reasons: string[] = [];
  const student = normalise(options.studentCode);
  const cleaned = cleanText(raw);

  if (CODE_FENCE.test(raw)) {
    flags.push('code-block');
    reasons.push('contained a code block or a function definition');
  }

  // New code: an expression the student has not written, e.g. `range(1, n + 1)`
  // or `str(age)`. Quoting their own code back at them is fine.
  for (const match of raw.matchAll(NEW_EXPRESSION)) {
    const fragment = normalise(match[0]);
    if (fragment.length > 3 && !student.includes(fragment)) {
      flags.push('new-code');
      reasons.push(`introduced code the student has not written: ${match[0]}`);
      break;
    }
  }

  // Statements (assignments, loops, returns) are never acceptable in prose.
  const proseForStatements = raw.replace(/```[\s\S]*?```/g, '');
  if (STATEMENT_LINE.test(proseForStatements)) {
    const match = proseForStatements.match(STATEMENT_LINE);
    const line = match?.[0]?.trim() ?? '';
    if (line && !student.includes(normalise(line))) {
      flags.push('new-code');
      reasons.push(`looked like a code statement: ${line}`);
    }
  }

  // Imperative fix instructions. Questions are exempt: "what would happen if
  // you changed the stop value?" is a hint, not a patch.
  const declarative = sentences(cleaned).filter((sentence) => !sentence.endsWith('?'));
  for (const sentence of declarative) {
    const hit = FIX_PHRASES.find((pattern) => pattern.test(sentence));
    if (hit) {
      flags.push('fix-instruction');
      reasons.push(`told the student what to change: "${sentence.slice(0, 80)}"`);
      break;
    }
  }

  for (const pattern of options.leakPatterns ?? []) {
    try {
      const matcher = new RegExp(pattern, 'im');
      // If the corrected line is already in their code, quoting it back tells
      // them nothing they cannot see - only new code is a leak.
      if (matcher.test(student)) continue;
      if (matcher.test(raw)) {
        flags.push('leaks-fix');
        reasons.push('contained the corrected line');
        break;
      }
    } catch {
      /* a bad pattern in content must never break the tutor */
    }
  }

  const { text, truncated } = limit(cleaned, options.mode);
  if (truncated) flags.push('too-long');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (options.mode === 'hint' && wordCount > 45) flags.push('too-long');
  if (options.mode === 'explain' && wordCount > 110) flags.push('too-long');
  const endsWithQuestion = text.trimEnd().endsWith('?');
  if (!endsWithQuestion) flags.push('no-question');

  const blocking: GuardFlag[] = ['code-block', 'new-code', 'fix-instruction', 'leaks-fix'];
  const accepted = !flags.some((flag) => blocking.includes(flag));

  return {
    text: text || cleaned,
    accepted,
    flags: [...new Set(flags)],
    reasons: [...new Set(reasons)],
    wordCount,
    endsWithQuestion,
  };
}

/** Human-readable note for the UI when the guard rejects a model answer. */
export function guardReasonText(report: GuardReport): string {
  if (!report.reasons.length) return '';
  return report.reasons.join('; ');
}
