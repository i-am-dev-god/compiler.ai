import './styles.css';
import { CHALLENGES, PLAYGROUND_STARTER, challengeById, type Challenge } from './data/challenges';
import { PythonRunner, type RunnerStatus } from './runner/client';
import type { RunResult } from './runner/types';
import { mountEditor, type CodeEditor } from './ui/editor';
import { clear, el, renderConsole, renderTests, statusLabel } from './ui/render';
import { AIClient } from './ai/client';
import { buildMessages, type HelpMode } from './ai/prompt';
import { applyGuard } from './ai/guard';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, catalogForRuntimeId, formatGB, modelById, tierLabel } from './ai/models';
import { builtinHint, explainWithoutModel } from './ai/fallbacks';
import { mountModelLab } from './ui/model-lab';

type Mode = 'playground' | 'debug' | 'lab';

const STORAGE = {
  codes: 'tracegym:codes:v1',
  expected: 'tracegym:expected:v1',
  model: 'tracegym:model:v1',
  mode: 'tracegym:mode:v1',
};

const DEFAULT_CHALLENGE = CHALLENGES[0].id;

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota: the app still works, it just forgets */
  }
}

const state = {
  mode: readStored<Mode>(STORAGE.mode, 'playground'),
  challengeId: DEFAULT_CHALLENGE,
  codes: readStored<Record<string, string>>(STORAGE.codes, {}),
  expected: readStored<string>(STORAGE.expected, ''),
  results: {} as Record<string, RunResult | null>,
  selectedModelId: readStored<string>(STORAGE.model, DEFAULT_MODEL_ID),
  hintUsedFor: null as string | null,
  running: false,
  pythonReady: false,
};

const runner = new PythonRunner();
const ai = new AIClient();

/* ---------- elements ---------- */

const rail = must('rail');
const challengeList = must('challenge-list');
const paneTitle = must('pane-title');
const paneSub = must('pane-sub');
const goal = must('goal');
const runButton = must<HTMLButtonElement>('run-btn');
const resetButton = must<HTMLButtonElement>('reset-btn');
const runStatus = must('run-status');
const consoleView = must('console-view');
const testsView = must('tests-view');
const testCount = must('test-count');
const tabOutput = must<HTMLButtonElement>('tab-output');
const tabTests = must<HTMLButtonElement>('tab-tests');
const expectedBlock = must<HTMLDetailsElement>('expected-block');
const expectedInput = must<HTMLTextAreaElement>('expected-input');
const aiPill = must<HTMLButtonElement>('ai-pill');
const aiPillText = must('ai-pill-text');
const aiBadge = must('ai-badge');
const aiNote = must('ai-note');
const explainButton = must<HTMLButtonElement>('explain-btn');
const hintButton = must<HTMLButtonElement>('hint-btn');
const aiAnswer = must('ai-answer');
const workbench = must('workbench');
const labHost = must('lab');

/* ---------- editor ---------- */

function currentKey(): string {
  return state.mode === 'debug' ? state.challengeId : 'playground';
}

function starterFor(key: string): string {
  if (key === 'playground') return PLAYGROUND_STARTER;
  return challengeById(key)?.starter ?? PLAYGROUND_STARTER;
}

function codeFor(key: string): string {
  const saved = state.codes[key];
  return saved === undefined ? starterFor(key) : saved;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const editor: CodeEditor = mountEditor(
  must('editor-host'),
  codeFor(currentKey()),
  () => void run(),
  (code) => {
    state.codes[currentKey()] = code;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => writeStored(STORAGE.codes, state.codes), 250);
  },
);

expectedInput.value = state.expected;
expectedInput.addEventListener('input', () => {
  state.expected = expectedInput.value;
  writeStored(STORAGE.expected, state.expected);
});

/* ---------- modes ---------- */

const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-button'));

function setMode(mode: Mode) {
  state.mode = mode;
  writeStored(STORAGE.mode, mode);
  for (const button of modeButtons) {
    button.setAttribute('aria-selected', String(button.dataset.mode === mode));
  }
  const inLab = mode === 'lab';
  workbench.hidden = inLab;
  labHost.hidden = !inLab;
  if (inLab) {
    ensureLab();
    return;
  }
  rail.hidden = mode !== 'debug';
  goal.hidden = mode !== 'debug';
  expectedBlock.hidden = mode !== 'playground';
  syncContext();
}

for (const button of modeButtons) {
  button.addEventListener('click', () => setMode((button.dataset.mode as Mode) ?? 'playground'));
}

