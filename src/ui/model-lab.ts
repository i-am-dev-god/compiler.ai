import { CHALLENGES, type Challenge, benchCode } from '../data/challenges';
import type { PythonRunner } from '../runner/client';
import type { RunResult } from '../runner/types';
import type { AIClient } from '../ai/client';
import { MODEL_CATALOG, formatGB, tierLabel } from '../ai/models';
import { buildMessages, type HelpMode } from '../ai/prompt';
import { meanScore, scoreHelp, type HelpScore } from '../ai/rubric';
import { clear, el } from './render';

/**
 * Model Lab: the same tutor prompt, run against every candidate model on the
 * student's own hardware, scored with the deterministic rubric. This is how the
 * default in docs/MODEL_CHOICE.md can be checked rather than trusted.
 */

interface BenchCase {
  id: string;
  challengeId: string;
  title: string;
  mode: HelpMode;
  code: string;
  goal: string;
  result: RunResult;
  challenge: Challenge;
}

interface CaseRecord {
  caseId: string;
  challengeId: string;
  title: string;
  mode: HelpMode;
  text: string;
  score: HelpScore;
  ttftMs: number;
  tokensPerSecond: number;
  totalMs: number;
}

interface ModelRecord {
  modelId: string;
  label: string;
  status: 'ok' | 'failed';
  error?: string;
  mean: number;
  guardPass: number;
  concept: number;
  format: number;
  meanTps: number;
  meanTtft: number;
  cases: CaseRecord[];
}

interface BenchRun {
  startedAt: string;
  hardware: Record<string, unknown>;
  models: ModelRecord[];
}

interface Hardware {
  webgpu: string;
  adapter: string;
  deviceMemory: string;
  cores: number;
  browser: string;
}

const STORAGE_KEY = 'tracegym:bench:v1';

async function collectHardware(): Promise<Hardware> {
  const nav = navigator as Navigator & { gpu?: GPU };
  const hardware: Hardware = {
    webgpu: nav.gpu ? 'available' : 'missing',
    adapter: 'not reported',
    deviceMemory: nav.deviceMemory ? `${nav.deviceMemory} GB (reported)` : 'not reported',
    cores: nav.hardwareConcurrency || 0,
    browser: navigator.userAgent,
  };
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
        hardware.adapter = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ') || 'unnamed adapter';
      }
    } catch {
      hardware.adapter = 'adapter query failed';
    }
  }
  return hardware;
}

async function buildCases(runner: PythonRunner): Promise<BenchCase[]> {
  const cases: BenchCase[] = [];
  for (const challenge of CHALLENGES) {
    const result = await runner.run({ mode: 'tests', code: benchCode(challenge), tests: challenge.tests });
    for (const mode of ['explain', 'hint'] as HelpMode[]) {
      cases.push({
        id: `${challenge.id}:${mode}`,
        challengeId: challenge.id,
        title: challenge.title,
        mode,
        code: benchCode(challenge),
        goal: challenge.goal,
        result,
        challenge,
      });
    }
  }
  return cases;
}

function loadPrevious(): BenchRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BenchRun) : null;
  } catch {
    return null;
  }
}

export interface LabDeps {
  runner: PythonRunner;
  ai: AIClient;
  onAiStateChange: () => void;
}

