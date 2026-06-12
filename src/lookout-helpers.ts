import { type ToolCallRepairFunction, type ToolSet } from 'ai';
import type { FilePart, ImagePart, ModelMessage, TextPart } from 'ai';
import type { ModelCapabilities, ResolvedModel, Sounding } from './types.js';
import { mediaPlaceholder, modelSupportsMedia, modalityFromMediaType, type MediaDescriptor, type OpenedMedia } from './media.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const WATCH_OPENROUTER_VIDEO_SENTINEL = '__watch_openrouter_video__:';

const WATCH_OPENROUTER_AUDIO_SENTINEL = '__watch_openrouter_audio__:';

export type ContextFit = {
  ok: boolean;
  usedTokensEstimate: number;
  maxOutputTokens: number;
  requiredTokensEstimate: number;
  limitTokens: number | null;
  ratio: number | null;
  recommendation?: string;
};

export type InferenceErrorClassification = {
  kind: string;
  retryable: boolean | null;
  statusCode?: number;
  providerErrorCode?: string | number;
  providerErrorMessage?: string;
};

export type SoundingMediaPart =
  | { type: 'image'; image: string; mediaType: string }
  | { type: 'file'; data: string; mediaType: string };

export function formatLedgerEntry(entry: string): string {
  return `\n\n---\n\n[curl]\nat: ${new Date().toISOString()}\n[/curl]\n\n${entry}\n`;
}

export function timeoutTraceMessage(sounding: Sounding, checkpointMessages: number, toolCallCount: number): ModelMessage {
  const checkpointSummary = checkpointMessages > 0
    ? `${checkpointMessages} response message(s) from completed model/tool steps were checkpointed into this conversation history. tool_call_count: ${toolCallCount}. Do not repeat completed tool calls unless the current situation requires it.`
    : 'No model step completed before the timeout, so there are no assistant/tool messages to checkpoint.';
  return {
    role: 'user',
    content: `[timeout_trace]
Previous Sounding timed out before a normal assistant completion.
sounding_id: ${sounding.id}
trigger: ${sounding.trigger}
clock: ${sounding.at}
checkpoint: ${checkpointSummary}
The original deltas for that Sounding may already have been popped from streams. Treat this as an interrupted attempt, not as absence of event. Continue from the visible checkpoint and current deltas.
[/timeout_trace]`,
  };
}

export function modelFailureTraceMessage(
  sounding: Sounding,
  checkpointMessages: number,
  toolCallCount: number,
  classification: InferenceErrorClassification,
): ModelMessage {
  const checkpointSummary = checkpointMessages > 0
    ? `${checkpointMessages} response message(s) from completed model/tool steps were checkpointed into this conversation history. tool_call_count: ${toolCallCount}. Do not repeat completed tool calls unless the current situation requires it.`
    : 'No completed model/tool step was available to checkpoint.';
  const providerSummary = [
    `kind: ${classification.kind}`,
    `retryable: ${classification.retryable ?? 'unknown'}`,
    classification.statusCode === undefined ? undefined : `status_code: ${classification.statusCode}`,
    classification.providerErrorCode === undefined ? undefined : `provider_error_code: ${classification.providerErrorCode}`,
    classification.providerErrorMessage ? `provider_error_message: ${classification.providerErrorMessage}` : undefined,
  ].filter(Boolean).join('\n');
  return {
    role: 'user',
    content: `[model_failure_trace]
Previous Sounding failed before a normal assistant completion.
sounding_id: ${sounding.id}
trigger: ${sounding.trigger}
clock: ${sounding.at}
${providerSummary}
checkpoint: ${checkpointSummary}
The original deltas for that Sounding may already have been popped from streams. Treat this as an interrupted attempt, not as absence of event. Continue from the visible checkpoint and current deltas.
[/model_failure_trace]`,
  };
}

