import type { PyError } from '../runner/types';
import { numberCode, type ChatMessage } from './prompt';

/**
 * "Fix this error" is a different job from "explain this error": it produces
 * code, so the guard that protects the tutor cannot be reused. Instead the
 * model returns a structured, minimal patch and TraceGym validates it before a
 * single character reaches the editor.
 *
 * The contract (also shown to the student in the UI):
 *   {"line": 2, "lines": 1, "replacement": "...", "why": "..."}
 * `line` is 1-based; `lines` is how many original lines are replaced (0 inserts
 * before `line`). Anything outside the error's neighbourhood is refused.
 */

export interface FixPatch {
  line: number;
  lines: number;
  replacement: string[];
  why: string;
}

export type FixResult = { ok: true; patch: FixPatch } | { ok: false; reason: string; raw?: string };

export const FIX_SYSTEM_PROMPT = `You are the repair step of TraceGym, a Python compiler for beginners.

You receive one program and one error. Return the smallest edit that removes that error, and nothing else.

Reply with exactly one JSON object, no prose and no markdown:
{"line": <first line to change, 1-based>, "lines": <how many existing lines to replace, 0-3>, "replacement": "<the new code, indentation included>", "why": "<one short clause, max 15 words>"}

Rules:
1. Fix only the reported error. Never rename, reformat, refactor or change behaviour that is not part of the fix.
2. "lines": 0 means insert the replacement before "line". Otherwise the replacement replaces exactly "lines" lines starting at "line".
3. Keep the existing indentation. "replacement" must be plain Python source, not markdown, and at most 3 lines.
4. Do not repeat unchanged lines.
5. If the fix needs more than 3 lines or you are not sure, reply {"line": 0, "lines": 0, "replacement": "", "why": "needs a larger change"} and nothing else.`;

