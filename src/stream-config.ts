import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  CameraStreamConfig,
  DesktopCaptureConfig,
  PersistedStreamConfig,
  SseStreamConfig,
  WebApiStreamConfig,
} from './types.js';
import { configPath } from './paths.js';

export type LegacyStreamConfig = {
  streams?: unknown;
  webApiStreams?: WebApiStreamConfig[];
  sseStreams?: SseStreamConfig[];
  cameraStreams?: CameraStreamConfig[];
  desktopCapture?: DesktopCaptureConfig;
};

export function resolveStreamConfigs(file: LegacyStreamConfig): PersistedStreamConfig[] {
  if (Array.isArray(file.streams)) return cleanCanonicalStreams(file.streams);
  const streams: PersistedStreamConfig[] = [];
  for (const config of file.webApiStreams ?? []) {
    streams.push({
      kind: 'web_api',
      name: config.name,
      url: config.url,
      headers: config.headers,
      intervalMs: config.intervalMs,
      waking: config.waking,
      active: config.subscribed,
      emitUnchanged: config.emitUnchanged,
      ignorePaths: config.ignorePaths,
      format: config.kind,
    });
  }
  for (const config of file.sseStreams ?? []) {
    streams.push({
      kind: 'sse',
      name: config.name,
      url: config.url,
      headers: config.headers,
      waking: config.waking,
      active: config.subscribed,
      maxPayloads: config.maxPayloads,
    });
  }
  for (const config of file.cameraStreams ?? []) {
    streams.push({ kind: 'camera', ...withoutSubscribed(config), active: config.subscribed });
  }
  if (file.desktopCapture?.enabled !== false && file.desktopCapture) {
    const config = file.desktopCapture;
    streams.push({
      kind: 'desktop_capture',
      name: config.name || 'desktop:capture',
      fps: config.fps,
      width: config.width,
      height: config.height,
      waking: config.waking,
      active: config.subscribed,
      maxBufferedChunks: config.maxBufferedChunks,
    });
  }
  return streams.filter(validDefinition);
}

export function updatePersistedStream(
  instanceRoot: string,
  mutation:
    | { type: 'set'; stream: PersistedStreamConfig }
    | { type: 'remove'; name: string }
    | { type: 'gaze'; name: string; active?: boolean; waking?: boolean },
): void {
  const path = configPath(instanceRoot);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  const current = resolveStreamConfigs(raw as LegacyStreamConfig);
  let streams: PersistedStreamConfig[];
  if (mutation.type === 'set') {
    streams = [...current.filter(stream => stream.name !== mutation.stream.name), mutation.stream];
  } else if (mutation.type === 'remove') {
    streams = current.filter(stream => stream.name !== mutation.name);
  } else {
    const existing = current.find(stream => stream.name === mutation.name);
    if (!existing) throw new Error(`stream is not persisted in config: ${mutation.name}`);
    streams = current.map(stream => stream.name === mutation.name
      ? {
          ...stream,
          ...(mutation.active === undefined ? {} : { active: mutation.active }),
          ...(mutation.waking === undefined ? {} : { waking: mutation.waking }),
        }
      : stream);
  }
  raw.streams = streams.sort((a, b) => a.name.localeCompare(b.name));
  delete raw.webApiStreams;
  delete raw.sseStreams;
  delete raw.cameraStreams;
  delete raw.desktopCapture;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function cleanCanonicalStreams(value: unknown[]): PersistedStreamConfig[] {
  return value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as PersistedStreamConfig;
    return validDefinition(candidate) ? [candidate] : [];
  });
}

function validDefinition(value: PersistedStreamConfig): boolean {
  if (!value.name?.trim()) return false;
  if (value.kind === 'buffered' || value.kind === 'desktop_capture') return true;
  return typeof value.url === 'string' && value.url.trim().length > 0;
}

function withoutSubscribed(config: CameraStreamConfig): Omit<CameraStreamConfig, 'subscribed'> {
  const { subscribed: _, ...rest } = config;
  return rest;
}
