import { jsonSchema, tool } from 'ai';
import { mediaToolOutputToModelOutput } from '../lookout-helpers.js';
import type { LookoutToolContext } from './context.js';
import type { JsonObject, PersistedStreamConfig } from '../types.js';

export function createStreamTools(ctx: LookoutToolContext) {
  return {
    stream_definition_list: tool({
      description: 'List every defined stream kind with origin, capabilities, current gaze, connector state, and redacted connection metadata.',
      inputSchema: jsonSchema<{ name?: string }>({
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional exact stream name filter.' },
        },
        additionalProperties: false,
      }),
      execute: async ({ name }) => ({ ok: true, streams: ctx.streams.listDefinitions({ name }) }),
    }),
    stream_definition_set: tool({
      description: 'Create or replace a buffered, SSE, Web API, camera, or desktop-capture stream. The live change is immediate; persistToConfig controls config.json projection.',
      inputSchema: jsonSchema<StreamDefinitionToolInput>({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['buffered', 'sse', 'web_api', 'camera', 'desktop_capture'] },
          name: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          active: { type: 'boolean' },
          waking: { type: 'boolean' },
          maxPayloads: { type: 'number' },
          intervalMs: { type: 'number' },
          emitUnchanged: { type: 'boolean' },
          ignorePaths: { type: 'array', items: { type: 'string' } },
          format: { type: 'string' },
          mode: { type: 'string', enum: ['stills', 'video'] },
          fps: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          duration: { type: 'number' },
          motionGate: { type: 'boolean' },
          maxBufferedChunks: { type: 'number' },
          persistToConfig: { type: 'boolean' },
        },
        required: ['kind', 'name', 'persistToConfig'],
        additionalProperties: false,
      }),
      execute: async input => {
        const definition = streamDefinitionFromTool(input);
        return ctx.streams.setDefinition(definition, input.persistToConfig);
      },
    }),
    stream_definition_remove: tool({
      description: 'Remove a stream definition and stop its connector. Integration-owned and protected system definitions cannot be removed.',
      inputSchema: jsonSchema<{ name: string; persistToConfig: boolean }>({
        type: 'object',
        properties: {
          name: { type: 'string' },
          persistToConfig: { type: 'boolean' },
        },
        required: ['name', 'persistToConfig'],
        additionalProperties: false,
      }),
      execute: async ({ name, persistToConfig }) => ctx.streams.removeDefinition(name, persistToConfig),
    }),
    gaze_list: tool({
      description: 'List active and inactive gaze across every stream kind, with optional filters.',
      inputSchema: jsonSchema<{ name?: string; active?: boolean; waking?: boolean }>({
        type: 'object',
        properties: {
          name: { type: 'string' },
          active: { type: 'boolean' },
          waking: { type: 'boolean' },
        },
        additionalProperties: false,
      }),
      execute: async filter => ({ ok: true, streams: ctx.streams.list(filter) }),
    }),
    gaze_set: tool({
      description: 'Activate or deactivate a defined stream and optionally change whether it wakes the agent. Runtime changes remain in durable gaze state; persistToConfig also projects them into config.json.',
      inputSchema: jsonSchema<{ name: string; active?: boolean; waking?: boolean; persistToConfig: boolean }>({
        type: 'object',
        properties: {
          name: { type: 'string' },
          active: { type: 'boolean' },
          waking: { type: 'boolean' },
          persistToConfig: { type: 'boolean' },
        },
        required: ['name', 'persistToConfig'],
        additionalProperties: false,
      }),
      execute: async ({ name, active, waking, persistToConfig }) => {
        if (active === undefined && waking === undefined) throw new Error('gaze_set requires active or waking');
        return ctx.streams.setGaze(name, { active, waking }, persistToConfig);
      },
    }),
    gaze_remove: tool({
      description: 'Remove a defined stream from gaze while retaining its definition. Equivalent to active=false.',
      inputSchema: jsonSchema<{ name: string; persistToConfig: boolean }>({
        type: 'object',
        properties: {
          name: { type: 'string' },
          persistToConfig: { type: 'boolean' },
        },
        required: ['name', 'persistToConfig'],
        additionalProperties: false,
      }),
      execute: async ({ name, persistToConfig }) => ctx.streams.setGaze(name, { active: false }, persistToConfig),
    }),
    text_stream_open: tool({
      description:
        'Begin reading a UTF-8 text file as a gaze stream. Returns the first chunk immediately, then future Soundings include the next chunk until EOF or text_stream_close/gaze_remove.',
      inputSchema: jsonSchema<{ path: string; charsPerSounding?: number; resumeAtChar?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Text file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          charsPerSounding: { type: 'number', description: 'Optional number of characters to include in each Sounding. Defaults to 4000, max 100000.' },
          resumeAtChar: { type: 'number', description: 'Optional zero-based character offset to start/resume from. Defaults to 0.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, charsPerSounding, resumeAtChar }) => {
        const result = await ctx.streams.openTextFileStream({ path, charsPerSounding, resumeAtChar });
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream: String(result.stream ?? 'text-stream'),
          subscribed: Boolean(result.subscribed),
        });
        return formatTextOpenResult(result);
      },
    }),
    text_stream_close: tool({
      description: 'Stop and remove a text file gaze stream created by text_stream_open.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'Stream name returned by text_stream_open.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const result = ctx.streams.closeTextFileStream(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: false,
        });
        return result;
      },
    }),
    video_stream_open: tool({
      description:
        'Begin reading a video file as a gaze stream. Streams video chunks when the active model supports video input, otherwise extracts image frames on-the-fly based on elapsed time between Soundings. Returns the initial chunk immediately, then future Soundings include subsequent chunks until video end or video_stream_close/gaze_remove.',
      inputSchema: jsonSchema<{ path: string; fps?: number; speed?: number; resumeAtSecond?: number; width?: number; height?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Video file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          fps: { type: 'number', description: 'Optional target frame rate for video chunks or sampled frames. Defaults to 5 fps.' },
          speed: { type: 'number', description: 'Optional playback speed multiplier. Defaults to 1 (real-time speed).' },
          resumeAtSecond: { type: 'number', description: 'Optional starting second offset to read/resume from. Defaults to 0.' },
          width: { type: 'number', description: 'Optional target width to downsample video resolution. Defaults to 640.' },
          height: { type: 'number', description: 'Optional target height to downsample video resolution. Defaults to 360.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, fps, speed, resumeAtSecond, width, height }) => {
        const result = await ctx.streams.openVideoFileStream({ path, fps, speed, resumeAtSecond, width, height, preferVideo: ctx.currentModel().capabilities.video });
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream: String(result.stream ?? 'video-stream'),
          subscribed: Boolean(result.subscribed),
        });
        return formatVideoOpenResult(result);
      },
      toModelOutput: (options: { output: unknown }) => mediaToolOutputToModelOutput(options.output) as never,
    }),
    video_stream_close: tool({
      description: 'Stop and remove a video file gaze stream created by video_stream_open.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'Stream name returned by video_stream_open.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const result = ctx.streams.closeVideoFileStream(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: false,
        });
        return result;
      },
    }),
    audio_stream_open: tool({
      description:
        'Begin reading an audio file as a gaze stream. Extracts audio chunks on-the-fly based on elapsed time between Soundings. Returns the initial chunk immediately, then future Soundings include subsequent chunks until audio end or audio_stream_close/gaze_remove.',
      inputSchema: jsonSchema<{ path: string; speed?: number; sampleRate?: number; channels?: number; format?: string; resumeAtSecond?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Audio file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          speed: { type: 'number', description: 'Optional playback speed multiplier. Defaults to 1 (real-time speed).' },
          sampleRate: { type: 'number', description: 'Optional sample rate to downsample audio (e.g. 16000). Defaults to 16000 Hz.' },
          channels: { type: 'number', description: 'Optional number of audio channels (e.g. 1 for mono, 2 for stereo). Defaults to 1.' },
          format: { type: 'string', description: 'Optional target container format (e.g. "mp3", "wav", "ogg", "m4a"). Defaults to "mp3".' },
          resumeAtSecond: { type: 'number', description: 'Optional starting second offset to read/resume from. Defaults to 0.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, speed, sampleRate, channels, format, resumeAtSecond }) => {
        const result = await ctx.streams.openAudioFileStream({ path, speed, sampleRate, channels, format, resumeAtSecond });
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream: String(result.stream ?? 'audio-stream'),
          subscribed: Boolean(result.subscribed),
        });
        return formatAudioOpenResult(result);
      },
      toModelOutput: (options: { output: unknown }) => mediaToolOutputToModelOutput(options.output) as never,
    }),
    audio_stream_close: tool({
      description: 'Stop and remove an audio file gaze stream created by audio_stream_open.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'Stream name returned by audio_stream_open.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const result = ctx.streams.closeAudioFileStream(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: false,
        });
        return result;
      },
    }),
    av_stream_open: tool({
      description:
        'Begin reading one media file containing audio and video as a single gaze stream. Extracts audio chunks and streams video chunks when the active model supports video input, otherwise samples image frames, from one shared media timeline based on elapsed time between Soundings. Returns the initial audio/video chunk immediately, then future Soundings include subsequent chunks until media end or av_stream_close/gaze_remove.',
      inputSchema: jsonSchema<{ path: string; fps?: number; speed?: number; sampleRate?: number; channels?: number; format?: string; resumeAtSecond?: number; width?: number; height?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Audio/video file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          fps: { type: 'number', description: 'Optional target frame rate for video chunks or sampled frames. Defaults to 5 fps.' },
          speed: { type: 'number', description: 'Optional playback speed multiplier. Defaults to 1 (real-time speed).' },
          sampleRate: { type: 'number', description: 'Optional sample rate to downsample audio (e.g. 16000). Defaults to 16000 Hz.' },
          channels: { type: 'number', description: 'Optional number of audio channels (e.g. 1 for mono, 2 for stereo). Defaults to 1.' },
          format: { type: 'string', description: 'Optional target audio container format (e.g. "mp3", "wav", "ogg", "m4a"). Defaults to "mp3".' },
          resumeAtSecond: { type: 'number', description: 'Optional starting second offset to read/resume from. Defaults to 0.' },
          width: { type: 'number', description: 'Optional target width to downsample video resolution. Defaults to 640.' },
          height: { type: 'number', description: 'Optional target height to downsample video resolution. Defaults to 360.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, fps, speed, sampleRate, channels, format, resumeAtSecond, width, height }) => {
        const result = await ctx.streams.openAudioVideoFileStream({ path, fps, speed, sampleRate, channels, format, resumeAtSecond, width, height, preferVideo: ctx.currentModel().capabilities.video });
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream: String(result.stream ?? 'av-stream'),
          subscribed: Boolean(result.subscribed),
        });
        return formatAudioVideoOpenResult(result);
      },
      toModelOutput: (options: { output: unknown }) => mediaToolOutputToModelOutput(options.output) as never,
    }),
    av_stream_close: tool({
      description: 'Stop and remove an audio/video file gaze stream created by av_stream_open.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'Stream name returned by av_stream_open.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const result = ctx.streams.closeAudioVideoFileStream(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: false,
        });
        return result;
      },
    }),
  };
}

