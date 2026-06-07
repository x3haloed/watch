import type { ModelMessage } from 'ai';
import type { ResolvedModel, Sounding } from './types.js';
import { contextFitForModel, maxOutputTokensForModel, type ContextFit } from './lookout-helpers.js';

export type TokenEstimate = {
  tokens: number;
  media: MediaTokenEstimate[];
};

export type MediaTokenEstimate = {
  mediaType: string;
  bytes: number;
  tokens: number;
  ratio: number;
};

type ProviderAnchor = {
  inputTokens: number;
  messageCount: number;
};

const TEXT_CHARS_PER_TOKEN = 4;
const BASE64_BYTES_PER_CHAR = 3 / 4;

const MEDIA_TOKEN_RATIOS: Array<{ test: (mediaType: string) => boolean; tokensPerByte: number }> = [
  // Calibrated from the first desktop streaming session: MP4 data-url clips
  // landed around 0.010-0.017 provider prompt tokens per encoded byte.
  { test: mediaType => mediaType === 'video/mp4', tokensPerByte: 0.014 },
  { test: mediaType => mediaType.startsWith('video/'), tokensPerByte: 0.016 },
  { test: mediaType => mediaType.startsWith('image/'), tokensPerByte: 0.02 },
  { test: mediaType => mediaType.startsWith('audio/'), tokensPerByte: 0.01 },
  { test: mediaType => mediaType === 'application/pdf', tokensPerByte: 0.005 },
];

export class ContextTokenTracker {
  private anchor: ProviderAnchor | undefined;

  estimateMessages(messages: ModelMessage[]): TokenEstimate {
    const full = estimateModelValue(messages);
    if (!this.anchor || messages.length < this.anchor.messageCount) {
      return full;
    }
    const sinceAnchor = estimateModelValue(messages.slice(this.anchor.messageCount));
    return {
      tokens: this.anchor.inputTokens + sinceAnchor.tokens,
      media: sinceAnchor.media,
    };
  }

  estimatePrompt(input: { instructions: string; messages: ModelMessage[]; sounding?: Sounding }): TokenEstimate {
    const messages = this.estimateMessages(input.messages);
    const instructions = estimateTextTokens(input.instructions);
    const sounding = input.sounding ? estimateModelValue(input.sounding) : { tokens: 0, media: [] };
    return {
      tokens: messages.tokens + instructions + sounding.tokens,
      media: [...messages.media, ...sounding.media],
    };
  }

  contextFitFor(model: ResolvedModel, estimate: TokenEstimate): ContextFit {
    return contextFitForModel(model, estimate.tokens);
  }

  recordProviderInput(inputTokens: unknown, messages: ModelMessage[]): void {
    if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0) {
      return;
    }
    this.anchor = {
      inputTokens: Math.floor(inputTokens),
      messageCount: messages.length,
    };
  }

  maxOutputTokensFor(model: ResolvedModel): number {
    return maxOutputTokensForModel(model);
  }
}

export function estimateModelValue(value: unknown): TokenEstimate {
  const media: MediaTokenEstimate[] = [];
  const tokens = estimateValueTokens(value, media);
  return { tokens, media };
}

export function estimateTextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / TEXT_CHARS_PER_TOKEN);
}

function estimateValueTokens(value: unknown, media: MediaTokenEstimate[]): number {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return 1;
  }
  if (typeof value === 'string') {
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateValueTokens(item, media), 0);
  }
  if (typeof value !== 'object') {
    return estimateTextTokens(String(value));
  }

  const record = value as Record<string, unknown>;
  const mediaEstimate = estimateMediaRecord(record);
  if (mediaEstimate) {
    media.push(mediaEstimate);
    return mediaEstimate.tokens + estimateMediaMetadataTokens(record);
  }

  return Object.entries(record).reduce((sum, [key, item]) => sum + estimateTextTokens(key) + estimateValueTokens(item, media), 0);
}

function estimateMediaRecord(record: Record<string, unknown>): MediaTokenEstimate | undefined {
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType.toLowerCase().split(';')[0]?.trim() : undefined;
  if (!mediaType) {
    return undefined;
  }

  const dataBase64 = typeof record.dataBase64 === 'string'
    ? record.dataBase64
    : typeof record.data === 'string'
      ? record.data
      : typeof record.image === 'string'
        ? record.image
        : undefined;
  if (!dataBase64) {
    return undefined;
  }

  const base64 = dataBase64.startsWith('data:')
    ? dataBase64.slice(dataBase64.indexOf(',') + 1)
    : dataBase64;
  const bytes = Math.max(0, Math.floor(base64.length * BASE64_BYTES_PER_CHAR));
  const ratio = tokensPerMediaByte(mediaType);
  return {
    mediaType,
    bytes,
    ratio,
    tokens: Math.max(1, Math.ceil(bytes * ratio)),
  };
}

function estimateMediaMetadataTokens(record: Record<string, unknown>): number {
  const { dataBase64: _dataBase64, data: _data, image: _image, ...metadata } = record;
  return estimateTextTokens(JSON.stringify(metadata));
}

function tokensPerMediaByte(mediaType: string): number {
  return MEDIA_TOKEN_RATIOS.find(entry => entry.test(mediaType))?.tokensPerByte ?? 0.02;
}
