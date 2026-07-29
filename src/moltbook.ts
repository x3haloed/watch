import { createHash } from 'node:crypto';
import { EventLog } from './event-log.js';
import { StreamRegistry } from './streams.js';
import { compactJsonObject, isJsonObject } from './stream-primitives.js';
import type { JsonObject, MoltbookConfig, MoltbookScopeConfig, MoltbookScopeSnapshot, MoltbookStateSnapshot } from './types.js';

const API_BASE = 'https://www.moltbook.com/api/v1';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ITEMS = 10;
const ACTIONABLE_STREAM = 'moltbook';
const UPDATES_STREAM = 'moltbook:updates';
const DEFAULT_API_KEY_ENV = 'MOLTBOOK_API_KEY';

type ScopeState = {
  initialized: boolean;
  contentFingerprints: Map<string, string>;
  engagementFingerprints: Map<string, string>;
};

type PollStatus = {
  lastPollAt?: string;
  nextPollAt?: string;
  backoffUntil?: string;
  lastError?: string;
  rateLimit?: JsonObject;
};

type FetchLike = typeof fetch;

export type MoltbookReadInput = {
  kind: 'home' | 'post' | 'comments' | 'profile' | 'feed' | 'search';
  postId?: string;
  name?: string;
  query?: string;
  filter?: 'all' | 'following';
  sort?: string;
  limit?: number;
  cursor?: string;
};

export type MoltbookMarkReadInput = {
  postId?: string;
  all?: boolean;
};

export class MoltbookBridge {
  private readonly configuredScopes = new Map<string, MoltbookScopeSnapshot>();
  private readonly runtimeScopes = new Map<string, MoltbookScopeSnapshot>();
  private readonly scopeState = new Map<string, ScopeState>();
  private readonly pollStatus: PollStatus = {};
  private readonly intervalMs: number;
  private readonly maxItemsPerDelta: number;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(
    private readonly config: MoltbookConfig | undefined,
    private readonly streams: StreamRegistry,
    private readonly log: EventLog,
    initialState?: MoltbookStateSnapshot,
    private readonly onStateChanged: (state: MoltbookStateSnapshot) => void = () => {},
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.intervalMs = validIntervalMs(config?.intervalMs);
    this.maxItemsPerDelta = validMaxItems(config?.maxItemsPerDelta);
    for (const scope of normalizeConfiguredScopes(config)) {
      this.configuredScopes.set(scope.key, scope);
    }
    for (const scope of normalizeRuntimeScopes(initialState)) {
      if (!this.configuredScopes.has(scope.key)) {
        this.runtimeScopes.set(scope.key, scope);
      }
    }
    if (config?.enabled === true) {
      this.streams.registerBufferedStream(ACTIONABLE_STREAM, {
        subscribed: config.subscribed ?? true,
        waking: config.waking ?? true,
        maxPayloads: 100,
      });
      this.streams.registerBufferedStream(UPDATES_STREAM, {
        subscribed: config.subscribed ?? true,
        waking: false,
        maxPayloads: 100,
      });
    }
  }

  isEnabled(): boolean {
    return this.config?.enabled === true;
  }

