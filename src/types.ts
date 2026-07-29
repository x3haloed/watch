export type JsonObject = Record<string, unknown>;

export type WatchConfig = {
  cloneRoot: string;
  instanceRoot: string;
  minCffMs: number;
  maxCffMs: number;
  modelTimeoutMs: number;
  defaultModel: string;
  availableModels: string[];
  webApiStreams: WebApiStreamConfig[];
  sseStreams: SseStreamConfig[];
  cameraStreams: CameraStreamConfig[];
  streams?: PersistedStreamConfig[];
  game?: GameIntegrationConfig;
  moltbook?: MoltbookConfig;
  desktopCapture?: DesktopCaptureConfig;
  ledgerPath?: string;
  discord?: DiscordConfig;
  scratchpad: ScratchpadConfig;
  restingModel?: string;
  restAfterNoToolSoundings: number;
  estimatedTokenWarningThreshold: number;
  noModel: boolean;
  memory?: {
    seedCrystals: SeedCrystalPolicy;
  };
};

export type SeedCrystalPolicy = {
  enabled: boolean;
  injectionEnabled: boolean;
  commissioningEnabled: boolean;
  creationPolicy: 'candidate_first' | 'allow_immediate_active';
  promotionPolicy: 'judgment_only' | 'disabled';
  maxActiveBytes: number;
  activeCountWarning: number;
  recoveryCliEnabled: boolean;
  omissionExperimentsEnabled: boolean;
  presentFitEnabled: boolean;
};

export type GameIntegrationConfig = {
  controlUrl: string;
  actionTimeoutMs?: number;
};

export type ScratchpadConfig = {
  enabled?: boolean;
  dir?: string;
  agentFile?: string;
  userFile?: string;
  agentMaxChars?: number;
  userMaxChars?: number;
};

export type SseStreamConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  waking?: boolean;
  subscribed?: boolean;
  maxPayloads?: number;
};

export type WebApiStreamConfig = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  waking?: boolean;
  subscribed?: boolean;
  emitUnchanged?: boolean;
  ignorePaths?: string[];
  kind?: 'tinyplace_canvas';
};

export type CameraStreamConfig = {
  name: string;
  url: string;
  mode?: 'stills' | 'video';
  fps?: number;
  width?: number;
  height?: number;
  duration?: number;
  motionGate?: boolean;
  format?: 'base64';
  waking?: boolean;
  subscribed?: boolean;
  maxBufferedChunks?: number;
};

export type DesktopCaptureConfig = {
  enabled?: boolean;
  name?: string;
  fps?: number;
  width?: number;
  height?: number;
  waking?: boolean;
  subscribed?: boolean;
  maxBufferedChunks?: number;
};

export type BufferedStreamConfig = {
  kind: 'buffered';
  name: string;
  active?: boolean;
  waking?: boolean;
  maxPayloads?: number;
};

export type CanonicalSseStreamConfig = Omit<SseStreamConfig, 'subscribed'> & {
  kind: 'sse';
  active?: boolean;
  maxPayloads?: number;
};

export type CanonicalWebApiStreamConfig = Omit<WebApiStreamConfig, 'subscribed' | 'kind'> & {
  kind: 'web_api';
  active?: boolean;
  format?: WebApiStreamConfig['kind'];
};

export type CanonicalCameraStreamConfig = Omit<CameraStreamConfig, 'subscribed'> & {
  kind: 'camera';
  active?: boolean;
};

export type CanonicalDesktopCaptureConfig = Omit<DesktopCaptureConfig, 'enabled' | 'name' | 'subscribed'> & {
  kind: 'desktop_capture';
  name: string;
  active?: boolean;
};

export type PersistedStreamConfig =
  | BufferedStreamConfig
  | CanonicalSseStreamConfig
  | CanonicalWebApiStreamConfig
  | CanonicalCameraStreamConfig
  | CanonicalDesktopCaptureConfig;

export type DiscordConfig = {
  enabled?: boolean;
  presenceEnabled?: boolean;
  tokenEnv?: string;
  defaultDMs?: boolean;
  dmWhitelist?: DiscordDmWhitelistConfig;
  defaultMentions?: boolean;
  defaultReplies?: boolean;
  defaultReactions?: boolean;
  mutedGuilds?: string[];
  mutedChannels?: string[];
  mutedThreads?: string[];
  mutedUsers?: string[];
  watchedChannels?: string[];
  watchedThreads?: string[];
};

