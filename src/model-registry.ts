import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { codexCli } from 'ai-sdk-provider-codex-cli';
import type { LanguageModel } from 'ai';
import { configPath, ensureInstanceDir, modelsDevCachePath, stateDir, statePath } from './paths.js';
import type { ModelCapabilities, ModelConfig, ModelProvider, ResolvedModel } from './types.js';

type WatchConfigFile = {
  defaultModel?: string;
  restingModel?: string;
  restAfterNoToolSoundings?: number;
  models?: Record<string, Omit<ModelConfig, 'id'> & { capabilities?: Partial<ModelCapabilities> }>;
};

type ModelsDevModel = {
  tool_call?: boolean;
  structured_output?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    output?: number;
  };
};

type ModelsDevRegistry = Record<string, { models?: Record<string, ModelsDevModel> }>;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_CACHE_TTL_MS = 60 * 60 * 1000;

const DEFAULT_MODELS: Record<string, Omit<ModelConfig, 'id'>> = {
  'local:auto': {
    provider: 'openai-compatible',
    model: 'auto',
    baseURL: 'http://localhost:1234/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  'ollama:auto': {
    provider: 'openai-compatible',
    model: 'auto',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
  },
  'codex:gpt-5.1-codex': {
    provider: 'codex-cli',
    model: 'gpt-5.1-codex',
  },
};

const PROVIDER_TO_MODELS_DEV: Record<string, string> = {
  openrouter: 'openrouter',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  'codex-cli': 'openai',
};

export class ModelRegistry {
  private activeModelId: string;
  private readonly models: Map<string, ModelConfig>;
  private modelsDevCache: ModelsDevRegistry | undefined;

  private constructor(
    private readonly instanceRoot: string,
    defaultModel: string,
    models: ModelConfig[],
  ) {
    this.models = new Map(models.map(model => [model.id, model]));
    this.activeModelId = this.readActiveModel() ?? defaultModel;
    if (!this.models.has(this.activeModelId)) {
      this.activeModelId = defaultModel;
    }
  }

  static load(instanceRoot: string, cliModel: string, cliModels?: string[]): ModelRegistry {
    const file = readConfigFile(instanceRoot);
    const modelEntries = new Map<string, ModelConfig>();

    for (const [id, model] of Object.entries(DEFAULT_MODELS)) {
      modelEntries.set(id, { id, ...model });
    }

    for (const [id, model] of Object.entries(file.models ?? {})) {
      modelEntries.set(id, normalizeModelConfig(id, model));
    }

    for (const id of cliModels ?? []) {
      if (!modelEntries.has(id)) {
        modelEntries.set(id, inferModelConfig(id));
      }
    }

    if (cliModel && !modelEntries.has(cliModel)) {
      modelEntries.set(cliModel, inferModelConfig(cliModel));
    }

    if (file.restingModel?.trim() && !modelEntries.has(file.restingModel)) {
      modelEntries.set(file.restingModel, inferModelConfig(file.restingModel));
    }

    const defaultModel = cliModel || file.defaultModel;
    if (!defaultModel?.trim()) {
      throw new Error('No default model configured. Set defaultModel in config.json or pass --model.');
    }
    if (!modelEntries.has(defaultModel)) {
      modelEntries.set(defaultModel, inferModelConfig(defaultModel));
    }

    return new ModelRegistry(instanceRoot, defaultModel, [...modelEntries.values()]);
  }

  listModelIds(): string[] {
    return [...this.models.keys()].sort();
  }

  get activeId(): string {
    return this.activeModelId;
  }

  async getActive(): Promise<ResolvedModel> {
    return await this.resolve(this.activeModelId);
  }

  async resolve(id: string): Promise<ResolvedModel> {
    const config = this.models.get(id);
    if (!config) {
      throw new Error(`Unknown model: ${id}`);
    }
    return {
      ...config,
      capabilities: await this.resolveCapabilities(config),
    };
  }

  async resolveAll(): Promise<ResolvedModel[]> {
    return await Promise.all(this.listModelIds().map(id => this.resolve(id)));
  }

  async switchTo(id: string): Promise<ResolvedModel> {
    const model = await this.resolve(id);
    if (!model.capabilities.tools) {
      throw new Error(`Model ${id} is not supported by Watch because tool_call is false or unknown.`);
    }
    this.activeModelId = id;
    this.writeActiveModel(id);
    return model;
  }

