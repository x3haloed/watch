export type JsonObject = Record<string, unknown>;

export type WatchConfig = {
  repoRoot: string;
  minCffMs: number;
  maxCffMs: number;
  modelId: string;
  availableModels: string[];
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
};

export type WatchEvent =
  | { type: 'daemon_started'; at: string; pid: number; config: WatchConfig }
  | { type: 'daemon_stopped'; at: string; reason: string }
  | { type: 'stream_delta'; at: string; delta: StreamDelta }
  | { type: 'sounding_started'; at: string; sounding: Sounding }
  | { type: 'sounding_finished'; at: string; soundingId: string; modelId: string; text: string }
  | { type: 'model_reroute'; at: string; soundingId: string; fromModelId: string; toModelId: string }
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