export function mediaToolOutputToModelOutput(output: unknown): Record<string, unknown> {
  const result = output as { ok?: unknown; media?: Partial<OpenedMedia>; text?: unknown };
  if (result.ok === true && result.media?.dataBase64 && result.media.mediaType) {
    return {
      type: 'content',
      value: [
        { type: 'text', text: typeof result.text === 'string' ? result.text : mediaPlaceholder(result.media as MediaDescriptor) },
        {
          type: 'media',
          data: result.media.dataBase64,
          mediaType: result.media.mediaType,
        },
      ],
    };
  }
  if (result.ok === true) {
    const mediaItems = mediaContentItemsFromNestedToolOutput(output);
    if (mediaItems.length > 0) {
      return {
        type: 'content',
        value: [
          {
            type: 'text',
            text: typeof result.text === 'string'
              ? result.text
              : typeof (output as { message?: unknown }).message === 'string'
                ? String((output as { message?: unknown }).message)
                : 'Tool call succeeded. Media is attached.',
          },
          ...mediaItems,
        ],
      };
    }
  }
  return { type: 'json', value: scrubMediaValue(output) };
}

function mediaContentItemsFromNestedToolOutput(output: unknown): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  collectNestedMediaContentItems(output, items);
  return items;
}

function collectNestedMediaContentItems(value: unknown, items: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedMediaContentItems(item, items);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.dataBase64 === 'string' && typeof value.mediaType === 'string') {
    items.push({
      type: 'media',
      data: value.dataBase64,
      mediaType: value.mediaType,
      ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
    });
    return;
  }

  for (const item of Object.values(value)) {
    collectNestedMediaContentItems(item, items);
  }
}

export function sanitizeMessagesForHistory(messages: ModelMessage[]): ModelMessage[] {
  return repairIncompleteToolTurns(JSON.parse(JSON.stringify(messages)) as ModelMessage[]);
}

export function messagesForModel(model: ResolvedModel, messages: ModelMessage[]): ModelMessage[] {
  const cloned = JSON.parse(JSON.stringify(messages)) as ModelMessage[];
  const supported = replaceUnsupportedMediaForModel(cloned, model) as ModelMessage[];
  const withOpenRouterMedia = model.provider === 'openrouter' ? convertMediaFilePartsForOpenRouter(supported) : supported;
  return usesOpenAICompatibleChatProvider(model) ? moveToolResultMediaToUserMessages(withOpenRouterMedia, model) : withOpenRouterMedia;
}

export function convertMediaFilePartsForOpenRouter(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return message;
    }
    const newContent = content.map(part => {
      if (part && typeof part === 'object' && part.type === 'file') {
        const mediaType = typeof part.mediaType === 'string' ? part.mediaType : '';
        const videoType = openRouterVideoMediaType(mediaType);
        if (videoType) {
          const data = typeof part.data === 'string' ? part.data : '';
          return openRouterVideoTextPart(data, videoType);
        }
        const audioFormat = openRouterAudioFormat(mediaType);
        if (audioFormat) {
          const data = typeof part.data === 'string' ? part.data : '';
          return openRouterAudioTextPart(data, audioFormat);
        }
      }
      return part;
    });
    return { ...message, content: newContent } as ModelMessage;
  });
}

export function usesOpenAICompatibleChatProvider(model: ResolvedModel): boolean {
  return model.provider === 'openai-compatible' || model.provider === 'openrouter';
}

export function prepareSoundingDeltas(sounding: Sounding, model: ResolvedModel): { textLines: string[]; mediaParts: SoundingMediaPart[] } {
  const mediaParts: SoundingMediaPart[] = [];
  const textLines = sounding.deltas.map(delta => {
    const payload = prepareSoundingPayload(delta.payload, model, mediaParts);
    return `${delta.stream}: ${JSON.stringify(payload)} @ ${delta.at}`;
  });
  return { textLines, mediaParts };
}

function prepareSoundingPayload(payload: unknown, model: ResolvedModel, mediaParts: SoundingMediaPart[]): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const media = mediaChunkFromRecord(payload);
  if (media) {
    return prepareSoundingMediaRecord(payload, media, model, mediaParts);
  }

  const mediaPartsBefore = mediaParts.length;
  const prepared = Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map(item => prepareSoundingPayload(item, model, mediaParts))
        : prepareSoundingPayload(value, model, mediaParts),
    ]),
  );

  if (payload.kind === 'av_file_chunk') {
    return {
      ...prepared,
      mediaPartsAttached: mediaParts.length - mediaPartsBefore,
    };
  }

  return prepared;
}