type StreamDefinitionToolInput = {
  kind: PersistedStreamConfig['kind'];
  name: string;
  url?: string;
  headers?: Record<string, string>;
  active?: boolean;
  waking?: boolean;
  maxPayloads?: number;
  intervalMs?: number;
  emitUnchanged?: boolean;
  ignorePaths?: string[];
  format?: string;
  mode?: 'stills' | 'video';
  fps?: number;
  width?: number;
  height?: number;
  duration?: number;
  motionGate?: boolean;
  maxBufferedChunks?: number;
  persistToConfig: boolean;
};

function streamDefinitionFromTool(input: StreamDefinitionToolInput): PersistedStreamConfig {
  const name = input.name.trim();
  if (!name) throw new Error('stream name is required');
  if (input.kind === 'buffered') {
    return { kind: input.kind, name, active: input.active, waking: input.waking, maxPayloads: input.maxPayloads };
  }
  if (input.kind === 'desktop_capture') {
    return {
      kind: input.kind,
      name,
      active: input.active,
      waking: input.waking,
      fps: input.fps,
      width: input.width,
      height: input.height,
      maxBufferedChunks: input.maxBufferedChunks,
    };
  }
  const url = input.url?.trim();
  if (!url) throw new Error(`${input.kind} streams require url`);
  if (input.kind === 'sse') {
    return { kind: input.kind, name, url, headers: input.headers, active: input.active, waking: input.waking, maxPayloads: input.maxPayloads };
  }
  if (input.kind === 'web_api') {
    if (input.format !== undefined && input.format !== 'tinyplace_canvas') throw new Error('web_api format must be tinyplace_canvas when provided');
    return {
      kind: input.kind,
      name,
      url,
      headers: input.headers,
      active: input.active,
      waking: input.waking,
      intervalMs: input.intervalMs,
      emitUnchanged: input.emitUnchanged,
      ignorePaths: input.ignorePaths,
      format: input.format as 'tinyplace_canvas' | undefined,
    };
  }
  return {
    kind: input.kind,
    name,
    url,
    active: input.active,
    waking: input.waking,
    mode: input.mode,
    fps: input.fps,
    width: input.width,
    height: input.height,
    duration: input.duration,
    motionGate: input.motionGate,
    maxBufferedChunks: input.maxBufferedChunks,
  };
}

