/// <reference lib="webworker" />
import { CreateMLCEngine, type MLCEngine } from '@mlc-ai/web-llm';

/**
 * The model runs here, not on the page's thread, so a forward pass never blocks
 * typing or scrolling.
 *
 * TraceGym talks to this worker with its own small protocol instead of
 * WebLLM's WebWorkerMLCEngine wrapper. The wrapper would pull a second copy of
 * WebLLM (~6 MB) into the main bundle just to send messages; this way the
 * library is downloaded once, only when a model is actually turned on.
 */

type LoadMessage = { type: 'load'; id: number; modelId: string; f32Id?: string };
type ChatMessage = {
  type: 'chat';
  id: number;
  messages: { role: string; content: string }[];
  params: { max_tokens: number; temperature: number; top_p: number };
  extraBody?: Record<string, unknown>;
};
type UnloadMessage = { type: 'unload'; id: number };
type Incoming = LoadMessage | ChatMessage | UnloadMessage;

let engine: MLCEngine | null = null;

function post(message: unknown) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function load(id: number, modelId: string, f32Id?: string) {
  if (engine) {
    try {
      await engine.unload();
    } catch {
      /* ignore */
    }
    engine = null;
  }
  const config = {
    initProgressCallback: (report: { progress?: number; text?: string }) => {
      post({ type: 'progress', id, progress: report.progress ?? 0, text: report.text ?? '' });
    },
  };
  try {
    engine = await CreateMLCEngine(modelId, config);
    post({ type: 'loaded', id, modelId });
  } catch (error) {
    // GPUs without shader-f16 cannot run the q4f16 kernels; retry in f32.
    if (!f32Id) throw error;
    post({ type: 'progress', id, progress: 0, text: 'Retrying with 32-bit weights…' });
    engine = await CreateMLCEngine(f32Id, config);
    post({ type: 'loaded', id, modelId: f32Id });
  }
}

self.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data;
  try {
    if (message.type === 'load') {
      await load(message.id, message.modelId, message.f32Id);
      return;
    }

    if (message.type === 'unload') {
      await engine?.unload();
      engine = null;
      post({ type: 'unloaded', id: message.id });
      return;
    }

    if (message.type === 'chat') {
      if (!engine) throw new Error('No model is loaded');
      const stream = await engine.chat.completions.create({
        messages: message.messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: message.params.max_tokens,
        temperature: message.params.temperature,
        top_p: message.params.top_p,
        ...(message.extraBody ? { extra_body: message.extraBody } : {}),
      } as never);

      let chunks = 0;
      let usage: number | null = null;
      for await (const chunk of stream as unknown as AsyncIterable<{
        choices?: { delta?: { content?: string } }[];
        usage?: { completion_tokens?: number } | null;
      }>) {
        const delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          chunks += 1;
          post({ type: 'delta', id: message.id, text: delta, tokens: chunks });
        }
        if (chunk.usage?.completion_tokens) {
          usage = chunk.usage.completion_tokens;
          post({ type: 'usage', id: message.id, tokens: usage });
        }
      }
      post({ type: 'done', id: message.id, tokens: usage ?? chunks });
    }
  } catch (error) {
    post({ type: 'failed', id: message.id, message: describe(error) });
  }
};