function prepareSoundingMediaRecord(
  record: Record<string, unknown>,
  media: { dataBase64: string; mediaType: string },
  model: ResolvedModel,
  mediaParts: SoundingMediaPart[],
): Record<string, unknown> {
  const metadata = omitInlineMediaPayload(record);
  if (shouldAttachSoundingMedia(media.mediaType, model)) {
    const modality = modalityFromMediaType(media.mediaType);
    if (modality === 'image') {
      mediaParts.push({ type: 'image', image: media.dataBase64, mediaType: media.mediaType });
    } else if (modality === 'video' || modality === 'audio') {
      mediaParts.push({ type: 'file', data: media.dataBase64, mediaType: media.mediaType });
    }
    return metadata;
  }

  return {
    ...metadata,
    mediaOmitted: unsupportedSoundingMediaReason(media.mediaType, model),
  };
}

function mediaChunkFromRecord(record: Record<string, unknown>): { dataBase64: string; mediaType: string } | undefined {
  const dataBase64 = record.dataBase64;
  const mediaType = record.mediaType;
  return typeof dataBase64 === 'string' && typeof mediaType === 'string'
    ? { dataBase64, mediaType }
    : undefined;
}

function omitInlineMediaPayload(record: Record<string, unknown>): Record<string, unknown> {
  const { dataBase64: _dataBase64, payload: _payload, ...metadata } = record;
  return metadata;
}

function shouldAttachSoundingMedia(mediaType: string, model: ResolvedModel): boolean {
  const modality = modalityFromMediaType(mediaType);
  return (modality === 'image' || modality === 'video' || modality === 'audio') && modelSupportsMedia(model, modality) && promptMediaSupportForModel(model, mediaType).ok;
}

function unsupportedSoundingMediaReason(mediaType: string, model: ResolvedModel): string {
  const modality = modalityFromMediaType(mediaType);
  if (modality !== 'image' && modality !== 'video' && modality !== 'audio') {
    return `stream media type ${mediaType} is ${modality}; Sounding media attachment currently supports image frames, video, and audio only`;
  }
  if (!modelSupportsMedia(model, modality)) {
    return `active model ${model.id} does not support ${modality} input`;
  }
  const providerSupport = promptMediaSupportForModel(model, mediaType);
  return providerSupport.ok ? 'media omitted for an unknown compatibility reason' : providerSupport.reason;
}

export function promptMediaSupportForModel(model: ResolvedModel, mediaType: string): { ok: true } | { ok: false; reason: string } {
  const normalized = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!usesOpenAICompatibleChatProvider(model)) {
    return { ok: true };
  }
  if (model.provider === 'openrouter') {
    if (openRouterVideoMediaType(normalized) || openRouterAudioFormat(normalized)) {
      return { ok: true };
    }
  }
  if (normalized.startsWith('video/') && model.capabilities.video) {
    return { ok: true };
  }
  if (normalized.startsWith('image/')) {
    return { ok: true };
  }
  if (normalized.startsWith('audio/')) {
    return { ok: true };
  }
  if (normalized === 'application/pdf') {
    return { ok: true };
  }
  if (normalized.startsWith('text/')) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `The OpenAI-compatible provider cannot serialize ${mediaType} as model input. It currently supports images, audio formats, PDFs, and text files; OpenRouter also supports MP4/MPEG/MOV/WebM video.`,
  };
}

