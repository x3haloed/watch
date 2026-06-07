import type { JsonObject } from './types.js';

export type StoredMessage = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  content: string;
  receivedAt: string;
  metadata?: JsonObject;
};

export type MessageEntry = {
  id: number;
  medium: string;
  source: string;
  subject: string;
  receivedAt: string;
};

export type MessagePage = {
  entries: MessageEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export interface MessageInbox {
  add(input: { medium: string; source: string; subject?: string; content: string; metadata?: JsonObject }): StoredMessage;
  get(id: number): StoredMessage | undefined;
  list(medium: string, page?: number, pageSize?: number): MessagePage;
}

export class InMemoryMessageInbox implements MessageInbox {
  private nextId = 1;
  private readonly messages = new Map<number, StoredMessage>();

  add(input: { medium: string; source: string; subject?: string; content: string; metadata?: JsonObject }): StoredMessage {
    const id = this.nextId++;
    const content = input.content;
    const message: StoredMessage = {
      id,
      medium: input.medium,
      source: input.source,
      subject: input.subject?.trim() || preview(content),
      content,
      receivedAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.messages.set(id, message);
    return message;
  }

  get(id: number): StoredMessage | undefined {
    return this.messages.get(id);
  }

  list(medium: string, page = 1, pageSize = 10): MessagePage {
    const safePageSize = Math.max(1, Math.min(50, Math.floor(pageSize)));
    const all = [...this.messages.values()]
      .filter(message => message.medium === medium)
      .sort((a, b) => b.id - a.id);
    const totalPages = Math.max(1, Math.ceil(all.length / safePageSize));
    const safePage = Math.max(1, Math.min(totalPages, Math.floor(page)));
    const start = (safePage - 1) * safePageSize;
    return {
      entries: all.slice(start, start + safePageSize).map(message => ({
        id: message.id,
        medium: message.medium,
        source: message.source,
        subject: message.subject,
        receivedAt: message.receivedAt,
      })),
      page: safePage,
      pageSize: safePageSize,
      total: all.length,
      totalPages,
    };
  }
}

function preview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return '(empty message)';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
