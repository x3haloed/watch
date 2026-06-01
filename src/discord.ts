import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js';
import { EventLog } from './event-log.js';
import { StreamRegistry } from './streams.js';
import type { DiscordConfig, JsonObject } from './types.js';

type DiscordAttentionPolicy = {
  defaultDMs: boolean;
  defaultMentions: boolean;
  defaultReplies: boolean;
  mutedGuilds: Set<string>;
  mutedChannels: Set<string>;
  mutedThreads: Set<string>;
  mutedUsers: Set<string>;
  watchedChannels: Set<string>;
  watchedThreads: Set<string>;
};

type AttentionScope =
  | { kind: 'dms' | 'mentions' | 'replies' }
  | { kind: 'guild' | 'channel' | 'thread' | 'user'; id: string };

type WatchableDiscordScope = { kind: 'channel' | 'thread'; id: string };
type SendableDiscordChannel = TextBasedChannel & {
  send(payload: Record<string, unknown>): Promise<Message>;
};

export type DiscordContextReadInput = {
  inboxMessageId?: number;
  channelId?: string;
  messageId?: string;
  before?: number;
  after?: number;
  beforeMessageId?: string;
  afterMessageId?: string;
  limit?: number;
};

export type DiscordSendInput = {
  replyToId?: number;
  message: string;
};

export class DiscordBridge {
  private readonly client: Client;
  private readonly policy: DiscordAttentionPolicy;
  private botUserId: string | undefined;
  private started = false;

  constructor(
    private readonly config: DiscordConfig | undefined,
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
  ) {
    this.policy = normalizePolicy(config);
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  isEnabled(): boolean {
    return this.config?.enabled === true;
  }

  async start(): Promise<void> {
    if (!this.isEnabled() || this.started) {
      return;
    }

    const tokenEnv = this.config?.tokenEnv?.trim() || 'DISCORD_BOT_TOKEN';
    const token = process.env[tokenEnv]?.trim();
    if (!token) {
      this.log.append({
        type: 'discord_dropped',
        at: new Date().toISOString(),
        reason: `${tokenEnv} is not set`,
      });
      return;
    }

    this.started = true;
    this.client.once(Events.ClientReady, readyClient => {
      this.botUserId = readyClient.user.id;
      this.log.append({
        type: 'discord_started',
        at: new Date().toISOString(),
        userId: readyClient.user.id,
        username: readyClient.user.tag,
      });
    });
    this.client.on(Events.MessageCreate, message => void this.handleMessage(message));
    this.client.on(Events.Error, error => this.logError(error));

    try {
      await this.client.login(token);
    } catch (error) {
      this.started = false;
      this.logError(error);
    }
  }

  async stop(reason: string): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.client.removeAllListeners();
    this.client.destroy();
    this.log.append({ type: 'discord_stopped', at: new Date().toISOString(), reason });
  }

  getAttention(): Record<string, unknown> {
    return {
      enabled: this.isEnabled(),
      connected: this.client.isReady(),
      botUserId: this.botUserId,
      policy: serializePolicy(this.policy),
    };
  }

  mute(scope: AttentionScope): Record<string, unknown> {
    this.applyScope(scope, 'mute');
    this.logAttentionChanged('mute', scope);
    return { ok: true, attention: this.getAttention() };
  }

  unmute(scope: AttentionScope): Record<string, unknown> {
    this.applyScope(scope, 'unmute');
    this.logAttentionChanged('unmute', scope);
    return { ok: true, attention: this.getAttention() };
  }

  watch(scope: WatchableDiscordScope): Record<string, unknown> {
    const set = scope.kind === 'thread' ? this.policy.watchedThreads : this.policy.watchedChannels;
    set.add(scope.id);
    this.logAttentionChanged('watch', scope);
    return { ok: true, attention: this.getAttention() };
  }

  unwatch(scope: WatchableDiscordScope): Record<string, unknown> {
    const set = scope.kind === 'thread' ? this.policy.watchedThreads : this.policy.watchedChannels;
    set.delete(scope.id);
    this.logAttentionChanged('unwatch', scope);
    return { ok: true, attention: this.getAttention() };
  }