export function buildFixMessages(code: string, error: PyError, goal?: string | null): ChatMessage[] {
  const parts: string[] = [];
  if (goal) parts.push(`GOAL OF THE PROGRAM: ${goal}`);
  parts.push(`PROGRAM (line numbers are annotations, not part of the code):\n${numberCode(code, 3000)}`);
  const where = error.line ? `\nAT LINE ${error.line}: ${error.snippet ?? ''}` : '';
  const span =
    error.span && error.line
      ? `\nTHE MARKED EXPRESSION: ${(error.snippet ?? '').slice(error.span.col_start, error.span.col_end)}`
      : '';
  parts.push(`ERROR: ${error.type}: ${error.message}${where}${span}`);
  parts.push('Return one JSON object with the smallest edit that removes this error.');

  return [
    { role: 'system', content: FIX_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** Pull the first balanced {...} out of a model reply, ignoring fences/prose. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function unescapeJsonString(literal: string): string {
  try {
    return JSON.parse(`"${literal}"`) as string;
  } catch {
    return literal.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/** Last-resort field extraction for replies that are almost JSON. */
function salvage(raw: string): Record<string, unknown> | null {
  const line = raw.match(/"line"\s*:\s*"?(\d+)"?/);
  const lines = raw.match(/"lines"\s*:\s*"?(\d+)"?/);
  const replacement = raw.match(/"replacement"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const why = raw.match(/"why"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!line && !replacement) return null;
  return {
    line: line ? Number(line[1]) : undefined,
    lines: lines ? Number(lines[1]) : undefined,
    replacement: replacement ? unescapeJsonString(replacement[1]) : undefined,
    why: why ? unescapeJsonString(why[1]) : undefined,
  };
}

function toLines(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const normalised = value.replace(/\r\n/g, '\n');
    if (normalised.trim() === '') return [];
    return normalised.replace(/\n+$/, '').split('\n');
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return (value as string[]).join('\n').replace(/\n+$/, '').split('\n');
  }
  return null;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Validate a raw model reply against the program it was given. Every rejection
 * is a sentence the UI can show verbatim.
 */
export function validateFix(raw: string, code: string, error: PyError | null): FixResult {
  if (!raw || !raw.trim()) return { ok: false, reason: 'The model returned nothing.', raw };

  let data: Record<string, unknown> | null = null;
  const json = extractJsonObject(raw);
  if (json) {
    try {
      data = JSON.parse(json) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!data) data = salvage(raw);
  if (!data) return { ok: false, reason: 'The model did not return a JSON object.', raw };

  const rawLine = typeof data.line === 'string' ? Number(data.line) : data.line;
  const line = Number.isFinite(rawLine) ? Math.trunc(Number(rawLine)) : NaN;
  const rawLines = typeof data.lines === 'string' ? Number(data.lines) : data.lines;
  const replaceCount = Number.isFinite(Number(rawLines)) ? Math.trunc(Number(rawLines)) : 1;
  const replacement = toLines(data.replacement);
  const why = typeof data.why === 'string' ? data.why.replace(/\s+/g, ' ').trim() : '';

  if (!Number.isFinite(line) || line < 0) {
    return { ok: false, reason: 'The model did not say which line to change.', raw };
  }
  if (line === 0) {
    return { ok: false, reason: why || 'The model thinks this needs a change bigger than three lines.', raw };
  }
  if (replacement === null) return { ok: false, reason: 'The model did not return any replacement code.', raw };

  const docLines = code.replace(/\r\n/g, '\n').split('\n');
  const total = docLines.length;
  if (line > total) {
    return { ok: false, reason: `The fix points at line ${line}, but the program has ${total} lines.`, raw };
  }
  if (replaceCount < 0 || replaceCount > 3) {
    return { ok: false, reason: 'The fix wanted to replace more than three lines, so it was refused.', raw };
  }
  if (replacement.length > 4) {
    return { ok: false, reason: 'The fix wanted to add more than four lines, so it was refused.', raw };
  }
  if (replacement.join('\n').length > 400) {
    return { ok: false, reason: 'The fix was too large to be a one-error repair.', raw };
  }

  // Locality: a fix for this error must be at or next to the failing line.
  if (error?.line) {
    const distance = Math.abs(line - error.line);
    if (distance > 2) {
      return {
        ok: false,
        reason: `The fix edits line ${line}, but the error is on line ${error.line}. TraceGym only applies repairs at the error.`,
        raw,
      };
    }
  }

  const replaced = docLines.slice(line - 1, line - 1 + replaceCount);
  if (replacement.length === 0 && replaced.length === 0) {
    return { ok: false, reason: 'The fix would do nothing.', raw };
  }
  if (replacement.join('\n') === replaced.join('\n')) {
    return { ok: false, reason: 'The fix is identical to what you already wrote.', raw };
  }
  if (replaceCount > 2 && replacement.length === 0) {
    return { ok: false, reason: 'The fix wanted to delete too much code, so it was refused.', raw };
  }

  // Do not let a repair silently unindent a block. Indentation errors are the
  // one case where moving a line left is the actual fix.
  const indentationError = error?.type === 'IndentationError' || error?.type === 'TabError';
  const oldIndent = replaced.length > 0 ? /^\s*/.exec(replaced[0])?.[0] ?? '' : '';
  const newIndent = replacement.length > 0 ? /^\s*/.exec(replacement[0])?.[0] ?? '' : '';
  if (!indentationError && oldIndent.length > newIndent.length) {
    return { ok: false, reason: 'The fix would have changed the indentation of the block.', raw };
  }

  const shortWhy = countWords(why) > 24 ? `${why.split(/\s+/).slice(0, 24).join(' ')}…` : why;
  return {
    ok: true,
    patch: { line, lines: replaceCount, replacement, why: shortWhy || 'smallest change at the error' },
  };
}

export interface AppliedFix {
  code: string;
  removed: string[];
  added: string[];
  firstLine: number;
  lastLine: number;
}

export function applyFix(code: string, patch: FixPatch): AppliedFix {
  const newline = code.includes('\r\n') ? '\r\n' : '\n';
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, patch.line - 1);
  const removed = lines.slice(start, start + patch.lines);
  const next = [...lines.slice(0, start), ...patch.replacement, ...lines.slice(start + patch.lines)];
  return {
    code: next.join(newline),
    removed,
    added: patch.replacement,
    firstLine: patch.line,
    lastLine: patch.line + patch.lines - 1,
  };
}

/** One-line summary of what the patch touches, for the inline card. */
export function describePatch(patch: FixPatch): string {
  if (patch.lines === 0) return `insert ${patch.replacement.length} line(s) before line ${patch.line}`;
  const span = patch.lines === 1 ? `line ${patch.line}` : `lines ${patch.line}–${patch.line + patch.lines - 1}`;
  return `rewrite ${span}`;
}