function formatTextOpenResult(result: Record<string, unknown>): Record<string, unknown> {
  const firstChunk = result.firstChunk as JsonObject | undefined;
  const filename = String(result.filename ?? result.file ?? 'file');
  const totalChars = Number(result.totalChars ?? 0);
  const charsPerSounding = Number(result.charsPerSounding ?? 0);
  const chunk = typeof firstChunk?.chunk === 'string' ? firstChunk.chunk : '';
  return {
    ...result,
    message: `text stream for file ${filename} successful. total of ${totalChars} chars. ${charsPerSounding} chars per sounding. First chapter starts now:`,
    text: `text stream for file ${filename} successful. total of ${totalChars} chars. ${charsPerSounding} chars per sounding. First chapter starts now:\n\n${chunk}`,
  };
}

function formatVideoOpenResult(result: Record<string, unknown>): Record<string, unknown> {
  const filename = String(result.filename ?? result.file ?? 'video');
  return {
    ...result,
    message: `video stream for file ${filename} opened successfully. total duration: ${result.duration}s. Fps: ${result.fps}, speed: ${result.speed}x. Initial video chunk extracted:`,
  };
}

function formatAudioOpenResult(result: Record<string, unknown>): Record<string, unknown> {
  const filename = String(result.filename ?? result.file ?? 'audio');
  return {
    ...result,
    message: `audio stream for file ${filename} opened successfully. total duration: ${result.duration}s. speed: ${result.speed}x, sampleRate: ${result.sampleRate}Hz, channels: ${result.channels}, format: ${result.format}. Initial audio chunk extracted:`,
  };
}

function formatAudioVideoOpenResult(result: Record<string, unknown>): Record<string, unknown> {
  const filename = String(result.filename ?? result.file ?? 'audio/video');
  return {
    ...result,
    message: `audio/video stream for file ${filename} opened successfully. total duration: ${result.duration}s. Fps: ${result.fps}, speed: ${result.speed}x, sampleRate: ${result.sampleRate}Hz, channels: ${result.channels}, format: ${result.format}. Initial audio/video chunk extracted:`,
  };
}