  async readContext(input: DiscordContextReadInput): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'Discord bridge is not enabled.' };
    }
    if (!this.client.isReady()) {
      return { ok: false, error: 'Discord bridge is not connected.' };
    }

    const anchor = this.resolveContextAnchor(input);
    if (!anchor.ok) {
      return anchor;
    }
    const channel = await this.fetchTextChannel(anchor.channelId);
    if (!channel) {
      return { ok: false, error: `Discord channel not found or not text-readable: ${anchor.channelId}` };
    }

    const mode = input.beforeMessageId ? 'older' : input.afterMessageId ? 'newer' : 'centered';
    const messages = await this.fetchContextMessages(channel, anchor, input);
    if (!messages.ok) {
      return messages;
    }
    const ordered = [...messages.messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const oldest = ordered[0];
    const newest = ordered.at(-1);

    return {
      ok: true,
      mode,
      channel: {
        id: channel.id,
        name: channelDisplayName(channel),
        guildId: 'guildId' in channel ? channel.guildId : undefined,
      },
      anchor: {
        inboxMessageId: input.inboxMessageId,
        channelId: anchor.channelId,
        messageId: anchor.messageId,
      },
      window: {
        count: ordered.length,
        oldestMessageId: oldest?.id,
        newestMessageId: newest?.id,
        oldestAt: oldest?.createdAt.toISOString(),
        newestAt: newest?.createdAt.toISOString(),
      },
      messages: ordered.map(formatContextMessage),
      text: formatContextText({ mode, channel, anchorMessageId: anchor.messageId, messages: ordered }),
      next: {
        older: oldest
          ? {
              tool: 'discord_read_context',
              args: { channelId: anchor.channelId, beforeMessageId: oldest.id, limit: messages.limit },
            }
          : undefined,
        newer: newest
          ? {
              tool: 'discord_read_context',
              args: { channelId: anchor.channelId, afterMessageId: newest.id, limit: messages.limit },
            }
          : undefined,
        recenter: anchor.messageId
          ? {
              tool: 'discord_read_context',
              args: {
                channelId: anchor.channelId,
                messageId: anchor.messageId,
                before: messages.before,
                after: messages.after,
              },
            }
          : undefined,
      },
    };
  }

  async sendMessage(input: DiscordSendInput): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return { ok: false, error: 'Discord bridge is not enabled.' };
    }
    if (!this.client.isReady()) {
      return { ok: false, error: 'Discord bridge is not connected.' };
    }
    if (input.replyToId === undefined) {
      return { ok: false, error: 'Discord send_message requires replyToId from a Discord inbox message.' };
    }

    const stored = this.streams.getMessage(input.replyToId);
    const discord = readDiscordMetadata(stored?.metadata);
    if (!discord) {
      return { ok: false, error: `Inbox message ${input.replyToId} is not a Discord message.` };
    }

    const channel = await this.fetchTextChannel(discord.channelId);
    if (!channel) {
      return { ok: false, error: `Discord channel not found or not text-readable: ${discord.channelId}` };
    }
    if (!isSendableChannel(channel)) {
      return { ok: false, error: `Discord channel is not sendable: ${discord.channelId}` };
    }

    const chunks = chunkDiscordMessage(input.message);
    const sent = [];
    for (const [index, chunk] of chunks.entries()) {
      const payload = {
        content: chunk,
        allowedMentions: { repliedUser: index === 0, parse: [] },
        reply: index === 0 ? { messageReference: discord.messageId, failIfNotExists: false } : undefined,
      };
      const result = await channel.send(payload).catch((error: unknown) => error);
      if (result instanceof Error) {
        return { ok: false, error: errorMessage(result), delivered: sent };
      }
      const sentMessage = result as Message;
      sent.push({
        messageId: sentMessage.id,
        channelId: sentMessage.channelId,
        url: sentMessage.url,
      });
    }

    return { ok: true, delivered: 'discord', replyToId: input.replyToId, messages: sent };
  }

  private async handleMessage(message: Message): Promise<void> {
    const fullMessage = message.partial ? await message.fetch().catch(() => message) : message;
    const author = fullMessage.author;
    const channelId = fullMessage.channelId;
    const guildId = fullMessage.guildId ?? undefined;
    const threadId = fullMessage.channel?.isThread() ? channelId : undefined;
    const content = fullMessage.content.trim();

    const drop = (reason: string): void => {
      this.log.append({
        type: 'discord_dropped',
        at: new Date().toISOString(),
        messageId: fullMessage.id,
        channelId,
        authorId: author?.id,
        reason,
      });
    };

    if (!author) return drop('missing author');
    if (author.bot) return drop('bot author');
    if (this.botUserId && author.id === this.botUserId) return drop('own message');
    if (!content) return drop('empty content');
    if (guildId && this.policy.mutedGuilds.has(guildId)) return drop('muted guild');
    if (this.policy.mutedChannels.has(channelId)) return drop('muted channel');
    if (threadId && this.policy.mutedThreads.has(threadId)) return drop('muted thread');
    if (this.policy.mutedUsers.has(author.id)) return drop('muted user');

    const reason = this.acceptanceReason(fullMessage);
    if (!reason) return drop('outside discord attention');

    const accepted = this.streams.push('inbox', {
      medium: 'discord',
      source: 'discord',
      subject: `${formatDiscordPlace(fullMessage)} from ${author.tag}`,
      message: content,
      metadata: {
        discord: {
          reason,
          messageId: fullMessage.id,
          channelId,
          guildId,
          threadId,
          authorId: author.id,
          authorName: author.tag,
          isDm: isDirectMessage(fullMessage),
          url: fullMessage.url,
          referencedMessageId: fullMessage.reference?.messageId,
        },
      },
    });

    if (!accepted) return drop('inbox unsubscribed');
    this.log.append({
      type: 'discord_inbound',
      at: new Date().toISOString(),
      messageId: fullMessage.id,
      channelId,
      authorId: author.id,
      reason,
    });
    this.log.append({
      type: 'stream_buffered',
      at: new Date().toISOString(),
      stream: 'inbox',
      payload: { source: 'discord', reason },
    });
  }

  private resolveContextAnchor(
    input: DiscordContextReadInput,
  ): { ok: true; channelId: string; messageId?: string } | { ok: false; error: string } {
    if (input.inboxMessageId !== undefined) {
      const stored = this.streams.getMessage(input.inboxMessageId);
      const discord = readDiscordMetadata(stored?.metadata);
      if (!discord) {
        return { ok: false, error: `Inbox message ${input.inboxMessageId} is not a Discord message.` };
      }
      return { ok: true, channelId: discord.channelId, messageId: discord.messageId };
    }

    const channelId = input.channelId?.trim();
    if (!channelId) {
      return { ok: false, error: 'Provide inboxMessageId or channelId.' };
    }

    const messageId = input.messageId?.trim() || input.beforeMessageId?.trim() || input.afterMessageId?.trim();
    return { ok: true, channelId, messageId };
  }

  private async fetchTextChannel(channelId: string): Promise<TextBasedChannel | undefined> {
    const cached = this.client.channels.cache.get(channelId);
    const channel = cached ?? await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('messages' in channel)) {
      return undefined;
    }
    return channel as TextBasedChannel;
  }

  private async fetchContextMessages(
    channel: TextBasedChannel,
    anchor: { channelId: string; messageId?: string },
    input: DiscordContextReadInput,
  ): Promise<
    | { ok: true; messages: Message[]; before: number; after: number; limit: number }
    | { ok: false; error: string }
  > {
    const limit = clampInt(input.limit, 25, 1, 50);
    if (input.beforeMessageId?.trim()) {
      const older = await channel.messages.fetch({ before: input.beforeMessageId.trim(), limit }).catch(error => error);
      if (!(older instanceof Map)) return { ok: false, error: errorMessage(older) };
      return { ok: true, messages: [...older.values()], before: limit, after: 0, limit };
    }
    if (input.afterMessageId?.trim()) {
      const newer = await channel.messages.fetch({ after: input.afterMessageId.trim(), limit }).catch(error => error);
      if (!(newer instanceof Map)) return { ok: false, error: errorMessage(newer) };
      return { ok: true, messages: [...newer.values()], before: 0, after: limit, limit };
    }
    if (!anchor.messageId) {
      const latest = await channel.messages.fetch({ limit }).catch(error => error);
      if (!(latest instanceof Map)) return { ok: false, error: errorMessage(latest) };
      return { ok: true, messages: [...latest.values()], before: limit, after: 0, limit };
    }

    const before = clampInt(input.before, 20, 0, 50);
    const after = clampInt(input.after, 5, 0, 50);
    const [anchorMessage, older, newer] = await Promise.all([
      channel.messages.fetch(anchor.messageId).catch(error => error),
      before > 0 ? channel.messages.fetch({ before: anchor.messageId, limit: before }).catch(error => error) : Promise.resolve(new Map()),
      after > 0 ? channel.messages.fetch({ after: anchor.messageId, limit: after }).catch(error => error) : Promise.resolve(new Map()),
    ]);
    if (anchorMessage instanceof Error) return { ok: false, error: errorMessage(anchorMessage) };
    if (!(older instanceof Map)) return { ok: false, error: errorMessage(older) };
    if (!(newer instanceof Map)) return { ok: false, error: errorMessage(newer) };
    const messages = [anchorMessage as Message, ...older.values(), ...newer.values()];
    const deduped = [...new Map(messages.map(message => [message.id, message])).values()];
    return { ok: true, messages: deduped, before, after, limit: Math.max(1, before + after + 1) };
  }

  private acceptanceReason(message: Message): string | undefined {
    const threadId = message.channel?.isThread() ? message.channelId : undefined;
    if (threadId && this.policy.watchedThreads.has(threadId)) return 'watched_thread';
    if (this.policy.watchedChannels.has(message.channelId)) return 'watched_channel';
    if (isDirectMessage(message) && this.policy.defaultDMs) return 'dm';
    if (this.botUserId && this.policy.defaultMentions && message.mentions.users.has(this.botUserId)) {
      return 'mention';
    }
    if (this.policy.defaultReplies && this.isReplyToBot(message)) return 'reply';
    return undefined;
  }

  private isReplyToBot(message: Message): boolean {
    const referencedAuthorId = message.reference?.messageId
      ? message.mentions.repliedUser?.id
      : undefined;
    return Boolean(this.botUserId && referencedAuthorId === this.botUserId);
  }

  private applyScope(scope: AttentionScope, action: 'mute' | 'unmute'): void {
    const muted = action === 'mute';
    if (scope.kind === 'dms') this.policy.defaultDMs = !muted;
    if (scope.kind === 'mentions') this.policy.defaultMentions = !muted;
    if (scope.kind === 'replies') this.policy.defaultReplies = !muted;
    if (scope.kind === 'guild') setMembership(this.policy.mutedGuilds, scope.id, muted);
    if (scope.kind === 'channel') setMembership(this.policy.mutedChannels, scope.id, muted);
    if (scope.kind === 'thread') setMembership(this.policy.mutedThreads, scope.id, muted);
    if (scope.kind === 'user') setMembership(this.policy.mutedUsers, scope.id, muted);
  }

  private logAttentionChanged(action: string, scope: AttentionScope): void {
    this.log.append({
      type: 'discord_attention_changed',
      at: new Date().toISOString(),
      action,
      scope: scope as unknown as JsonObject,
      policy: serializePolicy(this.policy),
    });
  }

  private logError(error: unknown): void {
    this.log.append({
      type: 'discord_error',
      at: new Date().toISOString(),
      error: errorToJson(error),
    });
  }
}