function syncContext() {
  const challenge = state.mode === 'debug' ? challengeById(state.challengeId) : null;
  paneTitle.textContent = challenge ? challenge.title : 'Playground';
  paneSub.textContent = challenge
    ? `Debug Lab ${CHALLENGES.indexOf(challenge) + 1} of ${CHALLENGES.length} · ${challenge.bugClass}`
    : 'your own Python, with an optional output check';
  if (challenge) {
    clear(goal);
    goal.append(el('strong', undefined, 'Goal: '));
    goal.append(document.createTextNode(challenge.goal));
    goal.append(el('span', 'bug-class', challenge.bugClass));
  }
  editor.set(codeFor(currentKey()));
  renderChallenges();
  renderResult();
}

/* ---------- challenge rail ---------- */

function renderChallenges() {
  clear(challengeList);
  for (const challenge of CHALLENGES) {
    const result = state.results[challenge.id];
    const button = el('button', 'challenge-item');
    button.type = 'button';
    if (challenge.id === state.challengeId) button.classList.add('active');

    const mark = el('span', 'tick', '·');
    button.append(mark);
    const body = el('span');
    body.append(document.createTextNode(challenge.title));
    body.append(el('small', undefined, challenge.bugClass));
    button.append(body);

    if (result) {
      if (result.error) {
        mark.textContent = '!';
        button.classList.add('failed');
      } else if (result.tests.length > 0 && result.passed_count === result.test_count) {
        mark.textContent = '✓';
        button.classList.add('solved');
      } else if (result.tests.length > 0) {
        mark.textContent = '×';
        button.classList.add('failed');
      }
    }

    button.addEventListener('click', () => {
      state.challengeId = challenge.id;
      if (state.mode !== 'debug') setMode('debug');
      else syncContext();
    });
    challengeList.append(button);
  }
}

/* ---------- running ---------- */

function updateRunButton() {
  runButton.disabled = state.running || !state.pythonReady;
  runButton.querySelector('span')!.textContent = state.running ? 'Running…' : 'Run';
}

runner.onStatus = (status: RunnerStatus) => {
  state.pythonReady = status.state === 'ready';
  if (status.state === 'ready') {
    runStatus.textContent = `Python ${status.version} · on device`;
    runStatus.className = 'run-status';
    if (import.meta.env.PROD) void warmOfflineCache();
  } else if (status.state === 'starting') {
    runStatus.textContent = 'starting Python…';
    runStatus.className = 'run-status';
  } else {
    runStatus.textContent = 'Python failed to start';
    runStatus.className = 'run-status tone-error';
    if (!state.results[currentKey()]) {
      clear(consoleView);
      consoleView.append(
        el(
          'p',
          'placeholder',
          `Python could not start${status.detail ? ` (${status.detail})` : ''}. The interpreter is served from /pyodide/ on this origin — run "npm run vendor:pyodide" and reload. Your code is safe in the editor, and the Debug Lab content is still readable.`,
        ),
      );
    }
  }
  updateRunButton();
};

async function run() {
  if (state.running || !state.pythonReady) return;
  const key = currentKey();
  const challenge: Challenge | null = state.mode === 'debug' ? challengeById(state.challengeId) ?? null : null;
  const code = editor.get();

  state.running = true;
  updateRunButton();
  runStatus.textContent = 'running…';
  runStatus.className = 'run-status';

  let result: RunResult;
  try {
    result = await runner.run({
      mode: challenge ? 'tests' : 'script',
      code,
      tests: challenge?.tests ?? [],
      expectedOutput: challenge ? null : state.expected.trim() ? state.expected : null,
      timeoutMs: 10_000,
    });
  } catch (error) {
    result = {
      mode: challenge ? 'tests' : 'script',
      status: 'error',
      stdout: '',
      stderr: '',
      error: {
        type: 'RunnerError',
        message: error instanceof Error ? error.message : 'The Python worker stopped unexpectedly.',
        line: null,
        snippet: null,
        traceback: '',
      },
      tests: [],
      output_match: null,
      passed_count: 0,
      test_count: 0,
      duration_ms: 0,
    };
  }

  state.results[key] = result;
  state.hintUsedFor = null;
  state.running = false;
  updateRunButton();
  renderResult();
  renderChallenges();
  showTab(challenge && result.tests.length > 0 ? 'tests' : 'output');
}

