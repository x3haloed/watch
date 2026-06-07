import { jsonSchema, tool } from 'ai';
import type { LookoutToolContext } from './context.js';
import type { JsonObject } from '../types.js';

export function createStreamTools(ctx: LookoutToolContext) {
  return {
    subscribe_stream: tool({
      description: 'Begin watching a stream. Subscription changes persist across future Soundings.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'The stream name to subscribe to.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const changed = ctx.streams.subscribe(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: true,
        });
        return { ok: true, changed, subscriptions: ctx.streams.listSubscriptions() };
      },
    }),
    unsubscribe_stream: tool({
      description: 'Stop watching a stream. The clock stream cannot be unsubscribed.',
      inputSchema: jsonSchema<{ stream: string }>({
        type: 'object',
        properties: {
          stream: { type: 'string', description: 'The stream name to unsubscribe from.' },
        },
        required: ['stream'],
        additionalProperties: false,
      }),
      execute: async ({ stream }) => {
        const changed = ctx.streams.unsubscribe(stream);
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream,
          subscribed: false,
        });
        return { ok: true, changed, subscriptions: ctx.streams.listSubscriptions() };
      },
    }),
    text_stream_open: tool({
      description:
        'Begin reading a UTF-8 text file as a gaze stream. Returns the first chunk immediately, then future Soundings include the next chunk until EOF or text_stream_close/unsubscribe_stream.',
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
        'Begin reading a video file as a gaze stream. Extracts image frames on-the-fly based on elapsed time between Soundings. Returns the initial frame immediately, then future Soundings include subsequent frames until video end or video_stream_close/unsubscribe_stream.',
      inputSchema: jsonSchema<{ path: string; fps?: number; speed?: number; resumeAtSecond?: number; width?: number; height?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Video file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          fps: { type: 'number', description: 'Optional frame rate to extract. Defaults to 1 (1 frame per video second).' },
          speed: { type: 'number', description: 'Optional playback speed multiplier. Defaults to 1 (real-time speed).' },
          resumeAtSecond: { type: 'number', description: 'Optional starting second offset to read/resume from. Defaults to 0.' },
          width: { type: 'number', description: 'Optional target width to downsample video resolution.' },
          height: { type: 'number', description: 'Optional target height to downsample video resolution.' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async ({ path, fps, speed, resumeAtSecond, width, height }) => {
        const result = await ctx.streams.openVideoFileStream({ path, fps, speed, resumeAtSecond, width, height });
        ctx.log.append({
          type: 'subscription_changed',
          at: new Date().toISOString(),
          stream: String(result.stream ?? 'video-stream'),
          subscribed: Boolean(result.subscribed),
        });
        return formatVideoOpenResult(result);
      },
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
        'Begin reading an audio file as a gaze stream. Extracts audio chunks on-the-fly based on elapsed time between Soundings. Returns the initial chunk immediately, then future Soundings include subsequent chunks until audio end or audio_stream_close/unsubscribe_stream.',
      inputSchema: jsonSchema<{ path: string; speed?: number; sampleRate?: number; channels?: number; format?: string; resumeAtSecond?: number }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Audio file path. Relative paths resolve from cwd; absolute paths are accepted. Paths containing .. are rejected.' },
          speed: { type: 'number', description: 'Optional playback speed multiplier. Defaults to 1 (real-time speed).' },
          sampleRate: { type: 'number', description: 'Optional sample rate to downsample audio (e.g. 16000). Defaults to 16000 Hz.' },
          channels: { type: 'number', description: 'Optional number of audio channels (e.g. 1 for mono, 2 for stereo). Defaults to 1.' },
          format: { type: 'string', description: 'Optional target container format (e.g. "wav", "mp3"). Defaults to "wav".' },
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
    report_gaze: tool({
      description: 'Report the current stream subscriptions.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => ({
        ok: true,
        subscriptions: ctx.streams.listSubscriptions(),
      }),
    }),
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
    message: `video stream for file ${filename} opened successfully. total duration: ${result.duration}s. Fps: ${result.fps}, speed: ${result.speed}x. Initial frame extracted:`,
  };
}

function formatAudioOpenResult(result: Record<string, unknown>): Record<string, unknown> {
  const filename = String(result.filename ?? result.file ?? 'audio');
  return {
    ...result,
    message: `audio stream for file ${filename} opened successfully. total duration: ${result.duration}s. speed: ${result.speed}x, sampleRate: ${result.sampleRate}Hz, channels: ${result.channels}, format: ${result.format}. Initial audio chunk extracted:`,
  };
}