export type DiscordDmWhitelistConfig = {
  mode?: 'all' | 'users';
  userIds?: string[];
};

export type MoltbookScopeType = 'home' | 'feed' | 'submolt' | 'user' | 'post' | 'search' | 'announcements';

export type MoltbookScopeConfig = {
  type: MoltbookScopeType;
  name?: string;
  id?: string;
  query?: string;
  filter?: 'all' | 'following';
  sort?: 'new' | 'hot' | 'top' | 'rising' | 'best' | 'old';
  comments?: boolean;
  waking?: boolean;
  intervalMs?: number;
};

export type MoltbookConfig = {
  enabled?: boolean;
  apiKeyEnv?: string;
  intervalMs?: number;
  subscribed?: boolean;
  waking?: boolean;
  maxItemsPerDelta?: number;
  scopes?: MoltbookScopeConfig[];
};

export type MoltbookScopeSnapshot = MoltbookScopeConfig & {
  key: string;
  source: 'config' | 'runtime';
};

export type MoltbookStateSnapshot = {
  scopes: MoltbookScopeSnapshot[];
};

export type TextStreamSnapshot = {
  name: string;
  file: string;
  charsPerSounding: number;
  nextChar: number;
};

export type VideoStreamSnapshot = {
  name: string;
  file: string;
  fps: number;
  speed: number;
  videoTime: number;
  duration: number;
  width?: number;
  height?: number;
};

export type AudioStreamSnapshot = {
  name: string;
  file: string;
  speed: number;
  sampleRate: number;
  channels: number;
  format: string;
  audioTime: number;
  duration: number;
};

export type AudioVideoStreamSnapshot = {
  name: string;
  file: string;
  fps: number;
  speed: number;
  mediaTime: number;
  duration: number;
  width?: number;
  height?: number;
  sampleRate: number;
  channels: number;
  format: string;
};

export type StreamRegistrySnapshot = {
  version?: 1 | 2;
  subscriptions: string[];
  knownStreams?: string[];
  gazeOverrides?: Record<string, { active?: boolean; waking?: boolean }>;
  runtimeDefinitions?: PersistedStreamConfig[];
  removedConfigDefinitions?: string[];
  textStreams: TextStreamSnapshot[];
  videoStreams?: VideoStreamSnapshot[];
  audioStreams?: AudioStreamSnapshot[];
  avStreams?: AudioVideoStreamSnapshot[];
};

export type DiscordPolicySnapshot = {
  defaultDMs: boolean;
  dmWhitelist: {
    mode: 'all' | 'users';
    userIds: string[];
  };
  defaultMentions: boolean;
  defaultReplies: boolean;
  defaultReactions: boolean;
  mutedGuilds: string[];
  mutedChannels: string[];
  mutedThreads: string[];
  mutedUsers: string[];
  watchedChannels: string[];
  watchedThreads: string[];
};