function renderResult() {
  const result = state.results[currentKey()] ?? null;
  const challenge = state.mode === 'debug' ? challengeById(state.challengeId) ?? null : null;
  renderConsole(consoleView, result);
  renderTests(testsView, result, challenge?.goal);

  const label = statusLabel(result);
  if (result) {
    runStatus.textContent = label.text;
    runStatus.className = `run-status ${label.tone === 'ok' ? 'tone-ok' : label.tone === 'idle' ? '' : 'tone-fail'}`;
  }

  if (result && result.tests.length > 0) {
    testCount.hidden = false;
    testCount.textContent = `${result.passed_count}/${result.test_count}`;
    testCount.className = `count${result.passed_count === result.test_count ? '' : ' bad'}`;
  } else {
    testCount.hidden = true;
  }

  const canAsk = Boolean(result);
  explainButton.disabled = !canAsk;
  hintButton.disabled = !canAsk || state.hintUsedFor === currentKey();
  hintButton.textContent = state.hintUsedFor === currentKey() ? 'Hint used — run again' : ai.modelId ? 'One hint' : 'Built-in hint';
}

function showTab(which: 'output' | 'tests') {
  const tests = which === 'tests';
  testsView.hidden = !tests;
  consoleView.hidden = tests;
  tabOutput.classList.toggle('active', !tests);
  tabTests.classList.toggle('active', tests);
  tabOutput.setAttribute('aria-selected', String(!tests));
  tabTests.setAttribute('aria-selected', String(tests));
}

tabOutput.addEventListener('click', () => showTab('output'));
tabTests.addEventListener('click', () => showTab('tests'));

resetButton.addEventListener('click', () => {
  const key = currentKey();
  delete state.codes[key];
  writeStored(STORAGE.codes, state.codes);
  editor.set(starterFor(key));
  state.results[key] = null;
  state.hintUsedFor = null;
  clear(aiAnswer);
  aiAnswer.hidden = true;
  renderResult();
  renderChallenges();
  editor.focus();
});

runButton.addEventListener('click', () => void run());

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    void run();
  }
});

/* ---------- AI chrome ---------- */

function updateAiChrome() {
  const model = catalogForRuntimeId(ai.modelId);
  const on = Boolean(model);
  aiPill.classList.toggle('on', on);
  aiPillText.textContent = on ? `${model!.label} · on device` : 'Local AI off';
  aiBadge.textContent = on ? 'on device' : 'off';
  aiBadge.classList.toggle('on', on);
  aiNote.textContent = on
    ? `Explanations come from ${model!.label} running in this tab. It can only describe the problem and ask a question; if it writes code, TraceGym throws the answer away.`
    : 'Optional. A small model can run on this device to explain the error or ask one guiding question. It never edits your code, and Python decides whether the code is right.';
  renderResult();
}

aiPill.addEventListener('click', () => void openModelDialog());
must('ai-settings').addEventListener('click', () => void openModelDialog());

/* ---------- model dialog ---------- */

const dialog = must<HTMLDialogElement>('ai-dialog');
const gpuStatus = must('gpu-status');
const modelChoiceList = must('model-choice-list');
const downloadArea = must('download-area');
const downloadBar = must('download-bar');
const downloadText = must('download-text');
const downloadButton = must<HTMLButtonElement>('ai-download');
const cancelButton = must<HTMLButtonElement>('ai-cancel');

let gpu: { ok: boolean; detail: string } | null = null;

async function openModelDialog() {
  if (!dialog.open) dialog.showModal();
  gpuStatus.className = 'gpu-status';
  gpuStatus.textContent = 'Checking this browser for WebGPU…';
  downloadArea.hidden = true;
  downloadButton.disabled = true;
  downloadButton.textContent = 'Download & turn on';
  gpu = await AIClient.webgpuAvailable();
  gpuStatus.textContent = gpu.ok
    ? `${gpu.detail}. Models are downloaded once and cached on this device.`
    : `${gpu.detail} Local AI is unavailable here — the built-in hints still work, and the editor, runner and tests are unaffected.`;
  if (!gpu.ok) gpuStatus.classList.add('bad');
  await renderModelChoices();
}

