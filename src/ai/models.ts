/**
 * The models TraceGym can run in the browser, in the order we would try them.
 *
 * Every id below exists in the WebLLM prebuilt registry that ships with the
 * pinned @mlc-ai/web-llm version (see `prebuiltAppConfig.model_list`). Sizes are
 * WebLLM's `vram_required_MB` at a 4k context, which is the number that decides
 * whether a machine can hold the model at all - not the download size.
 * The reasoning behind the ordering is in docs/MODEL_CHOICE.md.
 */

export type ModelTier = 'recommended' | 'light' | 'quality' | 'minimum' | 'stretch';

export interface CatalogModel {
  id: string;
  /** Same weights, 32-bit activations: used when the GPU has no shader-f16. */
  f32Id?: string;
  label: string;
  vendor: string;
  params: string;
  vramMB: number;
  downloadMB: number;
  contextWindow: number;
  license: string;
  codeTuned: boolean;
  tier: ModelTier;
  bestFor: string;
  caution?: string;
  /** Disable hybrid "thinking" so the answer arrives in tutoring-sized time. */
  disableThinking?: boolean;
}

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    f32Id: 'Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5-Coder 1.5B',
    vendor: 'Qwen (Alibaba)',
    params: '1.5B',
    vramMB: 1630,
    downloadMB: 1030,
    contextWindow: 4096,
    license: 'Apache-2.0',
    codeTuned: true,
    tier: 'recommended',
    bestFor: 'Default. Reads Python tracebacks accurately and knows the language semantics behind most beginner bugs.',
    caution: 'Chatty and eager to write code - TraceGym discards answers that contain code and falls back to the built-in hint.',
  },
  {
    id: 'LFM2.5-1.2B-Instruct-q4f16_1-MLC',
    f32Id: 'LFM2.5-1.2B-Instruct-q4f32_1-MLC',
    label: 'LFM2.5 1.2B',
    vendor: 'Liquid AI',
    params: '1.2B',
    vramMB: 1001,
    downloadMB: 640,
    contextWindow: 4096,
    license: 'LFM Open License 1.0',
    codeTuned: false,
    tier: 'light',
    bestFor: 'Weak GPUs and tablets. Fastest to first token and the most reliable at obeying the "one question only" rule.',
    caution: 'General-purpose model: weaker on Python specifics. Non-commercial-ish licence terms - read before shipping.',
  },
  {
    id: 'Qwen3.5-2B-q4f16_1-MLC',
    f32Id: 'Qwen3.5-2B-q4f32_1-MLC',
    label: 'Qwen3.5 2B',
    vendor: 'Qwen (Alibaba)',
    params: '2B',
    vramMB: 2245,
    downloadMB: 1420,
    contextWindow: 4096,
    license: 'Apache-2.0',
    codeTuned: false,
    tier: 'quality',
    bestFor: 'Best explanations when the machine has ~3 GB of GPU memory to spare. Stronger reasoning about *why* the bug happens.',
    caution: 'Hybrid reasoning: thinking mode is disabled here to keep answers under a few seconds.',
    disableThinking: true,
  },
  {
    id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
    f32Id: 'Qwen2.5-Coder-0.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5-Coder 0.5B',
    vendor: 'Qwen (Alibaba)',
    params: '0.5B',
    vramMB: 945,
    downloadMB: 400,
    contextWindow: 4096,
    license: 'Apache-2.0',
    codeTuned: true,
    tier: 'minimum',
    bestFor: 'The floor: 4 GB integrated GPUs, phones, or a quick test before committing to a bigger download.',
    caution: 'Recognises the error type but often misses the semantics - expect it to restate the message rather than explain it.',
  },
  {
    id: 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC',
    f32Id: 'Qwen2.5-Coder-3B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5-Coder 3B',
    vendor: 'Qwen (Alibaba)',
    params: '3B',
    vramMB: 2505,
    downloadMB: 1740,
    contextWindow: 4096,
    license: 'Apache-2.0',
    codeTuned: true,
    tier: 'stretch',
    bestFor: 'Opt-in upper bound for desktop GPUs - useful in Model Lab to see what an extra 1.5 GB buys you.',
    caution: 'Slow to load; not offered as a default.',
  },
];

export const DEFAULT_MODEL_ID = 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC';

export function modelById(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}

/** The catalog entry for a runtime id, which may be the 32-bit fallback build. */
export function catalogForRuntimeId(id: string | null | undefined): CatalogModel | undefined {
  if (!id) return undefined;
  return MODEL_CATALOG.find((model) => model.id === id || model.f32Id === id);
}

export function tierLabel(tier: ModelTier): string {
  switch (tier) {
    case 'recommended':
      return 'recommended';
    case 'light':
      return 'light / fast';
    case 'quality':
      return 'higher quality';
    case 'minimum':
      return 'smallest';
    case 'stretch':
      return 'stretch';
  }
}

export function formatGB(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}
