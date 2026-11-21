# TraceGym Compiler

A Python compiler for beginners that runs entirely in the browser and shows you exactly where your program
broke. When something fails, the failing expression is underlined in the editor, the error sits in a card beside
it, and help arrives only when you press a button:

- **Explain error** — two sentences, plain words, about *this* error.
- **Fix this error** — the smallest patch that removes *that* error, shown as a red/green diff on the failing
  line, applied only when you press **Apply**.
- **Highlight error** — jump to the exact expression CPython marked with carets.

Python runs the code. The model never decides whether a program is correct.

**Model:** [`Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC`](docs/MODEL_CHOICE.md) (1.63 GB GPU memory, Apache-2.0,
code-tuned), with `LFM2.5-1.2B` for weak GPUs and `Qwen3.5-2B` when there is memory to spare. It is asked for
once, on first load, and can be declined.

## Run it

```bash
npm install          # also vendors Pyodide into public/pyodide/
npm run dev          # http://localhost:5173
```

Node 20+. Python 3.14 (Pyodide 314.0.8) runs in a Web Worker; nothing is executed on a server. The AI is a
separate, explicit download: the first visit asks, and nothing is fetched unless you say yes.

```bash
npm run verify            # unit + integration tests, curriculum proof, typecheck, production build
npm test                  # 70 tests
npm run verify:curriculum # runs every bug through real CPython and asserts the behaviour
npm run build && npm run preview
```

## How it answers

The model is deliberately limited. The rules are in the UI under **How it answers**, and enforced in code:

| Rule | Enforced by |
| --- | --- |
| Explains only when asked | Nothing runs on a keystroke or on a failed run; each answer is one explicit button press. |
| Two sentences, plain words | System prompt, then `applyGuard` cuts to two sentences plus the question, and rejects code, diffs and "you should…" advice. |
| Only the reported error | The prompt contains the numbered program, the error, the failing line and the marked expression — no other context. |
| Fixes stay local | The model must return `{"line", "lines", "replacement", "why"}`. `validateFix` rejects anything more than ±2 lines from the error, more than 3 replaced lines, a flattened indent, a no-op, or a rewrite of the program. |
| Nothing changes without consent | A valid patch is rendered as a diff card in the editor. `Apply` performs that exact edit and re-runs Python; `Dismiss` leaves the code untouched. |
| Never judges correctness | The interpreter's exit status, output check and tests are the only sources of truth. |

The first-run dialog is the only thing that asks for the model; after that the pill in the corner shows whether
it is on device.

## What is actually verified

Tests changed the implementation several times while writing this; the ones below are the load-bearing ones.

| Check | How |
| --- | --- |
| Every starter reproduces its advertised bug class | `scripts/verify-curriculum.mjs` runs each starter in real CPython and asserts the intended failure (`UnboundLocalError`, `TypeError`, wrong answer, …). |
| Every reference fix passes every test | Same script. Solutions live in `tests/fixtures/solutions.json`, which the app never imports. |
| Error spans cover the right expression | The same script asserts the caret-derived column range for 8 exception types (including indented frames and `SyntaxError`, which has no traceback). |
| Tracebacks point at the student's file | The harness drops its own frames; asserted for line and column. |
| Runaway output and infinite loops are contained | Capped `stdout` (200 kB) and a 10 s timeout that recycles the interpreter. |
| A fix cannot rewrite the program | `tests/fix.test.ts`: locality, size, indent, no-op and malformed-JSON cases, plus insertion (`lines: 0`) and deletion. |
| Fix → diff → apply → re-run works end to end | `tests/fix-flow.test.ts` drives the real app with a stub model and a stub interpreter. |
| The editor underlines exactly the marked span | `tests/editor.test.ts` mounts real CodeMirror, checks the highlighted text and the line-removal/insert semantics. |
| Explanations cannot contain code or fix instructions | `tests/guard.test.ts`, including "what if the loop used `n + 1`?" and quoting the fix back after the student already wrote it. |
| The first visit asks for the model download | `tests/app.smoke.test.ts` boots the real `index.html` plus the real app module. |

**Not verified here:** the sandbox has no browser and no GPU, so the WebGPU inference path, the service-worker
offline flow and the visual layout were not exercised end to end. Python was exercised headlessly in Node with
the same `harness.py` the worker loads. Run `npm run dev` in Chrome/Edge 113+ to exercise the model.

## How the pieces fit

```
index.html                 compiler layout, error card, help bar, download dialog
src/
  main.ts                  state, run loop, error card, explain/fix/highlight wiring, first run
  runner/
    worker.ts              loads Pyodide from /pyodide/ (CDN fallback) inside a Worker
    harness.py             exec, tracebacks, caret→column spans, tests, capped output
    client.ts              serialised RPC, timeouts, worker recycling
  ai/
    fix.ts                 repair contract: prompt, JSON parsing, validation, apply
    guard.ts               enforcement for explanations (no code, no fix instructions)
    prompt.ts              tutor prompt, evidence formatting, token budgets
    rubric.ts              deterministic scoring used by Model Lab and tests
    fallbacks.ts           built-in questions, no model required
    worker.ts / client.ts  inference worker + RPC (WebLLM fetched lazily)
  ui/
    editor.ts              CodeMirror: error span mark, inline fix card, line patching
    render.ts              output/test renderers
    model-lab.ts           on-device model comparison
tests/                     vitest suites, reference solutions
scripts/                   pyodide vendoring, curriculum proof
docs/MODEL_CHOICE.md       model research, decision matrix, measurement protocol
```

### Design decisions worth knowing

- **The caret line is the highlight.** CPython 3.11+ already marks the failing sub-expression with `^`/`~`.
  TraceGym maps those columns back through the frame indent and the line's own indentation, so the underline is
  the interpreter's opinion, not a regex guess.
- **A patch is a proposal, not an edit.** The model returns JSON; the app validates it, renders the diff, and
  performs the edit itself. That keeps a 1.5B model away from the document and makes every change auditable.
- **Explanations and patches use different guards.** Explanations are text and must not contain code; patches
  are code and must not contain anything *but* the fix. Same promise, opposite checks.
- **The AI can stay off.** Every exception type maps to a built-in question, so the compiler and Debug Lab are
  useful with no download and no network.
- **Lazy by default.** WebLLM (~6 MB) is a separate chunk fetched only when a model is turned on; the base app
  is ~524 kB of JS (176 kB gzipped) including CodeMirror.

## Privacy and offline

- Code, errors and prompts never leave the device; there is no backend.
- Python is served from this origin and cached by `public/sw.js`, which the page tops up once the interpreter is
  ready — so compile-and-run works with the network off after the first visit.
- Model weights are cached by WebLLM in the Cache API; "remove from device" deletes them.
- Nothing is downloaded or executed for the AI until the first-run prompt is accepted.

## Licence notes

App code follows this repository. Model weights are separate: Qwen2.5-Coder and Qwen3.5 are Apache-2.0;
LFM2.5 uses the LFM Open License 1.0, which has commercial conditions — read it before shipping LFM as the default.

## Next steps

1. Add fix cases to Model Lab: ask each model for a patch, apply it in the runner, and score "error gone / tests
   pass". The validator and the runner already make that measurable.
2. Run Model Lab on real student hardware and keep the JSON exports (see docs §6).
3. LoRA a 0.5–1.5B model on `(traceback → Socratic question)` and `(traceback → minimal patch)` pairs; the rubric,
   the validator and the curriculum script are already the eval harness.
