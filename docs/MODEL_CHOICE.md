# Which local model should TraceGym ship?

**Short answer:** `Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC` — 1.63 GB of GPU memory, Apache-2.0,
code-tuned, already built for WebGPU by WebLLM. Keep `LFM2.5-1.2B-Instruct` as the fast/low-memory
option and `Qwen3.5-2B` as the quality tier for machines with ~3 GB to spare. Do **not** drop to
sub-1B general models: they fail exactly the part of the job that matters.

The rest of this document is why, plus how to check it on real hardware instead of trusting it.

---

## 1. What the model actually has to do

The model has two jobs, both narrow, and they are checked in opposite directions:

| Job | Input | Output | Hard failure |
| --- | --- | --- | --- |
| **Explain** | numbered beginner program, the failing expression, the error | two sentences naming what Python did, then **one question** | writing code, quoting a corrected line, "change X to Y", judging the program correct |
| **Hint** | same | **one question**, ≤ 25 words | same |
| **Repair** | same, plus the goal | one JSON object: `{"line", "lines", "replacement", "why"}` | touching code away from the error, restructuring the program, flattening an indent |

The explain path is guarded as prose: `applyGuard` rejects code fences, statement-shaped lines and
fix verbs, and truncates to three sentences. The repair path is guarded structurally: `validateFix`
parses the JSON, refuses anything more than ±2 lines from the error or more than 3 replaced lines,
refuses a no-op and a flattened block, and the app renders the result as a diff before applying it.
So the required skills, in order, are:

1. **Python semantics** — knows that `range(1, n)` excludes `n`, that `best = 0` loses to negative
   numbers, that mutating a list while iterating skips elements, that `str + int` is a `TypeError`.
2. **Instruction following under a strict format** — one question, no code, short; or exactly one
   small JSON object and nothing around it.
3. **Low latency** — an answer that arrives after 20 seconds does not get read.

Raw reasoning benchmarks (MMLU, GPQA) predict (1) only weakly; instruction-following benchmarks
(IFEval) predict (2) well, and a code-tuned model predicts the *repair* half of (2) better than a
general model of the same size. That is the lens for the table below.

## 2. Hard constraints from the browser

- **Must have a WebGPU build in WebLLM's prebuilt registry.** Running a GGUF through
  `llama.cpp`-compiled-to-WASM (wllama) works without WebGPU but is several times slower for the
  same model, and `transformers.js` needs an ONNX export per model. A model that does not exist in
  `prebuiltAppConfig` costs days of conversion work before it costs a single token. The registry in
  the pinned `@mlc-ai/web-llm` (0.2.89) is therefore the real shortlist.
- **≤ ~2.5 GB `vram_required_MB`.** This number already includes the KV cache and runtime overhead at
  a 4k context. Integrated GPUs borrow from system RAM, so 2.5 GB is roughly the line where an
  8 GB laptop still feels fine.
- **4k context is enough.** Prompts are ~600–900 tokens. Long context is not a selling point here;
  it costs memory.
- **A licence that allows redistribution.** The app should be shipable by a school.

## 3. Shortlist (the numbers that decided it)

`vram` and `ctx` are read from `prebuiltAppConfig.model_list` in the installed WebLLM package, not
from a blog post. Quality figures are vendor-reported unless noted.