function moveToolResultMediaToUserMessages(messages: ModelMessage[], model: ResolvedModel): ModelMessage[] {
  const moved: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role !== 'tool' || !Array.isArray(content)) {
      moved.push(message);
      continue;
    }

    const followUpMessages: ModelMessage[] = [];
    const transformedContent = content.map(part => {
      const record = isRecord(part) ? part : undefined;
      if (!record || record.type !== 'tool-result' || !isRecord(record.output)) {
        return part;
      }

      const mediaParts = mediaUserContentPartsFromToolOutput(record.output, model);
      if (mediaParts.length === 0) {
        return part;
      }

      const toolName = typeof record.toolName === 'string' ? record.toolName : 'tool';
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : 'unknown';
      const summary = textSummaryFromToolOutput(record.output);

      followUpMessages.push(
        { role: 'assistant', content: '[awaiting media open result]' } as ModelMessage,
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: [
                `Media requested by tool call ${toolCallId} (${toolName}) is attached here.`,
                summary ? `Tool result summary: ${summary}` : undefined,
              ].filter(Boolean).join('\n'),
            } satisfies TextPart,
            ...mediaParts,
          ],
        } as ModelMessage,
      );

      // The OpenAI-compatible chat provider serializes tool-result `content`
      // outputs with JSON.stringify(), so image/file content parts become opaque
      // text instead of real multimodal input. Keep the tool-call/result protocol
      // satisfied with a text result, then append the media as a user message,
      // where the provider already converts image/file parts correctly.
      return {
        ...record,
        output: {
          type: 'json',
          value: {
            ok: true,
            mediaAttachedInFollowingUserMessage: true,
            result: summary || 'Tool call succeeded. The requested media is attached in the following user message.',
          },
        },
      };
    });

    moved.push({ ...message, content: transformedContent } as ModelMessage, ...followUpMessages);
  }
  return moved;
}

function mediaUserContentPartsFromToolOutput(output: Record<string, unknown>, model: ResolvedModel): Array<ImagePart | FilePart | TextPart> {
  if (output.type !== 'content' || !Array.isArray(output.value)) {
    return [];
  }

  const parts: Array<ImagePart | FilePart | TextPart> = [];
  for (const item of output.value) {
    if (!isRecord(item)) continue;
    const mediaType = typeof item.mediaType === 'string' ? item.mediaType : undefined;
    if (!mediaType) continue;

    if ((item.type === 'media' || item.type === 'image-data') && typeof item.data === 'string' && mediaType.startsWith('image/')) {
      parts.push({ type: 'image', image: item.data, mediaType });
      continue;
    }

    if ((item.type === 'media' || item.type === 'file-data') && typeof item.data === 'string') {
      const openRouterVideoType = model.provider === 'openrouter' ? openRouterVideoMediaType(mediaType) : undefined;
      if (openRouterVideoType) {
        parts.push(openRouterVideoTextPart(item.data, openRouterVideoType));
        continue;
      }
      const openRouterAudioFormatVal = model.provider === 'openrouter' ? openRouterAudioFormat(mediaType) : undefined;
      if (openRouterAudioFormatVal) {
        parts.push(openRouterAudioTextPart(item.data, openRouterAudioFormatVal));
        continue;
      }
      parts.push({
        type: 'file',
        data: item.data,
        mediaType,
        ...(typeof item.filename === 'string' ? { filename: item.filename } : {}),
      });
      continue;
    }

    if (item.type === 'image-url' && typeof item.url === 'string') {
      parts.push({ type: 'image', image: new URL(item.url), mediaType });
      continue;
    }

    if (item.type === 'file-url' && typeof item.url === 'string') {
      const openRouterVideoType = model.provider === 'openrouter' ? openRouterVideoMediaType(mediaType) : undefined;
      if (openRouterVideoType) {
        parts.push(openRouterVideoTextPart(item.url, openRouterVideoType));
        continue;
      }
      parts.push({ type: 'file', data: new URL(item.url), mediaType });
      continue;
    }
  }
  return parts;
}

function openRouterVideoMediaType(mediaType: string): string | undefined {
  const normalized = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized === 'video/mp4') return 'video/mp4';
  if (normalized === 'video/mpeg') return 'video/mpeg';
  if (normalized === 'video/mov' || normalized === 'video/quicktime') return 'video/mov';
  if (normalized === 'video/webm') return 'video/webm';
  return undefined;
}

function openRouterVideoTextPart(dataOrUrl: string, mediaType: string): TextPart {
  const url = dataOrUrl.startsWith('http') || dataOrUrl.startsWith('data:')
    ? dataOrUrl
    : `data:${mediaType};base64,${dataOrUrl}`;
  return {
    type: 'text',
    text: `${WATCH_OPENROUTER_VIDEO_SENTINEL}${JSON.stringify({ url })}`,
  };
}