export function parseDiscordAttentionScope(kind: string, id?: string): AttentionScope {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'dms' || normalized === 'mentions' || normalized === 'replies') {
    return { kind: normalized };
  }
  if (['guild', 'channel', 'thread', 'user'].includes(normalized)) {
    const cleanId = id?.trim();
    if (!cleanId) {
      throw new Error(`Discord ${normalized} scope requires id.`);
    }
    return { kind: normalized as 'guild' | 'channel' | 'thread' | 'user', id: cleanId };
  }
  throw new Error('scope kind must be one of dms, mentions, replies, guild, channel, thread, user');
}

function normalizePolicy(config?: DiscordConfig): DiscordAttentionPolicy {
  return {
    defaultDMs: config?.defaultDMs !== false,
    defaultMentions: config?.defaultMentions !== false,
    defaultReplies: config?.defaultReplies !== false,
    mutedGuilds: new Set(config?.mutedGuilds ?? []),
    mutedChannels: new Set(config?.mutedChannels ?? []),
    mutedThreads: new Set(config?.mutedThreads ?? []),
    mutedUsers: new Set(config?.mutedUsers ?? []),
    watchedChannels: new Set(config?.watchedChannels ?? []),
    watchedThreads: new Set(config?.watchedThreads ?? []),
  };
}

