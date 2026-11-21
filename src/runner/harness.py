"""TraceGym Python harness.

Runs inside a Pyodide Web Worker. The TypeScript side calls ``run_tracegym``
with a JSON payload and gets JSON back. Nothing in here decides whether the
student's code is "good" - it only collects evidence (output, traceback,
test outcomes) the way CPython would.
"""

import builtins
import io
import json
import linecache
import sys
import time
import traceback
from ast import literal_eval

STUDENT_FILE = "student.py"
OUTPUT_LIMIT = 200_000


class OutputLimit(Exception):
    pass


class CappedIO(io.StringIO):
    """StringIO that refuses to buffer more than OUTPUT_LIMIT characters."""

    def __init__(self, limit=OUTPUT_LIMIT):
        super().__init__()
        self._limit = limit

    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        room = self._limit - self.tell()
        if room <= 0:
            raise OutputLimit("output limit reached")
        if len(s) > room:
            super().write(s[:room])
            raise OutputLimit("output limit reached")
        return super().write(s)


def _install_source(code):
    lines = code.splitlines(True)
    linecache.cache[STUDENT_FILE] = (len(code), None, lines, STUDENT_FILE)


def _clean_traceback(exc):
    """Format an exception with the harness frame(s) stripped off."""
    tb = exc.__traceback__
    # The first frame is this harness (exec / eval); drop it so line numbers
    # point at the student's file.
    if tb is not None:
        tb = tb.tb_next
    text = "".join(traceback.format_exception(type(exc), exc, tb))
    return text, tb


def _error_payload(exc):
    text, tb = _clean_traceback(exc)
    line = None
    frame = tb
    while frame is not None:
        line = frame.tb_lineno
        frame = frame.tb_next
    message = str(exc)
    name = type(exc).__name__
    snippet = None
    if line:
        src = linecache.getline(STUDENT_FILE, line).rstrip()
        snippet = src or None
    return {
        "type": name,
        "message": message,
        "line": line,
        "snippet": snippet,
        "traceback": text,
    }


def _normalise_output(text):
    if not isinstance(text, str):
        text = str(text)
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def _compare_output(actual, expected):
    a = _normalise_output(actual)
    e = _normalise_output(expected)
    match = a == e
    detail = None
    if not match:
        for i in range(max(len(a), len(e))):
            got = a[i] if i < len(a) else None
            want = e[i] if i < len(e) else None
            if got != want:
                detail = {"line": i + 1, "actual": got, "expected": want}
                break
    return {
        "match": match,
        "actual_lines": a,
        "expected_lines": e,
        "first_difference": detail,
    }


def _values_equal(actual, expected_repr):
    """Compare against the test's expected Python value.

    Expected is stored as a Python literal (e.g. ``6``, ``[3, 5]``,
    ``'HELLO'``). We compare value *and* type so ``True`` does not count as
    ``1``, which is exactly the kind of thing beginners need to see.
    """
    try:
        expected = literal_eval(expected_repr)
    except (ValueError, SyntaxError):
        return repr(actual) == expected_repr.strip()
    if type(actual) is not type(expected):
        if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
            return actual == expected
        return False
    return actual == expected


def _execute(code):
    """Execute student code and return (namespace, stdout, stderr, error)."""
    _install_source(code)
    namespace = {"__name__": "__main__", "__builtins__": builtins, "__file__": STUDENT_FILE}
    out, err = CappedIO(), CappedIO()
    real_out, real_err = sys.stdout, sys.stderr
    error = None
    sys.stdout, sys.stderr = out, err
    try:
        exec(compile(code, STUDENT_FILE, "exec"), namespace)
    except BaseException as exc:  # noqa: BLE001 - we want SyntaxError etc. too
        error = _error_payload(exc)
    finally:
        sys.stdout, sys.stderr = real_out, real_err
    return namespace, out.getvalue(), err.getvalue(), error


def _run_test(namespace, test):
    """Call one test expression and compare its value or printed output."""
    call = test.get("call") or test.get("name")
    expect = test.get("expect")
    expect_output = test.get("expect_output")
    result = {
        "name": test.get("name") or call,
        "call": call,
        "expect": expect,
        "expect_output": expect_output,
        "actual": None,
        "stdout": "",
        "passed": False,
        "error": None,
    }
    out = CappedIO()
    real_out = sys.stdout
    sys.stdout = out
    try:
        value = eval(compile(call, STUDENT_FILE, "eval"), namespace)
        result["actual"] = repr(value)
        if expect_output is not None:
            result["passed"] = _compare_output(out.getvalue(), expect_output)["match"]
        elif expect is not None:
            result["passed"] = _values_equal(value, expect)
    except BaseException as exc:  # noqa: BLE001
        result["error"] = _error_payload(exc)
    finally:
        sys.stdout = real_out
        result["stdout"] = out.getvalue()
        if result["actual"] is None and result["error"] is None:
            result["actual"] = "None"
    return result


def run_tracegym(payload_json):
    started = time.perf_counter()
    payload = json.loads(payload_json)
    code = payload.get("code") or ""
    mode = payload.get("mode") or "script"
    tests = payload.get("tests") or []
    expected_output = payload.get("expected_output")

    namespace, stdout, stderr, error = _execute(code)

    response = {
        "mode": mode,
        "stdout": stdout,
        "stderr": stderr,
        "error": error,
        "tests": [],
        "output_match": None,
        "status": "ran",
    }

    if mode == "script":
        if error is not None:
            response["status"] = "error"
        elif expected_output is not None and expected_output.strip() != "":
            comparison = _compare_output(stdout, expected_output)
            response["output_match"] = comparison
            response["status"] = "passed" if comparison["match"] else "failed"
        else:
            response["status"] = "ok"
    else:
        if error is not None:
            # The program itself failed to import/execute: still report tests as
            # blocked rather than silently passing.
            response["status"] = "error"
            for test in tests:
                response["tests"].append(
                    {
                        "name": test.get("name") or test.get("call"),
                        "call": test.get("call"),
                        "expect": test.get("expect"),
                        "expect_output": test.get("expect_output"),
                        "actual": None,
                        "stdout": "",
                        "passed": False,
                        "error": None,
                        "blocked": True,
                    }
                )
        else:
            for test in tests:
                response["tests"].append(_run_test(namespace, test))
            passed = sum(1 for t in response["tests"] if t["passed"])
            response["status"] = "passed" if passed == len(response["tests"]) else "failed"

    response["passed_count"] = sum(1 for t in response["tests"] if t["passed"])
    response["test_count"] = len(response["tests"])
    response["duration_ms"] = round((time.perf_counter() - started) * 1000, 2)
    return json.dumps(response)