function openRouterAudioFormat(mediaType: string): string | undefined {
  const normalized = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'audio/mp3' || normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'audio/flac' || normalized === 'audio/x-flac') return 'flac';
  if (normalized === 'audio/aac' || normalized === 'audio/x-aac') return 'aac';
  if (normalized === 'audio/m4a' || normalized === 'audio/x-m4a' || normalized === 'audio/mp4') return 'm4a';
  if (normalized === 'audio/aiff' || normalized === 'audio/x-aiff') return 'aiff';
  if (normalized === 'audio/pcm16') return 'pcm16';
  if (normalized === 'audio/pcm24') return 'pcm24';
  return undefined;
}

function openRouterAudioTextPart(base64Data: string, format: string): TextPart {
  return {
    type: 'text',
    text: `${WATCH_OPENROUTER_AUDIO_SENTINEL}${JSON.stringify({ data: base64Data, format })}`,
  };
}

function textSummaryFromToolOutput(output: Record<string, unknown>): string | undefined {
  if (output.type === 'text' || output.type === 'error-text') {
    return typeof output.value === 'string' ? output.value : undefined;
  }
  if (output.type !== 'content' || !Array.isArray(output.value)) {
    return undefined;
  }
  const text = output.value
    .filter(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map(item => (item as { text: string }).text.trim())
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function replaceUnsupportedMediaForModel(value: unknown, model: ResolvedModel): unknown {
  if (Array.isArray(value)) {
    return value.map(item => replaceUnsupportedMediaForModel(item, model));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const mediaType = mediaTypeFromRecord(record);
  const modality = mediaType ? modalityFromMediaType(mediaType) : undefined;
  if (mediaType && modality && !modelSupportsMedia(model, modality)) {
    return unsupportedMediaPlaceholder(record, mediaType, modality, model);
  }

  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, replaceUnsupportedMediaForModel(item, model)]));
}

function mediaTypeFromRecord(record: Record<string, unknown>): string | undefined {
  if (
    (record.type === 'media' || record.type === 'image-data' || record.type === 'file-data' || record.type === 'image' || record.type === 'file')
    && typeof record.mediaType === 'string'
  ) {
    return record.mediaType;
  }
  if ('dataBase64' in record && typeof record.mediaType === 'string') {
    return record.mediaType;
  }
  return undefined;
}

function unsupportedMediaPlaceholder(record: Record<string, unknown>, mediaType: string, modality: MediaDescriptor['modality'], model: ResolvedModel): unknown {
  const name = mediaNameFromRecord(record);
  return {
    type: 'text',
    text: `[${name} was attached but model ${model.id} does not support ${modality} input (${mediaType})]`,
  };
}

function mediaNameFromRecord(record: Record<string, unknown>): string {
  if (typeof record.filename === 'string' && record.filename.trim()) {
    return record.filename.trim();
  }
  if (typeof record.image === 'string' && record.image.trim()) {
    return record.image.trim().startsWith('data:') ? 'inline image data' : record.image.trim();
  }
  if (typeof record.path === 'string' && record.path.trim()) {
    return record.path.trim();
  }
  if (typeof record.url === 'string' && record.url.trim()) {
    return record.url.trim();
  }
  if (typeof record.data === 'string' && record.data.trim().startsWith('http')) {
    return record.data.trim();
  }
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType : 'media';
  return mediaType;
}

