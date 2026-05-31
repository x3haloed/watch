export type JsonObject = Record<string, unknown>;

export type WatchConfig = {
  repoRoot: string;
  minCffMs: number;
  maxCffMs: number;
  modelTimeoutMs: number;
  defaultModel: string;
  availableModels: string[];
  restingModel?: string;
  restAfterNoToolSoundings: number;
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
  | { type: 'sounding_failed'; at: string; soundingId: string; modelId: string; error: JsonObject }
  | { type: 'model_step_finished'; at: string; soundingId: string; modelId: string; step: JsonObject }
  | { type: 'model_finished'; at: string; soundingId: string; modelId: string; result: JsonObject }
  | { type: 'model_error'; at: string; soundingId: string; modelId: string; error: JsonObject }
  | { type: 'model_aborted'; at: string; soundingId: string; modelId: string; reason: string }
  | { type: 'model_unavailable'; at: string; soundingId: string; modelId: string; reason: string }
  | { type: 'model_reroute'; at: string; soundingId: string; fromModelId: string; toModelId: string; params: JsonObject }
  | { type: 'model_auto_restored'; at: string; fromModelId: string; toModelId: string; noToolSoundings: number }
  | { type: 'cli_message'; at: string; soundingId: string; medium?: string; replyToId?: number; message: string }
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