  start(): void {
    if (!this.isEnabled() || this.timer) {
      return;
    }
    void this.pollNow();
    this.timer = setInterval(() => void this.pollNow(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getAttention(): JsonObject {
    return {
      enabled: this.isEnabled(),
      apiKeyEnv: this.apiKeyEnv(),
      streams: {
        actionable: ACTIONABLE_STREAM,
        updates: UPDATES_STREAM,
      },
      scopes: this.snapshotState().scopes,
      poll: this.pollStatus,
    };
  }

  snapshotState(): MoltbookStateSnapshot {
    return {
      scopes: [...this.configuredScopes.values(), ...this.runtimeScopes.values()]
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  watch(scope: MoltbookScopeConfig): JsonObject {
    const normalized = normalizeScope(scope, 'runtime');
    if (!normalized) {
      return { ok: false, error: 'Invalid Moltbook scope. Required fields depend on type.' };
    }
    this.runtimeScopes.set(normalized.key, normalized);
    this.emitStateChanged();
    return { ok: true, scope: normalized, attention: this.getAttention() };
  }

  unwatch(key: string): JsonObject {
    const normalizedKey = key.trim();
    const removed = this.runtimeScopes.delete(normalizedKey);
    if (removed) {
      this.scopeState.delete(normalizedKey);
      this.emitStateChanged();
    }
    return {
      ok: true,
      removed,
      key: normalizedKey,
      note: this.configuredScopes.has(normalizedKey) ? 'Configured scopes cannot be removed at runtime; disable them in config.' : undefined,
      attention: this.getAttention(),
    };
  }

  async read(input: MoltbookReadInput): Promise<JsonObject> {
    const endpoint = endpointForRead(input);
    if (!endpoint) {
      return { ok: false, error: 'Unsupported or incomplete Moltbook read request.' };
    }
    const result = await this.request(endpoint.path, { method: 'GET' });
    if (!result.ok) {
      return result.payload;
    }
    return {
      ok: true,
      kind: input.kind,
      endpoint: endpoint.description,
      body: result.body,
    };
  }

  async markRead(input: MoltbookMarkReadInput): Promise<JsonObject> {
    const path = input.all === true
      ? '/notifications/read-all'
      : input.postId?.trim()
        ? `/notifications/read-by-post/${encodeURIComponent(input.postId.trim())}`
        : undefined;
    if (!path) {
      return { ok: false, error: 'Provide postId or all=true.' };
    }
    const result = await this.request(path, { method: 'POST' });
    return result.payload;
  }

  async pollNow(force = false): Promise<void> {
    if (!this.isEnabled() || this.polling) {
      return;
    }
    if (!force && !this.streams.isSubscribed(ACTIONABLE_STREAM) && !this.streams.isSubscribed(UPDATES_STREAM)) {
      return;
    }
    const now = Date.now();
    if (this.pollStatus.backoffUntil && Date.parse(this.pollStatus.backoffUntil) > now) {
      return;
    }
    this.polling = true;
    this.pollStatus.lastPollAt = new Date(now).toISOString();
    try {
      for (const scope of this.snapshotState().scopes) {
        await this.pollScope(scope, new Date(), force);
      }
      this.pollStatus.lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pollStatus.lastError = message;
      this.push(ACTIONABLE_STREAM, {
        kind: 'moltbook_error',
        error: message,
        sampledAt: new Date().toISOString(),
      });
    } finally {
      this.polling = false;
      this.pollStatus.nextPollAt = new Date(Date.now() + this.intervalMs).toISOString();
    }
  }

  private async pollScope(scope: MoltbookScopeSnapshot, now: Date, force: boolean): Promise<void> {
    const endpoint = endpointForScope(scope);
    if (!endpoint) {
      return;
    }
    const intervalMs = validIntervalMs(scope.intervalMs ?? this.intervalMs);
    const state = this.stateFor(scope.key);
    const lastPollAt = scopeLastPollMs(state);
    if (!force && lastPollAt && now.getTime() - lastPollAt < intervalMs) {
      return;
    }
    (state as ScopeState & { lastPollMs?: number }).lastPollMs = now.getTime();

    const result = await this.request(endpoint.path, { method: 'GET' });
    if (!result.ok) {
      this.push(ACTIONABLE_STREAM, {
        kind: 'moltbook_scope_error',
        scope: scope.key,
        status: result.status,
        error: result.payload.error,
        hint: result.payload.hint,
        sampledAt: now.toISOString(),
      });
      return;
    }

    const items = extractItems(scope, result.body);
    const nextContent = new Map<string, string>();
    const nextEngagement = new Map<string, string>();
    const contentChanges: JsonObject[] = [];
    const engagementChanges: JsonObject[] = [];

    for (const item of items) {
      const id = itemId(item);
      if (!id) continue;
      const contentFingerprint = fingerprint(contentFingerprintValue(item));
      const engagementFingerprint = fingerprint(engagementFingerprintValue(item));
      nextContent.set(id, contentFingerprint);
      nextEngagement.set(id, engagementFingerprint);
      if (!state.initialized) continue;
      if (state.contentFingerprints.get(id) !== contentFingerprint) {
        contentChanges.push(formatItem(scope, item));
      } else if (state.engagementFingerprints.get(id) !== engagementFingerprint) {
        engagementChanges.push(formatEngagementItem(scope, item));
      }
    }

    if (!state.initialized) {
      state.initialized = true;
      state.contentFingerprints = nextContent;
      state.engagementFingerprints = nextEngagement;
      this.push(UPDATES_STREAM, {
        kind: 'moltbook_baseline',
        scope: scope.key,
        count: items.length,
        sampledAt: now.toISOString(),
        hint: 'Moltbook baseline captured. Future deltas will include new or changed items.',
      });
      return;
    }

    state.contentFingerprints = nextContent;
    state.engagementFingerprints = nextEngagement;

    if (contentChanges.length > 0) {
      const bounded = contentChanges.slice(0, this.maxItemsPerDelta);
      this.push(isActionableScope(scope) ? ACTIONABLE_STREAM : UPDATES_STREAM, {
        kind: kindForScope(scope),
        scope: scope.key,
        count: contentChanges.length,
        truncated: contentChanges.length > bounded.length,
        items: bounded,
        sampledAt: now.toISOString(),
        hint: hintForScope(scope),
      });
    }
    if (engagementChanges.length > 0) {
      const bounded = engagementChanges.slice(0, this.maxItemsPerDelta);
      this.push(UPDATES_STREAM, {
        kind: 'moltbook_engagement_changed',
        scope: scope.key,
        count: engagementChanges.length,
        truncated: engagementChanges.length > bounded.length,
        items: bounded,
        sampledAt: now.toISOString(),
      });
    }
  }

  private async request(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown; payload: JsonObject }> {
    const apiKey = process.env[this.apiKeyEnv()]?.trim();
    if (!apiKey) {
      return {
        ok: false,
        status: 0,
        body: undefined,
        payload: { ok: false, error: `${this.apiKeyEnv()} is not set` },
      };
    }
    const url = apiUrl(path);
    if (!url) {
      return {
        ok: false,
        status: 0,
        body: undefined,
        payload: { ok: false, error: 'Refusing to send Moltbook Authorization outside https://www.moltbook.com/api/v1/*' },
      };
    }

    const response = await this.fetchImpl(url, {
      ...init,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });
    this.captureRateLimit(response);
    const text = await response.text();
    const body = parseJson(text) ?? text;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        this.pollStatus.backoffUntil = new Date(Date.now() + retryAfter * 1000).toISOString();
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      payload: compactJsonObject({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: response.ok ? body : undefined,
        error: response.ok ? undefined : errorFromBody(body, response),
        hint: response.ok ? undefined : hintFromBody(body),
        retryAfter: response.headers.get('retry-after') ?? undefined,
      }),
    };
  }

  private captureRateLimit(response: Response): void {
    this.pollStatus.rateLimit = compactJsonObject({
      limit: response.headers.get('x-ratelimit-limit') ?? response.headers.get('x-ratelimit-limit-medium') ?? undefined,
      remaining: response.headers.get('x-ratelimit-remaining') ?? response.headers.get('x-ratelimit-remaining-medium') ?? undefined,
      reset: response.headers.get('x-ratelimit-reset') ?? response.headers.get('x-ratelimit-reset-medium') ?? undefined,
    });
  }

  private push(stream: string, payload: JsonObject): void {
    const accepted = this.streams.push(stream, payload);
    if (accepted) {
      this.log.append({
        type: 'stream_buffered',
        at: new Date().toISOString(),
        stream,
        payload,
      });
    }
  }

  private stateFor(key: string): ScopeState {
    const existing = this.scopeState.get(key);
    if (existing) return existing;
    const created = {
      initialized: false,
      contentFingerprints: new Map<string, string>(),
      engagementFingerprints: new Map<string, string>(),
    };
    this.scopeState.set(key, created);
    return created;
  }

  private apiKeyEnv(): string {
    return this.config?.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  }

  private emitStateChanged(): void {
    this.onStateChanged(this.snapshotState());
  }
}

export function apiUrl(path: string): string | undefined {
  if (!path.startsWith('/')) {
    return undefined;
  }
  const url = new URL(`${API_BASE}${path}`);
  if (url.origin !== 'https://www.moltbook.com' || !url.pathname.startsWith('/api/v1/')) {
    return undefined;
  }
  return url.toString();
}

function normalizeConfiguredScopes(config: MoltbookConfig | undefined): MoltbookScopeSnapshot[] {
  if (config?.enabled !== true) {
    return [];
  }
  const input = Array.isArray(config.scopes) && config.scopes.length > 0 ? config.scopes : [{ type: 'home' as const }];
  return input.flatMap(scope => {
    const normalized = normalizeScope(scope, 'config');
    return normalized ? [normalized] : [];
  });
}

function normalizeRuntimeScopes(state: MoltbookStateSnapshot | undefined): MoltbookScopeSnapshot[] {
  return Array.isArray(state?.scopes)
    ? state.scopes.flatMap(scope => {
        const normalized = normalizeScope(scope, scope.source === 'config' ? 'config' : 'runtime');
        return normalized && normalized.source === 'runtime' ? [normalized] : [];
      })
    : [];
}

function normalizeScope(scope: MoltbookScopeConfig, source: 'config' | 'runtime'): MoltbookScopeSnapshot | undefined {
  if (!scope || typeof scope.type !== 'string') {
    return undefined;
  }
  const sort = scope.sort?.trim() || (scope.type === 'post' ? 'new' : 'new');
  const base = { ...scope, sort } as MoltbookScopeSnapshot;
  switch (scope.type) {
    case 'home':
      return { ...base, key: 'home', source };
    case 'announcements':
      return { ...base, key: 'announcements', source };
    case 'feed': {
      const filter = scope.filter === 'following' ? 'following' : 'all';
      return { ...base, filter, key: `feed:${filter}:${sort}`, source };
    }
    case 'submolt': {
      const name = scope.name?.trim().toLowerCase();
      return name ? { ...base, name, key: `submolt:${name}:${sort}`, source } : undefined;
    }
    case 'user': {
      const name = scope.name?.trim();
      return name ? { ...base, name, key: `user:${name}`, source } : undefined;
    }
    case 'post': {
      const id = scope.id?.trim();
      return id ? { ...base, id, key: `post:${id}:comments:${sort}`, source } : undefined;
    }
    case 'search': {
      const query = scope.query?.trim();
      return query ? { ...base, query, key: `search:${fingerprint(query).slice(0, 12)}`, source } : undefined;
    }
    default:
      return undefined;
  }
}

function endpointForScope(scope: MoltbookScopeSnapshot): { path: string } | undefined {
  const sort = encodeURIComponent(scope.sort || 'new');
  switch (scope.type) {
    case 'home':
      return { path: '/home' };
    case 'announcements':
      return { path: '/submolts/announcements/feed?sort=new&limit=10' };
    case 'feed': {
      const filter = scope.filter === 'following' ? '&filter=following' : '';
      return { path: `/feed?sort=${sort}&limit=15${filter}` };
    }
    case 'submolt':
      return scope.name ? { path: `/submolts/${encodeURIComponent(scope.name)}/feed?sort=${sort}&limit=15` } : undefined;
    case 'user':
      return scope.name ? { path: `/agents/profile?name=${encodeURIComponent(scope.name)}` } : undefined;
    case 'post':
      return scope.id ? { path: `/posts/${encodeURIComponent(scope.id)}/comments?sort=${sort}&limit=35` } : undefined;
    case 'search':
      return scope.query ? { path: `/search?q=${encodeURIComponent(scope.query)}&limit=20` } : undefined;
    default:
      return undefined;
  }
}

function endpointForRead(input: MoltbookReadInput): { path: string; description: string } | undefined {
  const limit = clampLimit(input.limit);
  const cursor = input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : '';
  const sort = encodeURIComponent(input.sort || 'new');
  switch (input.kind) {
    case 'home':
      return { path: '/home', description: 'home' };
    case 'post':
      return input.postId ? { path: `/posts/${encodeURIComponent(input.postId)}`, description: `post ${input.postId}` } : undefined;
    case 'comments':
      return input.postId ? { path: `/posts/${encodeURIComponent(input.postId)}/comments?sort=${sort}&limit=${limit}${cursor}`, description: `comments for ${input.postId}` } : undefined;
    case 'profile':
      return input.name ? { path: `/agents/profile?name=${encodeURIComponent(input.name)}`, description: `profile ${input.name}` } : undefined;
    case 'feed': {
      const filter = input.filter === 'following' ? '&filter=following' : '';
      return { path: `/feed?sort=${sort}&limit=${limit}${filter}${cursor}`, description: 'feed' };
    }
    case 'search':
      return input.query ? { path: `/search?q=${encodeURIComponent(input.query)}&limit=${limit}${cursor}`, description: `search ${input.query}` } : undefined;
    default:
      return undefined;
  }
}

function extractItems(scope: MoltbookScopeSnapshot, body: unknown): JsonObject[] {
  if (!isJsonObject(body)) return [];
  if (scope.type === 'home') {
    return [
      ...arrayObjects(body.activity_on_your_posts).map(item => ({ ...item, _moltbookKind: 'own_post_activity' })),
      ...arrayObjects((body.posts_from_accounts_you_follow as JsonObject | undefined)?.posts).map(item => ({ ...item, _moltbookKind: 'followed_post' })),
      ...arrayObjects((body.your_direct_messages as JsonObject | undefined)?.conversations).map(item => ({ ...item, _moltbookKind: 'direct_message' })),
      ...arrayObjects((body.your_direct_messages as JsonObject | undefined)?.requests).map(item => ({ ...item, _moltbookKind: 'direct_message_request' })),
      ...(isJsonObject(body.latest_moltbook_announcement) ? [{ ...body.latest_moltbook_announcement, _moltbookKind: 'announcement' }] : []),
      ...(isJsonObject(body.your_account) ? [{ ...body.your_account, _moltbookKind: 'account' }] : []),
    ];
  }
  if (scope.type === 'user') {
    return [
      ...arrayObjects(body.recentPosts).map(item => ({ ...item, _moltbookKind: 'user_post' })),
      ...arrayObjects(body.recentComments).map(item => ({ ...item, _moltbookKind: 'user_comment' })),
    ];
  }
  if (scope.type === 'post') {
    return flattenComments(arrayObjects(body.comments));
  }
  return arrayObjects(body.posts).length > 0
    ? arrayObjects(body.posts)
    : arrayObjects(body.results).length > 0
      ? arrayObjects(body.results)
      : Array.isArray(body) ? arrayObjects(body) : [];
}

function flattenComments(comments: JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  for (const comment of comments) {
    result.push({ ...comment, _moltbookKind: 'comment' });
    result.push(...flattenComments(arrayObjects(comment.replies)));
  }
  return result;
}

function itemId(item: JsonObject): string | undefined {
  for (const key of ['id', 'post_id', 'comment_id', 'conversation_id', 'request_id', 'latest_at']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      return `${String(item._moltbookKind ?? 'item')}:${value}`;
    }
  }
  const title = typeof item.title === 'string' ? item.title : '';
  const createdAt = typeof item.created_at === 'string' ? item.created_at : typeof item.latest_at === 'string' ? item.latest_at : '';
  if (title || createdAt) {
    return `${String(item._moltbookKind ?? 'item')}:${fingerprint({ title, createdAt }).slice(0, 16)}`;
  }
  return undefined;
}

function formatItem(scope: MoltbookScopeSnapshot, item: JsonObject): JsonObject {
  return compactJsonObject({
    kind: item._moltbookKind,
    id: item.id,
    post_id: item.post_id,
    comment_id: item.comment_id,
    title: item.title,
    content_preview: item.content_preview ?? previewText(item.content),
    preview: item.preview,
    author_name: item.author_name ?? objectName(item.author),
    submolt_name: item.submolt_name ?? objectName(item.submolt),
    post_title: item.post_title,
    created_at: item.created_at,
    latest_at: item.latest_at,
    upvotes: item.upvotes,
    comment_count: item.comment_count,
    new_notification_count: item.new_notification_count,
    suggested_actions: item.suggested_actions,
    read_hint: readHint(scope, item),
  });
}

function formatEngagementItem(scope: MoltbookScopeSnapshot, item: JsonObject): JsonObject {
  return compactJsonObject({
    kind: item._moltbookKind,
    id: item.id,
    post_id: item.post_id,
    title: item.title,
    upvotes: item.upvotes,
    downvotes: item.downvotes,
    comment_count: item.comment_count,
    new_notification_count: item.new_notification_count,
    latest_at: item.latest_at,
    read_hint: readHint(scope, item),
  });
}

function contentFingerprintValue(item: JsonObject): JsonObject {
  return compactJsonObject({
    kind: item._moltbookKind,
    id: item.id,
    post_id: item.post_id,
    comment_id: item.comment_id,
    title: item.title,
    content: item.content,
    content_preview: item.content_preview,
    preview: item.preview,
    author: item.author_name ?? objectName(item.author),
    submolt: item.submolt_name ?? objectName(item.submolt),
    created_at: item.created_at,
    latest_at: item.latest_at,
  });
}

function engagementFingerprintValue(item: JsonObject): JsonObject {
  return compactJsonObject({
    upvotes: item.upvotes,
    downvotes: item.downvotes,
    comment_count: item.comment_count,
    new_notification_count: item.new_notification_count,
    unread_count: item.unread_count,
    karma: item.karma,
  });
}

function isActionableScope(scope: MoltbookScopeSnapshot): boolean {
  if (scope.waking === true) return true;
  if (scope.waking === false) return false;
  return scope.type === 'home' || scope.type === 'user' || scope.type === 'post' || scope.type === 'announcements';
}

function kindForScope(scope: MoltbookScopeSnapshot): string {
  if (scope.type === 'post') return 'moltbook_new_comments';
  if (scope.type === 'home') return 'moltbook_home_activity';
  if (scope.type === 'user') return 'moltbook_user_activity';
  if (scope.type === 'announcements') return 'moltbook_announcements';
  return 'moltbook_new_items';
}

function hintForScope(scope: MoltbookScopeSnapshot): string {
  if (scope.type === 'home') return 'Call moltbook_read with kind "home" or a suggested post/comments read to inspect details.';
  if (scope.type === 'post') return 'Call moltbook_read with kind "comments" and this postId for the full conversation.';
  if (scope.type === 'user') return 'Call moltbook_read with kind "profile" and this name for the full profile.';
  return 'Call moltbook_read with the relevant kind to inspect full details.';
}

function readHint(scope: MoltbookScopeSnapshot, item: JsonObject): string | undefined {
  const postId = typeof item.post_id === 'string' ? item.post_id : typeof item.id === 'string' && scope.type !== 'user' ? item.id : undefined;
  if (postId) return `moltbook_read({ "kind": "post", "postId": "${postId}" })`;
  if (scope.type === 'user' && scope.name) return `moltbook_read({ "kind": "profile", "name": "${scope.name}" })`;
  return undefined;
}

function apiError(status: number, statusText: string): string {
  return `Moltbook API error ${status}: ${statusText}`;
}

function errorFromBody(body: unknown, response: Response): string {
  if (isJsonObject(body) && typeof body.error === 'string') return body.error;
  if (isJsonObject(body) && typeof body.message === 'string') return body.message;
  return apiError(response.status, response.statusText);
}

function hintFromBody(body: unknown): string | undefined {
  return isJsonObject(body) && typeof body.hint === 'string' ? body.hint : undefined;
}

function arrayObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function objectName(value: unknown): string | undefined {
  return isJsonObject(value) && typeof value.name === 'string' ? value.name : undefined;
}

function previewText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 240 ? `${value.slice(0, 240)}...` : typeof value === 'string' ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJsonValue(value))).digest('hex');
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJsonValue(value[key])]));
}

function validIntervalMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_INTERVAL_MS ? Math.trunc(value) : DEFAULT_INTERVAL_MS;
}

function validMaxItems(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(50, Math.trunc(value)) : DEFAULT_MAX_ITEMS;
}

function clampLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(100, Math.trunc(value)) : 25;
}

function scopeLastPollMs(state: ScopeState): number | undefined {
  return (state as ScopeState & { lastPollMs?: number }).lastPollMs;
}