| Model | Params | WebLLM VRAM | Licence | IFEval (non-thinking) | Why it is / isn't the pick |
| --- | --- | --- | --- | --- | --- |
| **Qwen2.5-Coder-1.5B-Instruct** | 1.5B | **1630 MB** | Apache-2.0 | not published for this build | **Chosen.** The only *code-tuned* model in this size class with a WebGPU build. 70.7% HumanEval per Qwen's report; Python is the language it is best at. |
| LFM2.5-1.2B-Instruct | 1.17B | 1001 MB | LFM Open License 1.0 | **86.2** | Fastest and best-behaved; general-purpose, so weaker on Python specifics. Licence has revenue conditions. |
| Qwen3.5-2B | 2B | 2245 MB | Apache-2.0 | 61.2 (78.6 thinking) | Smarter explanations, 1.4 GB more memory, and thinking must be switched off or latency doubles. |
| Qwen2.5-Coder-0.5B-Instruct | 0.5B | 945 MB | Apache-2.0 | — | The floor. Recognises `TypeError`, then restates it. Fine for a first-run demo, not for teaching. |
| Qwen3.5-0.8B | 0.8B | 1629 MB | Apache-2.0 | **52.1** | Rejected: costs the same memory as the 1.5B coder while scoring 52 on instruction following (MMLU-Pro 29.7). Newer is not better at this size. |
| Llama-3.2-1B-Instruct | 1B | 879 MB | Llama community | — | Cheap, but licence friction and no code specialisation. |
| SmolLM2-360M / 135M | 0.36B / 0.14B | 376 / 360 MB | Apache-2.0 | — | Toy-sized. Cannot explain `UnboundLocalError` without inventing something. |
| Qwen2.5-Coder-3B-Instruct | 3B | 2505 MB | Apache-2.0 | — | Offered as an opt-in "stretch" in Model Lab to show what +0.9 GB buys. |
| Anything ≥7B | 7B+ | 4.5 GB+ | — | — | Excluded by memory; the download alone is not an "optional extra" for a student. |

### Why the coder model wins despite weaker instruction-following

A factual Python mistake is worse than a formatting mistake, because the student cannot detect it.
Formatting is cheaper to enforce in software than semantics is: `src/ai/guard.ts` inspects every
answer and throws it away if it contains a code block, a diff, a statement the student has not
written, an imperative fix instruction, or the known corrected line for that exercise. On rejection
the student gets the hand-written hint instead. So the failure mode of a chatty model is "you get
the built-in hint", while the failure mode of a model that does not understand Python is "you get a
confident, wrong explanation".

That trade is why the default is code-tuned, and why every candidate is still scored on both axes in
Model Lab.

## 4. The decision rule

`src/ai/models.ts` ships all five; the app suggests a default with this rule (also what the dialog
text implies):

```
WebGPU missing            → no model; built-in questions only
deviceMemory ≤ 4 GB       → Qwen2.5-Coder-0.5B  (or LFM2.5-1.2B if the licence is fine)
deviceMemory ≤ 8 GB       → Qwen2.5-Coder-1.5B  (default)
otherwise                 → Qwen3.5-2B is worth the extra 0.6 GB
```

Honest caveat: `navigator.deviceMemory` is coarse and absent in Safari/Firefox. The dialog shows the
GPU name and every model's memory cost so the student can choose, and Model Lab measures what
actually happened.

## 5. Runtime, not just weights

WebLLM (MLC) is used for three concrete reasons:

1. **Prebuilt WebGPU kernels per model** with `q4f16_1` (f16 activations, 4-bit weights). On GPUs
   without `shader-f16`, TraceGym automatically retries the `q4f32_1` build (`f32Id` in the catalog).
2. **KV-cache reuse and streaming** through the OpenAI-shaped `chat.completions` API, so token
   arrival times can be measured and shown.
3. **Cache API storage** for weights, which is what makes "offline once cached" true. TraceGym
   checks `webllm/model` + `webllm/config` directly to label models "cached" without paying to load
   the library.

The 6 MB WebLLM library is a **lazy chunk**: it is fetched only when a model is turned on, so the
editor, runner and tests load without it (`dist/assets/index-*.js` ≈ 510 kB, WebLLM ≈ 6 MB on
demand). Inference runs in its own worker (`src/ai/ai.worker.ts`) so generation never blocks typing.

## 6. Do not trust this document — measure

Model Lab (`Model Lab` tab) runs the same 10 prompts the tutor uses (explain + hint for all five
exercises, generated from the *real* runner output on the real broken programs — for the exercise that
ships with an empty editor, its reference broken program in `benchStarter`) against whichever
models you select, on your hardware, and scores each answer with a deterministic rubric:

```
score = 0.55 × concept_coverage      (regex per exercise: did it reach the actual idea?)
      + 0.25 × guard_compliance      (no code, no diff, no fix instruction)
      + 0.20 × format                (short, ends with a question)
blocked answers score ≈ 0
```

Concept coverage carries the most weight because "your loop has a problem, can you spot it?" breaks no
rules and teaches nothing. There is deliberately no LLM judge: a second model explaining why the first model is right is not
evidence, and it cannot run offline. The rubric is in `src/ai/rubric.ts` and is unit-tested in
`tests/rubric.test.ts`, including the "leaked fix scores near zero" case.

What to look for in the results table:

| Metric | Bar | Meaning |
| --- | --- | --- |
| Guard pass | **100%** | Below that, students will see withheld answers. Acceptable only with the built-in fallback. |
| Concept | **≥ 70%** | It is finding the actual bug, not paraphrasing the error. |
| Format | ≥ 70% | Concise and ends with a question. |
| tok/s | ≥ 8 | Below this, a 60-token answer takes > 7 s and the hint feels broken. |
| TTFT | ≤ 2 s | Time until the student sees something happening. |

Run it on two models on the same machine, export both JSONs, and keep them — that is the actual
answer to "which model is best", and it is hardware-specific.

**Repair is measured by outcome, not by prose.** A patch does not need to sound good: it needs to run.
The natural third pass for Model Lab is to ask each model for a patch on each starter, pass it through
`validateFix`, apply it in the runner and score *valid JSON → patch accepted → error gone → tests
pass*. `validateFix`, `applyFix` and the runner already exist, so no new harness is needed. Until that
runs on real hardware, the repair path is verified structurally only (`tests/fix.test.ts`,
`tests/fix-flow.test.ts`): that proves a bad patch cannot touch the program, not that every model
produces a good one. Expect JSON compliance to be the binding constraint — a model that writes a
correct fix in prose but forgets the closing brace scores zero, which is the right outcome for a
student but a bad look for the model.

## 7. What would beat all of these

A 0.5–1.5B model LoRA-tuned on ~2–5k `(code, traceback) → Socratic question` and
`(code, traceback) → minimal JSON patch` pairs would outperform every base model here at this narrow
task, and could run in under 1 GB. The pieces are already in place: `src/data/challenges.json`
defines the concept each question must reach and the tests each patch must satisfy, `rubric.ts`
scores the prose, `validateFix` scores the JSON, and `scripts/verify-curriculum.mjs` proves the
training targets are pedagogically correct (and that the fixes actually pass). Until then, ship the
base model plus the two guards plus the built-in questions.

## Sources

- WebLLM prebuilt registry and per-model `vram_required_MB` / context: `node_modules/@mlc-ai/web-llm/lib/index.js`
  (`prebuiltAppConfig`), mirrored at <https://github.com/mlc-ai/web-llm/blob/main/src/config.ts>
- Qwen2.5-Coder-1.5B-Instruct (1.54B, Apache-2.0, 32k, 70.7% HumanEval):
  <https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct>
- Qwen3.5-2B and Qwen3.5-0.8B benchmark tables (MMLU-Pro, IFEval, GPQA, thinking vs non-thinking):
  <https://huggingface.co/Qwen/Qwen3.5-2B>, <https://huggingface.co/Qwen/Qwen3.5-0.8B>
- "Qwen3.5-0.8B is the smallest model worth running; MMLU-Pro 29.7, IFEval 52.1":
  <https://www.promptquorum.com/local-llms/small-local-llm-models>
- LFM2.5-1.2B-Instruct / Thinking benchmarks (IFEval 86.23, IFBench 47.33) and <1 GB footprint:
  <https://huggingface.co/LiquidAI/LFM2.5-1.2B-Thinking>
- LFM Open License 1.0 (commercial conditions) vs Apache-2.0 for Qwen:
  <https://artificialanalysis.ai/models/lfm2-5-1-2b-instruct>
- On-device decode speed head-to-head (Qwen3.5-0.8B vs LFM2.x, Metal and CPU):
  <https://samanvya.dev/blog/lfm2-vs-qwen3-5-on-apple-m4>
