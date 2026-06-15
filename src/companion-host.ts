import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { capturesDir } from './paths.js';
import { WatchRuntime } from './runtime.js';
import type { JsonObject, WatchEvent } from './types.js';

const DEFAULT_COMPANION_HOST = '127.0.0.1';
const DEFAULT_COMPANION_PORT = 4478;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export type CompanionHost = {
  close: () => Promise<void>;
};

type ConversationMessage = {
  id: string;
  at: string;
  direction: 'in' | 'out';
  source: string;
  text: string;
  metadata?: JsonObject;
  deliveryStatus: 'delivered' | 'pending' | 'failed';
};

type IncomingAttachment = {
  kind?: 'screenshot' | 'file';
  name?: string;
  mimeType?: string;
  dataBase64?: string;
  metadata?: JsonObject;
};

export async function startCompanionHost(runtime: WatchRuntime): Promise<CompanionHost> {
  const host = process.env.WATCH_COMPANION_HOST || DEFAULT_COMPANION_HOST;
  const port = Number(process.env.WATCH_COMPANION_PORT || DEFAULT_COMPANION_PORT);
  const server = createServer((request, response) => {
    void routeRequest(runtime, request, response).catch(error => {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise(resolve => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

async function routeRequest(runtime: WatchRuntime, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, await runtime.status());
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/conversation') {
    sendJson(response, 200, { messages: conversationFromEvents(runtime.eventTail(600)).slice(-100) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/send') {
    const body = await readJsonBody<{ message?: string; source?: string }>(request);
    const message = String(body.message ?? '').trim();
    if (!message) {
      sendJson(response, 400, { ok: false, error: 'message is required' });
      return;
    }
    const result = runtime.enqueueInboxMessage(message, body.source || 'desktop-companion');
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/send-with-attachments') {
    const body = await readJsonBody<{ message?: string; source?: string; attachments?: IncomingAttachment[] }>(request);
    const message = String(body.message ?? '').trim();
    if (!message) {
      sendJson(response, 400, { ok: false, error: 'message is required' });
      return;
    }
    const attachments = storeAttachments(runtime, Array.isArray(body.attachments) ? body.attachments : []);
    const result = runtime.enqueueInboxMessage(message, body.source || 'desktop-companion', { attachments });
    sendJson(response, 200, { ok: true, ...result, attachments });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/events/stream') {
    streamRuntimeEvents(runtime, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/visualization/stream') {
    streamVisualizationStub(response);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'not found' });
}

function streamRuntimeEvents(runtime: WatchRuntime, response: ServerResponse): void {
  writeSseHeaders(response);
  writeSse(response, 'ready', { ok: true });
  void writeStatusEvent(runtime, response);
  const unsubscribe = runtime.subscribeEvents(event => {
    for (const message of messagesFromEvent(event)) {
      writeSse(response, 'conversation.message.created', {
        type: 'conversation.message.created',
        at: message.at,
        message,
      });
    }
    writeSse(response, 'audit.event_appended', {
      type: 'audit.event_appended',
      at: event.at,
      event,
    });
    void writeStatusEvent(runtime, response);
  });
  response.on('close', unsubscribe);
}

function streamVisualizationStub(response: ServerResponse): void {
  writeSseHeaders(response);
  writeSse(response, 'ready', { ok: true });
  writeSse(response, 'visualization.snapshot', {
    type: 'visualization.snapshot',
    at: new Date().toISOString(),
    snapshot: {
      meta: {
        startedAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        impactCount: 0,
        packetCount: 0,
      },
      impacts: [],
      outputPackets: [],
      state: {
        activeSoundings: 0,
        subscriberCount: 1,
        mode: 'idle',
        queued: 0,
        digestion: 0,
        thinking: 0,
        pressure: 0,
        output: 0,
        tool: 0,
        call: 0,
      },
    },
  });
}

async function writeStatusEvent(runtime: WatchRuntime, response: ServerResponse): Promise<void> {
  writeSse(response, 'runtime.status_changed', {
    type: 'runtime.status_changed',
    at: new Date().toISOString(),
    status: await runtime.status(),
  });
}

function conversationFromEvents(events: WatchEvent[]): ConversationMessage[] {
  const seen = new Set<string>();
  const messages: ConversationMessage[] = [];
  for (const event of events) {
    for (const message of messagesFromEvent(event)) {
      const key = `${message.direction}:${message.source}:${message.text}:${JSON.stringify(message.metadata ?? {})}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      messages.push(message);
    }
  }
  return messages;
}

function messagesFromEvent(event: WatchEvent): ConversationMessage[] {
  if (event.type === 'stream_buffered' && event.stream === 'inbox' && typeof event.payload.message === 'string') {
    return [
      {
        id: `inbox:${event.at}:${String(event.payload.source ?? 'cli')}`,
        at: event.at,
        direction: 'out',
        source: String(event.payload.source ?? 'cli'),
        text: event.payload.message,
        metadata: isJsonObject(event.payload.metadata) ? event.payload.metadata : undefined,
        deliveryStatus: 'delivered',
      },
    ];
  }

  if (event.type === 'cli_message') {
    return [
      {
        id: `cli:${event.soundingId}:${event.at}`,
        at: event.at,
        direction: 'in',
        source: 'agent',
        text: event.message,
        metadata: event.attachments ? { attachments: event.attachments } : undefined,
        deliveryStatus: 'delivered',
      },
    ];
  }

  if (event.type === 'sounding_finished' && event.text) {
    return [
      {
        id: `sounding:${event.soundingId}:${event.at}`,
        at: event.at,
        direction: 'in',
        source: 'agent',
        text: event.text,
        deliveryStatus: 'delivered',
      },
    ];
  }

  if (event.type === 'discord_outbound') {
    const target = event.replyToId ? `reply #${event.replyToId}` : event.channelId ? `channel ${event.channelId}` : 'discord';
    return [
      {
        id: `discord:${event.soundingId}:${event.at}`,
        at: event.at,
        direction: 'in',
        source: 'agent',
        text: `Discord ${target}: ${event.messageIds.join(', ')}`,
        deliveryStatus: 'delivered',
      },
    ];
  }

  return [];
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function storeAttachments(runtime: WatchRuntime, attachments: IncomingAttachment[]): JsonObject[] {
  const directory = capturesDir(runtime.instanceRoot);
  mkdirSync(directory, { recursive: true });
  return attachments.map(attachment => {
    const dataBase64 = String(attachment.dataBase64 ?? '');
    if (!dataBase64) {
      throw new Error('attachment dataBase64 is required');
    }
    const mimeType = String(attachment.mimeType ?? 'application/octet-stream');
    const id = randomUUID();
    const name = sanitizeAttachmentName(attachment.name ?? `${attachment.kind ?? 'attachment'}-${id}${extensionForMimeType(mimeType)}`);
    const path = join(directory, `${id}-${name}`);
    const buffer = Buffer.from(dataBase64, 'base64');
    writeFileSync(path, buffer);
    return {
      id,
      kind: attachment.kind ?? 'file',
      name,
      mimeType,
      path,
      sizeBytes: buffer.byteLength,
      capturedAt: new Date().toISOString(),
      metadata: attachment.metadata,
    };
  });
}

function writeSseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  if (response.destroyed) {
    return;
  }
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}

function sanitizeAttachmentName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'attachment';
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    default:
      return '.bin';
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