async function renderModelChoices() {
  clear(modelChoiceList);
  const cached = await Promise.all(MODEL_CATALOG.map((model) => AIClient.isCached(model.id)));
  MODEL_CATALOG.forEach((model, index) => {
    const option = el('label', 'model-option');
    if (model.id === state.selectedModelId) option.classList.add('selected');
    const input = el('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = model.id;
    input.checked = model.id === state.selectedModelId;
    input.disabled = !gpu?.ok;
    input.addEventListener('change', () => {
      state.selectedModelId = model.id;
      writeStored(STORAGE.model, model.id);
      for (const node of Array.from(modelChoiceList.querySelectorAll('.model-option'))) node.classList.remove('selected');
      option.classList.add('selected');
      downloadButton.textContent = cached[index] ? 'Turn on this model' : 'Download & turn on';
    });

    const body = el('div');
    const title = el('div', 'model-option-title');
    title.append(el('strong', undefined, model.label));
    title.append(el('span', 'tag', tierLabel(model.tier)));
    title.append(el('span', 'tag mono', `${formatGB(model.vramMB)} GPU`));
    title.append(el('span', 'tag', model.license));
    if (cached[index]) title.append(el('span', 'tag', 'cached'));
    body.append(title);
    body.append(el('div', 'model-option-note', model.bestFor));
    if (model.caution) body.append(el('div', 'model-option-note', model.caution));

    if (cached[index]) {
      const remove = el('button', 'ghost small', 'remove from device');
      remove.type = 'button';
      remove.style.marginTop = '6px';
      remove.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await AIClient.removeFromDevice(model.id);
        if (ai.modelId === model.id) await ai.unload();
        updateAiChrome();
        await renderModelChoices();
      });
      body.append(remove);
    }

    option.append(input, body);
    modelChoiceList.append(option);
  });

  const selected = modelById(state.selectedModelId);
  downloadButton.textContent = cached[MODEL_CATALOG.findIndex((m) => m.id === state.selectedModelId)]
    ? 'Turn on this model'
    : `Download ${selected ? formatGB(selected.vramMB) : ''} & turn on`;
  downloadButton.disabled = !gpu?.ok;
}

downloadButton.addEventListener('click', async () => {
  const model = modelById(state.selectedModelId);
  if (!model || !gpu?.ok) return;
  downloadButton.disabled = true;
  downloadArea.hidden = false;
  downloadBar.style.width = '0%';
  downloadText.textContent = `Preparing ${model.label}…`;
  try {
    await ai.load(model, (progress) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.progress * 100)));
      downloadBar.style.width = `${percent}%`;
      downloadText.textContent = progress.text ? `${percent}% · ${progress.text}` : `${percent}%`;
    });
    downloadArea.hidden = true;
    updateAiChrome();
    dialog.close();
    aiAnswer.hidden = true;
  } catch (error) {
    downloadText.textContent = `The model could not start: ${error instanceof Error ? error.message : String(error)}. Try a smaller model, or keep using the built-in hints.`;
    downloadButton.disabled = false;
  }
});

cancelButton.addEventListener('click', () => dialog.close());

/* ---------- asking for help ---------- */

function answerHead(badgeText: string, tone: 'ok' | 'warn', meta?: string): HTMLElement {
  const head = el('div', 'answer-head');
  head.append(el('span', `badge ${tone}`, badgeText));
  if (meta) head.append(el('span', 'faint small', meta));
  return head;
}

function renderBuiltin(mode: HelpMode, result: RunResult, challenge: Challenge | null) {
  const question = builtinHint({ challenge, error: result.error });
  aiAnswer.hidden = false;
  clear(aiAnswer);
  aiAnswer.append(answerHead('built-in', 'ok', mode === 'hint' ? 'no model needed' : undefined));
  if (mode === 'explain') {
    aiAnswer.append(el('p', 'answer-text', explainWithoutModel({ challenge, error: result.error })));
  } else {
    aiAnswer.append(el('p', 'answer-text', question));
  }
  aiAnswer.append(
    el(
      'p',
      'answer-meta',
      ai.modelId
        ? 'This is the built-in hint. Ask "Explain this error" for the model’s explanation.'
        : 'Local AI is off, so this comes from TraceGym’s built-in error questions. Turn it on from the button in the corner if you want a written explanation.',
    ),
  );
  state.hintUsedFor = mode === 'hint' ? currentKey() : state.hintUsedFor;
  renderResult();
}

