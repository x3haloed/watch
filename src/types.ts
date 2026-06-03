export type JsonObject = Record<string, unknown>;

export type WatchConfig = {
  repoRoot: string;
  minCffMs: number;
  maxCffMs: number;
  modelTimeoutMs: number;
  defaultModel: string;
  availableModels: string[];
  webApiStreams: WebApiStreamConfig[];
  ledgerPath?: string;
  discord?: DiscordConfig;
  restingModel?: string;
  restAfterNoToolSoundings: number;
  estimatedTokenWarningThreshold: number;
  noModel: boolean;
};

export type WebApiStreamConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  waking?: boolean;
  subscribed?: boolean;
};

export type DiscordConfig = {
  enabled?: boolean;
  tokenEnv?: string;
  defaultDMs?: boolean;
  defaultMentions?: boolean;
  defaultReplies?: boolean;
  mutedGuilds?: string[];
  mutedChannels?: string[];
  mutedThreads?: string[];
  mutedUsers?: string[];
  watchedChannels?: string[];
  watchedThreads?: string[];
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
  params?: string;
  role?: string;
  useFor?: string;
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
  | { type: 'model_timeout_checkpoint'; at: string; soundingId: string; modelId: string; checkpointMessages: number; toolCallCount: number }
  | { type: 'model_unavailable'; at: string; soundingId: string; modelId: string; reason: string }
  | { type: 'model_reroute'; at: string; soundingId: string; fromModelId: string; toModelId: string; params: JsonObject }
  | { type: 'model_reroute_failed'; at: string; soundingId: string; fromModelId: string; toModelId: string; error: JsonObject }
  | { type: 'model_auto_restored'; at: string; fromModelId: string; toModelId: string; noToolSoundings: number }
  | { type: 'model_auto_restore_blocked'; at: string; fromModelId: string; toModelId: string; noToolSoundings: number; context: JsonObject }
  | { type: 'model_auto_restore_failed'; at: string; fromModelId: string; toModelId: string; noToolSoundings: number; error: JsonObject }
  | { type: 'terminal_started'; at: string; soundingId: string; sessionId: string; command: string; cwd: string; background: boolean; pty: boolean }
  | { type: 'terminal_output_delta'; at: string; soundingId: string; sessionId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'terminal_finished'; at: string; soundingId: string; sessionId: string; exitCode: number | null; durationMs: number; output: string; error?: string }
  | { type: 'terminal_input'; at: string; soundingId: string; sessionId: string; text: string }
  | { type: 'terminal_killed'; at: string; soundingId: string; sessionId: string }
  | { type: 'cli_message'; at: string; soundingId: string; medium?: string; replyToId?: number; message: string }
  | { type: 'subscription_changed'; at: string; stream: string; subscribed: boolean }
  | { type: 'discord_started'; at: string; userId: string; username: string }
  | { type: 'discord_stopped'; at: string; reason: string }
  | { type: 'discord_inbound'; at: string; messageId: string; channelId: string; authorId: string; reason: string }
  | { type: 'discord_outbound'; at: string; soundingId: string; replyToId?: number; messageIds: string[] }
  | { type: 'discord_dropped'; at: string; messageId?: string; channelId?: string; authorId?: string; reason: string }
  | { type: 'discord_attention_changed'; at: string; action: string; scope: JsonObject; policy: JsonObject }
  | { type: 'discord_error'; at: string; error: JsonObject }
  | { type: 'control_message'; at: string; command: string; payload?: JsonObject }
  | { type: 'curl'; at: string; soundingId: string; ledgerPath?: string; wroteLedger: boolean; clearedMessages: number }
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
