# TraceGym

A browser-based Python workbench and debugging tutor. Two modes:

- **Playground** — write or paste any Python; optionally check the output against what you expected.
- **Debug Lab** — repair five deliberately broken programs with a stated goal and built-in tests.

When a program crashes you get the original Python traceback. When it runs but answers wrongly you
get the test input, the expected result and the actual result. Help is optional and never writes
code: a local model can explain the error or ask one guiding question, and anything that contains
code or a corrected line is discarded and replaced with a hand-written hint.

**Model recommendation: [`Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC`](docs/MODEL_CHOICE.md)** — 1.63 GB
of GPU memory, Apache-2.0, code-tuned, with `LFM2.5-1.2B` as the fast/low-memory option and
`Qwen3.5-2B` as the quality tier. The reasoning, the rejected candidates and the measurement
protocol are in **[docs/MODEL_CHOICE.md](docs/MODEL_CHOICE.md)**.

## Run it

```bash
npm install          # also vendors Pyodide into public/pyodide/
npm run dev          # http://localhost:5173
```

Requires Node 20+. Python 3.14 (Pyodide 314.0.8) runs entirely in a Web Worker; nothing is executed
on a server. The AI is off by default and is never downloaded unless you open **Local AI** and press
download.

```bash
npm run verify            # unit tests + curriculum proof + typecheck + production build
npm test                  # guard, rubric, prompt, render, app-shell, realistic-answer tests (47)
npm run verify:curriculum # runs all five bugs through real CPython and asserts they behave
npm run build && npm run preview
```

## What is actually verified

Tests are not decoration here; several of them changed the implementation while writing it.

| Check | How |
| --- | --- |
| Every starter reproduces its advertised bug class | `scripts/verify-curriculum.mjs` executes each starter in real CPython via Pyodide and asserts the intended failure (`UnboundLocalError`, `TypeError`, wrong answer, …). |
| Every reference fix passes every test | Same script; solutions live in `tests/fixtures/solutions.json`, which is **not** imported by the app, so the UI cannot leak them. |
| Traceback line numbers point at the student's file | Harness drops its own frame; asserted in the script. |
| Runaway output and infinite loops are contained | Capped `stdout` (200 kB) and a 10 s worker timeout that recycles the interpreter. |
| The guard blocks code, diffs, fix instructions and the known corrected line | `tests/guard.test.ts`, including the sneaky case "what if the loop used `n + 1`?" and the inverse case: once the student has written the fix, quoting it back is allowed. |
| Plausible model answers land where you would expect | `tests/realistic-answers.test.ts`: five good answers score "good", the code-writing answer is blocked, the polite non-answer scores "weak". |
| The rubric punishes leaks and verbosity | `tests/rubric.test.ts`. |
| Program output cannot inject HTML | `tests/render.test.ts` renders `<img onerror=…>` as text. |

**Not verified here:** the sandbox had no browser and no GPU, so the WebGPU inference path, the
service-worker offline flow and the visual layout were not executed end-to-end. The Python worker
was exercised headlessly in Node (same `harness.py`), and the production bundle builds and serves.
Run `npm run dev` in Chrome/Edge 113+ to exercise the model path.

## How the pieces fit

```
index.html
src/
  main.ts                 app state, modes, run loop, AI dialog, guard wiring
  runner/
    worker.ts             loads Pyodide from /pyodide/ (or CDN fallback) in a Worker
    harness.py            the Python side: exec, tracebacks, tests, output capture
    client.ts             serialised RPC, timeouts, worker recycling
  data/challenges.json    the five exercises: goal, starter, tests, concept, hint, leak patterns
  ai/
    models.ts             catalog + WebLLM memory/licence facts + default
    prompt.ts             system prompt, evidence formatting, token budgets
    guard.ts              enforcement: no code, no fix, no leak
    rubric.ts             deterministic scoring (used by Model Lab and tests)
    fallbacks.ts          built-in questions, no model required
    worker.ts / client.ts local inference worker + RPC (WebLLM loaded lazily)
  ui/                     CodeMirror, output/test renderers, Model Lab
tests/                    vitest suites + reference solutions
scripts/                  pyodide vendoring, curriculum proof
docs/MODEL_CHOICE.md      model research, decision matrix, measurement protocol
```

### Design decisions worth knowing

- **The model is an explainer, not an oracle.** Tests decide correctness. The system prompt says so,
  and the guard enforces the "no code" half mechanically rather than trusting a 1.5B model to obey.
- **One hint per run.** After a hint, the button becomes "Hint used — run again", which pushes the
  student back to the editor instead of into a chat loop.
- **The AI can stay off.** Every exercise ships a hand-written Socratic question keyed to its bug
  class, and every exception type maps to a question. `Explain` and `One hint` still work with no
  model and no network.
- **4k context, deliberately.** Prompts are capped (~1.8 kB of code, last six traceback lines). Small
  context keeps KV cache small and latency low.
- **Lazy by default.** The 6 MB WebLLM chunk is only fetched when a model is turned on; the base app
  is ~510 kB of JS (172 kB gzipped) including CodeMirror.

## Privacy and offline

- Code, test results and prompts never leave the device; there is no backend at all.
- Python (interpreter, stdlib) is served from this origin and cached by `public/sw.js`, so the
  Playground and Debug Lab work offline after the first load.
- Model weights are cached by WebLLM in the Cache API. Once downloaded, the tutor works offline too.
  "Remove from device" deletes those cache entries.
- Nothing is downloaded or executed for the AI until the student presses download in the dialog.

## Licence notes

App code is unlicensed/MIT-style as this repository dictates. Model weights are separate:
Qwen2.5-Coder and Qwen3.5 are Apache-2.0; LFM2.5 uses the LFM Open License 1.0, which has commercial
conditions — read it before shipping LFM as the default.

## Next steps

1. Run Model Lab on real student hardware and record the JSON exports (see docs §6).
2. Replace the `concept` regexes with a larger judged dataset, then LoRA a 0.5–1.5B model on
   `(traceback → Socratic question)` pairs; the rubric and the curriculum script are already the
   eval harness for that.
3. Add keyboard-accessible "line in question" highlighting so the evidence and the editor point at
   the same line.