export function repairIncompleteToolTurns(messages: ModelMessage[]): ModelMessage[] {
  const availableResultIds = new Set<string>();
  const availableCallIds = new Set<string>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || typeof part.toolCallId !== 'string') continue;
      if (message.role === 'assistant' && part.type === 'tool-call') {
        availableCallIds.add(part.toolCallId);
      }
      if (message.role === 'tool' && part.type === 'tool-result') {
        availableResultIds.add(part.toolCallId);
      }
    }
  }

  const repaired: ModelMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (message.role === 'tool' && Array.isArray(content)) {
      const missingCallParts = content
        .filter(part => isRecord(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string' && !availableCallIds.has(part.toolCallId))
        .map(part => ({
          type: 'tool-call',
          toolCallId: (part as { toolCallId: string }).toolCallId,
          toolName: 'unknown_tool_called',
          input: { repaired: true, reason: 'tool result was present in history but the matching assistant tool call was missing' },
        }));
      if (missingCallParts.length > 0) {
        repaired.push({ role: 'assistant', content: missingCallParts } as ModelMessage);
      }
      repaired.push(message);
      continue;
    }

    repaired.push(message);
    if (message.role !== 'assistant' || !Array.isArray(content)) {
      continue;
    }

    const missingResultParts = content
      .filter(part => isRecord(part) && part.type === 'tool-call' && typeof part.toolCallId === 'string' && !availableResultIds.has(part.toolCallId))
      .map(part => ({
        type: 'tool-result',
        toolCallId: (part as { toolCallId: string }).toolCallId,
        toolName: typeof (part as { toolName?: unknown }).toolName === 'string' ? (part as { toolName: string }).toolName : 'unknown_tool_called',
        output: {
          type: 'json',
          value: {
            ok: false,
            repaired: true,
            result: 'unknown result',
            reason: 'assistant tool call was present in history but the matching tool result was missing',
          },
        },
      }));
    if (missingResultParts.length > 0) {
      repaired.push({ role: 'tool', content: missingResultParts } as ModelMessage);
    }
  }
  return repaired;
}

function scrubMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => scrubMediaValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === 'media' || record.type === 'image-data' || record.type === 'file-data') {
    return {
      type: 'text',
      text: mediaPlaceholder({
        source: 'url',
        mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
        modality: typeof record.mediaType === 'string' ? modalityFromMediaType(record.mediaType) : 'file',
      }),
    };
  }
  if (record.type === 'image-url' || record.type === 'file-url') {
    return {
      type: 'text',
      text: `[media URL previously attached: ${typeof record.url === 'string' ? record.url : 'unknown URL'}]`,
    };
  }
  if ('dataBase64' in record) {
    const { dataBase64: _dataBase64, ...rest } = record;
    return {
      ...Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, scrubMediaValue(item)])),
      placeholder: mediaPlaceholder({
        source: 'url',
        filename: typeof record.filename === 'string' ? record.filename : undefined,
        mediaType: typeof record.mediaType === 'string' ? record.mediaType : 'application/octet-stream',
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
        modality: typeof record.modality === 'string' ? (record.modality as MediaDescriptor['modality']) : 'file',
      }),
    };
  }

  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, scrubMediaValue(item)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type DiscordAttachmentRef = {
  id: string;
  url: string;
  filename?: string;
  mediaType: string;
  sizeBytes?: number;
  modality: OpenedMedia['modality'];
};

export function readDiscordAttachments(metadata: unknown): DiscordAttachmentRef[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const discord = (metadata as { discord?: unknown }).discord;
  if (!discord || typeof discord !== 'object') return [];
  const attachments = (discord as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const url = typeof record.url === 'string' ? record.url : undefined;
    const mediaType = typeof record.mediaType === 'string' ? record.mediaType : undefined;
    if (!id || !url || !mediaType) return [];
    return [
      {
        id,
        url,
        filename: typeof record.filename === 'string' ? record.filename : undefined,
        mediaType,
        sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : undefined,
        modality: modalityFromMediaType(mediaType),
      },
    ];
  });
}

export function parseWatchableDiscordScope(
  kind: 'channel' | 'thread',
  id: string | undefined,
): { ok: true; kind: 'channel' | 'thread'; id: string } | { ok: false; error: string } {
  const cleanId = id?.trim();
  if (!cleanId) {
    return { ok: false, error: `Discord ${kind} watch requires id.` };
  }
  return { ok: true, kind, id: cleanId };
}

