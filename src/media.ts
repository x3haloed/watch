import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { ModelCapabilities, ResolvedModel } from './types.js';

export type MediaModality = 'image' | 'audio' | 'video' | 'pdf' | 'file';

export type MediaDescriptor = {
  source: 'filesystem' | 'discord' | 'url';
  path?: string;
  url?: string;
  filename?: string;
  mediaType: string;
  sizeBytes?: number;
  modality: MediaModality;
};

export type OpenedMedia = MediaDescriptor & {
  dataBase64: string;
};

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.avif': 'image/avif',
  '.avi': 'video/x-msvideo',
  '.bmp': 'image/bmp',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

export const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export function mediaTypeFromFilename(filename: string): string | undefined {
  return MEDIA_TYPES_BY_EXTENSION[extname(filename).toLowerCase()];
}

export function modalityFromMediaType(mediaType: string): MediaModality {
  const normalized = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('audio/')) return 'audio';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized === 'application/pdf') return 'pdf';
  return 'file';
}

export function capabilityKeyForModality(modality: MediaModality): keyof Pick<ModelCapabilities, 'images' | 'audio' | 'video' | 'pdf'> | undefined {
  if (modality === 'image') return 'images';
  if (modality === 'audio') return 'audio';
  if (modality === 'video') return 'video';
  if (modality === 'pdf') return 'pdf';
  return undefined;
}

export function modelSupportsMedia(model: ResolvedModel, modality: MediaModality): boolean {
  const capability = capabilityKeyForModality(modality);
  return capability ? model.capabilities[capability] === true : false;
}

export async function recommendedModelsForMedia(models: { resolveAll(): Promise<ResolvedModel[]> }, modality: MediaModality): Promise<string[]> {
  return (await models.resolveAll())
    .filter(model => model.capabilities.tools && modelSupportsMedia(model, modality))
    .map(model => model.id);
}

export async function describeFilesystemMedia(path: string, displayPath: string): Promise<MediaDescriptor | undefined> {
  const mediaType = mediaTypeFromFilename(path);
  if (!mediaType) {
    return undefined;
  }
  const stats = await stat(path);
  if (!stats.isFile()) {
    return undefined;
  }
  return {
    source: 'filesystem',
    path: displayPath,
    filename: basename(path),
    mediaType,
    sizeBytes: stats.size,
    modality: modalityFromMediaType(mediaType),
  };
}

export async function openFilesystemMedia(path: string, displayPath: string, maxBytes = DEFAULT_MEDIA_MAX_BYTES): Promise<OpenedMedia> {
  const descriptor = await describeFilesystemMedia(path, displayPath);
  if (!descriptor) {
    throw new Error(`Unsupported or unrecognized media file: ${displayPath}`);
  }
  if (descriptor.sizeBytes !== undefined && descriptor.sizeBytes > maxBytes) {
    throw new Error(`Media file is too large: ${descriptor.sizeBytes} bytes exceeds ${maxBytes} bytes.`);
  }
  const data = await readFile(path);
  return { ...descriptor, dataBase64: data.toString('base64') };
}

export async function openUrlMedia(input: {
  url: string;
  filename?: string;
  mediaType?: string;
  sizeBytes?: number;
  source?: 'discord' | 'url';
  maxBytes?: number;
}): Promise<OpenedMedia> {
  const maxBytes = input.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  if (input.sizeBytes !== undefined && input.sizeBytes > maxBytes) {
    throw new Error(`Media attachment is too large: ${input.sizeBytes} bytes exceeds ${maxBytes} bytes.`);
  }

  const response = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch media: HTTP ${response.status} ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Media attachment is too large: ${contentLength} bytes exceeds ${maxBytes} bytes.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Media attachment is too large: ${bytes.byteLength} bytes exceeds ${maxBytes} bytes.`);
  }

  const mediaType = input.mediaType ?? response.headers.get('content-type') ?? mediaTypeFromFilename(input.filename ?? input.url) ?? 'application/octet-stream';
  return {
    source: input.source ?? 'url',
    url: input.url,
    filename: input.filename,
    mediaType,
    sizeBytes: input.sizeBytes ?? bytes.byteLength,
    modality: modalityFromMediaType(mediaType),
    dataBase64: bytes.toString('base64'),
  };
}

export function mediaPlaceholder(media: Pick<MediaDescriptor, 'source' | 'path' | 'url' | 'filename' | 'mediaType' | 'sizeBytes' | 'modality'>): string {
  const name = media.filename ?? media.path ?? media.url ?? 'unnamed media';
  const size = media.sizeBytes === undefined ? '' : `, ${media.sizeBytes} bytes`;
  return `[media previously attached: ${media.modality}, ${media.mediaType}, ${name}${size}]`;
}