export type ModelProvider = 'openrouter' | 'openai-compatible' | 'novitaai';

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
  | { type: 'daemon_start_blocked'; at: string; pid?: number; lockPath: string; reason: string }
  | { type: 'daemon_stopped'; at: string; pid?: number; reason: string }
  | { type: 'stream_buffered'; at: string; stream: string; payload: JsonObject }
  | { type: 'stream_delta'; at: string; delta: StreamDelta }
  | { type: 'camera_stream_connected'; at: string; stream: string; url: string; handshake: JsonObject }
  | { type: 'camera_stream_disconnected'; at: string; stream: string; reason: string }
  | { type: 'camera_stream_buffered'; at: string; stream: string; sequence?: number; mediaType?: string; sizeBytes?: number }
  | { type: 'camera_stream_error'; at: string; stream: string; error: JsonObject }
  | { type: 'sounding_started'; at: string; sounding: Sounding }
  | { type: 'sounding_finished'; at: string; soundingId: string; modelId: string; text: string }
  | { type: 'sounding_failed'; at: string; soundingId: string; modelId: string; error: JsonObject; classification?: JsonObject }
  | { type: 'sounding_steered'; at: string; soundingId: string; deltas: StreamDelta[] }
  | { type: 'model_step_finished'; at: string; soundingId: string; modelId: string; step: JsonObject }
  | { type: 'model_finished'; at: string; soundingId: string; modelId: string; result: JsonObject }
  | { type: 'model_error'; at: string; soundingId: string; modelId: string; error: JsonObject; classification?: JsonObject; request?: JsonObject; requests?: JsonObject[] }
  | { type: 'model_aborted'; at: string; soundingId: string; modelId: string; reason: string }
  | { type: 'model_failure_backoff'; at: string; modelId: string; failures: number; delayMs: number; until: string; reason: string; classification?: JsonObject }
  | { type: 'model_timeout_checkpoint'; at: string; soundingId: string; modelId: string; checkpointMessages: number; toolCallCount: number; errorKind?: string }
  | { type: 'model_failure_checkpoint'; at: string; soundingId: string; modelId: string; checkpointMessages: number; toolCallCount: number; errorKind?: string }
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
  | { type: 'terminal_killed'; at: string; soundingId: string; sessionId: string; reason?: string }
  | { type: 'cli_message'; at: string; soundingId: string; medium?: string; replyToId?: number | string; message: string; attachments?: string[] }
  | { type: 'subscription_changed'; at: string; stream: string; subscribed: boolean }
  | { type: 'discord_started'; at: string; userId: string; username: string }
  | { type: 'discord_stopped'; at: string; reason: string }
  | { type: 'discord_inbound'; at: string; messageId: string; channelId: string; authorId: string; reason: string }
  | { type: 'discord_outbound'; at: string; soundingId: string; replyToId?: number | string; channelId?: string; messageIds: string[] }
  | { type: 'discord_dropped'; at: string; messageId?: string; channelId?: string; authorId?: string; reason: string }
  | { type: 'discord_attention_changed'; at: string; action: string; scope: JsonObject; policy: JsonObject }
  | { type: 'discord_presence_changed'; at: string; presence: JsonObject }
  | { type: 'discord_error'; at: string; error: JsonObject }
  | { type: 'control_message'; at: string; command: string; payload?: JsonObject }
  | { type: 'curl'; at: string; soundingId: string; ledgerPath?: string; wroteLedger: boolean; clearedMessages: number }
  | { type: 'reboot_requested'; at: string; soundingId: string; ledgerPath?: string; wroteLedger: boolean; clearedMessages: number; source: 'tool' | 'control' }
  | { type: 'memory_updated'; at: string; target: string; payload: JsonObject }
  | { type: 'memory_captured'; at: string; memoryId: string; layer: string; kind: string; source: string; provenance: JsonObject }
  | { type: 'memory_candidates_presented'; at: string; soundingId?: string; memoryIds: string[] }
  | { type: 'memory_reinforced'; at: string; memoryId: string; outcome: string }
  | { type: 'memory_irrelevant'; at: string; memoryId: string; reason: string }
  | { type: 'memory_distilled'; at: string; memoryId: string; layer: string; parents: string[] }
  | { type: 'memory_contradicted'; at: string; memoryId: string; rationale: string }
  | { type: 'memory_stale'; at: string; memoryId: string; reason: string }
  | { type: 'memory_scratchpad_proposed'; at: string; memoryId: string; memoryIds: string[] }
  | { type: 'seed_crystals_injected'; at: string; soundingId: string; crystalIds: string[]; omittedCrystalIds: string[]; bytes: number; estimatedTokens: number; condition: 'normal' | 'controlled_omission' | 'injection_disabled' }
  | { type: 'sse_stream_connected'; at: string; stream: string; url: string }
  | { type: 'sse_stream_disconnected'; at: string; stream: string; reason: string }
  | { type: 'sse_stream_error'; at: string; stream: string; error: string }
  | { type: 'model_skipped'; at: string; soundingId: string; reason: string };

export type ControlRequest =
  | { command: 'send'; message: string; source?: string }
  | { command: 'status' }
  | { command: 'stop' }
  | { command: 'sound' }
  | { command: 'reboot'; ledgerEntry?: string };

export type ControlResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};
