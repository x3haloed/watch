export type JsonObject = Record<string, unknown>;

export type WatchConfig = {
  repoRoot: string;
  minCffMs: number;
  maxCffMs: number;
  defaultModel: string;
  availableModels: string[];
  noModel: boolean;
};

export type ModelProvider = 'openrouter' | 'openai-compatible';

export type ModelCapabilities = {
  tools: boolean;
  text: boolean;
  images: boolean;
  audio: boolean;
  video: boolean;
  pdf: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  contextTokens?: number;
  outputTokens?: number;
  source: string;
};

export type ModelConfig = {
  id: string;
  provider: ModelProvider;
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  capabilities?: Partial<ModelCapabilities>;
};

export type ResolvedModel = ModelConfig & {
  capabilities: ModelCapabilities;
};

export type StreamDelta = {
  stream: string;
  at: string;
  payload: JsonObject;
};

export type SoundingTrigger = 'delta' | 'heartbeat' | 'manual';

export type Sounding = {
  id: string;
  at: string;
  lastFlickerMs: number;
  trigger: SoundingTrigger;
  deltas: StreamDelta[];
  modelId: string;
  model: ResolvedModel;
};

export type WatchEvent =
  | { type: 'daemon_started'; at: string; pid: number; config: WatchConfig }
  | { type: 'daemon_stopped'; at: string; reason: string }
  | { type: 'stream_buffered'; at: string; stream: string; payload: JsonObject }
  | { type: 'stream_delta'; at: string; delta: StreamDelta }
  | { type: 'sounding_started'; at: string; sounding: Sounding }
  | { type: 'sounding_finished'; at: string; soundingId: string; modelId: string; text: string }
  | { type: 'model_reroute'; at: string; soundingId: string; fromModelId: string; toModelId: string; params: JsonObject }
  | { type: 'subscription_changed'; at: string; stream: string; subscribed: boolean }
  | { type: 'control_message'; at: string; command: string; payload?: JsonObject }
  | { type: 'model_skipped'; at: string; soundingId: string; reason: string };

export type ControlRequest =
  | { command: 'send'; message: string; source?: string }
  | { command: 'status' }
  | { command: 'stop' }
  | { command: 'sound' };

export type ControlResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};