export function formatCapabilities(capabilities: ModelCapabilities): string {
  const enabled = [
    capabilities.tools ? 'tools' : '',
    capabilities.text ? 'text' : '',
    capabilities.images ? 'images' : '',
    capabilities.audio ? 'audio' : '',
    capabilities.video ? 'video' : '',
    capabilities.pdf ? 'pdf' : '',
    capabilities.reasoning ? 'reasoning' : '',
    capabilities.structuredOutput ? 'structured_output' : '',
    capabilities.contextTokens ? `context:${capabilities.contextTokens}` : '',
    capabilities.outputTokens ? `output:${capabilities.outputTokens}` : '',
  ].filter(Boolean);
  return `${enabled.join(', ') || 'none'} (source: ${capabilities.source})`;
}

export function maxOutputTokensForModel(model: ResolvedModel): number {
  const modelLimit = model.capabilities.outputTokens;
  if (!modelLimit) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.max(1, Math.min(DEFAULT_MAX_OUTPUT_TOKENS, modelLimit));
}

export function contextFitForModel(model: ResolvedModel, usedTokensEstimate: number): ContextFit {
  const maxOutputTokens = maxOutputTokensForModel(model);
  const requiredTokensEstimate = usedTokensEstimate + maxOutputTokens;
  const limitTokens = model.capabilities.contextTokens ?? null;
  const ratio = limitTokens ? requiredTokensEstimate / limitTokens : null;
  const recommendation = contextRecommendation(ratio);
  return {
    ok: limitTokens === null || requiredTokensEstimate <= limitTokens,
    usedTokensEstimate,
    maxOutputTokens,
    requiredTokensEstimate,
    limitTokens,
    ratio,
    ...(recommendation ? { recommendation } : {}),
  };
}

export function validEstimatedTokenWarningThreshold(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function contextRecommendation(ratio: number | null): string | undefined {
  if (ratio === null) {
    return 'Context limit is unknown for this model. Use session_dashboard and curl if the session feels heavy.';
  }
  if (ratio >= 0.95) {
    return 'Context is critically full. Consider calling curl now with a ledgerEntry before more work accumulates.';
  }
  if (ratio >= 0.8) {
    return 'Context is getting heavy. Consider preparing a ledgerEntry and calling curl soon.';
  }
  if (ratio >= 0.6) {
    return 'Context is moderately loaded. Keep curl in mind if new work becomes detailed or emotionally load-bearing.';
  }
  return undefined;
}

export function crossedContextThreshold(ratio: number | null, previous: number): number | undefined {
  if (ratio === null) {
    return undefined;
  }
  const threshold = contextThresholdAtOrBelow(ratio);
  return threshold > previous ? threshold : undefined;
}

export function highestContextThresholdAtOrBelow(ratio: number): number {
  return contextThresholdAtOrBelow(ratio);
}

function contextThresholdAtOrBelow(ratio: number): number {
  if (ratio < 0.1) {
    return 0;
  }
  const step = contextThresholdStep(ratio);
  return roundThreshold(Math.floor((ratio + Number.EPSILON * 100) / step) * step);
}

function contextThresholdStep(ratio: number): number {
  if (ratio < 0.3) return 0.1;
  if (ratio < 0.5) return 0.05;
  if (ratio < 0.7) return 1 / 30;
  if (ratio < 0.85) return 0.025;
  if (ratio < 0.95) return 0.01;
  return 0.005;
}

function roundThreshold(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? 'unknown' : `${(ratio * 100).toFixed(1)}%`;
}

export const repairFlatToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, inputSchema }) => {
  const schema = await inputSchema({ toolName: toolCall.toolName });
  const repaired = repairToolInput(toolCall.input, schema);
  if (!repaired) {
    return null;
  }
  return {
    ...toolCall,
    input: JSON.stringify(repaired),
  };
};

function repairToolInput(inputText: string, schema: { type?: unknown; required?: unknown; properties?: unknown }): Record<string, unknown> | undefined {
  const parsed = parseToolInput(inputText);
  if (parsed === undefined || schema.type !== 'object') {
    return undefined;
  }

  if (isRecord(parsed) && isRecord(parsed.params)) {
    return parsed.params;
  }

  if (isRecord(parsed)) {
    return undefined;
  }

  const required = Array.isArray(schema.required) ? schema.required.filter(item => typeof item === 'string') : [];
  if (required.length !== 1) {
    return undefined;
  }
  return { [required[0]]: parsed };
}