  createLanguageModel(model: ResolvedModel): LanguageModel {
    if (model.provider === 'codex-cli') {
      return codexCli(model.model) as LanguageModel;
    }

    if (model.provider === 'openrouter') {
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: model.baseURL ?? 'https://openrouter.ai/api/v1',
        apiKey: readApiKey(model.apiKeyEnv ?? 'OPENROUTER_API_KEY'),
        transformRequestBody: transformOpenRouterRequestBody,
      })(model.model) as LanguageModel;
    }

    return createOpenAICompatible({
      name: model.id,
      baseURL: model.baseURL ?? 'http://localhost:1234/v1',
      apiKey: readApiKey(model.apiKeyEnv) || 'no-key-required',
    })(model.model) as LanguageModel;
  }

  async checkAvailable(model: ResolvedModel): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (model.provider !== 'openai-compatible' || !model.baseURL) {
      return { ok: true };
    }

    const url = `${model.baseURL.replace(/\/$/, '')}/models`;
    try {
      const response = await fetch(url, {
        headers: authHeaders(model),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        return { ok: false, reason: `/models returned ${response.status}` };
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (payload.data ?? []).map(entry => entry.id).filter((id): id is string => Boolean(id));
      if (model.model === 'auto') {
        return ids.length > 0 ? { ok: true } : { ok: false, reason: '/models returned no models' };
      }
      return ids.includes(model.model)
        ? { ok: true }
        : { ok: false, reason: `model ${model.model} not found in /models (${ids.join(', ') || 'none'})` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async resolveCapabilities(model: ModelConfig): Promise<ModelCapabilities> {
    const fromModelsDev = await this.lookupModelsDev(model);
    const fallback = conservativeCapabilities(model.provider);
    return {
      ...fallback,
      ...fromModelsDev,
      ...model.capabilities,
      source: model.capabilities ? `${fromModelsDev?.source ?? fallback.source}+config` : fromModelsDev?.source ?? fallback.source,
    };
  }

  private async lookupModelsDev(model: ModelConfig): Promise<Partial<ModelCapabilities> | undefined> {
    const providerId = modelsDevProviderId(model);
    if (!providerId) {
      return undefined;
    }

    const registry = await this.fetchModelsDev();
    const models = registry[providerId]?.models;
    if (!models) {
      return undefined;
    }

    const entry = findModelsDevEntry(models, model.model);
    return entry ? capabilitiesFromModelsDev(entry) : undefined;
  }

  private async fetchModelsDev(): Promise<ModelsDevRegistry> {
    if (this.modelsDevCache) {
      return this.modelsDevCache;
    }

    const cachePath = modelsDevCachePath(this.instanceRoot);
    const cached = readModelsDevCache(cachePath);
    if (cached && Date.now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
      this.modelsDevCache = cached.data;
      return cached.data;
    }

    try {
      const response = await fetch(MODELS_DEV_URL);
      if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`);
      }
      const data = (await response.json()) as ModelsDevRegistry;
      ensureInstanceDir(this.instanceRoot);
      mkdirSync(stateDir(this.instanceRoot), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), data }, null, 2), 'utf8');
      this.modelsDevCache = data;
      return data;
    } catch {
      this.modelsDevCache = cached?.data ?? {};
      return this.modelsDevCache;
    }
  }

  private readActiveModel(): string | undefined {
    const path = statePath(this.instanceRoot);
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { activeModel?: string };
      return parsed.activeModel;
    } catch {
      return undefined;
    }
  }

  private writeActiveModel(activeModel: string): void {
    ensureInstanceDir(this.instanceRoot);
    mkdirSync(stateDir(this.instanceRoot), { recursive: true });
    const path = statePath(this.instanceRoot);
    let previous: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        previous = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        previous = {};
      }
    }
    writeFileSync(
      path,
      `${JSON.stringify({
        ...previous,
        version: 1,
        updatedAt: new Date().toISOString(),
        activeModel,
      }, null, 2)}\n`,
      'utf8',
    );
  }
}

const WATCH_OPENROUTER_VIDEO_SENTINEL = '__watch_openrouter_video__:';
const WATCH_OPENROUTER_AUDIO_SENTINEL = '__watch_openrouter_audio__:';

function transformOpenRouterRequestBody(args: Record<string, any>): Record<string, any> {
  return {
    ...args,
    messages: Array.isArray(args.messages)
      ? args.messages.map(transformOpenRouterMessage)
      : args.messages,
  };
}

function transformOpenRouterMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const record = message as Record<string, any>;
  if (!Array.isArray(record.content)) return message;

  const content = record.content.flatMap((part: unknown) => {
    if (!part || typeof part !== 'object') return [part];
    const partRecord = part as Record<string, any>;
    if (partRecord.type !== 'text' || typeof partRecord.text !== 'string') return [part];
    
    const video = parseOpenRouterVideoSentinel(partRecord.text);
    if (video) {
      return [
        ...(video.text ? [{ type: 'text', text: video.text }] : []),
        { type: 'video_url', video_url: { url: video.url } },
      ];
    }

    const audio = parseOpenRouterAudioSentinel(partRecord.text);
    if (audio) {
      return [
        {
          type: 'input_audio',
          input_audio: {
            data: audio.data,
            format: audio.format,
          },
        },
      ];
    }

    return [part];
  });

  return { ...record, content };
}

function parseOpenRouterVideoSentinel(text: string): { url: string; text?: string } | undefined {
  if (!text.startsWith(WATCH_OPENROUTER_VIDEO_SENTINEL)) return undefined;
  try {
    const parsed = JSON.parse(text.slice(WATCH_OPENROUTER_VIDEO_SENTINEL.length)) as { url?: unknown; text?: unknown };
    return typeof parsed.url === 'string'
      ? { url: parsed.url, text: typeof parsed.text === 'string' ? parsed.text : undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseOpenRouterAudioSentinel(text: string): { data: string; format: string } | undefined {
  if (!text.startsWith(WATCH_OPENROUTER_AUDIO_SENTINEL)) return undefined;
  try {
    const parsed = JSON.parse(text.slice(WATCH_OPENROUTER_AUDIO_SENTINEL.length)) as { data?: unknown; format?: unknown };
    return typeof parsed.data === 'string' && typeof parsed.format === 'string'
      ? { data: parsed.data, format: parsed.format }
      : undefined;
  } catch {
    return undefined;
  }
}

function readConfigFile(instanceRoot: string): WatchConfigFile {
  const path = configPath(instanceRoot);
  if (!existsSync(path)) {
    return {};
  }
  return JSON.parse(readFileSync(path, 'utf8')) as WatchConfigFile;
}

function normalizeModelConfig(id: string, value: Omit<ModelConfig, 'id'>): ModelConfig {
  return { id, ...value };
}

function inferModelConfig(id: string): ModelConfig {
  if (id.startsWith('openrouter:')) {
    return {
      id,
      provider: 'openrouter',
      model: id.slice('openrouter:'.length),
      apiKeyEnv: 'OPENROUTER_API_KEY',
    };
  }

  if (id.startsWith('local:') || id.startsWith('ollama:')) {
    const local = id.startsWith('local:');
    return {
      id,
      provider: 'openai-compatible',
      model: id.split(':').slice(1).join(':') || 'auto',
      baseURL: local ? 'http://localhost:1234/v1' : 'http://localhost:11434/v1',
      apiKeyEnv: local ? 'OPENAI_API_KEY' : 'OLLAMA_API_KEY',
    };
  }

  if (id.startsWith('codex:')) {
    return {
      id,
      provider: 'codex-cli',
      model: id.slice('codex:'.length),
    };
  }

  return {
    id,
    provider: 'openrouter',
    model: id,
    apiKeyEnv: 'OPENROUTER_API_KEY',
  };
}

function readApiKey(envName?: string): string {
  return envName ? process.env[envName]?.trim() ?? '' : '';
}

function authHeaders(model: ResolvedModel): Record<string, string> {
  const apiKey = readApiKey(model.apiKeyEnv);
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function modelsDevProviderId(model: ModelConfig): string | undefined {
  if (model.provider === 'openrouter') {
    return 'openrouter';
  }

  if (model.baseURL) {
    const url = model.baseURL.toLowerCase();
    if (url.includes('api.openai.com')) return 'openai';
    if (url.includes('api.anthropic.com')) return 'anthropic';
    if (url.includes('generativelanguage.googleapis.com')) return 'google';
    if (url.includes('openrouter.ai')) return 'openrouter';
  }

  return PROVIDER_TO_MODELS_DEV[model.provider];
}

function findModelsDevEntry(models: Record<string, ModelsDevModel>, modelId: string): ModelsDevModel | undefined {
  const exact = models[modelId];
  if (exact) {
    return exact;
  }

  const lower = modelId.toLowerCase();
  for (const [id, entry] of Object.entries(models)) {
    if (id.toLowerCase() === lower) {
      return entry;
    }
  }

  return undefined;
}

function capabilitiesFromModelsDev(entry: ModelsDevModel): ModelCapabilities {
  const input = new Set(entry.modalities?.input ?? []);
  const output = new Set(entry.modalities?.output ?? []);
  return {
    tools: entry.tool_call === true,
    text: input.has('text') || output.has('text'),
    images: input.has('image'),
    audio: input.has('audio'),
    video: input.has('video'),
    pdf: input.has('pdf'),
    reasoning: entry.reasoning,
    structuredOutput: entry.structured_output,
    contextTokens: positiveInt(entry.limit?.context),
    outputTokens: positiveInt(entry.limit?.output),
    source: 'models.dev',
  };
}

function conservativeCapabilities(provider: ModelProvider): ModelCapabilities {
  return {
    tools: false,
    text: true,
    images: false,
    audio: false,
    video: false,
    pdf: false,
    source:
      provider === 'openai-compatible'
        ? 'conservative-openai-compatible'
        : provider === 'codex-cli'
          ? 'conservative-codex-cli'
          : 'conservative',
  };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function readModelsDevCache(path: string): { fetchedAt: number; data: ModelsDevRegistry } | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt?: number; data?: ModelsDevRegistry };
    if (typeof parsed.fetchedAt === 'number' && parsed.data) {
      return { fetchedAt: parsed.fetchedAt, data: parsed.data };
    }
  } catch {
    return undefined;
  }

  return undefined;
}
