import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
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