function parseToolInput(inputText: string): unknown {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function inferParamCount(text: string): string | undefined {
  const match = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([bm])(?:[^a-z0-9]|$)/i.exec(text);
  if (!match) {
    return undefined;
  }
  return `${match[1]}${match[2].toUpperCase()}`;
}

export function defaultUseFor(model: ResolvedModel, restingModelId?: string): string {
  if (model.id === restingModelId) {
    return 'ambient monitoring, lightweight routing, simple message handling, and deciding whether to reroute';
  }
  const multimodal = ['images', 'audio', 'video', 'pdf'].filter(key => model.capabilities[key as keyof ModelCapabilities] === true);
  const traits = [
    model.capabilities.reasoning ? 'hard reasoning' : 'general work',
    multimodal.length ? `${multimodal.join('/')} inputs` : '',
    model.params ?? inferParamCount(`${model.id} ${model.model}`) ?? '',
  ].filter(Boolean);
  return traits.join(', ');
}

export function estimateTokensRough(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export function requiredApiKeyEnv(model: ResolvedModel): string | undefined {
  if (model.provider === 'openai-compatible' && model.baseURL?.includes('localhost')) {
    return undefined;
  }
  const envName = model.apiKeyEnv ?? (model.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined);
  return envName && !process.env[envName]?.trim() ? envName : undefined;
}

export function isTimeoutLikeError(error: unknown): boolean {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted due to timeout/i.test(message);
}

export function classifyInferenceError(error: unknown): InferenceErrorClassification {
  const statusCode = numberProperty(error, 'statusCode');
  const retryable = booleanProperty(error, 'isRetryable');
  const data = objectProperty(error, 'data');
  const responseBody = stringProperty(error, 'responseBody');
  const parsedResponse = parseJsonObject(responseBody);
  const providerError = objectProperty(data, 'error') ?? objectProperty(parsedResponse, 'error');
  const providerErrorCode = stringOrNumberProperty(providerError, 'code');
  const providerErrorMessage = stringProperty(providerError, 'message');

  if (statusCode !== undefined) {
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 409 && statusCode !== 429) {
      return {
        kind: 'non_retryable_provider_error',
        retryable: retryable ?? false,
        statusCode,
        providerErrorCode,
        providerErrorMessage,
      };
    }
    if (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500) {
      return {
        kind: 'retryable_provider_error',
        retryable: retryable ?? true,
        statusCode,
        providerErrorCode,
        providerErrorMessage,
      };
    }
    return {
      kind: 'provider_error',
      retryable: retryable ?? null,
      statusCode,
      providerErrorCode,
      providerErrorMessage,
    };
  }

  if (isTimeoutLikeError(error)) {
    return { kind: 'timeout', retryable: true };
  }

  return {
    kind: retryable === false ? 'non_retryable_inference_error' : 'inference_error',
    retryable: retryable ?? null,
    providerErrorCode,
    providerErrorMessage,
  };
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: sanitizeForJson(error.cause),
      url: stringProperty(error, 'url'),
      statusCode: numberProperty(error, 'statusCode'),
      responseHeaders: sanitizeForJson(objectProperty(error, 'responseHeaders')),
      responseBody: stringProperty(error, 'responseBody'),
      data: sanitizeForJson(objectProperty(error, 'data')),
      isRetryable: booleanProperty(error, 'isRetryable'),
    };
  }
  return { value: sanitizeForJson(error) };
}

export function toJsonObject(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeForJson(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { value: sanitized };
}

export function countToolCalls(step: unknown): number {
  const content = (step as { content?: unknown })?.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter(part => part && typeof part === 'object' && (part as { type?: string }).type === 'tool-call').length;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === 'number' && Number.isFinite(property) ? property : undefined;
}

function booleanProperty(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === 'boolean' ? property : undefined;
}

function stringOrNumberProperty(value: unknown, key: string): string | number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return typeof property === 'string' || typeof property === 'number' ? property : undefined;
}

function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const property = value[key];
  return isRecord(property) ? property : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeForJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (value instanceof Error) {
    return errorToJson(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForJson(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeForJson(nested, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
      }
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}
