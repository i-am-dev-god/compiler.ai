export type RunMode = 'script' | 'tests';

export interface TestSpec {
  name?: string;
  call: string;
  expect?: string;
  expect_output?: string;
}

export interface ErrorSpan {
  line: number;
  /** Character offsets into the source line, 0-based, end exclusive. */
  col_start: number;
  col_end: number;
}

export interface PyError {
  type: string;
  message: string;
  line: number | null;
  snippet: string | null;
  /** The exact expression CPython marked with carets, when it reported one. */
  span: ErrorSpan | null;
  traceback: string;
}

export interface TestResult {
  name: string;
  call: string;
  expect?: string | null;
  expect_output?: string | null;
  actual: string | null;
  stdout: string;
  passed: boolean;
  blocked?: boolean;
  error: PyError | null;
}

export interface OutputComparison {
  match: boolean;
  actual_lines: string[];
  expected_lines: string[];
  first_difference: { line: number; actual: string | null; expected: string | null } | null;
}

export interface RunResult {
  mode: RunMode;
  status: 'ok' | 'passed' | 'failed' | 'error' | 'timeout';
  stdout: string;
  stderr: string;
  error: PyError | null;
  tests: TestResult[];
  output_match: OutputComparison | null;
  passed_count: number;
  test_count: number;
  duration_ms: number;
  /** Set by the TS side when the worker was killed for running too long. */
  timedOut?: boolean;
}

export interface RunOptions {
  mode: RunMode;
  code: string;
  tests?: TestSpec[];
  expectedOutput?: string | null;
  timeoutMs?: number;
}