async function askAI(mode: HelpMode) {
  const key = currentKey();
  const result = state.results[key];
  if (!result) return;
  const challenge = state.mode === 'debug' ? challengeById(state.challengeId) ?? null : null;

  if (!ai.modelId) {
    renderBuiltin(mode, result, challenge);
    return;
  }
  if (mode === 'hint' && state.hintUsedFor === key) return;

  const code = editor.get();
  aiAnswer.hidden = false;
  clear(aiAnswer);
  const typing = el('div', 'typing');
  typing.append(el('span', 'spinner'));
  const typingText = el('span', undefined, mode === 'hint' ? 'the model is thinking of one question…' : 'the model is reading the error…');
  typing.append(typingText);
  aiAnswer.append(typing);
  explainButton.disabled = true;
  hintButton.disabled = true;

  try {
    const completion = await ai.complete(
      buildMessages({
        mode,
        code,
        result,
        goal: challenge?.goal ?? null,
        challengeTitle: challenge?.title ?? null,
      }),
      mode,
      (tokens) => {
        typingText.textContent = `writing… ${tokens} tokens`;
      },
    );

    const report = applyGuard(completion.text, {
      mode,
      studentCode: code,
      leakPatterns: challenge?.leakPatterns ?? [],
    });

    clear(aiAnswer);
    const meta = `${catalogForRuntimeId(completion.modelId)?.label ?? completion.modelId} · ${(completion.totalMs / 1000).toFixed(1)}s · ${completion.tokensPerSecond.toFixed(0)} tok/s`;

    if (report.accepted) {
      aiAnswer.append(answerHead('checked · no code', 'ok', meta));
      aiAnswer.append(el('p', 'answer-text', report.text));
      const details = el('details', 'answer-details');
      details.append(el('summary', undefined, 'How TraceGym checked this'));
      const list = el('ul');
      list.append(el('li', undefined, 'No code block, no corrected line, no instruction to change your program.'));
      list.append(
        el('li', undefined, report.endsWithQuestion ? 'It ended with a question, as a hint should.' : 'It did not end with a question — treat it as context, not a hint.'),
      );
      list.append(el('li', undefined, 'The tests above, not this text, decide whether your code is correct.'));
      details.append(list);
      aiAnswer.append(details);
    } else {
      aiAnswer.append(answerHead('answer withheld', 'warn', meta));
      aiAnswer.append(
        el(
          'p',
          'muted small',
          'The model tried to give you code or a corrected line, so TraceGym discarded its answer. Here is the built-in question instead:',
        ),
      );
      aiAnswer.append(el('p', 'answer-text', builtinHint({ challenge, error: result.error })));
      const details = el('details', 'answer-details');
      details.append(el('summary', undefined, 'Why it was discarded'));
      const list = el('ul');
      for (const reason of report.reasons) list.append(el('li', undefined, reason));
      details.append(list);
      aiAnswer.append(details);
    }

    if (mode === 'hint') state.hintUsedFor = key;
  } catch (error) {
    clear(aiAnswer);
    aiAnswer.append(answerHead('model error', 'warn'));
    aiAnswer.append(el('p', 'muted small', `The model could not answer: ${error instanceof Error ? error.message : String(error)}`));
    aiAnswer.append(el('p', 'answer-text', builtinHint({ challenge, error: result.error })));
  } finally {
    renderResult();
  }
}

explainButton.addEventListener('click', () => void askAI('explain'));
hintButton.addEventListener('click', () => void askAI('hint'));

/* ---------- model lab ---------- */

let labMounted = false;
function ensureLab() {
  if (labMounted) return;
  mountModelLab(labHost, { runner, ai, onAiStateChange: updateAiChrome });
  labMounted = true;
}

/* ---------- offline ---------- */

/**
 * The service worker cannot cache the very first load, because it does not
 * control the page yet while Pyodide is downloading. So the page fills the same
 * Cache API bucket the worker reads from, once Python is up. After this runs,
 * a reload with the network switched off still gets the editor and Python.
 * Keep this cache name in sync with public/sw.js.
 */
const SHELL_CACHE = 'tracegym-shell-v1';
const PYODIDE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

async function warmOfflineCache() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHELL_CACHE);
    const urls = new Set<string>(['/']);
    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'))) {
      urls.add(link.href);
    }
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
      urls.add(script.src);
    }
    for (const file of PYODIDE_FILES) urls.add(`/pyodide/${file}`);

    await Promise.all(
      Array.from(urls).map(async (url) => {
        if (await cache.match(url)) return;
        const response = await fetch(url, { cache: 'force-cache' });
        if (response.ok) await cache.put(url, response);
      }),
    );
  } catch {
    /* offline warming is best-effort; the app works online regardless */
  }
}

/* ---------- boot ---------- */

renderChallenges();
setMode(state.mode === 'lab' ? 'playground' : state.mode);
updateAiChrome();
showTab('output');
updateRunButton();
editor.focus();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
