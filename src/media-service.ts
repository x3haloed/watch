import type { ModelRegistry } from './model-registry.js';
import type { RepoFileTools } from './file-tools.js';
import type { MessageInbox } from './message-inbox.js';
import type { ResolvedModel } from './types.js';
import {
  mediaPlaceholder,
  mediaTypeFromFilename,
  modelSupportsMedia,
  modalityFromMediaType,
  openUrlMedia,
  recommendedModelsForMedia,
  type MediaDescriptor,
  type OpenedMedia,
} from './media.js';
import { promptMediaSupportForModel, readDiscordAttachments } from './lookout-helpers.js';

export type OpenMediaInput = {
  path?: string;
  inboxMessageId?: number;
  attachmentId?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
};

export class MediaService {
  constructor(
    private readonly files: RepoFileTools,
    private readonly inbox: MessageInbox,
    private readonly models: ModelRegistry,
  ) {}

  async openForModel(input: OpenMediaInput, model: ResolvedModel): Promise<Record<string, unknown>> {
    let descriptor: MediaDescriptor | undefined;
    let open: () => Promise<OpenedMedia>;

    if (input.path?.trim()) {
      descriptor = await this.files.describeMedia(input.path);
      if (!descriptor) {
        return { ok: false, error: `Path is not recognized as supported media: ${input.path}` };
      }
      open = () => this.files.openMedia(input.path as string);
    } else {
      const attachment = this.resolveMediaAttachment(input);
      if (!attachment.ok) {
        return attachment;
      }
      descriptor = {
        source: attachment.source,
        url: attachment.url,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        modality: attachment.modality,
      };
      open = () =>
        openUrlMedia({
          url: attachment.url,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
          source: attachment.source,
        });
    }

    if (!modelSupportsMedia(model, descriptor.modality)) {
      const recommendedModels = await recommendedModelsForMedia(this.models, descriptor.modality);
      return {
        ok: false,
        error: `The active model ${model.id} does not support ${descriptor.modality} input.`,
        media: descriptor,
        recommendedModels,
        next_actions: recommendedModels.length
          ? [`handle_with_model can select "${recommendedModels[0]}"; open_media can then be retried with that model.`]
          : ['No configured model currently advertises support for this modality. Add one to config.json or choose a different media item.'],
      };
    }

    const providerSupport = promptMediaSupportForModel(model, descriptor.mediaType);
    if (!providerSupport.ok) {
      return {
        ok: false,
        error: providerSupport.reason,
        media: descriptor,
        next_actions: ['A different media format or a provider adapter that serializes this media type can make it available.'],
      };
    }

    const media = await open();
    return {
      ok: true,
      media,
      text: mediaPlaceholder(media),
    };
  }

  private resolveMediaAttachment(input: OpenMediaInput):
    | { ok: true; source: 'discord' | 'url'; url: string; filename?: string; mediaType: string; sizeBytes?: number; modality: OpenedMedia['modality'] }
    | { ok: false; error: string } {
    if (input.url?.trim()) {
      const mediaType = input.mediaType?.trim() || mediaTypeFromFilename(input.filename ?? input.url);
      if (!mediaType) return { ok: false, error: 'URL media requires mediaType or a recognized media filename/URL extension.' };
      return {
        ok: true,
        source: 'url',
        url: input.url.trim(),
        filename: input.filename?.trim() || undefined,
        mediaType,
        modality: modalityFromMediaType(mediaType),
      };
    }

    if (input.inboxMessageId === undefined) {
      return { ok: false, error: 'Provide path, url, or inboxMessageId + attachmentId.' };
    }
    const attachmentId = input.attachmentId?.trim();
    if (!attachmentId) {
      return { ok: false, error: 'Discord media requires attachmentId.' };
    }
    const stored = this.inbox.get(input.inboxMessageId);
    const attachments = readDiscordAttachments(stored?.metadata);
    const attachment = attachments.find(item => item.id === attachmentId);
    if (!attachment) {
      return { ok: false, error: `Attachment ${attachmentId} was not found on inbox message ${input.inboxMessageId}.` };
    }
    return {
      ok: true,
      source: 'discord',
      url: attachment.url,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      modality: attachment.modality,
    };
  }
}