function serializePolicy(policy: DiscordAttentionPolicy): JsonObject {
  return {
    defaultDMs: policy.defaultDMs,
    defaultMentions: policy.defaultMentions,
    defaultReplies: policy.defaultReplies,
    mutedGuilds: [...policy.mutedGuilds].sort(),
    mutedChannels: [...policy.mutedChannels].sort(),
    mutedThreads: [...policy.mutedThreads].sort(),
    mutedUsers: [...policy.mutedUsers].sort(),
    watchedChannels: [...policy.watchedChannels].sort(),
    watchedThreads: [...policy.watchedThreads].sort(),
  };
}

function setMembership(set: Set<string>, id: string, enabled: boolean): void {
  if (enabled) {
    set.add(id);
  } else {
    set.delete(id);
  }
}

function isDirectMessage(message: Message): boolean {
  return message.channel.type === ChannelType.DM;
}

function formatDiscordPlace(message: Message): string {
  if (isDirectMessage(message)) return 'Discord DM';
  const channel = 'name' in message.channel && message.channel.name ? `#${message.channel.name}` : message.channelId;
  return message.guild?.name ? `Discord ${message.guild.name} ${channel}` : `Discord ${channel}`;
}

function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

function readDiscordMetadata(metadata: unknown): { channelId: string; messageId: string } | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const discord = (metadata as { discord?: unknown }).discord;
  if (!discord || typeof discord !== 'object') return undefined;
  const channelId = (discord as { channelId?: unknown }).channelId;
  const messageId = (discord as { messageId?: unknown }).messageId;
  return typeof channelId === 'string' && typeof messageId === 'string' ? { channelId, messageId } : undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function formatContextMessage(message: Message): JsonObject {
  return {
    id: message.id,
    at: message.createdAt.toISOString(),
    authorId: message.author?.id,
    authorName: message.author?.tag ?? message.author?.username ?? 'unknown',
    content: message.content,
    attachmentCount: message.attachments.size,
    referencedMessageId: message.reference?.messageId,
    url: message.url,
  };
}