export function mountModelLab(root: HTMLElement, deps: LabDeps) {
  clear(root);

  const intro = el('div', 'lab-intro');
  intro.append(el('h1', undefined, 'Model Lab'));
  intro.append(
    el(
      'p',
      'lede',
      'Which local model is actually good at this job? Every model below gets the same tutor prompt on the same five broken programs, and every answer is scored by the same rule-based rubric — no second model is allowed to be the judge.',
    ),
  );
  root.append(intro);

  const hardwareCard = el('section', 'card hardware-card');
  hardwareCard.append(el('h2', undefined, 'This device'));
  const hardwareGrid = el('div', 'hardware-grid');
  hardwareCard.append(hardwareGrid);
  root.append(hardwareCard);

  const setup = el('section', 'card');
  setup.append(el('h2', undefined, 'Models to compare'));
  setup.append(
    el(
      'p',
      'muted',
      'Each checked model is downloaded once and cached by the browser. Weights stay on this device. Expect several GB of traffic and a few minutes per model.',
    ),
  );
  const modelList = el('div', 'model-checklist');
  setup.append(modelList);

  const controls = el('div', 'lab-controls');
  const runButton = el('button', 'primary', 'Run comparison');
  runButton.type = 'button';
  const cancelButton = el('button', 'ghost', 'Stop');
  cancelButton.type = 'button';
  cancelButton.hidden = true;
  const progressLabel = el('span', 'muted', '');
  controls.append(runButton, cancelButton, progressLabel);
  setup.append(controls);

  const log = el('div', 'lab-log');
  log.hidden = true;
  setup.append(log);
  root.append(setup);

  const resultsHost = el('section', 'results');
  root.append(resultsHost);

  const selected = new Set<string>(
    MODEL_CATALOG.filter((model) => model.tier === 'recommended' || model.tier === 'light').map((model) => model.id),
  );
  let cancelled = false;
  let running = false;

  for (const model of MODEL_CATALOG) {
    const label = el('label', 'model-check');
    const input = el('input');
    input.type = 'checkbox';
    input.value = model.id;
    input.checked = selected.has(model.id);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(model.id);
      else selected.delete(model.id);
    });
    const body = el('div', 'model-check-body');
    const title = el('div', 'model-check-title');
    title.append(el('strong', undefined, model.label));
    title.append(el('span', 'tag', tierLabel(model.tier)));
    title.append(el('span', 'tag mono', `${formatGB(model.vramMB)} GPU`));
    if (model.codeTuned) title.append(el('span', 'tag', 'code-tuned'));
    body.append(title);
    body.append(el('div', 'model-check-note', model.bestFor));
    if (model.caution) body.append(el('div', 'model-check-caution', model.caution));
    label.append(input, body);
    modelList.append(label);
  }

  void collectHardware().then((hardware) => {
    clear(hardwareGrid);
    for (const [key, value] of [
      ['WebGPU', hardware.webgpu],
      ['GPU', hardware.adapter],
      ['Memory hint', hardware.deviceMemory],
      ['CPU threads', String(hardware.cores)],
    ]) {
      const cell = el('div', 'hardware-cell');
      cell.append(el('div', 'hardware-key', key));
      cell.append(el('div', 'hardware-value', value));
      hardwareGrid.append(cell);
    }
  });

  function renderResults(run: BenchRun | null) {
    clear(resultsHost);
    if (!run) return;
    const header = el('div', 'results-head');
    header.append(el('h2', undefined, 'Results'));
    const exportButton = el('button', 'ghost small', 'Export JSON');
    exportButton.type = 'button';
    exportButton.addEventListener('click', () => downloadRun(run));
    header.append(exportButton);
    resultsHost.append(header);
    resultsHost.append(el('p', 'muted', `Run at ${new Date(run.startedAt).toLocaleString()}`));

    const table = el('table', 'results-table');
    const head = el('thead');
    const headRow = el('tr');
    for (const column of ['Model', 'Mean score', 'Guard pass', 'Concept', 'Format', 'tok/s', 'TTFT']) {
      headRow.append(el('th', undefined, column));
    }
    head.append(headRow);
    table.append(head);

    const body = el('tbody');
    for (const record of run.models) {
      const row = el('tr');
      const nameCell = el('td');
      nameCell.append(el('strong', undefined, record.label));
      if (record.status === 'failed') nameCell.append(el('div', 'tone-fail small', record.error ?? 'failed to load'));
      row.append(nameCell);
      if (record.status === 'failed') {
        for (let i = 0; i < 6; i += 1) row.append(el('td', 'muted', '—'));
        body.append(row);
        continue;
      }
      row.append(el('td', undefined, record.mean.toFixed(2)));
      row.append(el('td', undefined, `${Math.round(record.guardPass * 100)}%`));
      row.append(el('td', undefined, `${Math.round(record.concept * 100)}%`));
      row.append(el('td', undefined, `${Math.round(record.format * 100)}%`));
      row.append(el('td', undefined, record.meanTps.toFixed(1)));
      row.append(el('td', undefined, `${Math.round(record.meanTtft)} ms`));
      body.append(row);
    }
    table.append(body);
    resultsHost.append(table);

    resultsHost.append(
      el(
        'p',
        'fine',
        'Mean score = 55% concept coverage + 25% guard compliance + 20% format (short, ends with a question). Guard compliance is deliberately cheap: a model that breaks the rules scores near zero, but a polite non-answer that names no concept still scores badly.',
      ),
    );

    for (const record of run.models) {
      if (record.status !== 'ok' || record.cases.length === 0) continue;
      const details = el('details', 'result-details');
      const summary = el('summary');
      summary.append(el('strong', undefined, record.label));
      summary.append(el('span', 'muted', ` — ${record.cases.length} answers`));
      details.append(summary);
      for (const caseRecord of record.cases) {
        const item = el('div', 'case-record');
        const line = el('div', 'case-head');
        line.append(el('code', 'tag', caseRecord.challengeId));
        line.append(el('span', 'tag', caseRecord.mode));
        line.append(el('span', 'tag mono', caseRecord.score.total.toFixed(2)));
        if (!caseRecord.score.accepted) line.append(el('span', 'tag warn', 'blocked by guard'));
        if (caseRecord.score.flags.includes('no-question')) line.append(el('span', 'tag', 'no question'));
        line.append(el('span', 'muted small', `${caseRecord.tokensPerSecond.toFixed(1)} tok/s`));
        item.append(line);
        item.append(el('p', 'case-text', caseRecord.text || '(empty response)'));
        details.append(item);
      }
      resultsHost.append(details);
    }
  }

  const previous = loadPrevious();
  renderResults(previous);

  runButton.addEventListener('click', async () => {
    if (running) return;
    if (selected.size === 0) {
      progressLabel.textContent = 'Pick at least one model.';
      return;
    }
    running = true;
    cancelled = false;
    runButton.disabled = true;
    cancelButton.hidden = false;
    log.hidden = false;
    clear(log);
    resultsHost.replaceChildren();

    const say = (text: string, tone?: 'ok' | 'fail') => {
      const line = el('div', tone ? `log-line tone-${tone}` : 'log-line', text);
      log.append(line);
      log.scrollTop = log.scrollHeight;
    };

    const hardware = await collectHardware();
    const models = MODEL_CATALOG.filter((model) => selected.has(model.id));
    say(`Preparing ${CHALLENGES.length * 2} tutor prompts from the real runner…`);
    let cases: BenchCase[] = [];
    try {
      cases = await buildCases(deps.runner);
      say(`Got ${cases.length} prompts (explain + hint for each challenge).`, 'ok');
    } catch (error) {
      say(`Could not run the Python curriculum: ${describe(error)}`, 'fail');
      running = false;
      runButton.disabled = false;
      return;
    }

    await deps.ai.unload();
    deps.onAiStateChange();

    const run: BenchRun = { startedAt: new Date().toISOString(), hardware: hardware as unknown as Record<string, unknown>, models: [] };

    for (const model of models) {
      if (cancelled) break;
      progressLabel.textContent = `Loading ${model.label}…`;
      say(`\n${model.label} — ${formatGB(model.vramMB)} GPU memory, ${model.license}`);
      const record: ModelRecord = {
        modelId: model.id,
        label: model.label,
        status: 'ok',
        mean: 0,
        guardPass: 0,
        concept: 0,
        format: 0,
        meanTps: 0,
        meanTtft: 0,
        cases: [],
      };
      try {
        await deps.ai.load(model, (progress) => {
          const percent = Math.round(progress.progress * 100);
          progressLabel.textContent = `Loading ${model.label}… ${percent}%`;
          if (percent % 20 === 0) say(`  ${percent}% ${progress.text.split('|')[0]?.trim() ?? ''}`);
        });
        for (const benchCase of cases) {
          if (cancelled) break;
          const messages = buildMessages({
            mode: benchCase.mode,
            code: benchCase.code,
            result: benchCase.result,
            goal: benchCase.goal,
            challengeTitle: benchCase.title,
          });
          const completion = await deps.ai.complete(messages, benchCase.mode);
          const score = scoreHelp(completion.text, {
            mode: benchCase.mode,
            studentCode: benchCase.code,
            challenge: { concept: benchCase.challenge.concept, leakPatterns: benchCase.challenge.leakPatterns },
          });
          record.cases.push({
            caseId: benchCase.id,
            challengeId: benchCase.challengeId,
            title: benchCase.title,
            mode: benchCase.mode,
            text: completion.text.trim(),
            score,
            ttftMs: completion.ttftMs,
            tokensPerSecond: completion.tokensPerSecond,
            totalMs: completion.totalMs,
          });
          say(
            `  ${benchCase.challengeId}/${benchCase.mode}: ${score.total.toFixed(2)} · ${completion.tokensPerSecond.toFixed(1)} tok/s${score.accepted ? '' : ' · blocked'}`,
            score.total >= 0.5 ? 'ok' : 'fail',
          );
          progressLabel.textContent = `${model.label}: ${record.cases.length}/${cases.length}`;
        }
        if (record.cases.length > 0) {
          record.mean = meanScore(record.cases.map((entry) => entry.score));
          record.guardPass = record.cases.filter((entry) => entry.score.accepted).length / record.cases.length;
          record.concept = record.cases.reduce((sum, entry) => sum + entry.score.conceptScore, 0) / record.cases.length;
          record.format = record.cases.reduce((sum, entry) => sum + entry.score.formatScore, 0) / record.cases.length;
          record.meanTps = record.cases.reduce((sum, entry) => sum + entry.tokensPerSecond, 0) / record.cases.length;
          record.meanTtft = record.cases.reduce((sum, entry) => sum + entry.ttftMs, 0) / record.cases.length;
        }
      } catch (error) {
        record.status = 'failed';
        record.error = describe(error);
        say(`  failed: ${record.error}`, 'fail');
      } finally {
        run.models.push(record);
        await deps.ai.unload();
        deps.onAiStateChange();
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
        } catch {
          /* quota - results are still on screen */
        }
        renderResults(run);
      }
    }

    running = false;
    runButton.disabled = false;
    cancelButton.hidden = true;
    progressLabel.textContent = cancelled ? 'Stopped.' : 'Done.';
    say(cancelled ? 'Stopped by you.' : 'Comparison complete.', cancelled ? 'fail' : 'ok');
  });

  cancelButton.addEventListener('click', () => {
    cancelled = true;
    progressLabel.textContent = 'Stopping after this answer…';
  });
}

function downloadRun(run: BenchRun) {
  const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tracegym-model-lab-${run.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
