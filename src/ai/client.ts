import type { CatalogModel } from './models';
import { catalogForRuntimeId } from './models';
import type { ChatMessage, HelpMode } from './prompt';
import { GENERATION_PARAMS } from './prompt';

/**
 * Main-thread side of the local model. Nothing from WebLLM is imported here:
 * the library lives in ai.worker.ts and is fetched only when a model is turned
 * on. That keeps the editor, runner and tests independent of the AI feature.
 */

export interface LoadProgress {
  progress: number;
  text: string;
}

export interface CompletionResult {
  text: string;
  modelId: string;
  ttftMs: number;
  totalMs: number;
  tokens: number;
  tokensPerSecond: number;
}

interface Pending {
  kind: 'load' | 'chat' | 'unload';
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: LoadProgress) => void;
  onToken?: (tokens: number) => void;
  text: string;
  tokens: number;
  startedAt: number;
  firstTokenAt: number;
  modelId: string;
}

const CACHE_NAMES = { model: 'webllm/model', config: 'webllm/config' };

export class AIClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private loadedId: string | null = null;

  get modelId(): string | null {
    return this.loadedId;
  }

  static async webgpuAvailable(): Promise<{ ok: boolean; detail: string }> {
    const nav = navigator as Navigator & { gpu?: GPU };
    if (!nav.gpu) return { ok: false, detail: 'This browser does not expose WebGPU.' };
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { ok: false, detail: 'No GPU adapter was available to WebGPU.' };
      const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      const name = info?.description || info?.device || info?.vendor || 'a GPU';
      return { ok: true, detail: `WebGPU ready on ${name}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'WebGPU failed to start.' };
    }
  }

  /**
   * WebLLM stores artifacts in the Cache API under fixed cache names. Checking
   * for the model id in those keys avoids loading the 6 MB library just to
   * render a "cached" label in the dialog.
   */
  static async isCached(modelId: string): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
      for (const name of [CACHE_NAMES.model, CACHE_NAMES.config]) {
        if (!(await caches.has(name))) continue;
        const cache = await caches.open(name);
        const requests = await cache.keys();
        if (requests.some((request) => request.url.includes(modelId))) return true;
      }
    } catch {
      /* private mode or a locked cache: treat as not cached */
    }
    return false;
  }

  static async removeFromDevice(modelId: string): Promise<void> {
    if (typeof caches === 'undefined') return;
    for (const name of [CACHE_NAMES.model, CACHE_NAMES.config]) {
      if (!(await caches.has(name))) continue;
      const cache = await caches.open(name);
      const requests = await cache.keys();
      await Promise.all(
        requests.filter((request) => request.url.includes(modelId)).map((request) => cache.delete(request)),
      );
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => this.onMessage(event.data);
    worker.onerror = (event) => {
      for (const [, entry] of this.pending) entry.reject(new Error(event.message || 'The model worker crashed.'));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private onMessage(message: Record<string, unknown>) {
    const id = Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;

    switch (message.type) {
      case 'progress':
        entry.onProgress?.({ progress: Number(message.progress ?? 0), text: String(message.text ?? '') });
        return;
      case 'loaded':
        this.loadedId = String(message.modelId);
        entry.modelId = this.loadedId;
        this.pending.delete(id);
        entry.resolve(undefined);
        return;
      case 'delta': {
        if (!entry.firstTokenAt) entry.firstTokenAt = performance.now();
        entry.text += String(message.text ?? '');
        entry.tokens += 1;
        entry.onToken?.(entry.tokens);
        return;
      }
      case 'usage':
        entry.tokens = Number(message.tokens ?? entry.tokens);
        return;
      case 'done': {
        const totalMs = performance.now() - entry.startedAt;
        const ttft = entry.firstTokenAt ? entry.firstTokenAt - entry.startedAt : totalMs;
        this.pending.delete(id);
        entry.resolve({
          text: entry.text,
          modelId: entry.modelId || this.loadedId || '',
          ttftMs: Math.round(ttft),
          totalMs: Math.round(totalMs),
          tokens: Number(message.tokens ?? entry.tokens),
          tokensPerSecond:
            totalMs > 0 ? Math.round((Number(message.tokens ?? entry.tokens) / (totalMs / 1000)) * 10) / 10 : 0,
        } satisfies CompletionResult);
        return;
      }
      case 'unloaded':
        this.pending.delete(id);
        entry.resolve(undefined);
        return;
      case 'failed':
        this.pending.delete(id);
        entry.reject(new Error(String(message.message ?? 'The model failed.')));
        return;
      default:
        return;
    }
  }

  load(model: CatalogModel, onProgress?: (progress: LoadProgress) => void): Promise<void> {
    const worker = this.ensureWorker();
    this.loadedId = null;
    const id = ++this.seq;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'load',
        resolve: () => resolve(),
        reject,
        onProgress,
        text: '',
        tokens: 0,
        startedAt: performance.now(),
        firstTokenAt: 0,
        modelId: '',
      });
      worker.postMessage({ type: 'load', id, modelId: model.id, f32Id: model.f32Id });
    });
  }

  complete(messages: ChatMessage[], mode: HelpMode, onToken?: (tokens: number) => void): Promise<CompletionResult> {
    if (!this.loadedId) return Promise.reject(new Error('No model is loaded.'));
    const worker = this.ensureWorker();
    const params = GENERATION_PARAMS[mode];
    const model = catalogForRuntimeId(this.loadedId);
    const id = ++this.seq;
    return new Promise<CompletionResult>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'chat',
        resolve: (value) => resolve(value as CompletionResult),
        reject,
        onToken,
        text: '',
        tokens: 0,
        startedAt: performance.now(),
        firstTokenAt: 0,
        modelId: this.loadedId ?? '',
      });
      worker.postMessage({
        type: 'chat',
        id,
        messages,
        params: { max_tokens: params.maxTokens, temperature: params.temperature, top_p: params.topP },
        extraBody: model?.disableThinking ? { enable_thinking: false } : undefined,
      });
    });
  }

  async unload(): Promise<void> {
    if (!this.worker) {
      this.loadedId = null;
      return;
    }
    const worker = this.worker;
    try {
      await new Promise<void>((resolve) => {
        const id = ++this.seq;
        this.pending.set(id, {
          kind: 'unload',
          resolve: () => resolve(),
          reject: () => resolve(),
          text: '',
          tokens: 0,
          startedAt: performance.now(),
          firstTokenAt: 0,
          modelId: '',
        });
        worker.postMessage({ type: 'unload', id });
        setTimeout(resolve, 1500);
      });
    } finally {
      worker.terminate();
      this.worker = null;
      this.loadedId = null;
      for (const [, entry] of this.pending) entry.reject(new Error('Model unloaded.'));
      this.pending.clear();
    }
  }
}