function formatContextText(params: {
  mode: string;
  channel: TextBasedChannel;
  anchorMessageId?: string;
  messages: Message[];
}): string {
  const lines = params.messages.map(message => {
    const marker = message.id === params.anchorMessageId ? '>' : ' ';
    const time = message.createdAt.toISOString();
    const author = message.author?.tag ?? message.author?.username ?? 'unknown';
    const content = message.content.replace(/\s+/g, ' ').trim() || attachmentSummary(message);
    return `${marker} [${message.id}] ${time} ${author}: ${content}`;
  });
  return [
    `Discord context ${params.mode}: ${channelDisplayName(params.channel)}`,
    params.anchorMessageId ? `Anchor: ${params.anchorMessageId}` : undefined,
    lines.join('\n') || '(no messages)',
  ].filter(Boolean).join('\n');
}

function attachmentSummary(message: Message): string {
  return message.attachments.size > 0 ? `[${message.attachments.size} attachment(s)]` : '(empty message)';
}

function channelDisplayName(channel: TextBasedChannel): string {
  if (channel.type === ChannelType.DM) return 'DM';
  if ('name' in channel && channel.name) return `#${channel.name}`;
  return channel.id;
}

function isSendableChannel(channel: TextBasedChannel): channel is SendableDiscordChannel {
  return 'send' in channel && typeof channel.send === 'function';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunkDiscordMessage(message: string): string[] {
  const text = message.trim();
  if (!text) return ['(empty message)'];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }
    const splitAt = bestDiscordSplitIndex(remaining);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function bestDiscordSplitIndex(text: string): number {
  const limit = 2000;
  const candidates = [text.lastIndexOf('\n\n', limit), text.lastIndexOf('\n', limit), text.lastIndexOf(' ', limit)];
  return candidates.find(index => index > 1000) ?? limit;
}
